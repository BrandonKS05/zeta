from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from app.modal_client import (
    ModalClientError,
    _llm_autocomplete_candidates,
    _build_modal_payload,
    _normalize_generated_payload,
    _resolve_modal_endpoint,
    generate_lean,
)
from app.settings import Settings


def test_build_payload_for_analyze_endpoint_matches_expected_shape() -> None:
    payload = _build_modal_payload(
        prompt=r"For all $n \\in \\mathbb{N}$, we have $n + 0 = n$.",
        context_payload={
            "theorem_name": "add_zero_right",
            "imports": ["Std"],
            "temperature": 0.3,
        },
        max_iters=1,
        endpoint_url="https://example.modal.run/v1/analyze",
    )

    assert payload == {
        "text": r"For all $n \\in \\mathbb{N}$, we have $n + 0 = n$.",
        "theorem_name": "add_zero_right",
        "imports": ["Std"],
        "temperature": 0.3,
    }


def test_build_payload_for_analyze_endpoint_forwards_thinking_mode() -> None:
    payload = _build_modal_payload(
        prompt="For all real numbers x, x = x.",
        context_payload={
            "theorem_name": "real_refl",
            "imports": ["Mathlib.Data.Real.Basic"],
            "temperature": 0.0,
            "mode": "thinking",
            "include_iteration_history": True,
            "include_raw_model_output": False,
        },
        max_iters=4,
        endpoint_url="https://example.modal.run/v1/analyze",
    )

    assert payload == {
        "text": "For all real numbers x, x = x.",
        "theorem_name": "real_refl",
        "imports": ["Mathlib.Data.Real.Basic"],
        "temperature": 0.0,
        "mode": "thinking",
        "max_iters": 4,
        "include_iteration_history": True,
        "include_raw_model_output": False,
    }


def test_build_payload_auto_enables_thinking_for_multiple_iters() -> None:
    payload = _build_modal_payload(
        prompt="For all n, n = n.",
        context_payload={"theorem_name": "nat_refl"},
        max_iters=3,
        endpoint_url="https://example.modal.run/v1/analyze",
    )

    assert payload["mode"] == "thinking"
    assert payload["max_iters"] == 3


def test_build_payload_for_generate_endpoint_matches_expected_shape() -> None:
    payload = _build_modal_payload(
        prompt=r"For all $n \\in \\mathbb{N}$, we have $n + 0 = n$.",
        context_payload={
            "theorem_name": "add_zero_right",
            "imports": ["Std"],
            "temperature": 0.3,
        },
        max_iters=1,
        endpoint_url="https://example.modal.run/v1/generate",
    )

    assert payload == {
        "text": r"For all $n \\in \\mathbb{N}$, we have $n + 0 = n$.",
        "theorem_name": "add_zero_right",
        "imports": ["Std"],
        "temperature": 0.3,
    }


def test_resolve_modal_endpoint_root_gets_generate_or_analyze_path() -> None:
    endpoint_generate = _resolve_modal_endpoint(
        "https://example.modal.run",
        use_generate=True,
    )
    assert endpoint_generate == "https://example.modal.run/v1/generate"
    endpoint_analyze = _resolve_modal_endpoint(
        "https://example.modal.run",
        use_generate=False,
    )
    assert endpoint_analyze == "https://example.modal.run/v1/analyze"


def test_build_payload_for_root_endpoint_uses_backend_shape() -> None:
    payload = _build_modal_payload(
        prompt="For all real numbers x, x = x.",
        context_payload={
            "theorem_name": "real_refl",
            "imports": ["Mathlib.Data.Real.Basic"],
            "custom_field": {"foo": "bar"},
        },
        max_iters=1,
        endpoint_url="https://example.modal.run",
    )

    assert payload == {
        "nl_input": "For all real numbers x, x = x.",
        "context": {
            "theorem_name": "real_refl",
            "imports": ["Mathlib.Data.Real.Basic"],
            "custom_field": {"foo": "bar"},
        },
        "max_iters": 1,
    }


