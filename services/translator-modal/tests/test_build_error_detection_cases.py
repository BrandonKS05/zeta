from __future__ import annotations

import evals.build_error_detection_cases as builder


def test_build_dataset_rows_produces_clean_and_corrupted_variants() -> None:
    base_cases = [
        {
            "id": "sample",
            "text": "For all $n \\in \\mathbb{N}$, we have $n + 0 = n$.",
            "context": "Simple arithmetic identity.",
            "theorem_name": "sample_theorem",
            "imports": ["Std"],
            "metadata": {"dataset": "demo", "split": "train"},
        }
    ]

    rows = builder._build_dataset_rows(
        base_cases,
        max_base_cases=1,
        corruptions_per_base=2,
        max_errors_per_corrupted=2,
        seed=123,
    )

    clean_rows = [row for row in rows if row["variant"] == "clean"]
    corrupted_rows = [row for row in rows if row["variant"] == "corrupted"]

    assert len(clean_rows) == 1
    assert len(corrupted_rows) >= 1
    assert clean_rows[0]["gold"]["has_error"] is False
    assert clean_rows[0]["gold"]["error_count"] == 0

    for row in corrupted_rows:
        assert row["gold"]["has_error"] is True
        assert row["gold"]["error_count"] >= 1
        assert row["gold"]["error_types"]
        assert row["text"] != base_cases[0]["text"]


def test_apply_mutations_caps_at_target_error_count() -> None:
    text = "For all $x \\in \\mathbb{R}$, we have \\frac{1}{x} > 0."
    mutated, applied = builder._apply_mutations(
        text=text,
        rng=builder.random.Random(7),
        target_error_count=2,
    )

    assert mutated != text
    assert 1 <= len(applied) <= 2
