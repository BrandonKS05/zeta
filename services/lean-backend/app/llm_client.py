from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from .models import CompileResult, Interpretation, InterpretationItem
from .settings import Settings, get_settings
from .utils import extract_json_object, retry_async, truncate_text

logger = logging.getLogger(__name__)


class LLMClientError(RuntimeError):
    """Raised when LLM interpretation fails."""


class _RetriableLLMError(LLMClientError):
    pass


_ALLOWED_SOURCES = {"latex", "lean", "both", "unknown"}


def _endpoint_url(settings: Settings) -> str:
    return f"{settings.llm_base_url.rstrip('/')}/chat/completions"


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


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _as_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _normalize_latex_span(raw_item: dict[str, Any], nl_input: str) -> tuple[int | None, int | None, str | None]:
    start = _as_int(raw_item.get("latex_start"))
    if start is None:
        start = _as_int(raw_item.get("start"))

    end = _as_int(raw_item.get("latex_end"))
    if end is None:
        end = _as_int(raw_item.get("end"))

    excerpt = (
        _as_str(raw_item.get("latex_excerpt"))
        or _as_str(raw_item.get("source_excerpt"))
        or _as_str(raw_item.get("excerpt"))
    )

    text_len = len(nl_input)

    if start is not None and end is not None and 0 <= start < end <= text_len:
        if excerpt is None:
            excerpt = nl_input[start:end]
        return start, end, excerpt

    if excerpt:
        idx = nl_input.find(excerpt)
        if idx != -1:
            return idx, idx + len(excerpt), excerpt

    if start is not None and excerpt and 0 <= start < text_len:
        candidate_end = start + len(excerpt)
        if candidate_end <= text_len:
            return start, candidate_end, excerpt

    return None, None, excerpt


def _normalize_item(
    raw_item: dict[str, Any],
    *,
    nl_input: str,
    fallback_line: int | None,
    fallback_col: int | None,
    fallback_error: str | None,
) -> InterpretationItem:
    error = (
        _as_str(raw_item.get("error"))
        or _as_str(raw_item.get("message"))
        or fallback_error
        or "Lean compilation error"
    )

    probable_cause = (
        _as_str(raw_item.get("probable_cause"))
        or _as_str(raw_item.get("cause"))
        or _as_str(raw_item.get("why"))
    )
    suggested_fix = (
        _as_str(raw_item.get("suggested_fix"))
        or _as_str(raw_item.get("fix"))
        or _as_str(raw_item.get("edit_hint"))
    )
    replacement = (
        _as_str(raw_item.get("replacement"))
        or _as_str(raw_item.get("replace_with"))
        or _as_str(raw_item.get("rewrite"))
    )

    lean_line = _as_int(raw_item.get("lean_line"))
    if lean_line is None:
        lean_line = _as_int(raw_item.get("line"))
    if lean_line is None:
        lean_line = fallback_line

    lean_column = _as_int(raw_item.get("lean_column"))
    if lean_column is None:
        lean_column = _as_int(raw_item.get("column"))
    if lean_column is None:
        lean_column = fallback_col

    latex_start, latex_end, latex_excerpt = _normalize_latex_span(raw_item, nl_input)

    source = _as_str(raw_item.get("source"))
    source_norm = source.lower() if source else None
    if source_norm not in _ALLOWED_SOURCES:
        has_latex = latex_start is not None and latex_end is not None
        has_lean = lean_line is not None
        if has_latex and has_lean:
            source_norm = "both"
        elif has_latex:
            source_norm = "latex"
        elif has_lean:
            source_norm = "lean"
        else:
            source_norm = "unknown"

    confidence = _as_float(raw_item.get("confidence"))
    if confidence is not None:
        confidence = max(0.0, min(1.0, confidence))

    return InterpretationItem(
        error=error,
        probable_cause=probable_cause,
        suggested_fix=suggested_fix,
        source=source_norm,
        latex_start=latex_start,
        latex_end=latex_end,
        latex_excerpt=latex_excerpt,
        lean_line=lean_line,
        lean_column=lean_column,
        replacement=replacement,
        confidence=confidence,
    )


