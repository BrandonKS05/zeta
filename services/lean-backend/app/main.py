from __future__ import annotations

import logging
import re
import time
import uuid

from fastapi import FastAPI, HTTPException, Request

from .lean_compile import compile_lean
from .llm_client import interpret_errors
from .modal_client import ModalClientError, generate_lean
from .models import (
    Diagnostic,
    PipelineStage,
    PipelineTrace,
    SemanticValidation,
    SolveRequest,
    SolveResponse,
)
from .settings import get_settings
from .utils import configure_logging, request_id_ctx

settings = get_settings()
configure_logging(settings.log_level)
logger = logging.getLogger(__name__)

app = FastAPI(title="Lean Solver Backend", version="0.1.0")

_FALSE_DECL_RE = re.compile(
    r"(?m)^\s*(?:axiom|theorem|lemma)\s+(?P<name>[A-Za-z0-9_'.]+)\s*:\s*False(?:\b|$)"
)
_FALSE_STDOUT_RE = re.compile(
    r"^\s*(?P<name>[A-Za-z0-9_'.]+)(?:\s*\([^)]*\))*\s*:\s*False\s*$"
)


@app.middleware("http")
async def add_request_context(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    token = request_id_ctx.set(request_id)
    logger.info("request_started method=%s path=%s", request.method, request.url.path)
    try:
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        logger.info(
            "request_completed method=%s path=%s status=%s",
            request.method,
            request.url.path,
            response.status_code,
        )
        return response
    except Exception:
        logger.exception("request_failed method=%s path=%s", request.method, request.url.path)
        raise
    finally:
        request_id_ctx.reset(token)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


def run_semantic_validation(
    generated_code: str,
    compile_stdout: str,
    modal_metadata: dict[str, object] | None,
) -> SemanticValidation:
    reasons: list[str] = []
    declaration_name: str | None = None
    collapsed_to_false = False

    decl_match = _FALSE_DECL_RE.search(generated_code)
    if decl_match:
        declaration_name = decl_match.group("name")
        collapsed_to_false = True
        reasons.append(
            f"Generated declaration '{declaration_name}' has proposition type False."
        )

    for raw_line in compile_stdout.splitlines():
        line = raw_line.strip()
        if not line or not line.endswith(": False"):
            continue
        collapsed_to_false = True
        stdout_match = _FALSE_STDOUT_RE.match(line)
        if declaration_name is None and stdout_match:
            declaration_name = stdout_match.group("name")
        reasons.append(f"Lean #check output reported proposition type False: {line}")
        break

    metadata = modal_metadata or {}
    modal_valid = metadata.get("is_valid_lean")
    if modal_valid is False:
        reasons.append("Modal metadata reported is_valid_lean=false.")

    success = not collapsed_to_false and modal_valid is not False
    return SemanticValidation(
        success=success,
        collapsed_to_false=collapsed_to_false,
        declaration_name=declaration_name,
        reasons=reasons,
    )


@app.post("/v1/lean/solve", response_model=SolveResponse)
async def solve_lean(payload: SolveRequest) -> SolveResponse:
    logger.info("received solve request")
    pipeline_start = time.perf_counter()
    stages: list[PipelineStage] = []

    modal_start = time.perf_counter()
    try:
        generated = await generate_lean(
            payload.nl_input,
            context=payload.context,
            max_iters=payload.max_iters,
            settings=settings,
        )
    except ModalClientError as exc:
        modal_elapsed_ms = (time.perf_counter() - modal_start) * 1000
        logger.exception("modal generation failed duration_ms=%.2f", modal_elapsed_ms)
        raise HTTPException(status_code=502, detail=f"Modal generation failed: {exc}") from exc
    modal_elapsed_ms = (time.perf_counter() - modal_start) * 1000
    logger.info("stage_complete stage=modal_generation duration_ms=%.2f", modal_elapsed_ms)
    stages.append(
        PipelineStage(
            stage="modal_generation",
            attempted=True,
            success=True,
            duration_ms=modal_elapsed_ms,
            details={
                "endpoint": settings.modal_endpoint_url or "",
                "metadata_keys": sorted(generated.metadata.keys()),
            },
        )
    )

    compile_start = time.perf_counter()
    compile_result = await compile_lean(generated.code, settings=settings)
    compile_elapsed_ms = (time.perf_counter() - compile_start) * 1000
    logger.info(
        "stage_complete stage=lean_compile duration_ms=%.2f success=%s",
        compile_elapsed_ms,
        compile_result.success,
    )
    stages.append(
        PipelineStage(
            stage="lean_compile",
            attempted=True,
            success=compile_result.success,
            duration_ms=compile_elapsed_ms,
            details={
                "diagnostic_count": len(compile_result.diagnostics),
                "stdout_len": len(compile_result.stdout),
                "stderr_len": len(compile_result.stderr),
            },
        )
    )

    semantic_start = time.perf_counter()
    semantic_validation = run_semantic_validation(
        generated.code,
        compile_result.stdout,
        generated.metadata,
    )
    semantic_elapsed_ms = (time.perf_counter() - semantic_start) * 1000
    logger.info(
        "stage_complete stage=semantic_validation duration_ms=%.2f success=%s collapsed_to_false=%s",
        semantic_elapsed_ms,
        semantic_validation.success,
        semantic_validation.collapsed_to_false,
    )
    stages.append(
        PipelineStage(
            stage="semantic_validation",
            attempted=True,
            success=semantic_validation.success,
            duration_ms=semantic_elapsed_ms,
            details={
                "collapsed_to_false": semantic_validation.collapsed_to_false,
                "declaration_name": semantic_validation.declaration_name,
                "reason_count": len(semantic_validation.reasons),
            },
        )
    )

    if not semantic_validation.success and compile_result.success:
        error_message = (
            semantic_validation.reasons[0]
            if semantic_validation.reasons
            else "Semantic validation failed."
        )
        compile_result.success = False
        compile_result.diagnostics.append(
            Diagnostic(
                severity="error",
                message=error_message,
                raw=error_message,
            )
        )
        if compile_result.stderr:
            compile_result.stderr = f"{compile_result.stderr.rstrip()}\n{error_message}"
        else:
            compile_result.stderr = error_message

    interpretation = None
    interpretation_error: str | None = None
    llm_attempted = False

    if (
        not compile_result.success
        and settings.enable_llm_interpretation
        and not semantic_validation.collapsed_to_false
    ):
        llm_attempted = True
        llm_start = time.perf_counter()
        try:
            interpretation = await interpret_errors(
                generated.code,
                compile_result,
                payload.nl_input,
                settings=settings,
            )
            llm_elapsed_ms = (time.perf_counter() - llm_start) * 1000
            logger.info(
                "stage_complete stage=llm_interpretation duration_ms=%.2f success=true",
                llm_elapsed_ms,
            )
            stages.append(
                PipelineStage(
                    stage="llm_interpretation",
                    attempted=True,
                    success=True,
                    duration_ms=llm_elapsed_ms,
                    details={"item_count": len(interpretation.items)},
                )
            )
        except Exception as exc:  # pragma: no cover - broad to keep endpoint resilient
            interpretation_error = str(exc)
            llm_elapsed_ms = (time.perf_counter() - llm_start) * 1000
            logger.warning(
                "stage_complete stage=llm_interpretation duration_ms=%.2f success=false error=%s",
                llm_elapsed_ms,
                exc,
            )
            stages.append(
                PipelineStage(
                    stage="llm_interpretation",
                    attempted=True,
                    success=False,
                    duration_ms=llm_elapsed_ms,
                    details={"error": str(exc)},
                )
            )
    elif not compile_result.success and semantic_validation.collapsed_to_false:
        logger.info("stage_skipped stage=llm_interpretation reason=semantic_false")
        stages.append(
            PipelineStage(
                stage="llm_interpretation",
                attempted=False,
                success=None,
                duration_ms=None,
                details={"reason": "semantic_false"},
            )
        )
    elif not compile_result.success:
        logger.info("stage_skipped stage=llm_interpretation reason=disabled")
        stages.append(
            PipelineStage(
                stage="llm_interpretation",
                attempted=False,
                success=None,
                duration_ms=None,
                details={"reason": "disabled"},
            )
        )
    else:
        logger.info("stage_skipped stage=llm_interpretation reason=compile_success")
        stages.append(
            PipelineStage(
                stage="llm_interpretation",
                attempted=False,
                success=None,
                duration_ms=None,
                details={"reason": "compile_success"},
            )
        )

    pipeline_elapsed_ms = (time.perf_counter() - pipeline_start) * 1000
    logger.info(
        "pipeline_complete duration_ms=%.2f compile_success=%s llm_attempted=%s",
        pipeline_elapsed_ms,
        compile_result.success,
        llm_attempted,
    )

    return SolveResponse(
        lean_code=generated.code,
        compile=compile_result,
        interpretation=interpretation,
        interpretation_error=interpretation_error,
        pipeline=PipelineTrace(
            total_duration_ms=pipeline_elapsed_ms,
            stages=stages,
            semantic=semantic_validation,
        ),
    )