def test_resolve_modal_endpoint_rewrites_analyze_to_generate() -> None:
    endpoint = _resolve_modal_endpoint(
        "https://example.modal.run/v1/analyze",
        use_generate=True,
    )
    assert endpoint == "https://example.modal.run/v1/generate"


def test_resolve_modal_endpoint_keeps_analyze_when_disabled() -> None:
    endpoint = _resolve_modal_endpoint(
        "https://example.modal.run/v1/analyze",
        use_generate=False,
    )
    assert endpoint == "https://example.modal.run/v1/analyze"


def test_normalize_generated_payload_for_lean_source_response() -> None:
    response_data = {
        "model": "FrenzyMath/Herald_translator",
        "status": "ok",
        "input_text": "For all n in N, we have n + 0 = n.",
        "normalized_text": "For all n in Nat, we have n + 0 = n.",
        "statement_type": "∀ n : Nat, n + 0 = n",
        "declaration_name": "add_zero_right",
        "lean_declaration": "axiom add_zero_right : ∀ n : Nat, n + 0 = n",
        "lean_source": "import Std\\naxiom add_zero_right : ∀ n : Nat, n + 0 = n\\n",
        "diagnostics": [],
        "feedback": ["Generated Lean statement candidate from NL input."],
        "is_valid_lean": True,
        "latency_ms": 56032,
    }

    generated = _normalize_generated_payload(response_data)

    assert generated.code.startswith("import Std")
    assert generated.metadata["declaration_name"] == "add_zero_right"
    assert generated.metadata["status"] == "ok"


def test_normalize_generated_payload_accepts_needs_revision_status() -> None:
    response_data = {
        "status": "needs_revision",
        "feedback": ["lean parse warning"],
        "lean_source": "import Std\naxiom add_zero_right : ∀ n : Nat, n + 0 = n\n",
    }

    generated = _normalize_generated_payload(response_data)

    assert generated.code.startswith("import Std")
    assert generated.metadata["status"] == "needs_revision"


def test_normalize_generated_payload_accepts_unchecked_status() -> None:
    response_data = {
        "status": "unchecked",
        "feedback": ["Lean check skipped (`skip_lean_check=true`)."],
        "lean_source": "import Std\naxiom add_zero_right : ∀ n : Nat, n + 0 = n\n",
    }

    generated = _normalize_generated_payload(response_data)

    assert generated.code.startswith("import Std")
    assert generated.metadata["status"] == "unchecked"


def test_normalize_generated_payload_raises_on_non_ok_status() -> None:
    response_data = {
        "status": "error",
        "feedback": ["failed to parse"],
        "lean_source": "",
    }

    with pytest.raises(ModalClientError):
        _normalize_generated_payload(response_data)


def test_generate_lean_sends_both_authorization_and_x_api_key_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured_headers: dict[str, str] = {}
    captured_url: str | None = None

    class _FakeAsyncClient:
        def __init__(self, timeout=None):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, json, headers):
            nonlocal captured_headers, captured_url
            captured_url = str(url)
            captured_headers = dict(headers or {})
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "lean_source": "import Std\naxiom add_zero_right : ∀ n : Nat, n + 0 = n\n",
                },
            )

    monkeypatch.setattr("app.modal_client.httpx.AsyncClient", _FakeAsyncClient)

    settings = Settings(
        modal_endpoint_url="https://example.modal.run/v1/analyze",
        modal_api_key="test-api-key",
        modal_use_generate_endpoint=True,
    )

    async def _run() -> None:
        generated = await generate_lean(
            prompt=r"For all $n \\in \\mathbb{N}$, we have $n + 0 = n$.",
            context={
                "theorem_name": "add_zero_right",
                "imports": ["Std"],
                "temperature": 0.0,
            },
            max_iters=1,
            settings=settings,
        )
        assert generated.code.startswith("import Std")

    asyncio.run(_run())

    assert captured_headers.get("Authorization") == "Bearer test-api-key"
    assert captured_headers.get("x-api-key") == "test-api-key"
    assert captured_url == "https://example.modal.run/v1/generate"


