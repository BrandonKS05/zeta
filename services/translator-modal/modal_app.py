"""Modal deployment for a Grammarly-style NL -> Lean checker backend."""

from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
import json
import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Literal

import modal
from pydantic import BaseModel, Field, field_validator

APP_NAME = "herald-math-grammarly"
APP_VERSION = "2026-02-14-mathlib-fastcache-v2"
MODEL_ID = "FrenzyMath/Herald_translator"
MODEL_REVISION = os.environ.get("HERALD_MODEL_REVISION")

HF_CACHE_DIR = Path("/cache/hf")
MODEL_ROOT_DIR = Path("/cache/models")
MODEL_LOCAL_DIR = MODEL_ROOT_DIR / MODEL_ID.replace("/", "__")

LEAN_BIN = "/root/.elan/bin/lean"
LAKE_BIN = "/root/.elan/bin/lake"
LEAN_CHECK_TIMEOUT_SECONDS = 20
LEAN_CHECK_DECLARATION_NAME = "_candidate_statement"
MATHLIB_PROJECT_DIR = Path("/cache/lean/mathlib_checker")
MATHLIB_MARKER_FILE = MATHLIB_PROJECT_DIR / ".mathlib_ready"
MATHLIB_GIT_URL = "https://github.com/leanprover-community/mathlib4.git"
MATHLIB_REVISION = os.environ.get("MATHLIB_REVISION")
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

