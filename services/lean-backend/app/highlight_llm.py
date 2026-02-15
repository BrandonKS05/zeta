from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx

from .models import (
    HighlightChunk,
    HighlightItemResult,
    HighlightRange,
    HighlightResolveRequest,
    HighlightResolveResponse,
)
from .settings import Settings, get_settings
from .utils import extract_json_object, retry_async, truncate_text

logger = logging.getLogger(__name__)

_ALLOWED_SOURCES = {
    "latex_span",
    "latex_excerpt",
    "quoted_text",
    "replacement_text",
    "keyword",
    "llm",
}


class LLMHighlightError(RuntimeError):
    """Raised when LLM-based highlight resolution fails."""


class _RetriableLLMHighlightError(LLMHighlightError):
    pass


def _endpoint_url(settings: Settings) -> str:
    if settings.llm_endpoint_url:
        return settings.llm_endpoint_url
    return f"{settings.llm_base_url.rstrip('/')}/chat/completions"


def _should_enforce_json_mode(endpoint: str) -> bool:
    parsed = urlsplit(endpoint)
    return parsed.netloc.lower() == "api.openai.com"


def _highlight_json_response_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "lean_highlight_resolution",
            "strict": True,
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["highlights", "unresolved_items"],
                "properties": {
                    "highlights": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": [
                                "item_index",
                                "chunk_id",
                                "start_in_chunk",
                                "end_in_chunk",
                                "source",
                                "confidence",
                            ],
                            "properties": {
                                "item_index": {"type": "integer"},
                                "chunk_id": {"type": "string"},
                                "start_in_chunk": {"type": "integer"},
                                "end_in_chunk": {"type": "integer"},
                                "source": {
                                    "type": "string",
                                    "enum": [
                                        "latex_span",
                                        "latex_excerpt",
                                        "quoted_text",
                                        "replacement_text",
                                        "keyword",
                                        "llm",
                                    ],
                                },
                                "confidence": {"type": "number"},
                            },
                        },
                    },
                    "unresolved_items": {"type": "array", "items": {"type": "integer"}},
                },
            },
        },
    }


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


def _chunk_end(chunk: HighlightChunk) -> int:
    inferred_end = chunk.start + len(chunk.text)
    if chunk.end is None:
        return inferred_end
    return max(chunk.end, inferred_end)


def _lookup_sentence_id(chunk: HighlightChunk, abs_start: int, abs_end: int) -> str | None:
    for sentence in chunk.sentences:
        if (
            sentence.sentence_id
            and sentence.start is not None
            and sentence.end is not None
            and sentence.start < abs_end
            and sentence.end > abs_start
        ):
            return sentence.sentence_id
    return None


def _normalize_source(raw: Any) -> str:
    source = _as_str(raw)
    if not source:
        return "llm"
    source_key = source.lower()
    return source_key if source_key in _ALLOWED_SOURCES else "llm"


def _extract_message_content(payload: dict[str, Any]) -> str | None:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first = choices[0]
    if not isinstance(first, dict):
        return None
    message = first.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    return content if isinstance(content, str) else None


def _normalize_highlight_payload(
    data: dict[str, Any], *, payload: HighlightResolveRequest
) -> HighlightResolveResponse:
    chunk_by_id = {chunk.chunk_id: chunk for chunk in payload.chunks}
    active_chunk_id = payload.active_chunk_id.strip() if payload.active_chunk_id else ""
    if not active_chunk_id and payload.chunks:
        active_chunk_id = payload.chunks[0].chunk_id

    highlights: list[HighlightRange] = []
    by_item_index: dict[int, list[HighlightRange]] = {}

    raw_highlights = data.get("highlights")
    if not isinstance(raw_highlights, list):
        raw_highlights = []

    for raw in raw_highlights:
        if not isinstance(raw, dict):
            continue
        item_index = _as_int(raw.get("item_index"))
        if item_index is None:
            continue
        if item_index < 0 or item_index >= len(payload.interpretation.items):
            continue

        chunk_id = _as_str(raw.get("chunk_id")) or active_chunk_id
        if not chunk_id or chunk_id not in chunk_by_id:
            continue
        chunk = chunk_by_id[chunk_id]

        start_in_chunk = _as_int(raw.get("start_in_chunk"))
        end_in_chunk = _as_int(raw.get("end_in_chunk"))

        # Allow LLM to provide absolute offsets instead.
        if start_in_chunk is None or end_in_chunk is None:
            abs_start = _as_int(raw.get("start"))
            abs_end = _as_int(raw.get("end"))
            if abs_start is not None and abs_end is not None:
                start_in_chunk = abs_start - chunk.start
                end_in_chunk = abs_end - chunk.start

        if start_in_chunk is None or end_in_chunk is None:
            continue
        if start_in_chunk < 0 or end_in_chunk <= start_in_chunk:
            continue
        if end_in_chunk > len(chunk.text):
            continue

        abs_start = chunk.start + start_in_chunk
        abs_end = chunk.start + end_in_chunk
        if abs_end > _chunk_end(chunk):
            continue

        confidence = _as_float(raw.get("confidence"))
        if confidence is None:
            confidence = 0.75
        confidence = max(0.0, min(1.0, confidence))

        resolved = HighlightRange(
            chunk_id=chunk.chunk_id,
            item_index=item_index,
            start=abs_start,
            end=abs_end,
            start_in_chunk=start_in_chunk,
            end_in_chunk=end_in_chunk,
            text=chunk.text[start_in_chunk:end_in_chunk],
            source=_normalize_source(raw.get("source")),
            confidence=confidence,
            sentence_id=_lookup_sentence_id(chunk, abs_start, abs_end),
        )
        highlights.append(resolved)
        by_item_index.setdefault(item_index, []).append(resolved)

    unresolved_hint_raw = data.get("unresolved_items")
    unresolved_hint: set[int] = set()
    if isinstance(unresolved_hint_raw, list):
        for value in unresolved_hint_raw:
            idx = _as_int(value)
            if idx is None:
                continue
            if 0 <= idx < len(payload.interpretation.items):
                unresolved_hint.add(idx)

    item_results: list[HighlightItemResult] = []
    unresolved_items: list[int] = []

    for item_index, item in enumerate(payload.interpretation.items):
        ranges = by_item_index.get(item_index, [])
        if ranges:
            item_results.append(
                HighlightItemResult(
                    item_index=item_index,
                    error=item.error,
                    resolved=True,
                    ranges=ranges,
                    reason="llm",
                )
            )
            continue

        unresolved_items.append(item_index)
        reason = "llm_unresolved" if item_index in unresolved_hint else "llm_no_match"
        item_results.append(
            HighlightItemResult(
                item_index=item_index,
                error=item.error,
                resolved=False,
                ranges=[],
                reason=reason,
            )
        )

    return HighlightResolveResponse(
        highlights=highlights,
        items=item_results,
        unresolved_items=unresolved_items,
        resolver="llm",
        resolver_error=None,
    )


