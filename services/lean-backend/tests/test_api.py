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


def test_solve_unchecked_modal_metadata_does_not_fail_semantic(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        return GeneratedLean(
            code=(
                "import Mathlib.Data.Real.Basic\n\n"
                "namespace MathGrammar\n"
                "axiom real_refl : ∀ (x : Real), x = x\n"
                "#check real_refl\n"
                "end MathGrammar\n"
            ),
            metadata={"status": "unchecked", "is_valid_lean": False},
        )

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        return CompileResult(
            success=True,
            stdout="MathGrammar.real_refl (x : ℝ) : x = x\n",
            stderr="",
            diagnostics=[],
        )

    async def fake_interpret_errors(
        code: str,
        compile_result: CompileResult,
        nl_input: str,
        settings=None,
    ) -> Interpretation:
        raise AssertionError("Interpretation should not run when compile succeeds.")

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)
    monkeypatch.setattr("app.main.interpret_errors", fake_interpret_errors)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={"nl_input": "For all real numbers x, x = x."},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["compile"]["success"] is True
        assert payload["pipeline"]["semantic"]["success"] is True
        assert payload["pipeline"]["semantic"]["reasons"] == []

    asyncio.run(_run())


def test_solve_llm_repair_def_check_after_def_check_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """After first compile fails with def/#check error, LLM repair fixes it; no fallback to /v1/analyze."""
    bad_code = (
        "import Std\n\n"
        "set_option autoImplicit false\n\n"
        "namespace MathGrammar\n"
        "def zeta_candidate (x : Expr) : MetaM (Option (Expr × Expr))\n"
        "#check zeta_candidate\n"
        "end MathGrammar\n"
    )
    good_code = (
        "import Mathlib.Data.Real.Basic\n\n"
        "set_option autoImplicit false\n\n"
        "namespace MathGrammar\n"
        "axiom rational_repr : ∀ x : Real, (∃ p q : Int, x = (p : Real) / (q : Real))\n"
        "#check rational_repr\n"
        "end MathGrammar\n"
    )
    generate_calls: list[int] = []

    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        generate_calls.append(1)
        return GeneratedLean(code=bad_code, metadata={"status": "unchecked", "is_valid_lean": False})

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        if "def zeta_candidate" in code:
            return CompileResult(
                success=False,
                stdout="",
                stderr="Main.lean:6:1: error: unexpected token '#check'; expected ':=', 'where' or '|'",
                diagnostics=[
                    Diagnostic(
                        severity="error",
                        line=6,
                        column=1,
                        message="unexpected token '#check'; expected ':=', 'where' or '|'",
                    )
                ],
            )
        return CompileResult(success=True, stdout="", stderr="", diagnostics=[])

    async def fake_repair_lean_compile_errors(
        code: str, compile_result, settings=None
    ) -> tuple[str | None, str | None]:
        return (None, "fake_skip")

    async def fake_repair_lean_def_check(code: str, diag_msg: str, settings=None) -> str | None:
        return good_code

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)
    monkeypatch.setattr("app.main.repair_lean_compile_errors", fake_repair_lean_compile_errors)
    monkeypatch.setattr("app.main.repair_lean_def_check", fake_repair_lean_def_check)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={"nl_input": "We can represent x in R as p/q with integers p,q."},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["compile"]["success"] is True
        assert "rational_repr" in payload["lean_code"]
        stage_names = [s["stage"] for s in payload["pipeline"]["stages"]]
        assert "modal_retry_analyze" not in stage_names
        assert "modal_retry_thinking" not in stage_names
        repair_stage = next(
            (s for s in payload["pipeline"]["stages"] if s["stage"] == "patch_lean"),
            None,
        )
        assert repair_stage is not None
        assert repair_stage["attempted"] is True
        assert repair_stage["success"] is True

    asyncio.run(_run())

    assert len(generate_calls) == 1