SYSTEM_PROMPT = """You convert informal math to Lean 4.
Return JSON only with keys:
- lean_statement_type: a Lean proposition/type usable in `axiom t : ...`
- assumptions: list of assumptions you made
- notes: short explanation
Rules:
1) No markdown/code fences.
2) No proofs (`by`, `sorry`), no imports, no declarations.
3) Use explicit binders, e.g. `forall n : Nat, ...` or `∀ n : Nat, ...`.
4) Use Lean core identifiers, not textbook Unicode sets:
   - Natural numbers: `Nat` (never `ℕ` or `\\mathbb{N}`)
   - Integers: `Int` (never `ℤ` or `\\mathbb{Z}`)
   - Rationals: `Rat` (never `ℚ` or `\\mathbb{Q}`)
5) Prefer conservative formalizations when ambiguous.
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
LEAN_IMPORT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.']*$")
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
    "timeout": 900,
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


@dataclass
class Runtime:
    tokenizer: Any
    model: Any


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
    latency_ms: int = 0


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


def _load_runtime() -> Runtime:
    global _runtime
    if _runtime is not None:
        return _runtime

    with _runtime_lock:
        if _runtime is not None:
            return _runtime

        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        if torch.cuda.is_available():
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

        model_dir = _ensure_model_downloaded()
        tokenizer = AutoTokenizer.from_pretrained(
            model_dir.as_posix(),
            token=os.environ.get("HF_TOKEN"),
            local_files_only=True,
        )
        model = AutoModelForCausalLM.from_pretrained(
            model_dir.as_posix(),
            token=os.environ.get("HF_TOKEN"),
            torch_dtype=torch.float16,
            low_cpu_mem_usage=True,
            device_map="auto",
            local_files_only=True,
        )
        model.eval()

        if tokenizer.pad_token_id is None and tokenizer.eos_token_id is not None:
            tokenizer.pad_token = tokenizer.eos_token
        if model.generation_config is not None:
            model.generation_config.use_cache = True
            if tokenizer.eos_token_id is not None:
                model.generation_config.eos_token_id = tokenizer.eos_token_id
            if tokenizer.pad_token_id is not None:
                model.generation_config.pad_token_id = tokenizer.pad_token_id

        _runtime = Runtime(tokenizer=tokenizer, model=model)
        return _runtime


def _generate_model_output(request: AnalyzeRequest, normalized_text: str) -> str:
    import torch

    model_key = _model_output_cache_key(request, normalized_text)
    cached_output = _cache_get(_model_output_cache, model_key, MODEL_OUTPUT_CACHE_TTL_SECONDS)
    if isinstance(cached_output, str):
        return cached_output

    runtime = _load_runtime()
    tokenizer = runtime.tokenizer
    model = runtime.model

    if getattr(tokenizer, "chat_template", None):
        prompt = tokenizer.apply_chat_template(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": _user_prompt(request, normalized_text)},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt = f"{SYSTEM_PROMPT}\n\n{_user_prompt(request, normalized_text)}\n\nJSON:"

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
    text = tokenizer.decode(generated, skip_special_tokens=True).strip()
    _cache_put(_model_output_cache, model_key, text, MODEL_OUTPUT_CACHE_MAX_ENTRIES)
    return text


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


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
        stripped = stripped.removesuffix("```").strip()
    return stripped


def _normalize_statement_type(candidate: str) -> str:
    value = _strip_code_fences(candidate)
    value = re.sub(r"^lean_statement_type\s*:\s*", "", value, flags=re.IGNORECASE).strip()
    for pattern, replacement in LEAN_CANONICAL_REPLACEMENTS:
        value = re.sub(pattern, replacement, value)

    decl_match = LEAN_DECL_RE.match(value)
    if decl_match:
        value = decl_match.group(3).strip()

    for marker in [" := by", ":= by", " := ", ":=", "\nby", " where"]:
        if marker in value:
            value = value.split(marker, 1)[0].strip()

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

    statement_type = _normalize_statement_type(raw_output)
    return (statement_type if statement_type else None, assumptions, notes)


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


def _ensure_mathlib_project() -> Path:
    with _mathlib_lock:
        if MATHLIB_MARKER_FILE.exists():
            return MATHLIB_PROJECT_DIR
        try:
            hf_cache.reload()
        except Exception:  # noqa: BLE001
            # Reload can fail if other /cache files are open (e.g. loaded model weights).
            # For a warm container, local filesystem state is already usable.
            pass
        if MATHLIB_MARKER_FILE.exists():
            return MATHLIB_PROJECT_DIR

        MATHLIB_PROJECT_DIR.mkdir(parents=True, exist_ok=True)
        (MATHLIB_PROJECT_DIR / "lean-toolchain").write_text("stable\n", encoding="utf-8")
        (MATHLIB_PROJECT_DIR / "lakefile.lean").write_text(_mathlib_lakefile_contents(), encoding="utf-8")

        subprocess.run(
            [LAKE_BIN, "update"],
            cwd=MATHLIB_PROJECT_DIR.as_posix(),
            check=True,
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [LAKE_BIN, "exe", "cache", "get"],
            cwd=MATHLIB_PROJECT_DIR.as_posix(),
            check=False,
            capture_output=True,
            text=True,
        )

        MATHLIB_MARKER_FILE.write_text("ready\n", encoding="utf-8")
        try:
            hf_cache.commit()
        except Exception:  # noqa: BLE001
            pass
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
        if use_mathlib:
            try:
                project_dir = _ensure_mathlib_project()
            except subprocess.CalledProcessError as exc:
                message = (
                    (exc.stderr or "").strip()
                    or (exc.stdout or "").strip()
                    or f"Failed to initialize Mathlib project: {exc}"
                )
                return False, [LeanDiagnostic(severity="error", message=message)], message
            command = [LAKE_BIN, "env", LEAN_BIN, check_file.as_posix()]
            cwd = project_dir.as_posix()

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
    diagnostics: list[LeanDiagnostic],
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

    for diagnostic in diagnostics:
        if diagnostic.severity != "error":
            continue
        lower = diagnostic.message.lower()
        if "unknown constant" in lower or "unknown identifier" in lower:
            feedback.append("Lean found an unknown identifier. Add explicit binders or required imports.")
        elif "unknown package" in lower or "unknown module prefix" in lower:
            feedback.append("Requested import is unavailable in this runtime. Install that Lean package or use `Std`.")
        elif "type mismatch" in lower:
            feedback.append("Lean reported a type mismatch. Clarify quantifiers/domains in the statement.")
        elif "unexpected token" in lower or "parse" in lower:
            feedback.append("Lean parsing failed. Check punctuation and Lean syntax around quantifiers.")
        else:
            feedback.append("Lean returned an error. Inspect diagnostics and revise wording/notation.")
    return feedback


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

    declaration_name = _sanitize_declaration_name(request.theorem_name)
    effective_imports, auto_enabled_mathlib = _resolve_effective_imports(request.imports, statement_type)
    lean_source = _compose_lean_source(
        imports=effective_imports,
        declaration_name=declaration_name,
        statement_type=statement_type,
    )
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
            model_output=raw_output if request.include_raw_model_output else None,
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
            model_output=raw_output if request.include_raw_model_output else None,
            latency_ms=latency_ms,
        )

    rewritten_statement_type, used_fallback = _apply_identifier_fallbacks(statement_type, diagnostics)
    if not is_valid_lean and used_fallback:
        statement_type = rewritten_statement_type
        lean_source = _compose_lean_source(
            imports=effective_imports,
            declaration_name=declaration_name,
            statement_type=statement_type,
        )
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
        model_output=raw_output if request.include_raw_model_output else None,
        latency_ms=latency_ms,
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

    response = _analyze(parsed)
    payload = response.model_dump()
    payload["cache_hit"] = False
    _cache_put(_analyze_cache, key, payload, ANALYZE_CACHE_MAX_ENTRIES)
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
        return {"ok": True, "app": APP_NAME, "version": APP_VERSION, "model": MODEL_ID}

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
