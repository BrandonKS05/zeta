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


def test_normalize_statement_type_rewrites_incomplete_def_header() -> None:
    """Herald-style def with no body becomes a type (params) → type for axiom _ : type."""
    statement = "def zeta_candidate (x : ℝ) : Set (ℤ × ℕ)"
    normalized = app._normalize_statement_type(statement)
    assert "def " not in normalized and "zeta_candidate" not in normalized
    assert "Set" in normalized and "→" in normalized
    assert "(x :" in normalized and ("Real" in normalized or "ℝ" in normalized)


def test_normalize_statement_type_incomplete_def_ignores_trailing_check() -> None:
    """Trailing #check line is not included in the extracted type."""
    statement = "def zeta_candidate (x : ℝ) : Set (ℤ × ℕ)\n#check zeta_candidate"
    normalized = app._normalize_statement_type(statement)
    assert "#check" not in normalized
    assert "→" in normalized and "Set" in normalized


def test_normalize_statement_type_extracts_def_from_full_lean_file() -> None:
    """When model returns a full Lean file (import, namespace, def, #check), extract def header as type."""
    statement = (
        "import Std\n\n"
        "set_option autoImplicit false\n\n"
        "namespace MathGrammar\n"
        "def zeta_candidate (x : ℝ) : Option (ℤ × ℤ)\n"
        "#check zeta_candidate\n"
        "end MathGrammar\n"
    )
    normalized = app._normalize_statement_type(statement)
    assert "def " not in normalized and "zeta_candidate" not in normalized
    assert "import " not in normalized and "namespace " not in normalized and "#check" not in normalized
    assert "→" in normalized and "Option" in normalized


def test_normalize_statement_type_rewrites_noncomputable_def_header() -> None:
    """Lean 4 'noncomputable def name (n : ℕ) : ℝ' (no body) is normalized to a type."""
    statement = "noncomputable def zeta_candidate (n : ℕ) : ℝ"
    normalized = app._normalize_statement_type(statement)
    assert "noncomputable" not in normalized and "def " not in normalized and "zeta_candidate" not in normalized
    assert "→" in normalized and ("Real" in normalized or "ℝ" in normalized)


def test_normalize_statement_type_noncomputable_def_in_full_file() -> None:
    """Full file with 'noncomputable def ...' line is normalized (line-by-line fallback)."""
    statement = (
        "import Std\n\n"
        "set_option autoImplicit false\n\n"
        "namespace MathGrammar\n"
        "noncomputable def zeta_candidate (n : ℕ) : ℝ\n"
        "#check zeta_candidate\n"
        "end MathGrammar\n"
    )
    normalized = app._normalize_statement_type(statement)
    assert "def " not in normalized and "noncomputable" not in normalized and "zeta_candidate" not in normalized
    assert "→" in normalized


def test_sanitize_lean_source_def_headers_replaces_def_line_with_axiom() -> None:
    """Safety net: full file with 'def name (...) : type' line gets that line replaced by axiom."""
    lean_source = (
        "import Std\n\n"
        "set_option autoImplicit false\n\n"
        "namespace MathGrammar\n"
        "def zeta_candidate (x : ℝ) : Set (ℤ × ℤ)\n"
        "#check zeta_candidate\n"
        "end MathGrammar\n"
    )
    out = app._sanitize_lean_source_def_headers(lean_source, "zeta_candidate")
    assert "def zeta_candidate" not in out
    assert "axiom zeta_candidate :" in out
    assert "→" in out and "Set" in out
    assert "#check zeta_candidate" in out


def test_refine_statement_type_rewrites_incomplete_let_when_diagnostic_has_check() -> None:
    refined, notes = app._refine_statement_type(
        statement_type="let x : ℝ",
        diagnostics=[
            app.LeanDiagnostic(
                severity="error",
                message="unexpected token '#check'; expected ':=', 'where' or '|'",
                line=4,
                column=1,
            ),
        ],
    )
    assert refined == "∀ x : Real, True"
    assert any("let" in n.lower() or "axiom" in n.lower() for n in notes)


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


def test_extract_missing_olean_modules_parses_mathlib_only() -> None:
    diagnostics = [
        app.LeanDiagnostic(
            severity="error",
            message=(
                "object file '/tmp/Mathlib/Probability/Filtration.olean' "
                "of module Mathlib.Probability.Filtration does not exist"
            ),
        ),
        app.LeanDiagnostic(
            severity="error",
            message=(
                "object file '/tmp/Init/Prelude.olean' "
                "of module Init.Prelude does not exist"
            ),
        ),
    ]
    modules = app._extract_missing_olean_modules("", diagnostics)
    assert modules == ["Mathlib.Probability.Filtration"]


