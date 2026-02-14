from __future__ import annotations

import modal_app as app


def _resp(
    *,
    status: str,
    input_text: str,
    normalized_text: str,
    is_valid_lean: bool,
    statement_type: str | None = None,
    diagnostics: list[app.LeanDiagnostic] | None = None,
    feedback: list[str] | None = None,
    latency_ms: int = 5,
) -> app.AnalyzeResponse:
    return app.AnalyzeResponse(
        model=app.MODEL_ID,
        status=status,
        input_text=input_text,
        normalized_text=normalized_text,
        statement_type=statement_type,
        diagnostics=diagnostics or [],
        feedback=feedback or [],
        is_valid_lean=is_valid_lean,
        latency_ms=latency_ms,
    )


def test_normalize_statement_type_rewrites_unicode_sets() -> None:
    statement = "∀ n : ℕ, n + 0 = n"
    normalized = app._normalize_statement_type(statement)
    assert normalized == "∀ n : Nat, n + 0 = n"


def test_resolve_effective_imports_auto_enables_mathlib() -> None:
    imports, auto_enabled = app._resolve_effective_imports(["Std"], "∀ x : Real, x ^ 2 ≥ 0")
    assert auto_enabled is True
    assert imports[0] == "Mathlib.Data.Real.Basic"
    assert "Std" in imports


def test_resolve_effective_imports_respects_explicit_mathlib() -> None:
    imports, auto_enabled = app._resolve_effective_imports(["Mathlib", "Std"], "∀ n : Nat, n = n")
    assert auto_enabled is False
    assert imports == ["Mathlib", "Std"]


def test_parse_lean_diagnostics_with_error_codes() -> None:
    output = "/tmp/Candidate.lean:6:29: error(lean.unknownIdentifier): Unknown identifier `ℕ`"
    diagnostics = app._parse_lean_diagnostics(output)
    assert len(diagnostics) == 1
    assert diagnostics[0].line == 6
    assert diagnostics[0].column == 29
    assert diagnostics[0].severity == "error"
    assert "Unknown identifier" in diagnostics[0].message


def test_analyze_cache_key_distinguishes_skip_lean_check() -> None:
    req_full = app.AnalyzeRequest(text="n + 0 = n", skip_lean_check=False)
    req_fast = app.AnalyzeRequest(text="n + 0 = n", skip_lean_check=True)
    assert app._analyze_cache_key(req_full) != app._analyze_cache_key(req_fast)


def test_analyze_cache_key_distinguishes_modes() -> None:
    req_fast = app.AnalyzeRequest(text="For all n, n = n", mode="fast")
    req_thinking = app.AnalyzeRequest(text="For all n, n = n", mode="thinking", max_iters=4)
    assert app._analyze_cache_key(req_fast) != app._analyze_cache_key(req_thinking)


def test_refine_statement_type_adds_nat_annotations_to_untyped_forall() -> None:
    refined, rewrite_notes = app._refine_statement_type(
        statement_type="∀ x y, x = y",
        diagnostics=[app.LeanDiagnostic(severity="error", message="type mismatch")],
    )
    assert refined == "∀ x : Nat, ∀ y : Nat, x = y"
    assert any("Nat" in note for note in rewrite_notes)


def test_refine_statement_type_binds_unknown_identifiers() -> None:
    refined, rewrite_notes = app._refine_statement_type(
        statement_type="x = y",
        diagnostics=[app.LeanDiagnostic(severity="error", message="Unknown identifier `x`")],
    )
    assert refined.startswith("∀ x : Nat, ")
    assert any("missing `Nat` binders" in note for note in rewrite_notes)


