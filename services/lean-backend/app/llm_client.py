from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from .models import CompileResult, Interpretation
from .settings import Settings, get_settings
from .utils import extract_json_object, retry_async, truncate_text

logger = logging.getLogger(__name__)


class LLMClientError(RuntimeError):
    """Raised when LLM interpretation fails."""


class _RetriableLLMError(LLMClientError):
    pass


def _endpoint_url(settings: Settings) -> str:
    if settings.llm_endpoint_url:
        return settings.llm_endpoint_url
    return f"{settings.llm_base_url.rstrip('/')}/chat/completions"


def _normalize_interpretation(data: dict[str, Any]) -> Interpretation:
    summary = data.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        summary = "Lean compiler errors detected."

    raw_items = data.get("items")
    items: list[dict[str, Any]] = []
    if isinstance(raw_items, list):
        for item in raw_items:
            if isinstance(item, dict):
                items.append(item)

    raw_suggestions = data.get("suggestions")
    suggestions: list[str] = []
    if isinstance(raw_suggestions, list):
        suggestions = [str(s) for s in raw_suggestions if str(s).strip()]

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
        "Return JSON only with keys: summary (string), items (array of objects with "
        "error/probable_cause/suggested_fix), suggestions (array of short strings).\n\n"
        f"Lean code:\n{truncate_text(code, 8_000)}\n\n"
        f"Compiler stderr:\n{truncate_text(compile_result.stderr, 8_000)}\n\n"
        f"Compiler stdout:\n{truncate_text(compile_result.stdout, 8_000)}\n\n"
        f"Structured diagnostics:\n{truncate_text(diagnostics_json, 8_000)}"
    )

    payload = {
        "model": settings.llm_model,
        "temperature": 0,
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
                return _normalize_interpretation(data)

            if not isinstance(data, dict):
                raise LLMClientError("LLM response JSON is not an object")

            content = _extract_message_content(data)
            if content is None:
                raise LLMClientError("LLM response missing message content")

            parsed = extract_json_object(content)
            if parsed is None:
                raise LLMClientError("LLM message content was not valid JSON")

            return _normalize_interpretation(parsed)

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
