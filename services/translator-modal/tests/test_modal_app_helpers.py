from __future__ import annotations

import modal_app as app


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