def _normalize_interpretation(
    data: dict[str, Any],
    *,
    nl_input: str,
    compile_result: CompileResult,
) -> Interpretation:
    summary = data.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        summary = "Lean compiler errors detected."

    error_diags = [diag for diag in compile_result.diagnostics if diag.severity == "error"]
    fallback_diags = error_diags or compile_result.diagnostics

    raw_items = data.get("items")
    items: list[InterpretationItem] = []
    if isinstance(raw_items, list):
        for idx, raw_item in enumerate(raw_items):
            if not isinstance(raw_item, dict):
                continue
            fallback = fallback_diags[idx] if idx < len(fallback_diags) else None
            items.append(
                _normalize_item(
                    raw_item,
                    nl_input=nl_input,
                    fallback_line=fallback.line if fallback else None,
                    fallback_col=fallback.column if fallback else None,
                    fallback_error=fallback.message if fallback else None,
                )
            )

    if not items:
        for diag in fallback_diags:
            items.append(
                InterpretationItem(
                    error=diag.message,
                    source="lean",
                    lean_line=diag.line,
                    lean_column=diag.column,
                )
            )

    raw_suggestions = data.get("suggestions")
    suggestions: list[str] = []
    if isinstance(raw_suggestions, list):
        suggestions = [str(s).strip() for s in raw_suggestions if str(s).strip()]

    return Interpretation(summary=summary.strip(), items=items, suggestions=suggestions)


def _extract_message_content(payload: dict[str, Any]) -> str | None:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None

    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return None

    message = first_choice.get("message")
    if not isinstance(message, dict):
        return None

    content = message.get("content")
    return content if isinstance(content, str) else None


async def interpret_errors(
    code: str,
    compile_result: CompileResult,
    nl_input: str,
    *,
    settings: Settings | None = None,
) -> Interpretation:
    settings = settings or get_settings()
    if not settings.enable_llm_interpretation:
        raise LLMClientError("LLM interpretation is disabled")

    if not settings.llm_model:
        raise LLMClientError("LLM_MODEL is not configured")

    endpoint = _endpoint_url(settings)
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    diagnostics_json = json.dumps(
        [diag.model_dump() for diag in compile_result.diagnostics], ensure_ascii=False
    )

    user_prompt = (
        "Interpret this Lean 4 compilation failure for frontend display. "
        "Return JSON only with keys: summary (string), items (array), suggestions (array of short strings). "
        "Each item should include: error, probable_cause, suggested_fix, source (latex|lean|both|unknown), "
        "latex_start (0-based char offset in original NL/LaTeX), latex_end, latex_excerpt, lean_line, lean_column, "
        "replacement (optional edit text), confidence (0-1).\n\n"
        "If you can map the issue to the original NL/LaTeX input, provide accurate latex_start/latex_end. "
        "If uncertain, use null for those fields.\n\n"
        f"Original NL/LaTeX input:\n{truncate_text(nl_input, 8_000)}\n\n"
        f"Lean code:\n{truncate_text(code, 8_000)}\n\n"
        f"Compiler stderr:\n{truncate_text(compile_result.stderr, 8_000)}\n\n"
        f"Compiler stdout:\n{truncate_text(compile_result.stdout, 8_000)}\n\n"
        f"Structured diagnostics:\n{truncate_text(diagnostics_json, 8_000)}"
    )

    payload = {
        "model": settings.llm_model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an expert Lean 4 engineer. Respond only with valid compact JSON."
                ),
            },
            {"role": "user", "content": user_prompt},
        ],
    }

    timeout = httpx.Timeout(settings.llm_timeout_seconds)

    async with httpx.AsyncClient(timeout=timeout) as client:

        async def _call_llm() -> Interpretation:
            try:
                response = await client.post(endpoint, json=payload, headers=headers)
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                raise _RetriableLLMError(f"LLM transport error: {exc}") from exc

            if response.status_code >= 500:
                raise _RetriableLLMError(
                    f"LLM server error {response.status_code}: {response.text[:500]}"
                )
            if response.status_code >= 400:
                raise LLMClientError(
                    f"LLM returned HTTP {response.status_code}: {response.text[:500]}"
                )

            try:
                data = response.json()
            except ValueError as exc:
                raise LLMClientError("LLM returned non-JSON response") from exc

            if isinstance(data, dict) and {"summary", "items", "suggestions"}.issubset(data):
                return _normalize_interpretation(
                    data,
                    nl_input=nl_input,
                    compile_result=compile_result,
                )

            if not isinstance(data, dict):
                raise LLMClientError("LLM response JSON is not an object")

            content = _extract_message_content(data)
            if content is None:
                raise LLMClientError("LLM response missing message content")

            parsed = extract_json_object(content)
            if parsed is None:
                raise LLMClientError("LLM message content was not valid JSON")

            return _normalize_interpretation(
                parsed,
                nl_input=nl_input,
                compile_result=compile_result,
            )

        attempts = max(1, settings.llm_max_retries + 1)
        interpretation = await retry_async(
            _call_llm,
            attempts,
            backoff_seconds=0.75,
            retriable_exceptions=(_RetriableLLMError,),
            logger=logger,
            operation_name="llm.interpret_errors",
        )

    return interpretation
