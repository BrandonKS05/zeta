from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, HTTPException, Request

from .lean_compile import compile_lean
from .llm_client import interpret_errors
from .modal_client import ModalClientError, generate_lean
from .models import SolveRequest, SolveResponse
from .settings import get_settings
from .utils import configure_logging, request_id_ctx

settings = get_settings()
configure_logging(settings.log_level)
logger = logging.getLogger(__name__)

app = FastAPI(title="Lean Solver Backend", version="0.1.0")


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


@app.post("/v1/lean/solve", response_model=SolveResponse)
async def solve_lean(payload: SolveRequest) -> SolveResponse:
    logger.info("received solve request")
    pipeline_start = time.perf_counter()

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

    compile_start = time.perf_counter()
    compile_result = await compile_lean(generated.code, settings=settings)
    compile_elapsed_ms = (time.perf_counter() - compile_start) * 1000
    logger.info(
        "stage_complete stage=lean_compile duration_ms=%.2f success=%s",
        compile_elapsed_ms,
        compile_result.success,
    )

    interpretation = None
    interpretation_error: str | None = None
    llm_attempted = False

    if not compile_result.success and settings.enable_llm_interpretation:
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
        except Exception as exc:  # pragma: no cover - broad to keep endpoint resilient
            interpretation_error = str(exc)
            llm_elapsed_ms = (time.perf_counter() - llm_start) * 1000
            logger.warning(
                "stage_complete stage=llm_interpretation duration_ms=%.2f success=false error=%s",
                llm_elapsed_ms,
                exc,
            )
    elif not compile_result.success:
        logger.info("stage_skipped stage=llm_interpretation reason=disabled")
    else:
        logger.info("stage_skipped stage=llm_interpretation reason=compile_success")

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
    )
