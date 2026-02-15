from __future__ import annotations

import asyncio

import httpx
import pytest

from app.highlight_llm import resolve_highlights_with_llm
from app.models import HighlightChunk, HighlightResolveRequest, Interpretation, InterpretationItem
from app.settings import Settings


def test_highlight_llm_uses_json_schema_response_format(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_payload: dict[str, object] = {}

    class _FakeAsyncClient:
        def __init__(self, timeout=None):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, json, headers):
            nonlocal captured_payload
            captured_payload = dict(json or {})
            return httpx.Response(
                200,
                json={
                    "highlights": [
                        {
                            "item_index": 0,
                            "chunk_id": "chunk-1",
                            "start_in_chunk": 8,
                            "end_in_chunk": 17,
                            "source": "llm",
                            "confidence": 0.8,
                        }
                    ],
                    "unresolved_items": [],
                },
            )

    monkeypatch.setattr("app.highlight_llm.httpx.AsyncClient", _FakeAsyncClient)

    payload = HighlightResolveRequest(
        chunks=[HighlightChunk(chunk_id="chunk-1", text="Prove that x + 1 = x.", start=0)],
        active_chunk_id="chunk-1",
        interpretation=Interpretation(
            summary="failed",
            items=[InterpretationItem(error="contradiction in x + 1 = x", source="unknown")],
            suggestions=[],
        ),
    )
    settings = Settings(
        enable_llm_highlights=True,
        llm_model="gpt-5-nano",
        llm_base_url="https://api.openai.com/v1",
        llm_highlight_timeout_seconds=8,
        llm_highlight_max_retries=0,
    )

    async def _run() -> None:
        response = await resolve_highlights_with_llm(payload, settings=settings)
        assert response.highlights
        assert response.highlights[0].chunk_id == "chunk-1"

    asyncio.run(_run())

    response_format = captured_payload.get("response_format") or (
        (captured_payload.get("text") or {}).get("format")
    )
    assert isinstance(response_format, dict)
    assert response_format.get("type") == "json_schema"
    schema = response_format.get("json_schema")
    if schema is not None:
        assert isinstance(schema, dict)
        assert schema.get("name") == "lean_highlight_resolution"
    else:
        assert response_format.get("name") == "lean_highlight_resolution"