def test_llm_autocomplete_rewrites_openai_gpt5_chat_endpoint_to_responses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    class _FakeAsyncClient:
        def __init__(self, timeout=None):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, json, headers):
            nonlocal captured
            captured = {
                "url": str(url),
                "json": dict(json or {}),
                "headers": dict(headers or {}),
            }
            return httpx.Response(200, json={"output_text": "{\"candidates\": [\" + 0 = n\"]}"})

    monkeypatch.setattr("app.modal_client.httpx.AsyncClient", _FakeAsyncClient)

    settings = Settings(
        llm_api_key="test-api-key",
        llm_base_url="https://api.openai.com/v1",
        llm_endpoint_url="https://api.openai.com/v1/chat/completions",
        llm_model="gpt-5-2025-08-07",
        autocomplete_llm_fallback_enabled=True,
        autocomplete_llm_fallback_model="",
        autocomplete_llm_fallback_timeout_seconds=5,
        llm_max_completion_tokens=180,
    )

    async def _run() -> None:
        candidates, debug = await _llm_autocomplete_candidates(
            {
                "text": "theorem demo : Nat := by\n  exact 0",
                "cursor_offset": 18,
                "imports": ["Std"],
            },
            settings=settings,
        )
        assert candidates == ["+ 0 = n"]
        assert debug.get("success") is True
        assert debug.get("api") == "responses"
        assert debug.get("endpoint") == "https://api.openai.com/v1/responses"

    asyncio.run(_run())

    assert captured["url"] == "https://api.openai.com/v1/responses"
    assert captured["json"].get("model") == "gpt-5-2025-08-07"
    assert captured["json"].get("max_output_tokens") == 180
    assert "max_completion_tokens" not in captured["json"]
    assert isinstance(captured["json"].get("instructions"), str)
    assert isinstance(captured["json"].get("input"), str)


def test_llm_autocomplete_extracts_output_text_from_responses_output_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FakeAsyncClient:
        def __init__(self, timeout=None):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, json, headers):
            return httpx.Response(
                200,
                json={
                    "output": [
                        {
                            "type": "message",
                            "content": [
                                {"type": "output_text", "text": "{\"candidates\": [\"by\\n\"]}"}
                            ],
                        }
                    ]
                },
            )

    monkeypatch.setattr("app.modal_client.httpx.AsyncClient", _FakeAsyncClient)

    settings = Settings(
        llm_api_key="test-api-key",
        llm_base_url="https://api.openai.com/v1",
        llm_model="gpt-5-2025-08-07",
        autocomplete_llm_fallback_enabled=True,
        autocomplete_llm_fallback_model="",
        autocomplete_llm_fallback_timeout_seconds=5,
    )

    async def _run() -> None:
        candidates, debug = await _llm_autocomplete_candidates(
            {
                "text": "theorem demo : True :=",
                "cursor_offset": 21,
            },
            settings=settings,
        )
        assert candidates == ["by"]
        assert debug.get("success") is True

    asyncio.run(_run())


def test_llm_autocomplete_uses_heuristic_fallback_for_pythagorean_equals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _FakeAsyncClient:
        def __init__(self, timeout=None):
            self.timeout = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, json, headers):
            return httpx.Response(200, json={"output_text": "{\"candidates\": []}"})

    monkeypatch.setattr("app.modal_client.httpx.AsyncClient", _FakeAsyncClient)

    text = "For some right triangle, we have $a^2 + b^2 = "
    settings = Settings(
        llm_api_key="test-api-key",
        llm_base_url="https://api.openai.com/v1",
        llm_model="gpt-5-2025-08-07",
        autocomplete_llm_fallback_enabled=True,
        autocomplete_llm_fallback_model="",
        autocomplete_llm_fallback_timeout_seconds=5,
    )

    async def _run() -> None:
        candidates, debug = await _llm_autocomplete_candidates(
            {
                "text": text,
                "cursor_offset": len(text),
            },
            settings=settings,
        )
        assert candidates and candidates[0].strip() == "c^2$"
        assert debug.get("success") is True
        assert debug.get("reason") == "heuristic_fallback"

    asyncio.run(_run())
