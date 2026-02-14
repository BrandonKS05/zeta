from __future__ import annotations

import logging
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
    logger.info(
        "request_started method=%s path=%s request_id=%s",
        request.method,
        request.url.path,
        request_id,
    )
    try:
        response = await call_next(request)
        response.headers["x-request-id"] = request_id
        logger.info(
            "request_completed method=%s path=%s status=%s request_id=%s",
            request.method,
            request.url.path,
            response.status_code,
            request_id,
        )
        return response
    except Exception:
        logger.exception(
            "request_failed method=%s path=%s request_id=%s",
            request.method,
            request.url.path,
            request_id,
        )
        raise
    finally:
        request_id_ctx.reset(token)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/lean/solve", response_model=SolveResponse)
async def solve_lean(payload: SolveRequest) -> SolveResponse:
    logger.info("received solve request request_id=%s", request_id_ctx.get())

    try:
        generated = await generate_lean(
            payload.nl_input,
            context=payload.context,
            max_iters=payload.max_iters,
            settings=settings,
        )
    except ModalClientError as exc:
        logger.exception("modal generation failed")
        raise HTTPException(status_code=502, detail=f"Modal generation failed: {exc}") from exc

    compile_result = await compile_lean(generated.code, settings=settings)

    interpretation = None
    interpretation_error: str | None = None

    if not compile_result.success and settings.enable_llm_interpretation:
        try:
            interpretation = await interpret_errors(generated.code, compile_result, settings=settings)
        except Exception as exc:  # pragma: no cover - broad to keep endpoint resilient
            interpretation_error = str(exc)
            logger.warning("llm interpretation failed: %s", exc)

    return SolveResponse(
        lean_code=generated.code,
        compile=compile_result,
        interpretation=interpretation,
        interpretation_error=interpretation_error,
    )