def _build_prompt(payload: HighlightResolveRequest) -> str:
    chunks_payload = [
        {
            "chunk_id": chunk.chunk_id,
            "start": chunk.start,
            "end": chunk.end if chunk.end is not None else chunk.start + len(chunk.text),
            "text": truncate_text(chunk.text, 4_000),
            "sentences": [
                {
                    "sentence_id": sentence.sentence_id,
                    "start": sentence.start,
                    "end": sentence.end,
                    "text": truncate_text(sentence.text or "", 500),
                }
                for sentence in chunk.sentences
            ],
        }
        for chunk in payload.chunks
    ]

    items_payload = [item.model_dump() for item in payload.interpretation.items]

    return (
        "Map interpretation items to exact text spans in chunks. "
        "Return JSON only with keys: highlights (array), unresolved_items (array of item indexes).\n"
        "Each highlight object must include: item_index, chunk_id, start_in_chunk, end_in_chunk, source, confidence.\n"
        "Rules:\n"
        "- Use 0-based start_in_chunk and end_in_chunk (end exclusive).\n"
        "- Choose the shortest exact span that should be highlighted.\n"
        "- If uncertain, omit the highlight and put item index into unresolved_items.\n"
        "- source should be one of: latex_span, latex_excerpt, quoted_text, replacement_text, keyword, llm.\n\n"
        f"Chunks:\n{truncate_text(json.dumps(chunks_payload, ensure_ascii=False), 18_000)}\n\n"
        f"Interpretation:\n{truncate_text(json.dumps(items_payload, ensure_ascii=False), 10_000)}"
    )


async def resolve_highlights_with_llm(
    payload: HighlightResolveRequest,
    *,
    settings: Settings | None = None,
) -> HighlightResolveResponse:
    settings = settings or get_settings()
    if not settings.enable_llm_highlights:
        raise LLMHighlightError("LLM highlight resolution is disabled")
    if not settings.llm_model:
        raise LLMHighlightError("LLM_MODEL is not configured")

    endpoint = _endpoint_url(settings)
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    request_payload = {
        "model": settings.llm_model,
        "messages": [
            {
                "role": "system",
                "content": "You are a precise text span resolver. Respond only with compact valid JSON.",
            },
            {"role": "user", "content": _build_prompt(payload)},
        ],
    }
    if _should_enforce_json_mode(endpoint):
        request_payload["response_format"] = _highlight_json_response_format()

    timeout = httpx.Timeout(settings.llm_highlight_timeout_seconds)

    async with httpx.AsyncClient(timeout=timeout) as client:

        async def _call_llm() -> HighlightResolveResponse:
            try:
                response = await client.post(endpoint, json=request_payload, headers=headers)
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                raise _RetriableLLMHighlightError(f"LLM highlight transport error: {exc}") from exc

            if response.status_code >= 500:
                raise _RetriableLLMHighlightError(
                    f"LLM highlight server error {response.status_code}: {response.text[:500]}"
                )
            if response.status_code >= 400:
                raise LLMHighlightError(
                    f"LLM highlight returned HTTP {response.status_code}: {response.text[:500]}"
                )

            try:
                data = response.json()
            except ValueError as exc:
                raise LLMHighlightError("LLM highlight returned non-JSON response") from exc

            if isinstance(data, dict) and {"highlights", "unresolved_items"}.issubset(data):
                return _normalize_highlight_payload(data, payload=payload)
            if not isinstance(data, dict):
                raise LLMHighlightError("LLM highlight response JSON is not an object")

            content = _extract_message_content(data)
            if content is None:
                raise LLMHighlightError("LLM highlight response missing message content")

            parsed = extract_json_object(content)
            if parsed is None:
                raise LLMHighlightError("LLM highlight message content was not valid JSON")

            return _normalize_highlight_payload(parsed, payload=payload)

        attempts = max(1, settings.llm_highlight_max_retries + 1)
        return await retry_async(
            _call_llm,
            attempts,
            backoff_seconds=0.5,
            retriable_exceptions=(_RetriableLLMHighlightError,),
            logger=logger,
            operation_name="llm.resolve_highlights",
        )
