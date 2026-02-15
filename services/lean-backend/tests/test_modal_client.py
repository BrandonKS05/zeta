from __future__ import annotations

import asyncio

import httpx
import pytest

from app.modal_client import (
    ModalClientError,
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


def test_resolve_modal_endpoint_keeps_root_path() -> None:
    endpoint = _resolve_modal_endpoint(
        "https://example.modal.run",
        use_generate=True,
    )
    assert endpoint == "https://example.modal.run"


def test_build_payload_for_root_endpoint_uses_analyze_shape() -> None:
    payload = _build_modal_payload(
        prompt="For all real numbers x, x = x.",
        context_payload={
            "theorem_name": "real_refl",
            "imports": ["Mathlib.Data.Real.Basic"],
        },
        max_iters=1,
        endpoint_url="https://example.modal.run",
    )

    assert payload == {
        "text": "For all real numbers x, x = x.",
        "theorem_name": "real_refl",
        "imports": ["Mathlib.Data.Real.Basic"],
        "temperature": 0.0,
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
