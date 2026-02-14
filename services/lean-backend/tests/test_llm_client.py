from __future__ import annotations

from app.llm_client import _normalize_interpretation
from app.models import CompileResult, Diagnostic


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
