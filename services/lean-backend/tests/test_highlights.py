from __future__ import annotations

import asyncio

from httpx import ASGITransport, AsyncClient

from app.main import app


def test_highlights_local_span_maps_to_active_chunk() -> None:
    chunk_text = "For all n in Nat, n + 0 = n."
    local_start = chunk_text.index("n + 0")
    local_end = local_start + len("n + 0")

    request_payload = {
        "chunks": [
            {
                "chunkId": "chunk-a",
                "start": 100,
                "text": chunk_text,
                "sentences": [
                    {
                        "sentenceId": "sentence-a",
                        "start": 100,
                        "end": 100 + len(chunk_text),
                        "text": chunk_text,
                    }
                ],
            }
        ],
        "activeChunkId": "chunk-a",
        "interpretation": {
            "summary": "test",
            "items": [
                {
                    "error": "offending phrase",
                    "latex_start": local_start,
                    "latex_end": local_end,
                }
            ],
            "suggestions": [],
        },
    }

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post("/v1/lean/highlights", json=request_payload)

        assert response.status_code == 200
        payload = response.json()
        assert len(payload["highlights"]) == 1
        highlight = payload["highlights"][0]
        assert highlight["chunk_id"] == "chunk-a"
        assert highlight["start"] == 100 + local_start
        assert highlight["end"] == 100 + local_end
        assert highlight["text"] == "n + 0"
        assert highlight["source"] == "latex_span"
        assert highlight["sentence_id"] == "sentence-a"
        assert payload["unresolved_items"] == []

    asyncio.run(_run())


def test_highlights_resolve_by_excerpt() -> None:
    first_chunk = "For all real numbers x, "
    second_chunk = "we have x + 0 = x."

    request_payload = {
        "chunks": [
            {"chunkId": "chunk-1", "start": 0, "text": first_chunk},
            {"chunkId": "chunk-2", "start": len(first_chunk), "text": second_chunk},
        ],
        "interpretation": {
            "summary": "test",
            "items": [
                {
                    "error": "equation should be highlighted",
                    "latex_excerpt": "x + 0 = x",
                }
            ],
            "suggestions": [],
        },
    }

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post("/v1/lean/highlights", json=request_payload)

        assert response.status_code == 200
        payload = response.json()
        assert len(payload["highlights"]) == 1
        highlight = payload["highlights"][0]
        assert highlight["chunk_id"] == "chunk-2"
        assert highlight["text"] == "x + 0 = x"
        assert highlight["source"] == "latex_excerpt"
        assert payload["unresolved_items"] == []

    asyncio.run(_run())


def test_highlights_resolve_by_quoted_error_symbol_and_track_unresolved() -> None:
    chunk_text = "theorem demo : True := by\n  exact Foo\n"

    request_payload = {
        "chunks": [
            {"chunkId": "chunk-lean", "start": 300, "text": chunk_text},
        ],
        "interpretation": {
            "summary": "test",
            "items": [
                {"error": "unknown constant 'Foo'"},
                {"error": "generic parser failure"},
            ],
            "suggestions": [],
        },
    }

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post("/v1/lean/highlights", json=request_payload)

        assert response.status_code == 200
        payload = response.json()
        assert len(payload["highlights"]) == 1
        highlight = payload["highlights"][0]
        assert highlight["chunk_id"] == "chunk-lean"
        assert highlight["text"] == "Foo"
        assert highlight["source"] == "quoted_text"
        assert payload["unresolved_items"] == [1]
        assert payload["items"][1]["resolved"] is False

    asyncio.run(_run())
