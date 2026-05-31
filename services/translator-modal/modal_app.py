"""Modal deployment for a Grammarly-style NL -> Lean checker backend."""

from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Literal

import modal
from pydantic import BaseModel, Field, field_validator

APP_NAME = os.environ.get("APP_NAME", "deepseek-prover-v2")
APP_VERSION = "2026-05-30-deepseek-prover-v2-7b-v1"
MODEL_ID = os.environ.get("MODEL_ID", "deepseek-ai/DeepSeek-Prover-V2-7B")
MODEL_REVISION = os.environ.get("MODEL_REVISION")

HF_CACHE_DIR = Path("/cache/hf")
MODEL_ROOT_DIR = Path("/cache/models")
MODEL_LOCAL_DIR = MODEL_ROOT_DIR / MODEL_ID.replace("/", "__")

# LoRA target modules for DeepSeek-Prover-V2 7B.
# DeepSeek-V2-Lite (the backbone) uses Multi-head Latent Attention (MLA):
#   - q_a_proj / q_b_proj  — query low-rank decomposition
#   - kv_a_proj_with_mqa / kv_b_proj — compressed KV projection
#   - o_proj               — output projection
#   - gate_proj / up_proj / down_proj — MLP (SwiGLU)
# These replace the q/k/v_proj names used by Herald (Mistral/LLaMA architecture).
LORA_TARGET_MODULES = [
    "q_a_proj",
    "q_b_proj",
    "kv_a_proj_with_mqa",
    "kv_b_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
]

LEAN_BIN = "/root/.elan/bin/lean"
LAKE_BIN = "/root/.elan/bin/lake"
LEAN_CHECK_TIMEOUT_SECONDS = 20
LEAN_CHECK_DECLARATION_NAME = "_candidate_statement"
MATHLIB_PROJECT_DIR = Path("/cache/lean/mathlib_checker")
MATHLIB_MARKER_FILE = MATHLIB_PROJECT_DIR / ".mathlib_ready"
MATHLIB_GIT_URL = "https://github.com/leanprover-community/mathlib4.git"
MATHLIB_REVISION = os.environ.get("MATHLIB_REVISION")
MATHLIB_BOOTSTRAP_TOOLCHAIN = os.environ.get("MATHLIB_BOOTSTRAP_TOOLCHAIN", "stable")
MATHLIB_PREBUILD_MODULES_DEFAULT = (
    "Mathlib.Data.Real.Basic",
    "Mathlib.Probability.Filtration",
    "Mathlib.MeasureTheory.Measure.Space",
    "Mathlib.MeasureTheory.MeasurableSpace.Defs",
)
_mathlib_prebuild_modules_env = os.environ.get("MATHLIB_PREBUILD_MODULES")
if _mathlib_prebuild_modules_env:
    MATHLIB_PREBUILD_MODULES = tuple(
        item.strip() for item in _mathlib_prebuild_modules_env.split(",") if item.strip()
    )
else:
    MATHLIB_PREBUILD_MODULES = MATHLIB_PREBUILD_MODULES_DEFAULT
MATHLIB_BUILD_TIMEOUT_SECONDS = int(os.environ.get("MATHLIB_BUILD_TIMEOUT_SECONDS", "600"))
MATHLIB_PREBUILD_STRICT = os.environ.get("MATHLIB_PREBUILD_STRICT", "0").strip().lower() in {
    "1",
    "true",
    "yes",
}
MATHLIB_IMPORT = "Mathlib"
MATHLIB_IDENTIFIER_TO_IMPORT = (
    ("Real", "Mathlib.Data.Real.Basic"),
    ("Complex", "Mathlib.Data.Complex.Basic"),
    ("Differentiable", "Mathlib.Analysis.Calculus.Deriv.Basic"),
    ("Continuous", "Mathlib.Topology.Basic"),
    ("Measure", "Mathlib.MeasureTheory.Measure.Basic"),
    ("TopologicalSpace", "Mathlib.Topology.Basic"),
    ("Normed", "Mathlib.Analysis.NormedSpace.Basic"),
)
ANALYZE_CACHE_TTL_SECONDS = int(os.environ.get("ANALYZE_CACHE_TTL_SECONDS", "600"))
ANALYZE_CACHE_MAX_ENTRIES = int(os.environ.get("ANALYZE_CACHE_MAX_ENTRIES", "512"))
MODEL_OUTPUT_CACHE_TTL_SECONDS = int(os.environ.get("MODEL_OUTPUT_CACHE_TTL_SECONDS", "600"))
MODEL_OUTPUT_CACHE_MAX_ENTRIES = int(os.environ.get("MODEL_OUTPUT_CACHE_MAX_ENTRIES", "512"))
LEAN_CHECK_CACHE_TTL_SECONDS = int(os.environ.get("LEAN_CHECK_CACHE_TTL_SECONDS", "1200"))
LEAN_CHECK_CACHE_MAX_ENTRIES = int(os.environ.get("LEAN_CHECK_CACHE_MAX_ENTRIES", "1024"))
COMPLETE_CACHE_TTL_SECONDS = int(os.environ.get("COMPLETE_CACHE_TTL_SECONDS", "120"))
COMPLETE_CACHE_MAX_ENTRIES = int(os.environ.get("COMPLETE_CACHE_MAX_ENTRIES", "512"))
COMPLETE_RETRIEVAL_TOP_K = int(os.environ.get("COMPLETE_RETRIEVAL_TOP_K", "5"))
INFERENCE_BACKEND = os.environ.get("INFERENCE_BACKEND", "transformers").strip().lower()
if INFERENCE_BACKEND not in {"transformers", "vllm"}:
    INFERENCE_BACKEND = "transformers"

SYSTEM_PROMPT = """Translate the math statement to a Lean 4 type. Reply with ONLY the type expression. Nothing else.

CORRECT output examples:
  1 + 1 = 2
  ∀ (n : Nat), n + 0 = n
  ∀ (a b : Int), a + b = b + a
  ∀ (x : Real), x ^ 2 ≥ 0

WRONG output — never do this:
  ### Step 1: ...
  Here is the Lean 4 formalization: ...
  ```lean4 ... ```
  theorem foo : ...
  axiom foo : ...
  def foo : ...

STRICT rules:
1) Your entire response is the Lean 4 type expression and nothing else.
2) No headings, no steps, no explanation, no markdown, no code fences.
3) No `theorem`, `lemma`, `axiom`, `def`, `import`, `namespace`, `#check`.
4) No proofs: no `by`, no `sorry`, no `:=`.
5) Use `Nat` not `ℕ`, `Int` not `ℤ`, `Rat` not `ℚ`, `Real` not `ℝ`.
6) Use explicit binders: `∀ (n : Nat), ...`
"""

COMPLETE_SYSTEM_PROMPT = """You are a math writing autocomplete model.
Task: produce short suffix completions for the user's current cursor position.
Return JSON only with key:
- candidates: list of 1-8 short suffix strings to append at the cursor.
Rules:
1) Output suffixes only; do not repeat the full prefix.
2) No declarations or Lean commands (`theorem`, `lemma`, `axiom`, `import`, `namespace`, `set_option`, `#check`).
3) No proofs (`by`, `sorry`).
4) Prefer concise continuations that keep mathematical meaning clear.
"""

REWRITE_SYSTEM_PROMPT = """You are an expert Lean 4 refiner.
You will be given:
- A current Lean statement type candidate
- Lean compiler diagnostics

Return JSON only with keys:
- revised_lean_statement_type: Lean proposition/type only (no theorem/lemma/axiom keywords)
- feedback: list of short natural-language suggestions about what changed
- reason: short explanation

Rules:
1) No markdown/code fences.
2) Keep semantics as close as possible to the original intent.
3) If diagnostics suggest missing types/binders, add explicit binders.
4) Do not include proofs (`by`, `sorry`) or declarations.
"""

FINAL_FEEDBACK_SYSTEM_PROMPT = """You are a Lean 4 tutoring assistant.
You will receive:
- Original natural-language input
- Final Lean check status and diagnostics
- Existing heuristic feedback
- Optional thinking-mode iteration history

Return JSON only with keys:
- final_feedback: list of 1-4 concise, actionable user-facing suggestions
- summary: one short sentence

Rules:
1) No markdown/code fences.
2) If final Lean is valid, focus on confirmation and optional improvement ideas.
3) If invalid, prioritize the highest-impact fixes grounded in diagnostics.
4) Do not invent imports or theorem names not implied by context.
"""

SEMANTIC_INTERPRETATION_SYSTEM_PROMPT = """You are a math semantics checker for NL->Lean translations.
You receive the natural-language statement and the Lean proposition that typechecked.
Return JSON only with keys:
- summary: short sentence
- items: list of 0-2 objects with keys:
  error, probable_cause, suggested_fix, source, latex_start, latex_end, latex_excerpt, replacement, confidence
- suggestions: list of short actionable strings

Rules:
1) If no high-confidence semantic issue is found, return items as [] and suggestions as [].
2) Only flag clear contradictions or over-strong quantifier claims (for example statements that are not true for all values).
2a) For universal (`for all` / `∀`) numeric claims, actively test simple counterexamples mentally (small and larger values) before returning items=[].
3) If you flag an issue, include latex_excerpt that appears verbatim in the original input.
4) `replacement` must be direct replacement text for latex_excerpt (not prose), when possible.
5) `source` should be one of: latex, lean, both, unknown.
6) Never output congratulatory/positive diagnostics (for example "correct statement", "valid statement"). Use items=[] for valid inputs.

Example problematic case:
input_text: "For all n ≥ 2, n + 2 = 2n."
items[0].error should indicate the universal equality is false.
items[0].latex_excerpt can be "n + 2 = 2n".
items[0].replacement can be a corrected mathematical claim text.

Another problematic case:
input_text: "For all n in Nat, n^2 ≤ n + 3."
This is false for large n (e.g. n=5). items should include that counterexample-style reason.

Example valid case:
input_text: "For all n ∈ N, n + 0 = n."
items should be [].
"""

LEAN_DECL_RE = re.compile(
    r"^(theorem|lemma|example|axiom)\s+([A-Za-z_][A-Za-z0-9_']*)?\s*:\s*(.*)$",
    re.IGNORECASE | re.DOTALL,
)
LEAN_DIAGNOSTIC_RE = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+): "
    r"(?P<severity>error|warning|info|information)(?:\([^)]+\))?: "
    r"(?P<message>.+)$"
)
LEAN_MISSING_OLEAN_MODULE_RE = re.compile(r"of module (?P<module>[A-Za-z0-9_.']+) does not exist")
LEAN_IMPORT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.']*$")
LEAN_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_']*$")
LEAN_UNKNOWN_IDENTIFIER_RE = re.compile(r"Unknown identifier `([^`]+)`", re.IGNORECASE)
LEAN_FORALL_UNTYPED_GROUP_RE = re.compile(
    r"(?:∀|forall)\s+([A-Za-z_][A-Za-z0-9_']*(?:\s+[A-Za-z_][A-Za-z0-9_']*)*)\s*,"
)
LEAN_TYPED_BINDER_RE = re.compile(r"(?:∀|forall)\s+([A-Za-z_][A-Za-z0-9_']*)\s*:")
LEAN_INCOMPLETE_LET_RE = re.compile(
    r"^\s*let\s+([A-Za-z_][A-Za-z0-9_']*)\s*:\s*(.+)\s*$",
    re.IGNORECASE | re.DOTALL,
)
# Herald-style incomplete def/theorem (header with no := body); we need a type for axiom _ : <type>.
# Lean 4 allows modifiers before def: noncomputable, unsafe, partial.
LEAN_INCOMPLETE_DEF_HEADER_RE = re.compile(
    r"^\s*(?:(?:noncomputable|unsafe|partial)\s+)?def\s+[A-Za-z_][A-Za-z0-9_']*((?:\s*\([^)]*\))*)\s*:\s*(.+)\s*$",
    re.IGNORECASE | re.DOTALL,
)
LEAN_INCOMPLETE_THEOREM_HEADER_RE = re.compile(
    r"^\s*(?:theorem|lemma)\s+[A-Za-z_][A-Za-z0-9_']*((?:\s*\([^)]*\))*)\s*:\s*(.+)\s*$",
    re.IGNORECASE | re.DOTALL,
)
LEAN_CANONICAL_REPLACEMENTS = (
    (r"\\mathbb\s*\{\s*N\s*\}", "Nat"),
    (r"\\mathbb\s*\{\s*Z\s*\}", "Int"),
    (r"\\mathbb\s*\{\s*Q\s*\}", "Rat"),
    (r"\\mathbb\s*\{\s*R\s*\}", "Real"),
    (r"\\mathbb\s*\{\s*C\s*\}", "Complex"),
    (r"\\mathbbN\b", "Nat"),
    (r"\\mathbbZ\b", "Int"),
    (r"\\mathbbQ\b", "Rat"),
    (r"\\mathbbR\b", "Real"),
    (r"\\mathbbC\b", "Complex"),
    (r"ℕ", "Nat"),
    (r"ℤ", "Int"),
    (r"ℚ", "Rat"),
    (r"ℝ", "Real"),
    (r"ℂ", "Complex"),
    (r"\$", ""),
)
LEAN_IDENTIFIER_FALLBACKS = (
    ("ℕ", "Nat"),
    ("ℤ", "Int"),
    ("ℚ", "Rat"),
    ("ℝ", "Real"),
    ("ℂ", "Complex"),
)
LEAN_RESERVED_STATEMENT_WORDS = {
    "theorem",
    "lemma",
    "example",
    "axiom",
    "def",
    "structure",
    "inductive",
}
MAX_STATEMENT_TYPE_CHARS = int(os.environ.get("MAX_STATEMENT_TYPE_CHARS", "800"))
LEAN_FORBIDDEN_STATEMENT_SNIPPETS = (
    "import ",
    "namespace ",
    "set_option ",
    "#check ",
    "open ",
)
LEAN_STATEMENT_JSONISH_RE = re.compile(
    r'"lean_statement_type"\s*:\s*"(?P<value>(?:\\.|[^"\\])*)"',
    re.DOTALL,
)

