from __future__ import annotations

import asyncio

import httpx
import pytest

from app.llm_client import _normalize_interpretation, interpret_errors
from app.models import CompileResult, Diagnostic
from app.settings import Settings


def test_normalize_interpretation_inferrs_latex_offsets_from_excerpt() -> None:
    nl_input = "Let n be a natural number. Prove n = n."
    compile_result = CompileResult(
        success=False,
        stdout="",
        stderr="Main.lean:2:9: error: unknown constant 'Foo'",
        diagnostics=[
            Diagnostic(
                severity="error",
                message="unknown constant 'Foo'",
                line=2,
                column=9,
            )
        ],
    )

    payload = {
        "summary": "Unknown constant in generated proof.",
        "items": [
            {
                "error": "unknown constant 'Foo'",
                "source": "latex",
                "latex_excerpt": "Prove n = n",
                "suggested_fix": "Use a direct reflexivity proof.",
            }
        ],
        "suggestions": ["Try changing prompt to request reflexivity proof directly."],
    }

    interpretation = _normalize_interpretation(
        payload,
        nl_input=nl_input,
        compile_result=compile_result,
    )

    item = interpretation.items[0]
    assert item.latex_start == nl_input.find("Prove n = n")
    assert item.latex_end == item.latex_start + len("Prove n = n")
    assert item.lean_line == 2
    assert item.lean_column == 9


def test_normalize_interpretation_falls_back_to_compiler_diagnostics() -> None:
    compile_result = CompileResult(
        success=False,
        stdout="",
        stderr="Main.lean:4:5: error: type mismatch",
        diagnostics=[Diagnostic(severity="error", message="type mismatch", line=4, column=5)],
    )

    interpretation = _normalize_interpretation(
        {"summary": "Compilation failed", "items": [], "suggestions": []},
        nl_input="Prove commutativity.",
        compile_result=compile_result,
    )

    assert len(interpretation.items) == 1
    assert interpretation.items[0].error == "type mismatch"
    assert interpretation.items[0].source == "lean"
    assert interpretation.items[0].lean_line == 4
    assert interpretation.items[0].lean_column == 5


def test_interpret_errors_includes_completion_cap_and_limits_diagnostics(
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
                json={"summary": "ok", "items": [], "suggestions": []},
            )

    monkeypatch.setattr("app.llm_client.httpx.AsyncClient", _FakeAsyncClient)

    diagnostics = [
        Diagnostic(severity="error", message=f"diag_{idx}", line=idx + 1, column=1)
        for idx in range(12)
    ]
    compile_result = CompileResult(
        success=False,
        stdout="",
        stderr="failure",
        diagnostics=diagnostics,
    )
    settings = Settings(
        enable_llm_interpretation=True,
        llm_model="gpt-5-nano",
        llm_base_url="https://api.openai.com/v1",
        llm_max_completion_tokens=180,
        llm_timeout_seconds=10,
        llm_max_retries=0,
    )

    async def _run() -> None:
        interpretation = await interpret_errors(
            code="def x : Nat := 0",
            compile_result=compile_result,
            nl_input="bad statement",
            settings=settings,
        )
        assert interpretation.summary == "ok"

    asyncio.run(_run())

    # Interpretation uses Chat Completions (LLM_INTERPRETATION_USE_CHAT_COMPLETIONS=true) for reliable JSON
    assert captured_payload.get("max_completion_tokens") == 180
    response_format = captured_payload.get("response_format") or (
        (captured_payload.get("text") or {}).get("format")
    )
    assert isinstance(response_format, dict)
    assert response_format.get("type") == "json_object"
    messages = captured_payload.get("messages")
    assert isinstance(messages, list) and len(messages) >= 2
    prompt = messages[1].get("content") if isinstance(messages[1], dict) else captured_payload.get("input")
    assert isinstance(prompt, str)
    assert "diag_7" in prompt
    assert "diag_8" not in prompt


def test_interpret_errors_falls_back_when_content_not_json(
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
                    "choices": [
                        {
                            "message": {
                                "content": "Here is analysis:\n- cause: unknown identifier\n- fix: import module"
                            }
                        }
                    ]
                },
            )

    monkeypatch.setattr("app.llm_client.httpx.AsyncClient", _FakeAsyncClient)

    compile_result = CompileResult(
        success=False,
        stdout="",
        stderr="Main.lean:4:5: error: unknown identifier 'PositivityExt'",
        diagnostics=[
            Diagnostic(
                severity="error",
                message="unknown identifier 'PositivityExt'",
                line=4,
                column=5,
            )
        ],
    )
    settings = Settings(
        enable_llm_interpretation=True,
        llm_model="gpt-5-nano",
        llm_base_url="https://api.openai.com/v1",
        llm_max_completion_tokens=180,
        llm_timeout_seconds=10,
        llm_max_retries=0,
    )

    async def _run() -> None:
        interpretation = await interpret_errors(
            code="def bad : PositivityExt := by sorry",
            compile_result=compile_result,
            nl_input="For all real numbers x, x + 1 = x.",
            settings=settings,
        )
        assert interpretation.summary == "Lean compiler errors detected."
        assert interpretation.items
        assert interpretation.items[0].error == "unknown identifier 'PositivityExt'"

    asyncio.run(_run())
