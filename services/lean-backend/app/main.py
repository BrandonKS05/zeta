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
from .llm_client import (
    explain_issue_chat,
    interpret_errors,
    repair_lean_compile_errors,
    repair_lean_def_check,
)
from .modal_client import ModalClientError, generate_lean
from .models import (
    ChatExplainRequest,
    ChatExplainResponse,
    CompileResult,
    DashboardAdvice,
    Diagnostic,
    GeneratedLean,
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

# Console log env-derived settings at startup so you can verify they exist
_env_line = (
    f"env_check ENABLE_LLM_INTERPRETATION={settings.enable_llm_interpretation} "
    f"LLM_MODEL={settings.llm_model or '(none)'} LLM_API_KEY_set={bool(settings.llm_api_key)} "
    f"LLM_ENDPOINT_URL={settings.llm_endpoint_url or '(default)'} "
    f"MODAL_ENDPOINT_URL={settings.modal_endpoint_url or '(none)'} "
    f"LAKE_PROJECT_DIR={settings.lake_project_dir or '(none)'}"
)
print(_env_line, flush=True)
logger.info("%s", _env_line)

app = FastAPI(title="Lean Solver Backend", version="0.1.0")

_FALSE_DECL_RE = re.compile(
    r"(?m)^\s*(?:axiom|theorem|lemma)\s+(?P<name>[A-Za-z0-9_'.]+)\s*:\s*False(?:\b|$)"
)
_FALSE_STDOUT_RE = re.compile(
    r"^\s*(?P<name>[A-Za-z0-9_'.]+)(?:\s*\([^)]*\))*\s*:\s*False\s*$"
)
_LEAN_CANONICAL_REPLACEMENTS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\\mathbb\s*\{\s*N\s*\}", re.IGNORECASE), "Nat"),
    (re.compile(r"\\mathbb\s*\{\s*Z\s*\}", re.IGNORECASE), "Int"),
    (re.compile(r"\\mathbb\s*\{\s*Q\s*\}", re.IGNORECASE), "Rat"),
    (re.compile(r"\\mathbb\s*\{\s*R\s*\}", re.IGNORECASE), "Real"),
)
_LEAN_UNICODE_SET_REPLACEMENTS = {
    "ℕ": "Nat",
    "ℤ": "Int",
    "ℚ": "Rat",
    "ℝ": "Real",
}


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


def _normalize_suggestion_list(raw_value: Any) -> list[str]:
    if isinstance(raw_value, str):
        value = raw_value.strip()
        return [value] if value else []
    if not isinstance(raw_value, list):
        return []
    suggestions: list[str] = []
    for item in raw_value:
        value = str(item).strip()
        if value:
            suggestions.append(value)
    return suggestions


def _normalize_generated_lean_code(code: str) -> str:
    normalized = code
    for pattern, replacement in _LEAN_CANONICAL_REPLACEMENTS:
        normalized = pattern.sub(replacement, normalized)
    for source, replacement in _LEAN_UNICODE_SET_REPLACEMENTS.items():
        normalized = normalized.replace(source, replacement)
    return normalized