COMPLETE_FORBIDDEN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("lean_keyword_start", re.compile(r"^\s*(?:theorem|lemma|axiom|import|namespace|set_option|#check)\b", re.IGNORECASE)),
    ("lean_proof_start", re.compile(r"^\s*by\b", re.IGNORECASE)),
    ("sorry_token", re.compile(r"\bsorry\b", re.IGNORECASE)),
)
COMPLETE_TEXT_CLEANUP_RE = re.compile(r"^[\s:;,.-]+")
COMPLETE_CANDIDATES_ARRAY_RE = re.compile(
    r"(?:\"?candidates\"?\s*:\s*)?\[(?P<body>[^\]]+)\]",
    re.IGNORECASE | re.DOTALL,
)
COMPLETE_CANDIDATE_QUOTED_RE = re.compile(r'"(?P<item>(?:\\.|[^"\\])*)"')
COMPLETE_TRUNCATED_FIRST_CANDIDATE_RE = re.compile(
    r"candidates\"?\s*:\s*\[\s*\"(?P<item>[^\n\r\]\"]{1,220})",
    re.IGNORECASE,
)
COMPLETE_RETRIEVAL_CORPUS = (
    " therefore,",
    " hence,",
    " this implies that",
    " it follows that",
    " we obtain",
    " by definition,",
    " by contradiction,",
    " by induction on n,",
    " assume for contradiction that",
    " for every n in Nat,",
    " for all real numbers x,",
    " let epsilon be positive.",
    " in a right triangle,",
    " the Pythagorean identity gives",
    " so we can rewrite the expression as",
    " the inequality holds because",
    " applying the hypothesis yields",
    " combining both sides gives",
    " we conclude that",
    " as required.",
)

app = modal.App(APP_NAME)

api_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi>=0.115.0",
    "pydantic>=2.8.0",
)

inference_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "git")
    .pip_install(
        "fastapi>=0.115.0",
        "torch>=2.3.0",
        "transformers>=4.48.0",
        "accelerate>=1.0.0",
        "safetensors>=0.4.5",
        "huggingface_hub[hf_transfer]>=0.30.0",
        "vllm>=0.5.5",
    )
    .run_commands(
        "curl -sSf https://elan.lean-lang.org/elan-init.sh | sh -s -- -y --default-toolchain stable",
        "/root/.elan/bin/elan --version",
        "/root/.elan/bin/lean --version",
        "/root/.elan/bin/lake --version",
    )
    .env(
        {
            "HF_HOME": str(HF_CACHE_DIR),
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "HF_XET_HIGH_PERFORMANCE": "1",
            "PATH": "/root/.elan/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        }
    )
)

hf_cache = modal.Volume.from_name("herald-hf-model-cache", create_if_missing=True)


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return default


VLLM_GPU_MEMORY_UTILIZATION = _env_float("VLLM_GPU_MEMORY_UTILIZATION", 0.9)
VLLM_MAX_MODEL_LEN = _env_int("VLLM_MAX_MODEL_LEN", 8192)
VLLM_MAX_NUM_SEQS = _env_int("VLLM_MAX_NUM_SEQS", 8)
VLLM_ENFORCE_EAGER = _env_bool("VLLM_ENFORCE_EAGER", False)
ENABLE_FINAL_FEEDBACK_LLM = _env_bool("ENABLE_FINAL_FEEDBACK_LLM", True)
FINAL_FEEDBACK_MAX_NEW_TOKENS = _env_int("FINAL_FEEDBACK_MAX_NEW_TOKENS", 224)
ENABLE_SEMANTIC_INTERPRETATION_LLM = _env_bool("ENABLE_SEMANTIC_INTERPRETATION_LLM", True)
SEMANTIC_INTERPRETATION_MAX_NEW_TOKENS = _env_int("SEMANTIC_INTERPRETATION_MAX_NEW_TOKENS", 224)


def _resolve_secret(secret_name_env: str, secret_value_env: str) -> modal.Secret | None:
    secret_name = os.environ.get(secret_name_env)
    if secret_name:
        return modal.Secret.from_name(secret_name)
    secret_value = os.environ.get(secret_value_env)
    if secret_value:
        return modal.Secret.from_dict({secret_value_env: secret_value})
    return None


hf_secret = _resolve_secret("HF_SECRET_NAME", "HF_TOKEN")
api_secret = _resolve_secret("GRAMMAR_API_SECRET_NAME", "API_KEY")

gpu_function_kwargs: dict[str, Any] = {
    "image": inference_image,
    "gpu": "L4",
    "timeout": _env_int("GPU_FUNCTION_TIMEOUT_SECONDS", 900),
    "startup_timeout": 1800,
    "scaledown_window": 600,
    "volumes": {"/cache": hf_cache},
}
gpu_min_containers = _env_int("GPU_MIN_CONTAINERS", 1)
gpu_buffer_containers = _env_int("GPU_BUFFER_CONTAINERS", 0)
gpu_max_containers = _env_int("GPU_MAX_CONTAINERS", 1)
if gpu_min_containers > 0:
    gpu_function_kwargs["min_containers"] = gpu_min_containers
if gpu_buffer_containers > 0:
    gpu_function_kwargs["buffer_containers"] = gpu_buffer_containers
if gpu_max_containers > 0:
    gpu_function_kwargs["max_containers"] = gpu_max_containers
gpu_secrets = [secret for secret in [hf_secret] if secret is not None]
if gpu_secrets:
    gpu_function_kwargs["secrets"] = gpu_secrets

api_function_kwargs: dict[str, Any] = {
    "image": api_image,
    "timeout": 900,
}
api_min_containers = _env_int("API_MIN_CONTAINERS", 1)
api_max_containers = _env_int("API_MAX_CONTAINERS", 1)
if api_min_containers > 0:
    api_function_kwargs["min_containers"] = api_min_containers
if api_max_containers > 0:
    api_function_kwargs["max_containers"] = api_max_containers
api_secrets = [secret for secret in [api_secret] if secret is not None]
if api_secrets:
    api_function_kwargs["secrets"] = api_secrets

_runtime = None
_runtime_lock = Lock()
_mathlib_lock = Lock()
_cache_lock = Lock()
_analyze_cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_model_output_cache: OrderedDict[str, tuple[float, str]] = OrderedDict()
_lean_check_cache: OrderedDict[str, tuple[float, tuple[bool, list[dict[str, Any]], str]]] = OrderedDict()
_complete_cache: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_mathlib_runtime_probe_ok = False


@dataclass
class Runtime:
    backend: Literal["transformers", "vllm"]
    tokenizer: Any
    model: Any | None = None
    llm: Any | None = None


class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=1, description="Natural-language math statement.")
    context: str | None = Field(default=None, description="Optional nearby paragraph or document context.")
    theorem_name: str | None = Field(default=None)
    imports: list[str] = Field(default_factory=lambda: ["Std"])
    temperature: float = Field(default=0.0, ge=0.0, le=1.5)
    max_new_tokens: int = Field(default=128, ge=32, le=512)
    lean_timeout_seconds: int = Field(default=LEAN_CHECK_TIMEOUT_SECONDS, ge=2, le=60)
    skip_lean_check: bool = False
    include_raw_model_output: bool = False
    mode: Literal["fast", "thinking"] = Field(default="fast")
    max_iters: int = Field(default=3, ge=1, le=5)
    include_iteration_history: bool = False

    @field_validator("imports")
    @classmethod
    def _validate_imports(cls, value: list[str]) -> list[str]:
        sanitized: list[str] = []
        for item in value:
            candidate = item.strip()
            if LEAN_IMPORT_RE.fullmatch(candidate):
                sanitized.append(candidate)
        if not sanitized:
            sanitized = ["Std"]
        deduped = list(dict.fromkeys(sanitized))
        return deduped


class LeanDiagnostic(BaseModel):
    severity: Literal["error", "warning", "info"]
    line: int | None = None
    column: int | None = None
    message: str


class InterpretationItem(BaseModel):
    error: str
    probable_cause: str | None = None
    suggested_fix: str | None = None
    source: Literal["latex", "lean", "both", "unknown"] = "unknown"
    latex_start: int | None = None
    latex_end: int | None = None
    latex_excerpt: str | None = None
    lean_line: int | None = None
    lean_column: int | None = None
    replacement: str | None = None
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class Interpretation(BaseModel):
    summary: str
    items: list[InterpretationItem] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


class AnalyzeResponse(BaseModel):
    model: str
    status: Literal["ok", "needs_revision", "model_parse_error", "runtime_error", "unchecked"]
    input_text: str
    normalized_text: str
    assumptions: list[str] = Field(default_factory=list)
    notes: str = ""
    statement_type: str | None = None
    declaration_name: str | None = None
    imports_used: list[str] = Field(default_factory=list)
    lean_declaration: str | None = None
    lean_source: str | None = None
    diagnostics: list[LeanDiagnostic] = Field(default_factory=list)
    feedback: list[str] = Field(default_factory=list)
    is_valid_lean: bool = False
    cache_hit: bool = False
    model_output: str | None = None
    final_feedback: list[str] = Field(default_factory=list)
    interpretation: Interpretation | None = None
    latency_ms: int = 0
    mode: Literal["fast", "thinking"] = "fast"
    iteration_count: int = 1
    iteration_history: list[dict[str, Any]] | None = None


class CompleteRequest(BaseModel):
    text: str = Field(min_length=1, description="Current editor text.")
    cursor_offset: int | None = Field(default=None, ge=0)
    context: str | None = Field(default=None, description="Optional surrounding document context.")
    imports: list[str] = Field(default_factory=lambda: ["Std"])
    max_candidates: int = Field(default=3, ge=1, le=8)
    max_new_tokens: int = Field(default=36, ge=8, le=128)
    temperature: float = Field(default=0.35, ge=0.0, le=1.5)
    include_debug: bool = False
    system_prompt: str | None = Field(default=None, description="Optional custom system prompt for completion.")

    @field_validator("imports")
    @classmethod
    def _validate_imports(cls, value: list[str]) -> list[str]:
        sanitized: list[str] = []
        for item in value:
            candidate = item.strip()
            if LEAN_IMPORT_RE.fullmatch(candidate):
                sanitized.append(candidate)
        if not sanitized:
            sanitized = ["Std"]
        return list(dict.fromkeys(sanitized))

    @field_validator("cursor_offset")
    @classmethod
    def _validate_cursor_offset(cls, value: int | None, info):  # type: ignore[override]
        if value is None:
            return None
        text = info.data.get("text")
        if isinstance(text, str) and value > len(text):
            return len(text)
        return value

    @field_validator("context")
    @classmethod
    def _validate_context_str(cls, value: Any) -> str | None:
        """Ensure context is always str | None so .strip() and string ops never see a dict."""
        if value is None:
            return None
        if isinstance(value, str):
            return value
        return None


class CompletionCandidate(BaseModel):
    completion: str
    score: float
    model_score: float
    retrieval_score: float
    syntax_score: float
    rejected_reasons: list[str] = Field(default_factory=list)


class CompleteResponse(BaseModel):
    model: str
    status: Literal["ok", "no_suggestion", "runtime_error"]
    input_text: str
    prefix_text: str
    imports_used: list[str] = Field(default_factory=list)
    retrieved_hints: list[str] = Field(default_factory=list)
    selected_completion: str | None = None
    candidates: list[CompletionCandidate] = Field(default_factory=list)
    cache_hit: bool = False
    timings_ms: dict[str, int] = Field(default_factory=dict)
    latency_ms: int = 0
    debug: dict[str, Any] | None = None
    no_suggestion_reasons: list[str] = Field(default_factory=list)


def _normalize_input_text(text: str) -> str:
    normalized = text.strip()
    normalized = normalized.replace("\\(", "").replace("\\)", "")
    normalized = normalized.replace("\\[", "").replace("\\]", "")
    normalized = normalized.replace("\\left", "").replace("\\right", "")
    for pattern, replacement in LEAN_CANONICAL_REPLACEMENTS:
        normalized = re.sub(pattern, replacement, normalized)
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def _sanitize_declaration_name(name: str | None) -> str:
    if not name:
        return "candidate_statement"
    candidate = re.sub(r"[^A-Za-z0-9_']", "_", name.strip())
    if not candidate:
        candidate = "candidate_statement"
    if candidate[0].isdigit():
        candidate = f"s_{candidate}"
    return candidate


def _dedupe_imports(imports: list[str]) -> list[str]:
    return list(dict.fromkeys(imports))


def _canonical_imports(imports: list[str]) -> list[str]:
    return sorted(dict.fromkeys(imports))


def _cache_get(cache: OrderedDict[str, tuple[float, Any]], key: str, ttl_seconds: int) -> Any | None:
    if ttl_seconds <= 0:
        return None
    now = time.time()
    with _cache_lock:
        row = cache.get(key)
        if row is None:
            return None
        created_at, payload = row
        if (now - created_at) > ttl_seconds:
            cache.pop(key, None)
            return None
        cache.move_to_end(key)
        return deepcopy(payload)


def _cache_put(cache: OrderedDict[str, tuple[float, Any]], key: str, payload: Any, max_entries: int) -> None:
    if max_entries <= 0:
        return
    with _cache_lock:
        cache[key] = (time.time(), deepcopy(payload))
        cache.move_to_end(key)
        while len(cache) > max_entries:
            cache.popitem(last=False)