def test_analyze_with_iterations_succeeds_on_second_attempt(monkeypatch) -> None:
    calls = {"analyze": 0, "evaluate": 0}

    def fake_analyze(request: app.AnalyzeRequest) -> app.AnalyzeResponse:
        calls["analyze"] += 1
        return _resp(
            status="needs_revision",
            input_text=request.text,
            normalized_text=request.text,
            is_valid_lean=False,
            statement_type="∀ x, x = x",
            diagnostics=[app.LeanDiagnostic(severity="error", message="Unknown identifier `x`")],
            feedback=["Lean found an unknown identifier. Add explicit binders or required imports."],
            latency_ms=3,
        )

    def fake_refine_statement_type(*, statement_type: str, diagnostics: list[app.LeanDiagnostic]):
        assert statement_type == "∀ x, x = x"
        assert diagnostics
        return "∀ x : Nat, x = x", ["Added explicit `Nat` annotations to untyped quantified variables."]

    def fake_evaluate_statement_type(
        *,
        request: app.AnalyzeRequest,
        normalized_text: str,
        statement_type: str,
        assumptions: list[str],
        notes: str,
        model_output: str | None,
    ) -> app.AnalyzeResponse:
        calls["evaluate"] += 1
        assert statement_type == "∀ x : Nat, x = x"
        return _resp(
            status="ok",
            input_text=request.text,
            normalized_text=normalized_text,
            is_valid_lean=True,
            statement_type=statement_type,
            diagnostics=[],
            feedback=["Looks good."],
            latency_ms=4,
        )

    monkeypatch.setattr(app, "_analyze", fake_analyze)
    monkeypatch.setattr(app, "_refine_statement_type", fake_refine_statement_type)
    monkeypatch.setattr(app, "_evaluate_statement_type", fake_evaluate_statement_type)

    result = app._analyze_with_iterations(
        app.AnalyzeRequest(
            text="For all x, x = x.",
            mode="thinking",
            max_iters=3,
            include_iteration_history=True,
        )
    )

    assert calls["analyze"] == 1
    assert calls["evaluate"] == 1
    assert result.mode == "thinking"
    assert result.iteration_count == 2
    assert result.is_valid_lean is True
    assert result.iteration_history is not None
    assert len(result.iteration_history) == 2
    assert any("Final suggestions" in item for item in result.feedback)
    assert any("Applied Lean rewrites" in item for item in result.feedback)


def test_analyze_with_iterations_stops_when_refinement_is_unchanged(monkeypatch) -> None:
    calls = {"evaluate": 0}

    def fake_analyze(request: app.AnalyzeRequest) -> app.AnalyzeResponse:
        return _resp(
            status="needs_revision",
            input_text=request.text,
            normalized_text=request.text,
            is_valid_lean=False,
            statement_type="∀ x, x = x",
            diagnostics=[app.LeanDiagnostic(severity="error", message="type mismatch")],
            feedback=["Lean reported a type mismatch. Clarify quantifiers/domains in the statement."],
            latency_ms=2,
        )

    def fake_refine_statement_type(*, statement_type: str, diagnostics: list[app.LeanDiagnostic]):
        return statement_type, []

    def fake_evaluate_statement_type(**kwargs):  # noqa: ANN003
        calls["evaluate"] += 1
        return _resp(
            status="ok",
            input_text="unused",
            normalized_text="unused",
            is_valid_lean=True,
            statement_type="unused",
        )

    monkeypatch.setattr(app, "_analyze", fake_analyze)
    monkeypatch.setattr(app, "_refine_statement_type", fake_refine_statement_type)
    monkeypatch.setattr(app, "_evaluate_statement_type", fake_evaluate_statement_type)

    result = app._analyze_with_iterations(
        app.AnalyzeRequest(
            text="For all x, x = x.",
            mode="thinking",
            max_iters=4,
            include_iteration_history=True,
        )
    )

    assert calls["evaluate"] == 0
    assert result.mode == "thinking"
    assert result.iteration_count == 1
    assert result.is_valid_lean is False
    assert any("stopped early" in item.lower() for item in result.feedback)
    assert any("final suggestions" in item.lower() for item in result.feedback)