def _interpretation_from_modal_metadata(modal_metadata: dict[str, Any] | None) -> Interpretation | None:
    metadata = modal_metadata or {}
    raw_interpretation = metadata.get("interpretation")
    merged_suggestions = list(
        dict.fromkeys(
            [
                *_normalize_suggestion_list(metadata.get("final_feedback")),
                *_normalize_suggestion_list(metadata.get("feedback")),
            ]
        )
    )

    if isinstance(raw_interpretation, dict):
        try:
            interpreted = Interpretation.model_validate(raw_interpretation)
        except Exception:  # pragma: no cover - keep pipeline resilient to metadata drift
            interpreted = None
        if interpreted is not None:
            merged = list(dict.fromkeys([*interpreted.suggestions, *merged_suggestions]))
            if merged != interpreted.suggestions:
                interpreted = interpreted.model_copy(update={"suggestions": merged})
            return interpreted

    if not merged_suggestions:
        return None

    return Interpretation(
        summary=merged_suggestions[0],
        items=[],
        suggestions=merged_suggestions,
    )


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
    has_semantic_findings = bool(
        compile_result.success
        and semantic_validation.success
        and interpretation is not None
        and interpretation.items
    )

    if compile_result.success and semantic_validation.success and not has_semantic_findings:
        return DashboardAdvice(
            status="ok",
            headline="Lean compiled successfully.",
            messages=[],
            next_actions=[],
        )

    if semantic_validation.collapsed_to_false:
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
    if has_semantic_findings and interpretation is not None:
        for item in interpretation.items[:3]:
            text = item.error.strip()
            if text and text not in messages:
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
    message = issue.message or "Lean reported a mathematical/formalization issue."
    severity = issue.severity or "unknown"
    category = issue.category or "issue"
    question = payload.question.strip()

    # Build one or two flowing paragraphs that answer the user's question.
    intro: list[str] = []
    intro.append(message.rstrip("."))
    intro.append(f"This is classified as {severity} in category \"{category}\".")
    if issue.sentence:
        intro.append(f"The sentence in question is: \"{issue.sentence}\".")
    if issue.target_text:
        intro.append(f"The relevant span is: \"{issue.target_text}\".")

    if issue.compile_success is False:
        intro.append(
            "Lean did not compile this sentence, so the statement or proof is inconsistent with Lean's rules."
        )
    elif issue.compile_success is True and severity == "error":
        intro.append(
            "Lean compiled, but the result is still marked as an error, often because a semantic check failed (e.g. the proposition reduced to False)."
        )

    diag_bits: list[str] = []
    for diag in issue.diagnostics[:3]:
        loc = ""
        if diag.line is not None and diag.column is not None:
            loc = f" at line {diag.line}, column {diag.column}"
        diag_bits.append(f"{diag.message}{loc}")
    if diag_bits:
        intro.append("The compiler reports: " + "; ".join(diag_bits) + ".")
    for reason in (issue.semantic_reasons or [])[:3]:
        if reason:
            intro.append(reason.rstrip(".") + ".")

    next_step: str
    if issue.replacement:
        next_step = f"A good next step is to try: {issue.replacement}"
    elif issue.target_text:
        next_step = "Restate the marked span in stricter mathematical terms and re-run the checker"
    else:
        next_step = "Simplify the sentence into one clear claim with explicit quantifiers or types, then re-run"
    intro.append(next_step + ".")
    intro.append(f"To answer your question (\"{question}\"): the failure is due to the above; " + next_step + ".")

    return " ".join(intro)


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
        "chat explain request: severity=%s category=%s question_len=%s history_len=%s",
        payload.issue.severity,
        payload.issue.category,
        len(payload.question or ""),
        len(payload.history or []),
    )
    started_at = time.perf_counter()
    source: str = "deterministic"
    answer: str
    model: str | None = None
    fallback_reason: str | None = None

    llm_enabled = settings.enable_llm_interpretation and bool(settings.llm_model)
    logger.info(
        "chat explain llm config: enable_llm=%s llm_model=%s has_llm_api_key=%s",
        settings.enable_llm_interpretation,
        settings.llm_model or "(none)",
        bool(settings.llm_api_key),
    )
    if llm_enabled:
        try:
            answer = await explain_issue_chat(payload, settings=settings)
            source = "llm"
            model = settings.llm_model
            logger.info("chat explain llm success model=%s answer_len=%s", model, len(answer or ""))
        except Exception as exc:  # pragma: no cover - endpoint resilience
            fallback_reason = str(exc)
            logger.warning(
                "chat explain llm failed, using deterministic fallback: %s",
                exc,
                exc_info=True,
            )
            answer = build_deterministic_chat_answer(payload)
    else:
        logger.info("chat explain llm disabled, using deterministic answer")
        answer = build_deterministic_chat_answer(payload)

    latency_ms = (time.perf_counter() - started_at) * 1000
    logger.info(
        "chat explain complete: source=%s latency_ms=%.2f fallback_reason=%s answer_len=%s",
        source,
        latency_ms,
        fallback_reason or "(none)",
        len(answer or ""),
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
    modal_status = str(metadata.get("status") or "").strip().lower()
    modal_is_unchecked = modal_status == "unchecked"
    if modal_valid is False and not modal_is_unchecked:
        reasons.append("Modal metadata reported is_valid_lean=false.")

    success = not collapsed_to_false and (modal_valid is not False or modal_is_unchecked)
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
        generated = generated.model_copy(update={"code": _normalize_generated_lean_code(generated.code)})
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

    # If the first compile failed, try once to fix with LLM (e.g. GPT 5.3): syntactical fixes only, then recompile.
    if (
        not compile_result.success
        and settings.enable_llm_interpretation
        and settings.llm_model
    ):
        repair_start = time.perf_counter()
        try:
            repaired = await repair_lean_compile_errors(
                generated.code,
                compile_result,
                settings=settings,
            )
            repair_elapsed_ms = (time.perf_counter() - repair_start) * 1000
            if repaired:
                compile_repaired = await compile_lean(repaired, settings=settings)
                if compile_repaired.success:
                    generated = GeneratedLean(code=repaired, metadata=generated.metadata)
                    compile_result = compile_repaired
                    stages.append(
                        PipelineStage(
                            stage="llm_repair_compile",
                            attempted=True,
                            success=True,
                            duration_ms=repair_elapsed_ms,
                            details={"reason": "syntactical_fix_then_recompile"},
                        )
                    )
                else:
                    stages.append(
                        PipelineStage(
                            stage="llm_repair_compile",
                            attempted=True,
                            success=False,
                            duration_ms=repair_elapsed_ms,
                            details={"reason": "repaired_but_still_fails"},
                        )
                    )
            else:
                stages.append(
                    PipelineStage(
                        stage="llm_repair_compile",
                        attempted=True,
                        success=False,
                        duration_ms=repair_elapsed_ms,
                        details={"reason": "llm_returned_nothing"},
                    )
                )
        except Exception:  # noqa: BLE001
            repair_elapsed_ms = (time.perf_counter() - repair_start) * 1000
            stages.append(
                PipelineStage(
                    stage="llm_repair_compile",
                    attempted=True,
                    success=False,
                    duration_ms=repair_elapsed_ms,
                    details={"reason": "exception"},
                )
            )

    # If compile failed with def-without-body / #check error and we didn't use thinking mode,
    # retry once with iteration loop so refinement can fix the statement.
    def _is_def_check_compile_error(code: str, result: CompileResult) -> bool:
        if result.success:
            return False
        err = " ".join(d.raw or d.message for d in result.diagnostics).lower()
        # Match common Lean errors: incomplete def (expected ':=', 'where' or '|'), #check token, etc.
        err_matches = (
            "expected ':=" in err
            or "expected 'where'" in err
            or "expected '|'" in err
            or "#check" in err
            or "unexpected token" in err
            or "incomplete def" in err
        )
        if not err_matches:
            return False
        # Code has a def (possibly noncomputable/unsafe/partial) and/or #check
        code_lower = code.lower()
        has_def = "def " in code_lower or "noncomputable def" in code_lower
        has_check = "#check" in code
        return has_def or has_check

    retry_with_thinking = (
        not compile_result.success
        and payload.max_iters <= 1
        and _is_def_check_compile_error(generated.code, compile_result)
    )
    if retry_with_thinking:
        thinking_context = {**(payload.context or {}), "mode": "thinking"}
        try:
            generated_retry = await generate_lean(
                payload.nl_input,
                context=thinking_context,
                max_iters=3,
                settings=settings,
            )
            generated_retry = generated_retry.model_copy(
                update={"code": _normalize_generated_lean_code(generated_retry.code)}
            )
            compile_retry = await compile_lean(generated_retry.code, settings=settings)
            if compile_retry.success or not _is_def_check_compile_error(
                generated_retry.code, compile_retry
            ):
                generated = generated_retry
                compile_result = compile_retry
                stages.append(
                    PipelineStage(
                        stage="modal_retry_thinking",
                        attempted=True,
                        success=compile_retry.success,
                        duration_ms=0,
                        details={
                            "reason": "def_header_fix",
                            "resolved": compile_retry.success,
                        },
                    )
                )
        except Exception:  # noqa: BLE001
            pass

    # If the fast /v1/generate path still returns malformed def/#check output,
    # force one retry against /v1/analyze for higher reliability.
    force_retry_with_analyze = (
        not compile_result.success
        and payload.max_iters <= 1
        and _is_def_check_compile_error(generated.code, compile_result)
    )
    if force_retry_with_analyze:
        analyze_settings = settings.model_copy(update={"modal_use_generate_endpoint": False})
        analyze_context = {**(payload.context or {}), "mode": "fast"}
        try:
            generated_analyze = await generate_lean(
                payload.nl_input,
                context=analyze_context,
                max_iters=1,
                settings=analyze_settings,
            )
            generated_analyze = generated_analyze.model_copy(
                update={"code": _normalize_generated_lean_code(generated_analyze.code)}
            )
            compile_analyze = await compile_lean(generated_analyze.code, settings=settings)
            if compile_analyze.success or not _is_def_check_compile_error(
                generated_analyze.code, compile_analyze
            ):
                generated = generated_analyze
                compile_result = compile_analyze
                stages.append(
                    PipelineStage(
                        stage="modal_retry_analyze",
                        attempted=True,
                        success=compile_analyze.success,
                        duration_ms=0,
                        details={
                            "reason": "force_analyze_endpoint",
                            "resolved": compile_analyze.success,
                        },
                    )
                )
        except Exception:  # noqa: BLE001
            pass

    # If still failing with def/#check error, try one LLM repair pass to fix the Lean code.
    if (
        not compile_result.success
        and settings.enable_llm_interpretation
        and _is_def_check_compile_error(generated.code, compile_result)
    ):
        diag_msg = (
            compile_result.diagnostics[0].message
            if compile_result.diagnostics
            else "unexpected token '#check'; expected ':=', 'where' or '|'"
        )
        try:
            repaired = await repair_lean_def_check(
                generated.code,
                diag_msg,
                settings=settings,
            )
            if repaired:
                compile_repaired = await compile_lean(repaired, settings=settings)
                if compile_repaired.success:
                    generated = GeneratedLean(code=repaired, metadata=generated.metadata)
                    compile_result = compile_repaired
                    stages.append(
                        PipelineStage(
                            stage="llm_repair_def_check",
                            attempted=True,
                            success=True,
                            duration_ms=0,
                            details={"reason": "def_check_fixed"},
                        )
                    )
        except Exception:  # noqa: BLE001
            pass

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

    interpretation = _interpretation_from_modal_metadata(generated.metadata)
    interpretation_error: str | None = None
    llm_attempted = False

    if (
        not compile_result.success
        and interpretation is not None
        and interpretation.items
    ):
        logger.info(
            "stage_skipped stage=llm_interpretation reason=modal_metadata item_count=%s",
            len(interpretation.items),
        )
        stages.append(
            PipelineStage(
                stage="llm_interpretation",
                attempted=False,
                success=None,
                duration_ms=None,
                details={"reason": "modal_metadata", "item_count": len(interpretation.items)},
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
        skip_reason = "compile_success"
        if interpretation is not None and interpretation.items:
            skip_reason = "modal_metadata"
        logger.info("stage_skipped stage=llm_interpretation reason=%s", skip_reason)
        stages.append(
            PipelineStage(
                stage="llm_interpretation",
                attempted=False,
                success=None,
                duration_ms=None,
                details={"reason": skip_reason},
            )
        )

    highlights: HighlightResolveResponse | None = None
    should_resolve_highlights = (not compile_result.success) or bool(
        interpretation is not None and interpretation.items
    )
    if should_resolve_highlights:
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
