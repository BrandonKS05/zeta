from __future__ import annotations

import logging
import re
import time
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Request

from .highlight_llm import resolve_highlights_with_llm
from .highlight_locator import resolve_highlights
from .lean_compile import compile_lean
from .llm_client import explain_issue_chat, interpret_errors
from .modal_client import ModalClientError, generate_lean
from .models import (
    ChatExplainRequest,
    ChatExplainResponse,
    DashboardAdvice,
    Diagnostic,
    HighlightChunk,
    HighlightResolveRequest,
    HighlightResolveResponse,
    HighlightSentence,
    Interpretation,
    InterpretationItem,
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
_AXIOM_DECL_RE = re.compile(r"(?m)^\s*axiom\s+(?P<name>[A-Za-z0-9_'.]+)\b")


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


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _parse_sentences(raw_sentences: Any) -> list[HighlightSentence]:
    if not isinstance(raw_sentences, list):
        return []
    parsed: list[HighlightSentence] = []
    for raw in raw_sentences:
        if not isinstance(raw, dict):
            continue
        sentence_id = raw.get("sentence_id") or raw.get("sentenceId")
        parsed.append(
            HighlightSentence(
                sentence_id=str(sentence_id) if sentence_id else None,
                start=_as_int(raw.get("start")),
                end=_as_int(raw.get("end")),
                text=str(raw.get("text")) if raw.get("text") is not None else None,
            )
        )
    return parsed


def _parse_chunks_from_context(context: dict[str, Any], nl_input: str) -> list[HighlightChunk]:
    raw_chunks = context.get("chunks")
    chunks: list[HighlightChunk] = []

    if isinstance(raw_chunks, list):
        for idx, raw in enumerate(raw_chunks):
            if not isinstance(raw, dict):
                continue
            chunk_id_raw = raw.get("chunk_id") or raw.get("chunkId") or f"chunk-{idx + 1}"
            chunk_id = str(chunk_id_raw).strip() or f"chunk-{idx + 1}"
            text = str(raw.get("text")) if raw.get("text") is not None else ""
            start = _as_int(raw.get("start"))
            if start is None:
                start = 0
            end = _as_int(raw.get("end"))
            if end is None:
                end = start + len(text)
            parent_id_raw = raw.get("parent_id") or raw.get("parentId")
            parent_id = str(parent_id_raw) if parent_id_raw is not None else None
            chunks.append(
                HighlightChunk(
                    chunk_id=chunk_id,
                    text=text,
                    start=start,
                    end=end,
                    parent_id=parent_id,
                    sentences=_parse_sentences(raw.get("sentences")),
                )
            )

    if chunks:
        return chunks

    chunk_id = str(context.get("chunk_id") or context.get("chunkId") or "input").strip() or "input"
    chunk_start = _as_int(context.get("chunk_start") or context.get("chunkStart")) or 0
    return [
        HighlightChunk(
            chunk_id=chunk_id,
            text=nl_input,
            start=chunk_start,
            end=chunk_start + len(nl_input),
            sentences=[],
        )
    ]


def _build_highlight_interpretation(
    interpretation: Interpretation | None,
    compile_result,
    semantic_validation: SemanticValidation,
) -> Interpretation:
    if interpretation is not None:
        return interpretation

    items: list[InterpretationItem] = []
    for diag in compile_result.diagnostics:
        if diag.severity not in {"error", "unknown"}:
            continue
        items.append(
            InterpretationItem(
                error=diag.message,
                source="lean",
                lean_line=diag.line,
                lean_column=diag.column,
            )
        )

    if not items and semantic_validation.reasons:
        for reason in semantic_validation.reasons:
            items.append(InterpretationItem(error=reason, source="unknown"))

    if not items and compile_result.stderr.strip():
        first_line = compile_result.stderr.strip().splitlines()[0]
        items.append(InterpretationItem(error=first_line, source="lean"))

    summary = items[0].error if items else "Lean compilation failed."
    return Interpretation(summary=summary, items=items, suggestions=[])


async def _resolve_highlights_for_request(
    request: HighlightResolveRequest,
) -> HighlightResolveResponse:
    if not request.interpretation.items:
        return HighlightResolveResponse(resolver="deterministic")

    llm_configured = bool(settings.llm_model) and (
        bool(settings.llm_api_key)
        or bool(settings.llm_endpoint_url)
        or settings.llm_base_url.rstrip("/") != "https://api.openai.com/v1"
    )

    if settings.enable_llm_highlights and llm_configured:
        try:
            return await resolve_highlights_with_llm(request, settings=settings)
        except Exception as exc:  # pragma: no cover - keep pipeline resilient
            logger.warning("highlight llm failed, falling back to deterministic: %s", exc)
            fallback = resolve_highlights(request)
            fallback.resolver = "deterministic"
            fallback.resolver_error = str(exc)
            return fallback

    return resolve_highlights(request)


def _format_diagnostic_message(diag: Diagnostic) -> str:
    location = ""
    if diag.line is not None and diag.column is not None:
        location = f" (L{diag.line}:C{diag.column})"
    return f"{diag.message}{location}"


def build_dashboard_advice(
    *,
    compile_result,
    interpretation: Interpretation | None,
    interpretation_error: str | None,
    semantic_validation: SemanticValidation,
    highlights: HighlightResolveResponse | None,
) -> DashboardAdvice:
    if compile_result.success and semantic_validation.success:
        return DashboardAdvice(
            status="ok",
            headline="Lean compiled successfully.",
            messages=[],
            next_actions=[],
        )

    if semantic_validation.unverified_by_policy:
        headline = "Lean statement is unverified by policy."
    elif semantic_validation.collapsed_to_false:
        headline = "Generated Lean statement collapsed to False."
    elif interpretation and interpretation.summary:
        headline = interpretation.summary
    elif compile_result.diagnostics:
        headline = compile_result.diagnostics[0].message
    else:
        headline = "Lean compilation failed."

    messages: list[str] = []
    for reason in semantic_validation.reasons[:3]:
        if reason and reason not in messages:
            messages.append(reason)
    for diag in compile_result.diagnostics[:3]:
        text = _format_diagnostic_message(diag)
        if text not in messages:
            messages.append(text)
    if interpretation_error:
        messages.append(f"Interpretation fallback: {interpretation_error}")
    if highlights and highlights.unresolved_items:
        messages.append(
            f"{len(highlights.unresolved_items)} issue(s) were not mapped to exact text spans."
        )

    next_actions: list[str] = []
    if interpretation:
        for suggestion in interpretation.suggestions:
            suggestion_text = suggestion.strip()
            if suggestion_text and suggestion_text not in next_actions:
                next_actions.append(suggestion_text)
            if len(next_actions) >= 5:
                break
    if not next_actions and not compile_result.success:
        next_actions = [
            "Review highlighted text spans first.",
            "Apply one suggested Lean edit and re-run.",
            "If unresolved, simplify the natural-language statement.",
        ]

    return DashboardAdvice(
        status="error" if not compile_result.success else "warning",
        headline=headline,
        messages=messages,
        next_actions=next_actions,
    )


def build_deterministic_chat_answer(payload: ChatExplainRequest) -> str:
    issue = payload.issue
    diagnosis = issue.message or "Lean reported a mathematical/formalization issue."
    severity = issue.severity or "unknown"
    category = issue.category or "issue"
    question = payload.question.strip()

    lines: list[str] = []
    lines.append(f"Diagnosis: {diagnosis}")
    lines.append(f"This is classified as {severity} in category '{category}'.")

    if issue.sentence:
        lines.append(f"Sentence under review: {issue.sentence}")
    if issue.target_text:
        lines.append(f"Relevant text span: {issue.target_text}")

    if issue.compile_success is False:
        lines.append(
            "Lean compilation for this sentence did not succeed, so the generated statement or proof term is inconsistent with Lean's rules."
        )
    elif issue.compile_success is True and severity == "error":
        lines.append(
            "Lean compiled but this is still marked as an error, usually due to semantic checks (for example, collapsing to False)."
        )

    diagnostics = issue.diagnostics[:3]
    if diagnostics:
        lines.append("Compiler diagnostics:")
        for diag in diagnostics:
            location = ""
            if diag.line is not None and diag.column is not None:
                location = f" (L{diag.line}:C{diag.column})"
            lines.append(f"- {diag.message}{location}")

    if issue.semantic_reasons:
        lines.append("Semantic validation notes:")
        for reason in issue.semantic_reasons[:3]:
            if reason:
                lines.append(f"- {reason}")

    if issue.replacement:
        lines.append(f"Suggested rewrite to try next: {issue.replacement}")
    elif issue.target_text:
        lines.append(
            "Suggested next step: restate the marked span in stricter mathematical terms and re-run the checker."
        )
    else:
        lines.append(
            "Suggested next step: simplify the sentence into one claim with explicit quantifiers/types, then re-run."
        )

    lines.append(f"Answer to your question: {question}")
    return "\n".join(lines)


@app.post("/v1/lean/highlights", response_model=HighlightResolveResponse)
async def resolve_highlights_endpoint(payload: HighlightResolveRequest) -> HighlightResolveResponse:
    logger.info(
        "received highlight resolve request chunk_count=%s interpretation_items=%s",
        len(payload.chunks),
        len(payload.interpretation.items),
    )
    started_at = time.perf_counter()
    response = await _resolve_highlights_for_request(payload)
    duration_ms = (time.perf_counter() - started_at) * 1000
    logger.info(
        "highlight resolve complete duration_ms=%.2f resolver=%s resolved_items=%s unresolved_items=%s",
        duration_ms,
        response.resolver,
        len(response.highlights),
        len(response.unresolved_items),
    )
    return response


@app.post("/v1/chat/explain", response_model=ChatExplainResponse)
async def explain_chat_issue_endpoint(payload: ChatExplainRequest) -> ChatExplainResponse:
    logger.info(
        "received chat explain request severity=%s category=%s",
        payload.issue.severity,
        payload.issue.category,
    )
    started_at = time.perf_counter()
    source: str = "deterministic"
    answer: str
    model: str | None = None
    fallback_reason: str | None = None

    llm_enabled = settings.enable_llm_interpretation and bool(settings.llm_model)
    if llm_enabled:
        try:
            answer = await explain_issue_chat(payload, settings=settings)
            source = "llm"
            model = settings.llm_model
        except Exception as exc:  # pragma: no cover - endpoint resilience
            fallback_reason = str(exc)
            logger.warning("chat llm explanation failed, using deterministic fallback: %s", exc)
            answer = build_deterministic_chat_answer(payload)
    else:
        answer = build_deterministic_chat_answer(payload)

    latency_ms = (time.perf_counter() - started_at) * 1000
    logger.info(
        "chat explain complete source=%s latency_ms=%.2f fallback=%s",
        source,
        latency_ms,
        bool(fallback_reason),
    )
    return ChatExplainResponse(
        answer=answer,
        source=source,
        latency_ms=latency_ms,
        model=model,
        fallback_reason=fallback_reason,
    )


def run_semantic_validation(
    generated_code: str,
    compile_stdout: str,
    modal_metadata: dict[str, object] | None,
    *,
    require_proof_terms: bool,
) -> SemanticValidation:
    reasons: list[str] = []
    declaration_name: str | None = None
    collapsed_to_false = False
    unverified_by_policy = False
    unverified_preview: str | None = None

    if require_proof_terms:
        axiom_names = [
            match.group("name")
            for match in _AXIOM_DECL_RE.finditer(generated_code)
            if match.group("name")
        ]
        if axiom_names:
            unverified_by_policy = True
            preview = ", ".join(axiom_names[:3])
            if len(axiom_names) > 3:
                preview = f"{preview}, ..."
            unverified_preview = preview

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
    modal_status = str(metadata.get("status") or "").strip().lower()
    modal_is_unchecked = modal_status == "unchecked"
    if modal_valid is False and not modal_is_unchecked:
        reasons.append("Modal metadata reported is_valid_lean=false.")
    if unverified_by_policy:
        reasons.append(
            f"Generated Lean uses axiom declaration(s): {unverified_preview}. Treated as unverified by policy."
        )

    success = (
        not collapsed_to_false
        and not unverified_by_policy
        and (modal_valid is not False or modal_is_unchecked)
    )
    return SemanticValidation(
        success=success,
        collapsed_to_false=collapsed_to_false,
        unverified_by_policy=unverified_by_policy,
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
        require_proof_terms=bool(settings.require_proof_terms),
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
                "unverified_by_policy": semantic_validation.unverified_by_policy,
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

    if not compile_result.success and semantic_validation.collapsed_to_false:
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
    elif not compile_result.success and semantic_validation.unverified_by_policy:
        logger.info("stage_skipped stage=llm_interpretation reason=unverified_policy")
        stages.append(
            PipelineStage(
                stage="llm_interpretation",
                attempted=False,
                success=None,
                duration_ms=None,
                details={"reason": "unverified_policy"},
            )
        )
    elif (
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

    highlights: HighlightResolveResponse | None = None
    if not compile_result.success:
        highlight_start = time.perf_counter()
        highlight_chunks = _parse_chunks_from_context(payload.context, payload.nl_input)
        active_chunk_id = str(
            payload.context.get("active_chunk_id")
            or payload.context.get("activeChunkId")
            or highlight_chunks[0].chunk_id
        )
        highlight_interpretation = _build_highlight_interpretation(
            interpretation,
            compile_result,
            semantic_validation,
        )
        highlight_request = HighlightResolveRequest(
            chunks=highlight_chunks,
            interpretation=highlight_interpretation,
            active_chunk_id=active_chunk_id,
        )
        highlights = await _resolve_highlights_for_request(highlight_request)
        highlight_elapsed_ms = (time.perf_counter() - highlight_start) * 1000
        logger.info(
            "stage_complete stage=highlight_resolution duration_ms=%.2f resolver=%s resolved=%s unresolved=%s",
            highlight_elapsed_ms,
            highlights.resolver,
            len(highlights.highlights),
            len(highlights.unresolved_items),
        )
        stages.append(
            PipelineStage(
                stage="highlight_resolution",
                attempted=True,
                success=True,
                duration_ms=highlight_elapsed_ms,
                details={
                    "resolver": highlights.resolver,
                    "resolved_count": len(highlights.highlights),
                    "unresolved_count": len(highlights.unresolved_items),
                    "resolver_error": highlights.resolver_error,
                },
            )
        )
    else:
        logger.info("stage_skipped stage=highlight_resolution reason=compile_success")
        stages.append(
            PipelineStage(
                stage="highlight_resolution",
                attempted=False,
                success=None,
                duration_ms=None,
                details={"reason": "compile_success"},
            )
        )
        highlights = HighlightResolveResponse(
            highlights=[],
            items=[],
            unresolved_items=[],
            resolver="deterministic",
            resolver_error=None,
        )

    dashboard = build_dashboard_advice(
        compile_result=compile_result,
        interpretation=interpretation,
        interpretation_error=interpretation_error,
        semantic_validation=semantic_validation,
        highlights=highlights,
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
        highlights=highlights,
        dashboard=dashboard,
        pipeline=PipelineTrace(
            total_duration_ms=pipeline_elapsed_ms,
            stages=stages,
            semantic=semantic_validation,
        ),
    )
