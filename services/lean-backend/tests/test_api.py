from __future__ import annotations

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.models import CompileResult, Diagnostic, GeneratedLean, Interpretation


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

    asyncio.run(_run())


def test_solve_compile_failure_with_interpretation(monkeypatch: pytest.MonkeyPatch) -> None:
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

    async def fake_interpret_errors(code: str, compile_result: CompileResult, settings=None) -> Interpretation:
        return Interpretation(
            summary="Unknown identifier caused compilation to fail.",
            items=[
                {
                    "error": "unknown constant 'Foo'",
                    "probable_cause": "The theorem references an undefined symbol.",
                    "suggested_fix": "Replace Foo with a valid proof term such as `trivial`.",
                }
            ],
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
        assert payload["interpretation_error"] is None

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

    async def fake_interpret_errors(code: str, compile_result: CompileResult, settings=None) -> Interpretation:
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

    asyncio.run(_run())
