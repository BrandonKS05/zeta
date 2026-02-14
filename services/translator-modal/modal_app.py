"""Modal deployment for a Grammarly-style NL -> Lean checker backend."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import modal
from pydantic import BaseModel, Field, field_validator

APP_NAME = "herald-math-grammarly"
APP_VERSION = "2026-02-14-lean-normalize-v2"
MODEL_ID = "FrenzyMath/Herald_translator"
MODEL_REVISION = os.environ.get("HERALD_MODEL_REVISION")

HF_CACHE_DIR = Path("/cache/hf")
MODEL_ROOT_DIR = Path("/cache/models")
MODEL_LOCAL_DIR = MODEL_ROOT_DIR / MODEL_ID.replace("/", "__")

LEAN_BIN = "/root/.elan/bin/lean"
LEAN_CHECK_TIMEOUT_SECONDS = 20

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
gpu_secrets = [secret for secret in [hf_secret] if secret is not None]
if gpu_secrets:
    gpu_function_kwargs["secrets"] = gpu_secrets

api_function_kwargs: dict[str, Any] = {
    "image": api_image,
    "timeout": 900,
}
api_secrets = [secret for secret in [api_secret] if secret is not None]
if api_secrets:
    api_function_kwargs["secrets"] = api_secrets

_runtime = None


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
    max_new_tokens: int = Field(default=192, ge=32, le=512)
    lean_timeout_seconds: int = Field(default=LEAN_CHECK_TIMEOUT_SECONDS, ge=2, le=60)
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
    status: Literal["ok", "needs_revision", "model_parse_error", "runtime_error"]
    input_text: str
    normalized_text: str
    assumptions: list[str] = Field(default_factory=list)
    notes: str = ""
    statement_type: str | None = None
    declaration_name: str | None = None
    lean_declaration: str | None = None
    lean_source: str | None = None
    diagnostics: list[LeanDiagnostic] = Field(default_factory=list)
    feedback: list[str] = Field(default_factory=list)
    is_valid_lean: bool = False
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


def _user_prompt(request: AnalyzeRequest, normalized_text: str) -> str:
    imports_text = ", ".join(request.imports)
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

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    model_dir = _ensure_model_downloaded()
    tokenizer = AutoTokenizer.from_pretrained(
        model_dir.as_posix(),
        token=os.environ.get("HF_TOKEN"),
    )
    model = AutoModelForCausalLM.from_pretrained(
        model_dir.as_posix(),
        token=os.environ.get("HF_TOKEN"),
        torch_dtype=torch.float16,
        low_cpu_mem_usage=True,
        device_map="auto",
    )
    model.eval()

    if tokenizer.pad_token_id is None and tokenizer.eos_token_id is not None:
        tokenizer.pad_token = tokenizer.eos_token

    _runtime = Runtime(tokenizer=tokenizer, model=model)
    return _runtime


def _generate_model_output(request: AnalyzeRequest, normalized_text: str) -> str:
    import torch

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
        "pad_token_id": tokenizer.eos_token_id,
    }
    if do_sample:
        kwargs["temperature"] = request.temperature
        kwargs["top_p"] = 0.95

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


def _run_lean_check(lean_source: str, timeout_seconds: int) -> tuple[bool, list[LeanDiagnostic], str]:
    with tempfile.TemporaryDirectory(prefix="lean-check-") as tmpdir:
        check_file = Path(tmpdir) / "Candidate.lean"
        check_file.write_text(lean_source, encoding="utf-8")

        try:
            proc = subprocess.run(
                [LEAN_BIN, check_file.as_posix()],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
        except FileNotFoundError:
            message = f"Lean binary not found at {LEAN_BIN}."
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

        return (not has_error and proc.returncode == 0, diagnostics, output)


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
    lean_source = _compose_lean_source(
        imports=request.imports,
        declaration_name=declaration_name,
        statement_type=statement_type,
    )
    is_valid_lean, diagnostics, _lean_raw = _run_lean_check(
        lean_source=lean_source,
        timeout_seconds=request.lean_timeout_seconds,
    )

    rewritten_statement_type, used_fallback = _apply_identifier_fallbacks(statement_type, diagnostics)
    if not is_valid_lean and used_fallback:
        statement_type = rewritten_statement_type
        lean_source = _compose_lean_source(
            imports=request.imports,
            declaration_name=declaration_name,
            statement_type=statement_type,
        )
        is_valid_lean, diagnostics, _lean_raw = _run_lean_check(
            lean_source=lean_source,
            timeout_seconds=request.lean_timeout_seconds,
        )

    feedback = _build_feedback(statement_type, diagnostics, assumptions, notes)
    if used_fallback:
        feedback.append("Applied identifier fallback rewrite (e.g. `ℕ` -> `Nat`) before re-checking.")
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
    response = _analyze(parsed)
    return response.model_dump()


@app.function(**gpu_function_kwargs)
def warmup_rpc() -> dict[str, Any]:
    _load_runtime()
    probe = AnalyzeRequest(
        text="For every natural number n, n + 0 equals n.",
        include_raw_model_output=False,
    )
    result = _analyze(probe)
    return {
        "status": "ready",
        "model": MODEL_ID,
        "probe_is_valid_lean": result.is_valid_lean,
    }


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
        return warmup_rpc.remote()

    return app_api


@app.local_entrypoint()
def main(
    text: str = "For every natural number n, n + 0 equals n.",
    theorem_name: str = "add_zero_right",
) -> None:
    payload = AnalyzeRequest(text=text, theorem_name=theorem_name).model_dump()
    print(json.dumps(analyze_rpc.remote(payload), indent=2, ensure_ascii=False))