def _analyze_cache_key(request: AnalyzeRequest) -> str:
    normalized_text = _normalize_input_text(request.text)
    context = request.context.strip() if request.context else None
    if context == "":
        context = None
    return json.dumps(
        {
            "version": APP_VERSION,
            "normalized_text": normalized_text,
            "context": context,
            "theorem_name": request.theorem_name,
            "imports": _canonical_imports(request.imports),
            "temperature": request.temperature,
            "max_new_tokens": request.max_new_tokens,
            "lean_timeout_seconds": request.lean_timeout_seconds,
            "skip_lean_check": request.skip_lean_check,
            "include_raw_model_output": request.include_raw_model_output,
            "enable_final_feedback_llm": ENABLE_FINAL_FEEDBACK_LLM,
            "mode": request.mode,
            "max_iters": request.max_iters if request.mode == "thinking" else None,
            "include_iteration_history": (
                request.include_iteration_history if request.mode == "thinking" else None
            ),
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _model_output_cache_key(request: AnalyzeRequest, normalized_text: str) -> str:
    context = request.context.strip() if request.context else None
    if context == "":
        context = None
    return json.dumps(
        {
            "version": APP_VERSION,
            "normalized_text": normalized_text,
            "context": context,
            "imports": _canonical_imports(request.imports),
            "temperature": request.temperature,
            "max_new_tokens": request.max_new_tokens,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _lean_check_cache_key(statement_type: str, imports: list[str]) -> str:
    return json.dumps(
        {
            "version": APP_VERSION,
            "statement_type": statement_type,
            "imports": _canonical_imports(imports),
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _complete_cache_key(request: CompleteRequest) -> str:
    cursor = request.cursor_offset if request.cursor_offset is not None else len(request.text)
    prefix = request.text[: max(0, min(cursor, len(request.text)))]
    context = request.context.strip() if request.context else None
    if context == "":
        context = None
    return json.dumps(
        {
            "version": APP_VERSION,
            "prefix": prefix,
            "context": context,
            "imports": _canonical_imports(request.imports),
            "max_candidates": request.max_candidates,
            "max_new_tokens": request.max_new_tokens,
            "temperature": request.temperature,
            "include_debug": request.include_debug,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def _requires_mathlib(imports: list[str], statement_type: str | None) -> bool:
    if any(item == MATHLIB_IMPORT or item.startswith(f"{MATHLIB_IMPORT}.") for item in imports):
        return True
    if not statement_type:
        return False
    return any(token in statement_type for token, _ in MATHLIB_IDENTIFIER_TO_IMPORT)


def _auto_mathlib_imports(statement_type: str | None) -> list[str]:
    if not statement_type:
        return []
    imports: list[str] = []
    for token, module_import in MATHLIB_IDENTIFIER_TO_IMPORT:
        if token in statement_type:
            imports.append(module_import)
    return _dedupe_imports(imports)


def _resolve_effective_imports(imports: list[str], statement_type: str | None) -> tuple[list[str], bool]:
    effective = _dedupe_imports(imports)
    auto_enabled = False
    has_explicit_mathlib = any(item == MATHLIB_IMPORT or item.startswith(f"{MATHLIB_IMPORT}.") for item in effective)
    if not has_explicit_mathlib:
        inferred_imports = _auto_mathlib_imports(statement_type)
        if inferred_imports:
            effective = _dedupe_imports([*inferred_imports, *effective])
            auto_enabled = True
        elif _requires_mathlib(effective, statement_type):
            effective = [MATHLIB_IMPORT, *effective]
            auto_enabled = True
    return effective, auto_enabled


def _user_prompt(request: AnalyzeRequest, normalized_text: str) -> str:
    imports_text = ", ".join(_canonical_imports(request.imports))
    context_block = f"Context:\n{request.context.strip()}\n\n" if request.context and request.context.strip() else ""
    return (
        f"{context_block}"
        f"Lean imports available: {imports_text}\n"
        "Choose identifiers compatible with those imports.\n\n"
        "Natural-language statement:\n"
        f"{normalized_text}\n\n"
        "Return only a JSON object with `lean_statement_type`, `assumptions`, and `notes`."
    )


def _complete_prefix(request: CompleteRequest) -> str:
    cursor = request.cursor_offset if request.cursor_offset is not None else len(request.text)
    cursor = max(0, min(cursor, len(request.text)))
    return request.text[:cursor]


def _tokenize_for_retrieval(text: str) -> list[str]:
    lowered = text.lower()
    lowered = re.sub(r"[^a-z0-9_]+", " ", lowered)
    return [token for token in lowered.split() if token]


def _token_overlap_score(a_text: str, b_text: str) -> float:
    a_tokens = set(_tokenize_for_retrieval(a_text))
    b_tokens = set(_tokenize_for_retrieval(b_text))
    if not a_tokens or not b_tokens:
        return 0.0
    intersection = len(a_tokens & b_tokens)
    return intersection / max(1, len(a_tokens | b_tokens))


def _extract_context_completion_hints(prefix_text: str, context_text: str, top_k: int) -> list[str]:
    text = str(context_text or "").strip()
    if not text:
        return []

    clipped = text[-2400:]
    parts = re.split(r"(?:\n+|(?<=[.!?;:])\s+)", clipped)
    seen: set[str] = set()
    scored: list[tuple[float, str]] = []
    prefix_tail = prefix_text[-320:]
    for idx, part in enumerate(parts):
        candidate = " ".join(part.strip().split())
        if len(candidate) < 12 or len(candidate) > 220:
            continue
        if re.match(r"^(?:theorem|lemma|axiom|import|namespace|set_option|#check)\b", candidate, re.IGNORECASE):
            continue
        key = candidate.lower()
        if key in seen:
            continue
        seen.add(key)
        overlap = _token_overlap_score(prefix_tail, candidate)
        recency_bonus = idx / max(1, len(parts))
        score = (0.8 * overlap) + (0.2 * recency_bonus)
        scored.append((score, candidate))

    scored.sort(key=lambda item: item[0], reverse=True)
    hints = [candidate for score, candidate in scored if score > 0]
    return hints[: max(1, top_k)]


def _retrieve_completion_hints(prefix_text: str, context_text: str, top_k: int) -> list[str]:
    context_hints = _extract_context_completion_hints(prefix_text, context_text, top_k=max(1, top_k * 2))
    if len(context_hints) >= top_k:
        return context_hints[:top_k]

    ranked = sorted(
        (
            (_token_overlap_score(prefix_text, candidate), candidate)
            for candidate in COMPLETE_RETRIEVAL_CORPUS
        ),
        key=lambda item: item[0],
        reverse=True,
    )
    fallback_hints = [candidate for score, candidate in ranked if score > 0]
    if not fallback_hints:
        fallback_hints = list(COMPLETE_RETRIEVAL_CORPUS[: max(1, top_k)])

    merged: list[str] = []
    seen: set[str] = set()
    for candidate in [*context_hints, *fallback_hints]:
        key = candidate.lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(candidate)
        if len(merged) >= max(1, top_k):
            break
    return merged


def _complete_user_prompt(
    *,
    request: CompleteRequest,
    prefix_text: str,
    retrieval_hints: list[str],
) -> str:
    imports_text = ", ".join(_canonical_imports(request.imports))
    context_block = f"Context:\n{request.context.strip()}\n\n" if request.context and request.context.strip() else ""
    hints_block = "\n".join(f"- {item}" for item in retrieval_hints)
    return (
        f"{context_block}"
        f"Lean imports available: {imports_text}\n"
        "Top retrieval hints:\n"
        f"{hints_block}\n\n"
        "Current text prefix at cursor:\n"
        f"{prefix_text}\n\n"
        "Return JSON only: {\"candidates\": [\" ...\", \" ...\"]}"
    )


def _build_completion_prompt(
    tokenizer: Any,
    *,
    request: CompleteRequest,
    prefix_text: str,
    retrieval_hints: list[str],
) -> str:
    system_content = (
        request.system_prompt.strip() if request.system_prompt and request.system_prompt.strip()
        else COMPLETE_SYSTEM_PROMPT
    )
    user_prompt = _complete_user_prompt(
        request=request,
        prefix_text=prefix_text,
        retrieval_hints=retrieval_hints,
    )
    if getattr(tokenizer, "chat_template", None):
        return tokenizer.apply_chat_template(
            [
                {"role": "system", "content": system_content},
                {"role": "user", "content": user_prompt},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
    return f"{system_content}\n\n{user_prompt}\n\nLean 4 type:"


def _ensure_model_downloaded() -> Path:
    hf_cache.reload()
    if (MODEL_LOCAL_DIR / "config.json").exists():
        return MODEL_LOCAL_DIR

    from huggingface_hub import snapshot_download

    token = os.environ.get("HF_TOKEN")
    snapshot_download(
        repo_id=MODEL_ID,
        revision=MODEL_REVISION,
        local_dir=MODEL_LOCAL_DIR,
        token=token,
    )
    hf_cache.commit()
    return MODEL_LOCAL_DIR


def _build_generation_prompt(tokenizer: Any, request: AnalyzeRequest, normalized_text: str) -> str:
    if getattr(tokenizer, "chat_template", None):
        # DeepSeek-Prover-V2's chat template appends <think>\n when
        # add_generation_prompt=True, forcing chain-of-thought before the
        # model can act on SYSTEM_PROMPT.  Passing skip_thinking=True (supported
        # in transformers >= 4.51 for DeepSeek reasoning models) suppresses it.
        # If the installed transformers version doesn't support skip_thinking the
        # kwarg is silently ignored, so this is safe across versions.
        try:
            return tokenizer.apply_chat_template(
                [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": _user_prompt(request, normalized_text)},
                ],
                tokenize=False,
                add_generation_prompt=True,
                skip_thinking=True,
            )
        except TypeError:
            # Older transformers: fall back to manually closing the think block.
            base = tokenizer.apply_chat_template(
                [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": _user_prompt(request, normalized_text)},
                ],
                tokenize=False,
                add_generation_prompt=True,
            )
            # Replace the opening <think>\n injected by the template so the
            # model starts generating the Lean type directly.
            return base.replace("<think>\n", "<think>\n</think>\n")
    return f"{SYSTEM_PROMPT}\n\n{_user_prompt(request, normalized_text)}\n\nLean 4 type:"


def _load_runtime() -> Runtime:
    global _runtime
    if _runtime is not None:
        return _runtime

    with _runtime_lock:
        if _runtime is not None:
            return _runtime

        from transformers import AutoTokenizer

        model_dir = _ensure_model_downloaded()
        tokenizer = AutoTokenizer.from_pretrained(
            model_dir.as_posix(),
            token=os.environ.get("HF_TOKEN"),
            local_files_only=True,
        )
        if tokenizer.pad_token_id is None and tokenizer.eos_token_id is not None:
            tokenizer.pad_token = tokenizer.eos_token

        if INFERENCE_BACKEND == "vllm":
            try:
                from vllm import LLM
            except ModuleNotFoundError as exc:
                raise RuntimeError(
                    "INFERENCE_BACKEND=vllm but vLLM is unavailable in this image."
                ) from exc

            llm_kwargs: dict[str, Any] = {
                "model": model_dir.as_posix(),
                "tokenizer": model_dir.as_posix(),
                "tensor_parallel_size": 1,
                "dtype": "bfloat16",
                "trust_remote_code": True,
                "gpu_memory_utilization": max(0.5, min(0.98, VLLM_GPU_MEMORY_UTILIZATION)),
            }
            if VLLM_MAX_MODEL_LEN > 0:
                llm_kwargs["max_model_len"] = VLLM_MAX_MODEL_LEN
            if VLLM_MAX_NUM_SEQS > 0:
                llm_kwargs["max_num_seqs"] = VLLM_MAX_NUM_SEQS
            if VLLM_ENFORCE_EAGER:
                llm_kwargs["enforce_eager"] = True

            llm = LLM(**llm_kwargs)
            _runtime = Runtime(backend="vllm", tokenizer=tokenizer, llm=llm)
            return _runtime

        import torch
        from transformers import AutoModelForCausalLM

        if torch.cuda.is_available():
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

        model = AutoModelForCausalLM.from_pretrained(
            model_dir.as_posix(),
            token=os.environ.get("HF_TOKEN"),
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
            device_map="auto",
            local_files_only=True,
        )
        model.eval()

        if model.generation_config is not None:
            model.generation_config.use_cache = True
            if tokenizer.eos_token_id is not None:
                model.generation_config.eos_token_id = tokenizer.eos_token_id
            if tokenizer.pad_token_id is not None:
                model.generation_config.pad_token_id = tokenizer.pad_token_id

        _runtime = Runtime(backend="transformers", tokenizer=tokenizer, model=model)
        return _runtime


def _generate_with_transformers(runtime: Runtime, prompt: str, request: AnalyzeRequest) -> str:
    import torch

    tokenizer = runtime.tokenizer
    model = runtime.model
    if model is None:
        raise RuntimeError("Transformers backend selected but model is unavailable.")

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    do_sample = request.temperature > 0
    kwargs: dict[str, Any] = {
        **inputs,
        "max_new_tokens": request.max_new_tokens,
        "do_sample": do_sample,
        "use_cache": True,
        "pad_token_id": tokenizer.pad_token_id,
    }
    if tokenizer.eos_token_id is not None:
        kwargs["eos_token_id"] = tokenizer.eos_token_id
    if do_sample:
        kwargs["temperature"] = request.temperature
        kwargs["top_p"] = 0.95

    with torch.inference_mode():
        outputs = model.generate(**kwargs)

    input_tokens = inputs["input_ids"].shape[1]
    generated = outputs[0][input_tokens:]
    return tokenizer.decode(generated, skip_special_tokens=True).strip()


def _generate_with_vllm(runtime: Runtime, prompt: str, request: AnalyzeRequest) -> str:
    llm = runtime.llm
    if llm is None:
        raise RuntimeError("vLLM backend selected but LLM runtime is unavailable.")

    try:
        from vllm import SamplingParams
    except ModuleNotFoundError as exc:
        raise RuntimeError("INFERENCE_BACKEND=vllm but vLLM is unavailable in this image.") from exc

    do_sample = request.temperature > 0
    sampling_kwargs: dict[str, Any] = {
        "max_tokens": request.max_new_tokens,
        "temperature": request.temperature if do_sample else 0.0,
        "top_p": 0.95 if do_sample else 1.0,
    }
    eos_token_id = getattr(runtime.tokenizer, "eos_token_id", None)
    if isinstance(eos_token_id, int):
        sampling_kwargs["stop_token_ids"] = [eos_token_id]
    sampling_params = SamplingParams(**sampling_kwargs)

    outputs = llm.generate([prompt], sampling_params=sampling_params, use_tqdm=False)
    if not outputs:
        return ""
    first_output = outputs[0]
    candidates = getattr(first_output, "outputs", None)
    if not candidates:
        return ""
    text = getattr(candidates[0], "text", "")
    return str(text).strip()


def _generate_model_output(request: AnalyzeRequest, normalized_text: str) -> str:
    model_key = _model_output_cache_key(request, normalized_text)
    cached_output = _cache_get(_model_output_cache, model_key, MODEL_OUTPUT_CACHE_TTL_SECONDS)
    if isinstance(cached_output, str):
        return cached_output

    runtime = _load_runtime()
    prompt = _build_generation_prompt(runtime.tokenizer, request, normalized_text)

    if runtime.backend == "vllm":
        text = _generate_with_vllm(runtime, prompt, request)
    else:
        text = _generate_with_transformers(runtime, prompt, request)

    _cache_put(_model_output_cache, model_key, text, MODEL_OUTPUT_CACHE_MAX_ENTRIES)
    return text


def _generate_completion_outputs(
    request: CompleteRequest,
    *,
    prefix_text: str,
    retrieval_hints: list[str],
) -> list[str]:
    runtime = _load_runtime()
    tokenizer = runtime.tokenizer
    prompt = _build_completion_prompt(
        tokenizer,
        request=request,
        prefix_text=prefix_text,
        retrieval_hints=retrieval_hints,
    )
    num_return_sequences = max(1, min(3, request.max_candidates))
    effective_max_new_tokens = max(8, min(request.max_new_tokens, 40))

    if runtime.backend == "vllm":
        llm = runtime.llm
        if llm is None:
            raise RuntimeError("vLLM backend selected but LLM runtime is unavailable.")
        try:
            from vllm import SamplingParams
        except ModuleNotFoundError as exc:
            raise RuntimeError("INFERENCE_BACKEND=vllm but vLLM is unavailable in this image.") from exc

        do_sample = request.temperature > 0
        if not do_sample:
            num_return_sequences = 1
        sampling_kwargs: dict[str, Any] = {
            "n": num_return_sequences,
            "max_tokens": effective_max_new_tokens,
            "temperature": request.temperature if do_sample else 0.0,
            "top_p": 0.95 if do_sample else 1.0,
        }
        eos_token_id = getattr(tokenizer, "eos_token_id", None)
        if isinstance(eos_token_id, int):
            sampling_kwargs["stop_token_ids"] = [eos_token_id]

        outputs = llm.generate([prompt], sampling_params=SamplingParams(**sampling_kwargs), use_tqdm=False)
        if not outputs:
            return []
        first_output = outputs[0]
        candidates = getattr(first_output, "outputs", None) or []
        return [str(getattr(item, "text", "")).strip() for item in candidates if str(getattr(item, "text", "")).strip()]

    import torch

    model = runtime.model
    if model is None:
        raise RuntimeError("Transformers backend selected but model is unavailable.")
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    do_sample = request.temperature > 0
    if not do_sample:
        num_return_sequences = 1
    kwargs: dict[str, Any] = {
        **inputs,
        "max_new_tokens": effective_max_new_tokens,
        "do_sample": do_sample,
        "use_cache": True,
        "pad_token_id": tokenizer.pad_token_id,
        "num_return_sequences": num_return_sequences,
    }
    if tokenizer.eos_token_id is not None:
        kwargs["eos_token_id"] = tokenizer.eos_token_id
    if do_sample:
        kwargs["temperature"] = request.temperature
        kwargs["top_p"] = 0.95

    with torch.inference_mode():
        outputs = model.generate(**kwargs)

    input_tokens = inputs["input_ids"].shape[1]
    decoded: list[str] = []
    for row in outputs:
        generated = row[input_tokens:]
        text = tokenizer.decode(generated, skip_special_tokens=True).strip()
        if text:
            decoded.append(text)
    return decoded


def _extract_completion_candidates_from_output(raw_output: str) -> list[str]:
    payload = _extract_json(raw_output)
    if payload is not None:
        candidates_payload = payload.get("candidates")
        if isinstance(candidates_payload, list):
            return [str(item) for item in candidates_payload if str(item).strip()]
        single = payload.get("completion")
        if isinstance(single, str) and single.strip():
            return [single.strip()]

    array_matches = COMPLETE_CANDIDATES_ARRAY_RE.finditer(raw_output)
    extracted_from_arrays: list[str] = []
    for match in array_matches:
        body = str(match.group("body") or "")
        wrapped = f"[{body}]"
        parsed_items: list[str] = []
        try:
            parsed = json.loads(wrapped)
            if isinstance(parsed, list):
                parsed_items = [str(item) for item in parsed if str(item).strip()]
        except Exception:  # noqa: BLE001
            parsed_items = []

        if not parsed_items:
            parsed_items = [
                bytes(item, "utf-8").decode("unicode_escape")
                for item in COMPLETE_CANDIDATE_QUOTED_RE.findall(body)
                if item.strip()
            ]
        extracted_from_arrays.extend(parsed_items)

    if extracted_from_arrays:
        return extracted_from_arrays[:8]

    if "candidates" in raw_output.lower():
        partial_items = []
        for item in COMPLETE_CANDIDATE_QUOTED_RE.findall(raw_output):
            if not item.strip():
                continue
            decoded = bytes(item, "utf-8").decode("unicode_escape")
            if decoded.strip().lower() == "candidates":
                continue
            partial_items.append(decoded)
        if partial_items:
            return partial_items[:8]
        truncated_match = COMPLETE_TRUNCATED_FIRST_CANDIDATE_RE.search(raw_output)
        if truncated_match:
            item = str(truncated_match.group("item") or "").strip()
            if item:
                return [item]

    lines: list[str] = []
    for raw_line in raw_output.splitlines():
        candidate = raw_line.strip()
        if not candidate:
            continue
        candidate = re.sub(r"^[-*0-9.\)\s]+", "", candidate).strip()
        if candidate:
            lines.append(candidate)
    return lines[:8]


def _normalize_completion_suffix(prefix_text: str, candidate: str) -> tuple[str | None, list[str]]:
    reasons: list[str] = []
    cleaned = _strip_code_fences(candidate).replace("\r", "").strip().strip('"').strip("'")
    if not cleaned:
        return None, ["empty_candidate"]

    if cleaned.startswith(prefix_text):
        cleaned = cleaned[len(prefix_text) :].strip()
    cleaned = COMPLETE_TEXT_CLEANUP_RE.sub("", cleaned)
    cleaned = cleaned.strip()
    if not cleaned:
        return None, ["empty_after_prefix_strip"]

    lowered = cleaned.lower()
    for label, pattern in COMPLETE_FORBIDDEN_PATTERNS:
        if pattern.search(cleaned):
            reasons.append(f"forbidden_pattern:{label}")

    if '"lean_statement_type"' in lowered or cleaned.startswith("{") or cleaned.endswith("}"):
        reasons.append("json_like_candidate")
    if re.search(r"\bcandidates?\b", lowered) or cleaned.startswith("[") or cleaned.endswith("]"):
        reasons.append("schema_fragment")
    if len(cleaned) > 220:
        reasons.append("too_long")
    if cleaned.count("\n") > 1:
        reasons.append("too_many_newlines")

    if reasons:
        return None, reasons

    if cleaned[:1].isalnum():
        cleaned = " " + cleaned
    return cleaned, []


def _completion_syntax_score(candidate: str) -> float:
    pairs = {")": "(",
        "]": "[",
        "}": "{",
    }
    openers = set(pairs.values())
    stack: list[str] = []
    for char in candidate:
        if char in openers:
            stack.append(char)
            continue
        if char in pairs:
            if not stack or stack[-1] != pairs[char]:
                return 0.0
            stack.pop()
    if stack:
        return 0.4
    return 1.0


def _rank_completion_candidates(
    *,
    prefix_text: str,
    retrieval_hints: list[str],
    raw_outputs: list[str],
    max_candidates: int,
) -> tuple[list[CompletionCandidate], list[dict[str, Any]]]:
    ranked: list[CompletionCandidate] = []
    rejected: list[dict[str, Any]] = []
    seen: set[str] = set()
    prefix_tail = prefix_text[-320:]
    prefix_tokens = set(_tokenize_for_retrieval(prefix_tail))
    in_inline_math = prefix_text.count("$") % 2 == 1
    math_fragment_tokens = set()
    if in_inline_math:
        math_fragment_tokens = set(_tokenize_for_retrieval(prefix_text.rsplit("$", 1)[-1]))

    raw_candidates: list[str] = []
    for output in raw_outputs:
        raw_candidates.extend(_extract_completion_candidates_from_output(output))

    for idx, raw_candidate in enumerate(raw_candidates):
        suffix, reasons = _normalize_completion_suffix(prefix_text, raw_candidate)
        if suffix is None:
            rejected.append({"candidate": raw_candidate, "reasons": reasons})
            continue
        if suffix in seen:
            continue
        seen.add(suffix)
        candidate_tokens = set(_tokenize_for_retrieval(suffix))
        candidate_token_count = len(candidate_tokens)
        if candidate_token_count >= 2 and candidate_tokens and candidate_tokens.issubset(prefix_tokens):
            rejected.append({"candidate": raw_candidate, "reasons": ["redundant_with_prefix"]})
            continue

        model_score = max(0.0, 1.0 - (idx * 0.08))
        retrieval_score = 0.0
        if retrieval_hints:
            retrieval_score = max(_token_overlap_score(suffix, hint) for hint in retrieval_hints)
        context_score = _token_overlap_score(suffix, prefix_tail)
        if candidate_token_count >= 2 and prefix_tokens and not (candidate_tokens & prefix_tokens):
            rejected.append({"candidate": raw_candidate, "reasons": ["low_relevance_to_prefix"]})
            continue
        if in_inline_math and candidate_token_count >= 2 and math_fragment_tokens:
            if not (candidate_tokens & math_fragment_tokens):
                rejected.append({"candidate": raw_candidate, "reasons": ["math_context_mismatch"]})
                continue
        syntax_score = _completion_syntax_score(suffix)
        total_score = (
            (0.45 * model_score)
            + (0.20 * retrieval_score)
            + (0.20 * context_score)
            + (0.15 * syntax_score)
        )
        ranked.append(
            CompletionCandidate(
                completion=suffix,
                score=round(total_score, 4),
                model_score=round(model_score, 4),
                retrieval_score=round(retrieval_score, 4),
                syntax_score=round(syntax_score, 4),
            )
        )

    ranked.sort(key=lambda item: item.score, reverse=True)
    return ranked[:max_candidates], rejected


def _generate_rewrite_output(statement_type: str, diagnostics: list["LeanDiagnostic"]) -> str | None:
    import torch

    if not diagnostics:
        return None

    diagnostic_lines = [
        f"- line={diag.line} col={diag.column} severity={diag.severity}: {diag.message}"
        for diag in diagnostics
        if diag.severity == "error"
    ]
    if not diagnostic_lines:
        diagnostic_lines = [f"- {diag.message}" for diag in diagnostics]

    user_prompt = (
        "Current Lean statement type candidate:\n"
        f"{statement_type}\n\n"
        "Compiler diagnostics:\n"
        f"{chr(10).join(diagnostic_lines)}\n\n"
        "Return only JSON with revised_lean_statement_type, feedback, and reason."
    )

    runtime = _load_runtime()
    tokenizer = runtime.tokenizer
    model = runtime.model

    if getattr(tokenizer, "chat_template", None):
        prompt = tokenizer.apply_chat_template(
            [
                {"role": "system", "content": REWRITE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt = f"{REWRITE_SYSTEM_PROMPT}\n\n{user_prompt}\n\nJSON:"

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    kwargs: dict[str, Any] = {
        **inputs,
        "max_new_tokens": 192,
        "do_sample": False,
        "use_cache": True,
        "pad_token_id": tokenizer.pad_token_id,
    }
    if tokenizer.eos_token_id is not None:
        kwargs["eos_token_id"] = tokenizer.eos_token_id

    with torch.inference_mode():
        outputs = model.generate(**kwargs)

    input_tokens = inputs["input_ids"].shape[1]
    generated = outputs[0][input_tokens:]
    return tokenizer.decode(generated, skip_special_tokens=True).strip()


def _extract_json(text: str) -> dict[str, Any] | None:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    fragment = text[start : end + 1]
    try:
        parsed = json.loads(fragment)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _shorten_for_prompt(text: str, max_chars: int = 280) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= max_chars:
        return compact
    return compact[: max_chars - 3].rstrip() + "..."


def _generate_final_feedback_output(request: AnalyzeRequest, response: AnalyzeResponse) -> str | None:
    import torch

    diagnostics_payload = [
        {
            "severity": diag.severity,
            "line": diag.line,
            "column": diag.column,
            "message": _shorten_for_prompt(diag.message, 320),
        }
        for diag in response.diagnostics
    ]
    prompt_payload = {
        "input_text": _shorten_for_prompt(request.text, 600),
        "mode": response.mode,
        "status": response.status,
        "is_valid_lean": response.is_valid_lean,
        "statement_type": _shorten_for_prompt(response.statement_type or "", 320),
        "notes": _shorten_for_prompt(response.notes, 320),
        "diagnostics": diagnostics_payload,
        "iteration_count": response.iteration_count,
        "iteration_history": response.iteration_history or [],
        "existing_feedback": response.feedback,
    }
    user_prompt = (
        "Validation outcome payload:\n"
        f"{json.dumps(prompt_payload, ensure_ascii=False)}\n\n"
        "Return only JSON with final_feedback and summary."
    )

    runtime = _load_runtime()
    tokenizer = runtime.tokenizer
    model = runtime.model

    if getattr(tokenizer, "chat_template", None):
        prompt = tokenizer.apply_chat_template(
            [
                {"role": "system", "content": FINAL_FEEDBACK_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt = f"{FINAL_FEEDBACK_SYSTEM_PROMPT}\n\n{user_prompt}\n\nJSON:"

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    kwargs: dict[str, Any] = {
        **inputs,
        "max_new_tokens": FINAL_FEEDBACK_MAX_NEW_TOKENS,
        "do_sample": False,
        "use_cache": True,
        "pad_token_id": tokenizer.pad_token_id,
    }
    if tokenizer.eos_token_id is not None:
        kwargs["eos_token_id"] = tokenizer.eos_token_id

    with torch.inference_mode():
        outputs = model.generate(**kwargs)

    input_tokens = inputs["input_ids"].shape[1]
    generated = outputs[0][input_tokens:]
    return tokenizer.decode(generated, skip_special_tokens=True).strip()


def _summarize_final_feedback_with_llm(
    request: AnalyzeRequest,
    response: AnalyzeResponse,
) -> list[str]:
    if not ENABLE_FINAL_FEEDBACK_LLM:
        return []

    raw_output = _generate_final_feedback_output(request, response)
    if not raw_output:
        return []

    payload = _extract_json(raw_output)
    if payload is None:
        return []

    feedback_items: list[str] = []
    raw_feedback = payload.get("final_feedback")
    if isinstance(raw_feedback, list):
        feedback_items.extend(str(item).strip() for item in raw_feedback if str(item).strip())
    elif isinstance(raw_feedback, str) and raw_feedback.strip():
        feedback_items.append(raw_feedback.strip())

    fallback_feedback = payload.get("feedback")
    if isinstance(fallback_feedback, list):
        feedback_items.extend(str(item).strip() for item in fallback_feedback if str(item).strip())

    summary = str(payload.get("summary") or "").strip()
    if summary:
        feedback_items.append(summary)

    deduped = list(dict.fromkeys(item for item in feedback_items if item))
    return deduped[:4]


def _generate_semantic_interpretation_output(response: AnalyzeResponse) -> str | None:
    if not ENABLE_SEMANTIC_INTERPRETATION_LLM:
        return None
    if not response.is_valid_lean:
        return None

    payload = {
        "input_text": _shorten_for_prompt(response.input_text, 1200),
        "normalized_text": _shorten_for_prompt(response.normalized_text, 1200),
        "statement_type": _shorten_for_prompt(response.statement_type or "", 800),
        "feedback": response.feedback,
        "final_feedback": response.final_feedback,
    }
    user_prompt = (
        "Typechecked translation payload:\n"
        f"{json.dumps(payload, ensure_ascii=False)}\n\n"
        "Return only JSON with summary, items, and suggestions."
    )

    runtime = _load_runtime()
    tokenizer = runtime.tokenizer

    if getattr(tokenizer, "chat_template", None):
        prompt = tokenizer.apply_chat_template(
            [
                {"role": "system", "content": SEMANTIC_INTERPRETATION_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt = f"{SEMANTIC_INTERPRETATION_SYSTEM_PROMPT}\n\n{user_prompt}\n\nJSON:"
    if runtime.backend == "vllm":
        llm = runtime.llm
        if llm is None:
            return None
        try:
            from vllm import SamplingParams
        except ModuleNotFoundError:
            return None

        sampling_kwargs: dict[str, Any] = {
            "max_tokens": SEMANTIC_INTERPRETATION_MAX_NEW_TOKENS,
            "temperature": 0.0,
            "top_p": 1.0,
        }
        eos_token_id = getattr(tokenizer, "eos_token_id", None)
        if isinstance(eos_token_id, int):
            sampling_kwargs["stop_token_ids"] = [eos_token_id]
        outputs = llm.generate(
            [prompt],
            sampling_params=SamplingParams(**sampling_kwargs),
            use_tqdm=False,
        )
        if not outputs:
            return None
        candidates = getattr(outputs[0], "outputs", None) or []
        if not candidates:
            return None
        return str(getattr(candidates[0], "text", "")).strip()

    import torch

    model = runtime.model
    if model is None:
        return None
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    kwargs: dict[str, Any] = {
        **inputs,
        "max_new_tokens": SEMANTIC_INTERPRETATION_MAX_NEW_TOKENS,
        "do_sample": False,
        "use_cache": True,
        "pad_token_id": tokenizer.pad_token_id,
    }
    if tokenizer.eos_token_id is not None:
        kwargs["eos_token_id"] = tokenizer.eos_token_id

    with torch.inference_mode():
        outputs = model.generate(**kwargs)

    input_tokens = inputs["input_ids"].shape[1]
    generated = outputs[0][input_tokens:]
    return tokenizer.decode(generated, skip_special_tokens=True).strip()


def _interpret_semantic_items_with_llm(response: AnalyzeResponse) -> Interpretation | None:
    if not ENABLE_SEMANTIC_INTERPRETATION_LLM:
        return None
    if not response.is_valid_lean:
        return None
    if not response.statement_type:
        return None

    raw_output = _generate_semantic_interpretation_output(response)
    if not raw_output:
        return None

    payload = _extract_json(raw_output)
    if payload is None:
        return None

    source_text = response.input_text or response.normalized_text or ""
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raw_items = []

    negative_markers = (
        "false",
        "not true",
        "cannot hold",
        "inconsistent",
        "contradiction",
        "wrong",
        "invalid",
        "fails for",
        "counterexample",
        "too strong",
    )
    positive_markers = (
        "correct statement",
        "valid statement",
        "accurately represents",
        "well-formed",
        "looks good",
    )

    items: list[InterpretationItem] = []
    for raw_item in raw_items[:2]:
        if not isinstance(raw_item, dict):
            continue

        error = str(raw_item.get("error") or raw_item.get("message") or "").strip()
        probable_cause = str(raw_item.get("probable_cause") or raw_item.get("cause") or "").strip() or None
        suggested_fix = str(
            raw_item.get("suggested_fix")
            or raw_item.get("fix")
            or raw_item.get("edit_hint")
            or ""
        ).strip() or None
        replacement = str(
            raw_item.get("replacement")
            or raw_item.get("replace_with")
            or ""
        ).strip() or None
        excerpt = str(
            raw_item.get("latex_excerpt")
            or raw_item.get("excerpt")
            or raw_item.get("target_text")
            or ""
        ).strip() or None

        start_raw = raw_item.get("latex_start")
        end_raw = raw_item.get("latex_end")
        start = int(start_raw) if isinstance(start_raw, int) else None
        end = int(end_raw) if isinstance(end_raw, int) else None
        if (start is None or end is None) and excerpt and source_text:
            idx = source_text.find(excerpt)
            if idx != -1:
                start = idx
                end = idx + len(excerpt)
        if start is not None and end is not None:
            if start < 0 or end <= start or end > len(source_text):
                start = None
                end = None

        if not error:
            error = suggested_fix or "Potential semantic inconsistency."
        if not error:
            continue

        combined = " ".join(
            part for part in [error, probable_cause or "", suggested_fix or ""] if part
        ).lower()
        if any(marker in combined for marker in positive_markers):
            continue
        if not any(marker in combined for marker in negative_markers):
            continue

        source = str(raw_item.get("source") or "latex").strip().lower()
        if source not in {"latex", "lean", "both", "unknown"}:
            source = "latex"

        confidence_raw = raw_item.get("confidence")
        confidence = float(confidence_raw) if isinstance(confidence_raw, (int, float)) else None
        if confidence is not None:
            confidence = max(0.0, min(1.0, confidence))

        if replacement:
            replacement_lower = replacement.lower()
            if any(marker in replacement_lower for marker in positive_markers):
                replacement = None
            elif len(replacement.split()) > 18 and not re.search(r"[=<>≤≥∈+\-*/^]", replacement):
                replacement = None

        items.append(
            InterpretationItem(
                error=error,
                probable_cause=probable_cause,
                suggested_fix=suggested_fix,
                source=source,  # type: ignore[arg-type]
                latex_start=start,
                latex_end=end,
                latex_excerpt=excerpt,
                replacement=replacement,
                confidence=confidence,
            )
        )

    if not items:
        return None

    suggestions: list[str] = []
    raw_suggestions = payload.get("suggestions")
    if isinstance(raw_suggestions, list):
        suggestions.extend(str(item).strip() for item in raw_suggestions if str(item).strip())
    summary = str(payload.get("summary") or "").strip()
    if summary:
        suggestions.append(summary)
    for item in items:
        if item.suggested_fix:
            suggestions.append(item.suggested_fix)
    suggestions = list(dict.fromkeys(item for item in suggestions if item))[:4]
    summary_text = summary or (suggestions[0] if suggestions else "Potential semantic issue.")

    return Interpretation(
        summary=summary_text,
        items=items,
        suggestions=suggestions,
    )


def _apply_final_feedback_summary(request: AnalyzeRequest, response: AnalyzeResponse) -> AnalyzeResponse:
    if request.skip_lean_check or response.status == "runtime_error":
        return response

    try:
        final_feedback = _summarize_final_feedback_with_llm(request, response)
    except Exception:  # noqa: BLE001
        return response

    if not final_feedback:
        return response

    response.final_feedback = final_feedback
    for item in final_feedback:
        tagged = f"LLM final feedback: {item}"
        if tagged not in response.feedback:
            response.feedback.append(tagged)
    return response


def _attach_interpretation(response: AnalyzeResponse) -> AnalyzeResponse:
    if response.status in {"runtime_error", "unchecked"}:
        return response

    has_compile_error = (not response.is_valid_lean) or any(
        diag.severity == "error" for diag in response.diagnostics
    )
    if not has_compile_error:
        try:
            semantic_interpretation = _interpret_semantic_items_with_llm(response)
        except Exception:  # noqa: BLE001
            semantic_interpretation = None
        if semantic_interpretation and semantic_interpretation.items:
            response.interpretation = semantic_interpretation
            for item in semantic_interpretation.suggestions:
                if item and item not in response.feedback:
                    response.feedback.append(item)
        elif response.interpretation is not None and not response.interpretation.items:
            response.interpretation = None
        return response

    suggestions = [item for item in response.final_feedback if item.strip()]
    if not suggestions:
        suggestions = [
            item
            for item in response.feedback
            if item.strip()
            and not item.startswith("Generated a Lean statement type candidate")
            and not item.startswith("Model assumptions:")
            and not item.startswith("Model notes:")
        ]
    if not suggestions:
        first_error = next(
            (diag.message for diag in response.diagnostics if diag.severity == "error" and diag.message.strip()),
            "",
        )
        if first_error:
            suggestions = [first_error]
    suggestions = list(dict.fromkeys(suggestions))[:4]

    summary = suggestions[0] if suggestions else "Lean compilation failed."
    default_fix = suggestions[0] if suggestions else None

    error_diagnostics = [diag for diag in response.diagnostics if diag.severity == "error"]
    fallback_diagnostics = error_diagnostics or response.diagnostics
    items = [
        InterpretationItem(
            error=diag.message,
            suggested_fix=default_fix,
            source="lean",
            lean_line=diag.line,
            lean_column=diag.column,
            confidence=0.55 if default_fix else None,
        )
        for diag in fallback_diagnostics
    ]

    response.interpretation = Interpretation(
        summary=summary,
        items=items,
        suggestions=suggestions,
    )
    return response


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
        stripped = stripped.removesuffix("```").strip()
    return stripped


def _normalize_statement_type(candidate: str) -> str:
    value = _strip_code_fences(candidate)

    # Strip markdown headers anywhere in the string (e.g. "### Lean4 Formalization\n").
    # DeepSeek-Prover-V2 sometimes prefixes output with one or more heading lines.
    value = re.sub(r"^#{1,6}\s+[^\n]*\n?", "", value, flags=re.MULTILINE).strip()

    # Re-run _strip_code_fences after removing headers, because a code fence
    # that was preceded by a header (and therefore not at position 0) is now
    # at the start of the string.
    value = _strip_code_fences(value)

    value = re.sub(r"^lean_statement_type\s*:\s*", "", value, flags=re.IGNORECASE).strip()
    for pattern, replacement in LEAN_CANONICAL_REPLACEMENTS:
        value = re.sub(pattern, replacement, value)

    decl_match = LEAN_DECL_RE.match(value)
    if decl_match:
        value = decl_match.group(3).strip()

    for marker in [" := by", ":= by", " := ", ":=", "\nby", " where"]:
        if marker in value:
            value = value.split(marker, 1)[0].strip()

    if ":=" not in value:
        def_match = LEAN_INCOMPLETE_DEF_HEADER_RE.match(value)
        if def_match:
            binders = def_match.group(1).strip()
            type_part = def_match.group(2).split("\n")[0].strip()
            if type_part and len(type_part) <= 500 and "#check" not in type_part.lower():
                binder_parts = re.findall(r"\([^)]*\)", binders)
                if binder_parts:
                    value = " → ".join(binder_parts) + " → " + type_part
                else:
                    value = type_part
        else:
            thm_match = LEAN_INCOMPLETE_THEOREM_HEADER_RE.match(value)
            if thm_match:
                binders = thm_match.group(1).strip()
                type_part = thm_match.group(2).split("\n")[0].strip()
                if type_part and len(type_part) <= 500 and "#check" not in type_part.lower():
                    binder_parts = re.findall(r"\([^)]*\)", binders)
                    if binder_parts:
                        value = " → ".join(binder_parts) + " → " + type_part
                    else:
                        value = type_part
            else:
                # Full Lean file: find first line that looks like "[noncomputable] def name (...) : type" (no :=)
                for line in value.split("\n"):
                    line_stripped = line.strip()
                    if " : " not in line_stripped or " := " in line_stripped:
                        continue
                    def_match = LEAN_INCOMPLETE_DEF_HEADER_RE.match(line_stripped)
                    if def_match:
                        binders = def_match.group(1).strip()
                        type_part = def_match.group(2).split("\n")[0].strip()
                        if type_part and len(type_part) <= 500 and "#check" not in type_part.lower():
                            binder_parts = re.findall(r"\([^)]*\)", binders)
                            if binder_parts:
                                value = " → ".join(binder_parts) + " → " + type_part
                            else:
                                value = type_part
                        break
                    thm_match = LEAN_INCOMPLETE_THEOREM_HEADER_RE.match(line_stripped)
                    if thm_match:
                        binders = thm_match.group(1).strip()
                        type_part = thm_match.group(2).split("\n")[0].strip()
                        if type_part and len(type_part) <= 500 and "#check" not in type_part.lower():
                            binder_parts = re.findall(r"\([^)]*\)", binders)
                            if binder_parts:
                                value = " → ".join(binder_parts) + " → " + type_part
                            else:
                                value = type_part
                        break

    value = value.strip().strip("`").strip()
    value = re.sub(r"\s+", " ", value)
    return value


def _extract_statement_payload(raw_output: str) -> tuple[str | None, list[str], str]:
    json_payload = _extract_json(raw_output)
    assumptions: list[str] = []
    notes = ""

    if json_payload is not None:
        candidate = str(
            json_payload.get("lean_statement_type")
            or json_payload.get("statement_type")
            or json_payload.get("statement")
            or ""
        ).strip()
        assumptions_value = json_payload.get("assumptions")
        if isinstance(assumptions_value, list):
            assumptions = [str(item) for item in assumptions_value if str(item).strip()]
        notes = str(json_payload.get("notes") or "").strip()
        statement_type = _normalize_statement_type(candidate)
        return (statement_type if statement_type else None, assumptions, notes)

    jsonish_match = LEAN_STATEMENT_JSONISH_RE.search(raw_output)
    if jsonish_match:
        try:
            jsonish_value = json.loads(f"\"{jsonish_match.group('value')}\"")
            if isinstance(jsonish_value, str):
                statement_type = _normalize_statement_type(jsonish_value)
                return (statement_type if statement_type else None, assumptions, notes)
        except json.JSONDecodeError:
            pass

    statement_type = _normalize_statement_type(raw_output)
    return (statement_type if statement_type else None, assumptions, notes)


def _validate_statement_type(statement_type: str) -> str | None:
    normalized = statement_type.strip()
    lowered = normalized.lower()
    if not normalized:
        return "Extracted statement is empty."
    if lowered in LEAN_RESERVED_STATEMENT_WORDS:
        return f"Extracted statement is only a Lean declaration keyword: `{normalized}`."
    if any(lowered.startswith(f"{word} ") for word in LEAN_RESERVED_STATEMENT_WORDS):
        return f"Extracted statement starts with Lean declaration syntax: `{normalized[:80]}`."
    if normalized.startswith("{") or normalized.endswith("}") or '"lean_statement_type"' in normalized:
        return "Extracted statement still looks like JSON, not a Lean proposition."
    if len(normalized) > MAX_STATEMENT_TYPE_CHARS:
        return (
            f"Extracted statement is too long ({len(normalized)} chars > {MAX_STATEMENT_TYPE_CHARS}). "
            "Likely malformed output."
        )
    for snippet in LEAN_FORBIDDEN_STATEMENT_SNIPPETS:
        if snippet in lowered:
            return f"Extracted statement contains non-type Lean code (`{snippet.strip()}`)."
    return None


def _compose_lean_source(imports: list[str], declaration_name: str, statement_type: str) -> str:
    import_block = "\n".join(f"import {item}" for item in imports)
    return (
        f"{import_block}\n\n"
        "set_option autoImplicit false\n\n"
        "namespace MathGrammar\n"
        f"axiom {declaration_name} : {statement_type}\n"
        f"#check {declaration_name}\n"
        "end MathGrammar\n"
    )


def _sanitize_lean_source_def_headers(lean_source: str, declaration_name: str) -> str:
    """If lean_source contains a line like 'def name (...) : type' or 'axiom name : def ...' (no :=),
    replace with 'axiom declaration_name : type' so the file is valid. Last-resort safety net."""
    lines = lean_source.split("\n")

    def extract_type_from_def_line(text: str) -> str | None:
        def_match = LEAN_INCOMPLETE_DEF_HEADER_RE.match(text)
        if def_match:
            binders = def_match.group(1).strip()
            type_part = def_match.group(2).split("\n")[0].strip()
        else:
            thm_match = LEAN_INCOMPLETE_THEOREM_HEADER_RE.match(text)
            if not thm_match:
                return None
            binders = thm_match.group(1).strip()
            type_part = thm_match.group(2).split("\n")[0].strip()
        if not type_part or "#check" in type_part.lower() or len(type_part) > 500:
            return None
        for pattern, replacement in LEAN_CANONICAL_REPLACEMENTS:
            type_part = re.sub(pattern, replacement, type_part)
            binders = re.sub(pattern, replacement, binders)
        binder_parts = re.findall(r"\([^)]*\)", binders)
        type_str = " → ".join(binder_parts) + " → " + type_part if binder_parts else type_part
        return re.sub(r"\s+", " ", type_str).strip()

    for i, line in enumerate(lines):
        line_stripped = line.strip()
        if " := " in line_stripped:
            continue
        # Case 1: line is "def name (...) : type" or "noncomputable def ..."
        type_str = extract_type_from_def_line(line_stripped)
        if type_str is not None:
            lines[i] = f"axiom {declaration_name} : {type_str}"
            return "\n".join(lines)
        # Case 2: line is "axiom name : def name (...) : type" (composed when statement_type was raw def)
        if line_stripped.startswith("axiom ") and " : def " in line_stripped:
            prefix, _, after_colon = line_stripped.partition(" : ")
            if after_colon.strip().startswith("def "):
                type_str = extract_type_from_def_line(after_colon.strip())
                if type_str is not None:
                    lines[i] = f"axiom {declaration_name} : {type_str}"
                    return "\n".join(lines)
    return lean_source


def _parse_lean_diagnostics(output: str) -> list[LeanDiagnostic]:
    diagnostics: list[LeanDiagnostic] = []
    for line in output.splitlines():
        match = LEAN_DIAGNOSTIC_RE.match(line.strip())
        if not match:
            continue
        severity = match.group("severity")
        if severity == "information":
            severity = "info"
        diagnostics.append(
            LeanDiagnostic(
                severity=severity,  # type: ignore[arg-type]
                line=int(match.group("line")),
                column=int(match.group("col")),
                message=match.group("message"),
            )
        )
    return diagnostics


def _mathlib_lakefile_contents() -> str:
    revision = f' @ "{MATHLIB_REVISION}"' if MATHLIB_REVISION else ""
    return (
        "import Lake\n"
        "open Lake DSL\n\n"
        "package «mathlib_checker» where\n\n"
        "require mathlib from git\n"
        f'  "{MATHLIB_GIT_URL}"{revision}\n'
    )


def _format_subprocess_failure(exc: subprocess.CalledProcessError) -> str:
    stderr = (exc.stderr or "").strip()
    stdout = (exc.stdout or "").strip()
    fragments = [part for part in [stderr, stdout] if part]
    if fragments:
        return "\n".join(fragments)
    return f"process exited with status {exc.returncode}"


def _sanitize_mathlib_modules(modules: list[str] | tuple[str, ...]) -> list[str]:
    sanitized: list[str] = []
    for module in modules:
        candidate = module.strip()
        if not candidate:
            continue
        if not LEAN_IMPORT_RE.fullmatch(candidate):
            continue
        if candidate != MATHLIB_IMPORT and not candidate.startswith(f"{MATHLIB_IMPORT}."):
            continue
        sanitized.append(candidate)
    return list(dict.fromkeys(sanitized))


def _prebuild_mathlib_modules(
    project_dir: Path,
    modules: list[str] | tuple[str, ...],
    *,
    strict: bool,
) -> list[str]:
    built_modules: list[str] = []
    for module in _sanitize_mathlib_modules(modules):
        command = [LAKE_BIN, "build", module]
        try:
            subprocess.run(
                command,
                cwd=project_dir.as_posix(),
                check=True,
                capture_output=True,
                text=True,
                timeout=MATHLIB_BUILD_TIMEOUT_SECONDS,
            )
            built_modules.append(module)
        except subprocess.TimeoutExpired as exc:
            message = f"Timed out while running `{' '.join(command)}`."
            if strict:
                raise RuntimeError(message) from exc
            print(f"Warning: {message}")
        except subprocess.CalledProcessError as exc:
            details = _format_subprocess_failure(exc)
            message = f"`{' '.join(command)}` failed: {details}"
            if strict:
                raise RuntimeError(message) from exc
            print(f"Warning: {message}")
    return built_modules


def _extract_missing_olean_modules(output: str, diagnostics: list["LeanDiagnostic"]) -> list[str]:
    candidates: list[str] = []
    for diagnostic in diagnostics:
        if diagnostic.severity != "error":
            continue
        for match in LEAN_MISSING_OLEAN_MODULE_RE.finditer(diagnostic.message):
            candidates.append(match.group("module"))
    for match in LEAN_MISSING_OLEAN_MODULE_RE.finditer(output):
        candidates.append(match.group("module"))
    return _sanitize_mathlib_modules(candidates)


def _sync_project_toolchain_to_mathlib(project_dir: Path) -> bool:
    root_toolchain_path = project_dir / "lean-toolchain"
    mathlib_toolchain_path = project_dir / ".lake" / "packages" / "mathlib" / "lean-toolchain"
    if not mathlib_toolchain_path.exists():
        return False
    mathlib_toolchain = mathlib_toolchain_path.read_text(encoding="utf-8").strip()
    if not mathlib_toolchain:
        return False
    current_toolchain = (
        root_toolchain_path.read_text(encoding="utf-8").strip() if root_toolchain_path.exists() else ""
    )
    if current_toolchain == mathlib_toolchain:
        return False
    root_toolchain_path.write_text(f"{mathlib_toolchain}\n", encoding="utf-8")
    return True


def _verify_mathlib_project(project_dir: Path, timeout_seconds: int = 90) -> None:
    probe_file = project_dir / ".mathlib_probe.lean"
    probe_file.write_text(
        "import Mathlib.Data.Real.Basic\n\n#check (0 : Real)\n",
        encoding="utf-8",
    )
    subprocess.run(
        [LAKE_BIN, "env", LEAN_BIN, probe_file.as_posix()],
        cwd=project_dir.as_posix(),
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def _ensure_mathlib_project() -> Path:
    global _mathlib_runtime_probe_ok
    with _mathlib_lock:
        if _mathlib_runtime_probe_ok and MATHLIB_MARKER_FILE.exists():
            return MATHLIB_PROJECT_DIR

        def _validate_existing_marker() -> bool:
            if not MATHLIB_MARKER_FILE.exists():
                return False
            try:
                _verify_mathlib_project(MATHLIB_PROJECT_DIR)
            except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                return False
            return True

        if _validate_existing_marker():
            _mathlib_runtime_probe_ok = True
            return MATHLIB_PROJECT_DIR

        if MATHLIB_PROJECT_DIR.exists():
            shutil.rmtree(MATHLIB_PROJECT_DIR, ignore_errors=True)
        _mathlib_runtime_probe_ok = False

        try:
            hf_cache.reload()
        except Exception:  # noqa: BLE001
            # Reload can fail if other /cache files are open (e.g. loaded model weights).
            # For a warm container, local filesystem state is already usable.
            pass
        if _validate_existing_marker():
            _mathlib_runtime_probe_ok = True
            return MATHLIB_PROJECT_DIR

        MATHLIB_PROJECT_DIR.mkdir(parents=True, exist_ok=True)
        (MATHLIB_PROJECT_DIR / "lean-toolchain").write_text(
            f"{MATHLIB_BOOTSTRAP_TOOLCHAIN}\n", encoding="utf-8"
        )
        (MATHLIB_PROJECT_DIR / "lakefile.lean").write_text(_mathlib_lakefile_contents(), encoding="utf-8")

        try:
            subprocess.run(
                [LAKE_BIN, "update"],
                cwd=MATHLIB_PROJECT_DIR.as_posix(),
                check=True,
                capture_output=True,
                text=True,
                timeout=240,
            )
            if _sync_project_toolchain_to_mathlib(MATHLIB_PROJECT_DIR):
                subprocess.run(
                    [LAKE_BIN, "update"],
                    cwd=MATHLIB_PROJECT_DIR.as_posix(),
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=480,
                )
            subprocess.run(
                [LAKE_BIN, "exe", "cache", "get"],
                cwd=MATHLIB_PROJECT_DIR.as_posix(),
                check=True,
                capture_output=True,
                text=True,
                timeout=480,
            )
            prebuild_modules = _sanitize_mathlib_modules(MATHLIB_PREBUILD_MODULES)
            if prebuild_modules:
                _prebuild_mathlib_modules(
                    MATHLIB_PROJECT_DIR,
                    prebuild_modules,
                    strict=MATHLIB_PREBUILD_STRICT,
                )
            _verify_mathlib_project(MATHLIB_PROJECT_DIR)
        except FileNotFoundError as exc:
            raise RuntimeError(f"Lean toolchain binary not found: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            command = " ".join(exc.cmd) if isinstance(exc.cmd, list) else str(exc.cmd)
            raise RuntimeError(f"Mathlib bootstrap timed out while running `{command}`.") from exc
        except subprocess.CalledProcessError as exc:
            command = " ".join(exc.cmd) if isinstance(exc.cmd, list) else str(exc.cmd)
            details = _format_subprocess_failure(exc)
            raise RuntimeError(f"Mathlib bootstrap failed while running `{command}`: {details}") from exc

        MATHLIB_MARKER_FILE.write_text("ready\n", encoding="utf-8")
        _mathlib_runtime_probe_ok = True
        try:
            hf_cache.commit()
        except Exception as exc:  # noqa: BLE001
            # Keep serving traffic even if commit fails, but surface this in app logs.
            print(f"Warning: failed to persist Mathlib cache volume: {exc}")
        return MATHLIB_PROJECT_DIR


def _run_lean_check(
    statement_type: str,
    timeout_seconds: int,
    imports: list[str],
) -> tuple[bool, list[LeanDiagnostic], str]:
    effective_imports = _canonical_imports(imports)
    cache_key = _lean_check_cache_key(statement_type, effective_imports)
    cached = _cache_get(_lean_check_cache, cache_key, LEAN_CHECK_CACHE_TTL_SECONDS)
    if isinstance(cached, tuple) and len(cached) == 3:
        cached_ok, cached_diagnostics_payload, cached_output = cached
        diagnostics = [LeanDiagnostic.model_validate(item) for item in cached_diagnostics_payload]
        return bool(cached_ok), diagnostics, str(cached_output)

    lean_source = _compose_lean_source(
        imports=effective_imports,
        declaration_name=LEAN_CHECK_DECLARATION_NAME,
        statement_type=statement_type,
    )
    use_mathlib = any(
        item == MATHLIB_IMPORT or item.startswith(f"{MATHLIB_IMPORT}.") for item in effective_imports
    )
    with tempfile.TemporaryDirectory(prefix="lean-check-") as tmpdir:
        check_file = Path(tmpdir) / "Candidate.lean"
        check_file.write_text(lean_source, encoding="utf-8")

        command = [LEAN_BIN, check_file.as_posix()]
        cwd = None
        project_dir: Path | None = None
        if use_mathlib:
            try:
                project_dir = _ensure_mathlib_project()
            except Exception as exc:  # noqa: BLE001
                message = f"Failed to initialize Mathlib project: {exc}"
                return False, [LeanDiagnostic(severity="error", message=message)], message
            command = [LAKE_BIN, "env", LEAN_BIN, check_file.as_posix()]
            cwd = project_dir.as_posix()

        retried_missing_module_build = False
        while True:
            try:
                proc = subprocess.run(
                    command,
                    cwd=cwd,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                )
            except FileNotFoundError:
                message = f"Required binary not found while running `{command[0]}`."
                return False, [LeanDiagnostic(severity="error", message=message)], message
            except subprocess.TimeoutExpired:
                message = f"Lean check timed out after {timeout_seconds}s."
                return False, [LeanDiagnostic(severity="error", message=message)], message

            output = "\n".join(part for part in [proc.stdout, proc.stderr] if part).strip()
            diagnostics = _parse_lean_diagnostics(output)

            has_error = any(item.severity == "error" for item in diagnostics)
            if proc.returncode != 0 and not diagnostics:
                diagnostics = [
                    LeanDiagnostic(
                        severity="error",
                        message=output or f"`lean` exited with status {proc.returncode}.",
                    )
                ]
                has_error = True

            if (
                use_mathlib
                and project_dir is not None
                and has_error
                and not retried_missing_module_build
            ):
                missing_modules = _extract_missing_olean_modules(output, diagnostics)
                if missing_modules:
                    try:
                        _prebuild_mathlib_modules(project_dir, missing_modules, strict=True)
                    except Exception as exc:  # noqa: BLE001
                        diagnostics.append(
                            LeanDiagnostic(
                                severity="error",
                                message=f"On-demand Mathlib module build failed: {exc}",
                            )
                        )
                    else:
                        retried_missing_module_build = True
                        continue
            break

        result = (not has_error and proc.returncode == 0, diagnostics, output)
        _cache_put(
            _lean_check_cache,
            cache_key,
            (result[0], [item.model_dump() for item in diagnostics], output),
            LEAN_CHECK_CACHE_MAX_ENTRIES,
        )
        return result


def _build_feedback(
    statement_type: str | None,
    _diagnostics: list[LeanDiagnostic],
    assumptions: list[str],
    notes: str,
) -> list[str]:
    feedback: list[str] = []
    if statement_type:
        feedback.append("Generated a Lean statement type candidate from natural language input.")
    if assumptions:
        feedback.append("Model assumptions: " + "; ".join(assumptions))
    if notes:
        feedback.append("Model notes: " + notes)
    return feedback


def _expand_untyped_forall_groups(statement_type: str) -> tuple[str, bool]:
    changed = False

    def _replacement(match: re.Match[str]) -> str:
        nonlocal changed
        raw_group = match.group(1).strip()
        names = [name for name in raw_group.split() if name]
        if not names:
            return match.group(0)
        changed = True
        return " ".join(f"∀ {name} : Nat," for name in names) + " "

    rewritten = LEAN_FORALL_UNTYPED_GROUP_RE.sub(_replacement, statement_type)
    return rewritten, changed


def _collect_bound_identifiers(statement_type: str) -> set[str]:
    bound = set(LEAN_TYPED_BINDER_RE.findall(statement_type))
    for group in LEAN_FORALL_UNTYPED_GROUP_RE.findall(statement_type):
        bound.update(name for name in group.split() if name)
    return bound


def _rewrite_with_llm(
    statement_type: str,
    diagnostics: list[LeanDiagnostic],
) -> tuple[str | None, list[str]]:
    if not diagnostics:
        return None, []

    try:
        raw_output = _generate_rewrite_output(statement_type, diagnostics)
    except Exception:  # noqa: BLE001 - fallback to heuristic rewrite
        return None, []

    if not raw_output:
        return None, []

    payload = _extract_json(raw_output)
    if payload is None:
        return None, []

    revised_candidate = str(
        payload.get("revised_lean_statement_type")
        or payload.get("lean_statement_type")
        or payload.get("statement_type")
        or ""
    ).strip()
    revised_statement = _normalize_statement_type(revised_candidate) if revised_candidate else None

    feedback: list[str] = []
    raw_feedback = payload.get("feedback")
    if isinstance(raw_feedback, list):
        feedback.extend(str(item).strip() for item in raw_feedback if str(item).strip())
    elif isinstance(raw_feedback, str) and raw_feedback.strip():
        feedback.append(raw_feedback.strip())

    reason = str(payload.get("reason") or "").strip()
    if reason:
        feedback.append(reason)

    return revised_statement, list(dict.fromkeys(feedback))


def _refine_statement_type(
    *,
    statement_type: str,
    diagnostics: list[LeanDiagnostic],
) -> tuple[str, list[str]]:
    candidate = _normalize_statement_type(statement_type)
    rewrite_notes: list[str] = []

    lower_errors = " ".join(
        d.message.lower() for d in diagnostics if d.severity == "error"
    )
    if ":=" not in candidate and ("#check" in lower_errors or "expected ':='" in lower_errors):
        let_match = LEAN_INCOMPLETE_LET_RE.match(candidate)
        if let_match:
            binder_id = let_match.group(1)
            type_part = let_match.group(2).strip()
            if type_part and len(type_part) <= 200:
                candidate = f"∀ {binder_id} : {type_part}, True"
                rewrite_notes.append(
                    "Rewrote incomplete `let` term to type (∀ x : T, True) so it is valid in an axiom."
                )
                return candidate, rewrite_notes

    llm_rewrite, llm_feedback = _rewrite_with_llm(candidate, diagnostics)
    if llm_rewrite and llm_rewrite != candidate:
        if llm_feedback:
            rewrite_notes.extend(f"LLM suggestion: {item}" for item in llm_feedback)
        else:
            rewrite_notes.append("LLM suggestion: revised Lean statement candidate.")
        candidate = llm_rewrite
        candidate = re.sub(r"\s+", " ", candidate).strip()
        return candidate, rewrite_notes

    expanded, expanded_changed = _expand_untyped_forall_groups(candidate)
    if expanded_changed:
        candidate = expanded
        rewrite_notes.append("Added explicit `Nat` annotations to untyped quantified variables.")

    unknown_identifiers: list[str] = []
    for diagnostic in diagnostics:
        if diagnostic.severity != "error":
            continue
        unknown_identifiers.extend(LEAN_UNKNOWN_IDENTIFIER_RE.findall(diagnostic.message))

    if unknown_identifiers:
        bound_identifiers = _collect_bound_identifiers(candidate)
        missing: list[str] = []
        for identifier in unknown_identifiers:
            if not LEAN_IDENTIFIER_RE.fullmatch(identifier):
                continue
            if identifier in bound_identifiers:
                continue
            # Treat unresolved lowercase symbols as likely missing local binders.
            if not identifier[:1].islower():
                continue
            missing.append(identifier)
        deduped_missing = sorted(dict.fromkeys(missing))
        if deduped_missing:
            prefix = " ".join(f"∀ {name} : Nat," for name in deduped_missing)
            candidate = f"{prefix} {candidate}".strip()
            rewrite_notes.append(
                "Introduced missing `Nat` binders for unresolved identifiers: "
                + ", ".join(deduped_missing)
                + "."
            )

    lower_errors = " ".join(
        diagnostic.message.lower() for diagnostic in diagnostics if diagnostic.severity == "error"
    )
    if ("unexpected token" in lower_errors or "parse" in lower_errors) and "forall" in candidate:
        replaced = re.sub(r"\bforall\b", "∀", candidate)
        if replaced != candidate:
            candidate = replaced
            rewrite_notes.append("Normalized `forall` to Lean `∀` notation for parser compatibility.")

    fallback_candidate, fallback_changed = _apply_identifier_fallbacks(candidate, diagnostics)
    if fallback_changed and fallback_candidate != candidate:
        candidate = fallback_candidate
        rewrite_notes.append("Applied identifier fallback rewrite (e.g. `ℕ` -> `Nat`).")

    candidate = re.sub(r"\s+", " ", candidate).strip()
    return candidate, rewrite_notes


def _apply_identifier_fallbacks(statement_type: str, diagnostics: list[LeanDiagnostic]) -> tuple[str, bool]:
    if not diagnostics:
        return statement_type, False

    joined = "\n".join(item.message for item in diagnostics)
    rewritten = statement_type
    changed = False

    for src, dst in LEAN_IDENTIFIER_FALLBACKS:
        if f"Unknown identifier `{src}`" in joined and src in rewritten:
            rewritten = rewritten.replace(src, dst)
            changed = True

    return rewritten, changed


def _evaluate_statement_type(
    *,
    request: AnalyzeRequest,
    normalized_text: str,
    statement_type: str,
    assumptions: list[str],
    notes: str,
    model_output: str | None,
) -> AnalyzeResponse:
    started = time.perf_counter()
    declaration_name = _sanitize_declaration_name(request.theorem_name)
    effective_imports, auto_enabled_mathlib = _resolve_effective_imports(request.imports, statement_type)
    lean_source = _compose_lean_source(
        imports=effective_imports,
        declaration_name=declaration_name,
        statement_type=statement_type,
    )
    lean_source = _sanitize_lean_source_def_headers(lean_source, declaration_name)
    if request.skip_lean_check:
        feedback = _build_feedback(statement_type, [], assumptions, notes)
        feedback.append("Lean check skipped (`skip_lean_check=true`).")
        latency_ms = int((time.perf_counter() - started) * 1000)
        return AnalyzeResponse(
            model=MODEL_ID,
            status="unchecked",
            input_text=request.text,
            normalized_text=normalized_text,
            assumptions=assumptions,
            notes=notes,
            statement_type=statement_type,
            declaration_name=declaration_name,
            imports_used=effective_imports,
            lean_declaration=f"axiom {declaration_name} : {statement_type}",
            lean_source=lean_source,
            diagnostics=[],
            feedback=feedback,
            is_valid_lean=False,
            model_output=model_output,
            latency_ms=latency_ms,
        )
    try:
        is_valid_lean, diagnostics, _lean_raw = _run_lean_check(
            statement_type=statement_type,
            timeout_seconds=request.lean_timeout_seconds,
            imports=effective_imports,
        )
    except Exception as exc:  # noqa: BLE001
        latency_ms = int((time.perf_counter() - started) * 1000)
        return AnalyzeResponse(
            model=MODEL_ID,
            status="runtime_error",
            input_text=request.text,
            normalized_text=normalized_text,
            assumptions=assumptions,
            notes=notes,
            statement_type=statement_type,
            declaration_name=declaration_name,
            imports_used=effective_imports,
            lean_declaration=f"axiom {declaration_name} : {statement_type}",
            lean_source=lean_source,
            diagnostics=[LeanDiagnostic(severity="error", message=f"Lean check failed: {exc}")],
            feedback=["Lean runtime setup failed while validating this statement."],
            is_valid_lean=False,
            model_output=model_output,
            latency_ms=latency_ms,
        )

    rewritten_statement_type, used_fallback = _apply_identifier_fallbacks(statement_type, diagnostics)
    if not is_valid_lean and used_fallback and rewritten_statement_type != statement_type:
        statement_type = rewritten_statement_type
        effective_imports, auto_enabled_mathlib = _resolve_effective_imports(request.imports, statement_type)
        lean_source = _compose_lean_source(
            imports=effective_imports,
            declaration_name=declaration_name,
            statement_type=statement_type,
        )
        lean_source = _sanitize_lean_source_def_headers(lean_source, declaration_name)
        is_valid_lean, diagnostics, _lean_raw = _run_lean_check(
            statement_type=statement_type,
            timeout_seconds=request.lean_timeout_seconds,
            imports=effective_imports,
        )

    feedback = _build_feedback(statement_type, diagnostics, assumptions, notes)
    if used_fallback:
        feedback.append("Applied identifier fallback rewrite (e.g. `ℕ` -> `Nat`) before re-checking.")
    if auto_enabled_mathlib:
        feedback.append("Auto-enabled Mathlib imports based on detected identifiers in the statement.")
    latency_ms = int((time.perf_counter() - started) * 1000)

    return AnalyzeResponse(
        model=MODEL_ID,
        status="ok" if is_valid_lean else "needs_revision",
        input_text=request.text,
        normalized_text=normalized_text,
        assumptions=assumptions,
        notes=notes,
        statement_type=statement_type,
        declaration_name=declaration_name,
        imports_used=effective_imports,
        lean_declaration=f"axiom {declaration_name} : {statement_type}",
        lean_source=lean_source,
        diagnostics=diagnostics,
        feedback=feedback,
        is_valid_lean=is_valid_lean,
        model_output=model_output,
        latency_ms=latency_ms,
    )


def _analyze_with_iterations(request: AnalyzeRequest) -> AnalyzeResponse:
    started = time.perf_counter()
    max_iters = max(1, request.max_iters)
    initial_response = _analyze(request)

    history: list[dict[str, Any]] = [
        {
            "iteration": 1,
            "statement_type": initial_response.statement_type,
            "status": initial_response.status,
            "is_valid_lean": initial_response.is_valid_lean,
            "diagnostic_count": len(initial_response.diagnostics),
            "latency_ms": initial_response.latency_ms,
            "rewrite_notes": [],
        }
    ]

    current_response = initial_response
    rewrite_notes_accumulated: list[str] = []

    if (
        request.skip_lean_check
        or initial_response.statement_type is None
        or initial_response.status in {"runtime_error", "model_parse_error"}
    ):
        current_response.mode = "thinking"
        current_response.iteration_count = 1
        current_response.iteration_history = history if request.include_iteration_history else None
        current_response.latency_ms = int((time.perf_counter() - started) * 1000)
        current_response.feedback.append(
            "Thinking mode completed without iterative Lean rewrites (no revisable Lean candidate)."
        )
        return current_response

    current_statement_type = initial_response.statement_type
    normalized_text = initial_response.normalized_text
    assumptions = initial_response.assumptions
    notes = initial_response.notes
    model_output = initial_response.model_output

    for iteration in range(2, max_iters + 1):
        if current_response.is_valid_lean:
            break

        refined_statement, rewrite_notes = _refine_statement_type(
            statement_type=current_statement_type,
            diagnostics=current_response.diagnostics,
        )
        if refined_statement == current_statement_type:
            current_response.feedback.append(
                "Thinking mode stopped early: no additional Lean rewrite produced."
            )
            break

        current_statement_type = refined_statement
        rewrite_notes_accumulated.extend(rewrite_notes)
        current_response = _evaluate_statement_type(
            request=request,
            normalized_text=normalized_text,
            statement_type=current_statement_type,
            assumptions=assumptions,
            notes=notes,
            model_output=model_output,
        )
        history.append(
            {
                "iteration": iteration,
                "statement_type": current_response.statement_type,
                "status": current_response.status,
                "is_valid_lean": current_response.is_valid_lean,
                "diagnostic_count": len(current_response.diagnostics),
                "latency_ms": current_response.latency_ms,
                "rewrite_notes": rewrite_notes,
            }
        )

    current_response.mode = "thinking"
    current_response.iteration_count = len(history)
    current_response.iteration_history = history if request.include_iteration_history else None
    current_response.latency_ms = int((time.perf_counter() - started) * 1000)

    if current_response.is_valid_lean:
        current_response.feedback.append(
            f"Thinking mode converged after {len(history)} iterations."
        )
    elif len(history) >= max_iters:
        current_response.feedback.append(f"Reached max iterations ({max_iters}) without valid Lean.")

    if not current_response.is_valid_lean and current_statement_type:
        backup_refined, backup_notes = _refine_statement_type(
            statement_type=current_statement_type,
            diagnostics=current_response.diagnostics,
        )
        if backup_refined != current_statement_type and backup_notes:
            fallback_response = _evaluate_statement_type(
                request=request,
                normalized_text=normalized_text,
                statement_type=backup_refined,
                assumptions=assumptions,
                notes=notes,
                model_output=model_output,
            )
            if fallback_response.is_valid_lean:
                current_response = fallback_response
                current_response.mode = "thinking"
                current_response.iteration_count = len(history)
                current_response.iteration_history = history if request.include_iteration_history else None
                current_response.feedback.append(
                    "Backup heuristic applied after iterations: statement rewritten and re-checked."
                )
                rewrite_notes_accumulated.extend(backup_notes)

    current_response.feedback.append(
        "Final suggestions are generated from the last Lean validation pass."
    )

    if rewrite_notes_accumulated:
        deduped_notes = list(dict.fromkeys(rewrite_notes_accumulated))
        current_response.feedback.append("Applied Lean rewrites: " + "; ".join(deduped_notes))

    return current_response


def _analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    started = time.perf_counter()
    normalized_text = _normalize_input_text(request.text)

    try:
        raw_output = _generate_model_output(request, normalized_text)
        statement_type, assumptions, notes = _extract_statement_payload(raw_output)
    except Exception as exc:  # noqa: BLE001
        latency_ms = int((time.perf_counter() - started) * 1000)
        return AnalyzeResponse(
            model=MODEL_ID,
            status="runtime_error",
            input_text=request.text,
            normalized_text=normalized_text,
            diagnostics=[LeanDiagnostic(severity="error", message=str(exc))],
            feedback=["Model runtime error during NL-to-Lean generation."],
            is_valid_lean=False,
            model_output=None,
            latency_ms=latency_ms,
        )

    if not statement_type:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return AnalyzeResponse(
            model=MODEL_ID,
            status="model_parse_error",
            input_text=request.text,
            normalized_text=normalized_text,
            assumptions=assumptions,
            notes=notes,
            diagnostics=[LeanDiagnostic(severity="error", message="Could not extract a Lean statement.")],
            feedback=["Model output did not include a parseable `lean_statement_type`."],
            is_valid_lean=False,
            model_output=raw_output if request.include_raw_model_output else None,
            latency_ms=latency_ms,
        )

    statement_error = _validate_statement_type(statement_type)
    if statement_error:
        latency_ms = int((time.perf_counter() - started) * 1000)
        return AnalyzeResponse(
            model=MODEL_ID,
            status="model_parse_error",
            input_text=request.text,
            normalized_text=normalized_text,
            assumptions=assumptions,
            notes=notes,
            statement_type=statement_type,
            diagnostics=[LeanDiagnostic(severity="error", message=statement_error)],
            feedback=["Model output produced an invalid Lean proposition form."],
            is_valid_lean=False,
            model_output=raw_output if request.include_raw_model_output else None,
            latency_ms=latency_ms,
        )

    response = _evaluate_statement_type(
        request=request,
        normalized_text=normalized_text,
        statement_type=statement_type,
        assumptions=assumptions,
        notes=notes,
        model_output=raw_output if request.include_raw_model_output else None,
    )
    response.latency_ms = int((time.perf_counter() - started) * 1000)
    return response


def _complete(request: CompleteRequest) -> CompleteResponse:
    """Run the completion pipeline: prefix from request.text[:cursor], retrieval hints from
    request.context + corpus, generation (LLM), then ranking. 'no_suggestion' when all
    candidates are rejected by _normalize_completion_suffix (empty, forbidden_pattern,
    json_like_candidate, schema_fragment, too_long, too_many_newlines) or by ranking
    (redundant_with_prefix, low_relevance_to_prefix, math_context_mismatch). More context
    (request.context) improves retrieval hints; prefix_text is request.text up to cursor."""
    started = time.perf_counter()
    prefix_text = _complete_prefix(request)
    imports_used = _canonical_imports(request.imports)
    timings: dict[str, int] = {}

    try:
        retrieval_started = time.perf_counter()
        retrieval_hints = _retrieve_completion_hints(
            prefix_text,
            request.context,
            COMPLETE_RETRIEVAL_TOP_K,
        )
        timings["retrieval"] = int((time.perf_counter() - retrieval_started) * 1000)

        generation_started = time.perf_counter()
        raw_outputs = _generate_completion_outputs(
            request,
            prefix_text=prefix_text,
            retrieval_hints=retrieval_hints,
        )
        timings["generation"] = int((time.perf_counter() - generation_started) * 1000)

        ranking_started = time.perf_counter()
        candidates, rejected = _rank_completion_candidates(
            prefix_text=prefix_text,
            retrieval_hints=retrieval_hints,
            raw_outputs=raw_outputs,
            max_candidates=request.max_candidates,
        )
        timings["ranking"] = int((time.perf_counter() - ranking_started) * 1000)
    except Exception as exc:  # noqa: BLE001
        return CompleteResponse(
            model=MODEL_ID,
            status="runtime_error",
            input_text=request.text,
            prefix_text=prefix_text,
            imports_used=imports_used,
            retrieved_hints=[],
            candidates=[],
            selected_completion=None,
            cache_hit=False,
            timings_ms=timings,
            latency_ms=int((time.perf_counter() - started) * 1000),
            debug={"error": str(exc)} if request.include_debug else None,
        )

    selected_completion = candidates[0].completion if candidates else None
    status: Literal["ok", "no_suggestion", "runtime_error"] = "ok" if candidates else "no_suggestion"
    debug_payload: dict[str, Any] | None = None
    if request.include_debug:
        debug_payload = {
            "raw_outputs": raw_outputs,
            "rejected_candidates": rejected,
        }
    no_suggestion_reasons_list: list[str] = []
    if status == "no_suggestion":
        if rejected:
            reason_counts: dict[str, int] = {}
            for item in rejected:
                for r in item.get("reasons") or []:
                    reason_counts[r] = reason_counts.get(r, 0) + 1
            no_suggestion_reasons_list = [
                f"{reason}({count})" for reason, count in sorted(reason_counts.items(), key=lambda x: -x[1])
            ]
        else:
            no_suggestion_reasons_list = ["no_candidates"]
    return CompleteResponse(
        model=MODEL_ID,
        status=status,
        input_text=request.text,
        prefix_text=prefix_text,
        imports_used=imports_used,
        retrieved_hints=retrieval_hints,
        selected_completion=selected_completion,
        candidates=candidates,
        cache_hit=False,
        timings_ms=timings,
        latency_ms=int((time.perf_counter() - started) * 1000),
        debug=debug_payload,
        no_suggestion_reasons=no_suggestion_reasons_list,
    )


@app.function(**gpu_function_kwargs)
def analyze_rpc(request: dict[str, Any]) -> dict[str, Any]:
    parsed = AnalyzeRequest.model_validate(request)
    key = _analyze_cache_key(parsed)
    cached_response = _cache_get(_analyze_cache, key, ANALYZE_CACHE_TTL_SECONDS)
    if isinstance(cached_response, dict):
        cached_response["cache_hit"] = True
        cached_response["latency_ms"] = min(int(cached_response.get("latency_ms", 0)), 5)
        return cached_response

    if parsed.mode == "thinking":
        response = _analyze_with_iterations(parsed)
    else:
        response = _analyze(parsed)
        response.mode = "fast"
        response.iteration_count = 1
        response.iteration_history = None
    response = _apply_final_feedback_summary(parsed, response)
    response = _attach_interpretation(response)
    payload = response.model_dump()
    payload["cache_hit"] = False
    _cache_put(_analyze_cache, key, payload, ANALYZE_CACHE_MAX_ENTRIES)
    return payload


@app.function(**gpu_function_kwargs)
def complete_rpc(request: dict[str, Any]) -> dict[str, Any]:
    parsed = CompleteRequest.model_validate(request)
    key = _complete_cache_key(parsed)
    cached_response = _cache_get(_complete_cache, key, COMPLETE_CACHE_TTL_SECONDS)
    if isinstance(cached_response, dict):
        cached_response["cache_hit"] = True
        cached_response["latency_ms"] = min(int(cached_response.get("latency_ms", 0)), 5)
        return cached_response

    response = _complete(parsed)
    payload = response.model_dump()
    payload["cache_hit"] = False
    _cache_put(_complete_cache, key, payload, COMPLETE_CACHE_MAX_ENTRIES)
    return payload


@app.function(**api_function_kwargs)
@modal.asgi_app()
def api():
    from fastapi import Depends, FastAPI, Header, HTTPException
    from fastapi.middleware.cors import CORSMiddleware

    app_api = FastAPI(
        title="Math Grammarly API",
        version="0.1.0",
        description="Natural language math -> Lean statement generator with Lean diagnostics.",
    )

    allow_origins = [item.strip() for item in os.environ.get("CORS_ALLOW_ORIGINS", "*").split(",")]
    wildcard_cors = any(origin == "*" for origin in allow_origins)
    app_api.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_credentials=not wildcard_cors,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    api_key = os.environ.get("API_KEY")
    modal_exception_module = getattr(modal, "exception", None)
    output_expired_error = (
        getattr(modal_exception_module, "OutputExpiredError", RuntimeError)
        if modal_exception_module is not None
        else RuntimeError
    )

    def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
        if api_key and x_api_key != api_key:
            raise HTTPException(status_code=401, detail="Invalid API key.")

    @app_api.get("/healthz")
    def healthz() -> dict[str, Any]:
        return {
            "ok": True,
            "app": APP_NAME,
            "version": APP_VERSION,
            "model": MODEL_ID,
            "inference_backend": INFERENCE_BACKEND,
        }

    @app_api.post("/v1/analyze")
    def analyze_endpoint(
        request: AnalyzeRequest,
        _auth: None = Depends(require_api_key),
    ) -> dict[str, Any]:
        return analyze_rpc.remote(request.model_dump())

    @app_api.post("/v1/query")
    def query_endpoint(
        request: AnalyzeRequest,
        _auth: None = Depends(require_api_key),
    ) -> dict[str, Any]:
        return analyze_rpc.remote(request.model_dump())

    @app_api.post("/v1/generate")
    def generate_endpoint(
        request: AnalyzeRequest,
        _auth: None = Depends(require_api_key),
    ) -> dict[str, Any]:
        payload = request.model_dump()
        payload["skip_lean_check"] = True
        return analyze_rpc.remote(payload)

    @app_api.post("/v1/complete")
    def complete_endpoint(
        request: CompleteRequest,
        _auth: None = Depends(require_api_key),
    ) -> dict[str, Any]:
        return complete_rpc.remote(request.model_dump())

    @app_api.post("/v1/analyze/jobs")
    def analyze_job_endpoint(
        request: AnalyzeRequest,
        _auth: None = Depends(require_api_key),
    ) -> dict[str, Any]:
        call = analyze_rpc.spawn(request.model_dump())
        return {
            "status": "pending",
            "call_id": call.object_id,
            "poll_path": f"/v1/analyze/jobs/{call.object_id}",
        }

    @app_api.get("/v1/analyze/jobs/{call_id}")
    def analyze_job_status(
        call_id: str,
        _auth: None = Depends(require_api_key),
    ) -> dict[str, Any]:
        function_call = modal.FunctionCall.from_id(call_id)
        try:
            result = function_call.get(timeout=0)
            return {"status": "completed", "call_id": call_id, "result": result}
        except TimeoutError:
            return {"status": "pending", "call_id": call_id}
        except output_expired_error:
            return {"status": "expired", "call_id": call_id}
        except Exception as exc:  # noqa: BLE001
            return {"status": "failed", "call_id": call_id, "error": str(exc)}

    @app_api.post("/v1/warmup")
    def warmup_endpoint(_auth: None = Depends(require_api_key)) -> dict[str, Any]:
        probe = AnalyzeRequest(
            text="For all real numbers x, x = x.",
            theorem_name="warmup_real_refl",
            imports=["Mathlib.Data.Real.Basic"],
            temperature=0.0,
            max_new_tokens=64,
            lean_timeout_seconds=max(LEAN_CHECK_TIMEOUT_SECONDS, 30),
            include_raw_model_output=False,
        )
        result = analyze_rpc.remote(probe.model_dump())
        imports_used = result.get("imports_used") if isinstance(result, dict) else []
        return {
            "status": "ready",
            "model": MODEL_ID,
            "inference_backend": INFERENCE_BACKEND,
            "probe_status": result.get("status") if isinstance(result, dict) else "runtime_error",
            "probe_is_valid_lean": bool(result.get("is_valid_lean")) if isinstance(result, dict) else False,
            "mathlib_warmed": bool(
                isinstance(imports_used, list)
                and any(item == MATHLIB_IMPORT or item.startswith(f"{MATHLIB_IMPORT}.") for item in imports_used)
            ),
            "latency_ms": int(result.get("latency_ms", 0)) if isinstance(result, dict) else 0,
        }

    return app_api


@app.local_entrypoint()
def main(
    text: str = "For every natural number n, n + 0 equals n.",
    theorem_name: str = "add_zero_right",
) -> None:
    payload = AnalyzeRequest(text=text, theorem_name=theorem_name).model_dump()
    print(json.dumps(analyze_rpc.remote(payload), indent=2, ensure_ascii=False))
