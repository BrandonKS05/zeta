from __future__ import annotations

import pytest

from app.modal_client import (
    ModalClientError,
    _build_modal_payload,
    _normalize_generated_payload,
)


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