def test_solve_uses_modal_semantic_interpretation_on_compile_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sentence = "For all naturals n, n + 2 >= n + 3."

    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        assert prompt == sentence
        return GeneratedLean(
            code=(
                "import Std\n\n"
                "set_option autoImplicit false\n\n"
                "namespace MathGrammar\n"
                "axiom bad_claim : ∀ n : Nat, n + 2 ≥ n + 3\n"
                "#check bad_claim\n"
                "end MathGrammar\n"
            ),
            metadata={
                "status": "ok",
                "is_valid_lean": True,
                "interpretation": {
                    "summary": "This universal inequality is false.",
                    "items": [
                        {
                            "error": "The inequality fails for n = 0.",
                            "probable_cause": "Direction is reversed.",
                            "suggested_fix": "Use n + 2 <= n + 3 instead.",
                            "source": "latex",
                            "latex_start": 20,
                            "latex_end": 33,
                            "latex_excerpt": "n + 2 >= n + 3",
                            "lean_line": None,
                            "lean_column": None,
                            "replacement": "n + 2 <= n + 3",
                            "confidence": 0.93,
                        }
                    ],
                    "suggestions": ["Replace with n + 2 <= n + 3."],
                },
                "final_feedback": ["Try n + 2 <= n + 3."],
            },
        )

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        return CompileResult(success=True, stdout="", stderr="", diagnostics=[])

    async def fake_interpret_errors(
        code: str,
        compile_result: CompileResult,
        nl_input: str,
        settings=None,
    ) -> Interpretation:
        raise AssertionError("Local LLM interpretation should be skipped when modal interpretation exists.")

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)
    monkeypatch.setattr("app.main.interpret_errors", fake_interpret_errors)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={"nl_input": sentence},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["compile"]["success"] is True
        assert payload["interpretation"]["summary"] == "This universal inequality is false."
        assert payload["interpretation"]["items"][0]["replacement"] == "n + 2 <= n + 3"
        assert "Try n + 2 <= n + 3." in payload["interpretation"]["suggestions"]
        assert payload["dashboard"]["status"] == "warning"
        assert payload["highlights"]["highlights"]

        llm_stage = next(
            stage for stage in payload["pipeline"]["stages"] if stage["stage"] == "llm_interpretation"
        )
        assert llm_stage["attempted"] is False
        assert llm_stage["details"]["reason"] == "modal_metadata"

    asyncio.run(_run())


def test_solve_normalizes_unicode_math_sets_before_compile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen_compiled_code: list[str] = []

    async def fake_generate_lean(
        prompt: str,
        context: dict | None = None,
        max_iters: int = 1,
        settings=None,
    ) -> GeneratedLean:
        return GeneratedLean(
            code=(
                "import Std\n\n"
                "set_option autoImplicit false\n\n"
                "namespace MathGrammar\n"
                "axiom bad_claim : ∀ n : ℕ, n + 2 ≥ n + 3\n"
                "#check bad_claim\n"
                "end MathGrammar\n"
            ),
            metadata={"status": "ok", "is_valid_lean": True},
        )

    async def fake_compile_lean(code: str, settings=None) -> CompileResult:
        seen_compiled_code.append(code)
        if "ℕ" in code:
            return CompileResult(
                success=False,
                stdout="",
                stderr="Unknown identifier `ℕ`",
                diagnostics=[Diagnostic(severity="error", message="Unknown identifier `ℕ`")],
            )
        return CompileResult(success=True, stdout="", stderr="", diagnostics=[])

    monkeypatch.setattr("app.main.generate_lean", fake_generate_lean)
    monkeypatch.setattr("app.main.compile_lean", fake_compile_lean)

    async def _run() -> None:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            response = await client.post(
                "/v1/lean/solve",
                json={"nl_input": "For all naturals n, n + 2 >= n + 3."},
            )

        assert response.status_code == 200
        payload = response.json()
        assert payload["compile"]["success"] is True
        assert seen_compiled_code, "compile_lean should have been called"
        assert "Nat" in seen_compiled_code[0]
        assert "ℕ" not in seen_compiled_code[0]

    asyncio.run(_run())