def test_sanitize_mathlib_modules_dedupes_and_filters() -> None:
    modules = app._sanitize_mathlib_modules(
        [
            "Mathlib.Data.Real.Basic",
            " Init.Prelude ",
            "Mathlib.Data.Real.Basic",
            "Mathlib.Probability.Filtration",
        ]
    )
    assert modules == ["Mathlib.Data.Real.Basic", "Mathlib.Probability.Filtration"]


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


def test_apply_final_feedback_summary_appends_llm_feedback(monkeypatch) -> None:
    def fake_summarize(request: app.AnalyzeRequest, response: app.AnalyzeResponse) -> list[str]:
        return ["Use explicit binders for free variables.", "Looks valid in Lean."]

    monkeypatch.setattr(app, "_summarize_final_feedback_with_llm", fake_summarize)
    request = app.AnalyzeRequest(text="For all x, x = x.", mode="fast")
    response = _resp(
        status="ok",
        input_text=request.text,
        normalized_text=request.text,
        is_valid_lean=True,
        statement_type="∀ x : Nat, x = x",
        feedback=["Generated a Lean statement type candidate from natural language input."],
    )

    updated = app._apply_final_feedback_summary(request, response)

    assert updated.final_feedback == [
        "Use explicit binders for free variables.",
        "Looks valid in Lean.",
    ]
    assert any(item.startswith("LLM final feedback: ") for item in updated.feedback)


def test_apply_final_feedback_summary_skips_for_skip_lean_check(monkeypatch) -> None:
    called = {"summarize": 0}

    def fake_summarize(request: app.AnalyzeRequest, response: app.AnalyzeResponse) -> list[str]:
        called["summarize"] += 1
        return ["unused"]

    monkeypatch.setattr(app, "_summarize_final_feedback_with_llm", fake_summarize)
    request = app.AnalyzeRequest(text="For all x, x = x.", skip_lean_check=True)
    response = _resp(
        status="unchecked",
        input_text=request.text,
        normalized_text=request.text,
        is_valid_lean=False,
    )

    updated = app._apply_final_feedback_summary(request, response)

    assert called["summarize"] == 0
    assert updated.final_feedback == []


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


def test_validate_statement_type_rejects_declaration_prefix() -> None:
    message = app._validate_statement_type("theorem add_zero_right")
    assert isinstance(message, str)
    assert "declaration syntax" in message


def test_extract_statement_payload_jsonish_fallback() -> None:
    raw = (
        '{ "lean_statement_type": "∀ n : Nat, n + 0 = n", '
        '"assumptions": [], "notes": "ok", "unterminated": '
    )
    statement, assumptions, notes = app._extract_statement_payload(raw)
    assert statement == "∀ n : Nat, n + 0 = n"
    assert assumptions == []
    assert notes == ""


def test_complete_cache_key_changes_with_prefix() -> None:
    req_a = app.CompleteRequest(text="For all n", cursor_offset=3, imports=["Std"])
    req_b = app.CompleteRequest(text="For all n", cursor_offset=8, imports=["Std"])
    assert app._complete_cache_key(req_a) != app._complete_cache_key(req_b)


def test_rank_completion_candidates_filters_forbidden() -> None:
    ranked, rejected = app._rank_completion_candidates(
        prefix_text="For all n,",
        retrieval_hints=["∀ n : Nat, n + 0 = n"],
        raw_outputs=[
            '{"candidates": [" theorem bad_candidate", " n + 0 = n"]}',
        ],
        max_candidates=3,
    )
    assert ranked
    assert ranked[0].completion.strip() == "n + 0 = n"
    assert rejected


def test_extract_completion_candidates_from_schema_fragment_output() -> None:
    raw = '"candidates": ["n", "n + 0 = n", "0 + n = n"]'
    extracted = app._extract_completion_candidates_from_output(raw)
    assert extracted[:2] == ["n", "n + 0 = n"]


def test_extract_completion_candidates_from_truncated_json_fragment() -> None:
    raw = '{"candidates": ["n", "n + 0 = n", "0 + n = n",'
    extracted = app._extract_completion_candidates_from_output(raw)
    assert extracted[:3] == ["n", "n + 0 = n", "0 + n = n"]


def test_extract_completion_candidates_from_truncated_first_item() -> None:
    raw = '{\n  "candidates": ["a * (b + c) ='
    extracted = app._extract_completion_candidates_from_output(raw)
    assert extracted == ["a * (b + c) ="]


def test_normalize_completion_suffix_rejects_schema_fragment() -> None:
    suffix, reasons = app._normalize_completion_suffix("For all n,", 'candidates": ["n + 0 = n"]')
    assert suffix is None
    assert "schema_fragment" in reasons
