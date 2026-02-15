from __future__ import annotations

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.models import CompileResult, Diagnostic, GeneratedLean, Interpretation, InterpretationItem


def test_solve_success(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        assert prompt
        return GeneratedLean(code="def fortyTwo : Nat := 42", metadata={"source": "mock"})

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        assert "fortyTwo" in code
        return CompileResult(success=True, stdout="", stderr="", diagnostics=[])

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={"nl_input": "Define a constant fortyTwo", "max_iters": 1},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["lean_code"].startswith("def fortyTwo")
        assert payload["compile"]["success"] is True
        assert payload["interpretation"] is None
        assert payload["interpretation_error"] is None
        assert payload["pipeline"]["semantic"]["success"] is True

    asyncio.run(_run())


def test_solve_compile_failure_with_interpretation(monkeypatch: pytest.MonkeyPatch) -> None:
    captured_nl_input: str | None = None

    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        return GeneratedLean(code="theorem broken : True := by\n  exact Foo", metadata={})

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        return CompileResult(
            success=False,
            stdout="",
            stderr="Main.lean:2:9: error: unknown constant 'Foo'",
            diagnostics=[
                Diagnostic(
                    severity="error",
                    file="Main.lean",
                    line=2,
                    column=9,
                    message="unknown constant 'Foo'",
                )
            ],
        )

    async def fake_interpret_errors(
        code: str,
        compile_result: CompileResult,
        nl_input: str,
        settings=None,
    ) -> Interpretation:
        nonlocal captured_nl_input
        captured_nl_input = nl_input
        return Interpretation(
            summary="Unknown identifier caused compilation to fail.",
            items=[InterpretationItem(
                error="unknown constant 'Foo'",
                probable_cause="The theorem references an undefined symbol.",
                suggested_fix="Replace Foo with a valid proof term such as `trivial`.",
                source="latex",
                latex_start=0,
                latex_end=5,
                latex_excerpt="Prove",
                lean_line=2,
                lean_column=9,
                replacement="Try proving `True` with `trivial`.",
            )],
            suggestions=["Try replacing `exact Foo` with `trivial`"],
        )

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)
    monkeypatch.setattr("app.main.interpret_errors", fake_interpret_errors)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={"nl_input": "Prove True with broken code", "context": {}, "max_iters": 1},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["compile"]["success"] is False
        assert payload["compile"]["diagnostics"][0]["line"] == 2
        assert payload["interpretation"]["summary"].startswith("Unknown identifier")
        assert payload["interpretation"]["items"][0]["latex_start"] == 0
        assert payload["interpretation"]["items"][0]["source"] == "latex"
        assert payload["interpretation"]["items"][0]["lean_line"] == 2
        assert payload["interpretation_error"] is None
        assert captured_nl_input == "Prove True with broken code"
        assert payload["pipeline"]["semantic"]["success"] is True
        llm_stage = next(
            stage for stage in payload["pipeline"]["stages"] if stage["stage"] == "llm_interpretation"
        )
        assert llm_stage["attempted"] is True
        assert llm_stage["success"] is True

    asyncio.run(_run())


def test_solve_llm_failure_does_not_fail_request(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        return GeneratedLean(code="theorem broken : True := by\n  exact Foo", metadata={})

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        return CompileResult(
            success=False,
            stdout="",
            stderr="Main.lean:2:9: error: unknown constant 'Foo'",
            diagnostics=[Diagnostic(severity="error", message="unknown constant 'Foo'", line=2, column=9)],
        )

    async def fake_interpret_errors(
        code: str,
        compile_result: CompileResult,
        nl_input: str,
        settings=None,
    ) -> Interpretation:
        raise RuntimeError("upstream llm unavailable")

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)
    monkeypatch.setattr("app.main.interpret_errors", fake_interpret_errors)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={"nl_input": "Force an interpretation error"},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["compile"]["success"] is False
        assert payload["interpretation"] is None
        assert payload["interpretation_error"] == "upstream llm unavailable"
        llm_stage = next(
            stage for stage in payload["pipeline"]["stages"] if stage["stage"] == "llm_interpretation"
        )
        assert llm_stage["attempted"] is True
        assert llm_stage["success"] is False

    asyncio.run(_run())


def test_solve_semantic_false_collapse_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        return GeneratedLean(
            code=(
                "import Std\n\n"
                "namespace MathGrammar\n"
                "axiom add_zero_right : False\n"
                "#check add_zero_right\n"
                "end MathGrammar\n"
            ),
            metadata={"status": "ok", "is_valid_lean": True},
        )

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        assert "False" in code
        return CompileResult(
            success=True,
            stdout="MathGrammar.add_zero_right : False\n",
            stderr="",
            diagnostics=[],
        )

    async def fake_interpret_errors(
        code: str,
        compile_result: CompileResult,
        nl_input: str,
        settings=None,
    ) -> Interpretation:
        raise AssertionError("LLM interpretation should be skipped for semantic false collapse.")

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)
    monkeypatch.setattr("app.main.interpret_errors", fake_interpret_errors)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={
                    "nl_input": "For all n in N, n + 1 = n.",
                    "context": {"theorem_name": "add_zero_right"},
                },
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["compile"]["success"] is False
        assert any(
            "type False" in diag["message"] for diag in payload["compile"]["diagnostics"]
        )
        assert payload["pipeline"]["semantic"]["success"] is False
        assert payload["pipeline"]["semantic"]["collapsed_to_false"] is True
        llm_stage = next(
            stage for stage in payload["pipeline"]["stages"] if stage["stage"] == "llm_interpretation"
        )
        assert llm_stage["attempted"] is False
        assert llm_stage["details"]["reason"] == "semantic_false"

    asyncio.run(_run())


def test_solve_includes_highlights_and_dashboard(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        return GeneratedLean(code="theorem broken : True := by\n  exact Foo", metadata={})

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        return CompileResult(
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

    async def fake_interpret_errors(
        code: str,
        compile_result: CompileResult,
        nl_input: str,
        settings=None,
    ) -> Interpretation:
        return Interpretation(
            summary="Unknown identifier in generated Lean code.",
            items=[
                InterpretationItem(
                    error="unknown constant 'Foo'",
                    source="latex",
                    latex_start=6,
                    latex_end=9,
                    latex_excerpt="Foo",
                    suggested_fix="Use an in-scope proof term.",
                    replacement="trivial",
                )
            ],
            suggestions=["Replace Foo with a valid term such as trivial."],
        )

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)
    monkeypatch.setattr("app.main.interpret_errors", fake_interpret_errors)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={
                    "nl_input": "Proof Foo fails",
                    "context": {"chunk_id": "chunk-test", "chunk_start": 0},
                },
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["compile"]["success"] is False
        assert payload["highlights"] is not None
        assert payload["highlights"]["highlights"][0]["chunk_id"] == "chunk-test"
        assert payload["highlights"]["highlights"][0]["text"] == "Foo"
        assert payload["dashboard"]["status"] == "error"
        assert payload["dashboard"]["headline"].startswith("Unknown identifier")
        assert payload["dashboard"]["next_actions"]
        highlight_stage = next(
            stage for stage in payload["pipeline"]["stages"] if stage["stage"] == "highlight_resolution"
        )
        assert highlight_stage["attempted"] is True
        assert highlight_stage["success"] is True

    asyncio.run(_run())
