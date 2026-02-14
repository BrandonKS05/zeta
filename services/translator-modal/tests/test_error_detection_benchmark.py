from __future__ import annotations

import run_error_detection_benchmark as bench


def test_compute_system_metrics_confusion_and_counts() -> None:
    rows = [
        {
            "gold": {"has_error": True, "error_count": 2},
            "predictions": {"herald": {"available": True, "has_error": True, "error_count": 2}},
        },
        {
            "gold": {"has_error": False, "error_count": 0},
            "predictions": {"herald": {"available": True, "has_error": False, "error_count": 0}},
        },
        {
            "gold": {"has_error": False, "error_count": 0},
            "predictions": {"herald": {"available": True, "has_error": True, "error_count": 1}},
        },
        {
            "gold": {"has_error": True, "error_count": 1},
            "predictions": {"herald": {"available": True, "has_error": False, "error_count": 0}},
        },
    ]

    summary = bench._compute_system_metrics(rows, "herald")
    confusion = summary["confusion"]
    assert confusion == {"tp": 1, "tn": 1, "fp": 1, "fn": 1}
    assert summary["scored_cases"] == 4
    assert summary["precision"] == 0.5
    assert summary["recall"] == 0.5
    assert summary["accuracy"] == 0.5

    count_metrics = summary["count_metrics"]
    assert count_metrics["total_gold_error_count"] == 3
    assert count_metrics["total_pred_error_count"] == 3
    assert count_metrics["mae"] == 0.5
    assert count_metrics["exact_match_rate"] == 0.5


def test_compute_pairwise_count_closeness() -> None:
    rows = [
        {
            "gold": {"has_error": True, "error_count": 2},
            "predictions": {
                "herald": {"available": True, "error_count": 2},
                "gpt": {"available": True, "error_count": 1},
            },
        },
        {
            "gold": {"has_error": True, "error_count": 1},
            "predictions": {
                "herald": {"available": True, "error_count": 3},
                "gpt": {"available": True, "error_count": 1},
            },
        },
        {
            "gold": {"has_error": False, "error_count": 0},
            "predictions": {
                "herald": {"available": True, "error_count": 0},
                "gpt": {"available": True, "error_count": 0},
            },
        },
    ]

    pairwise = bench._compute_pairwise_count_closeness(rows, "herald", "gpt")
    assert pairwise["compared_cases"] == 3
    assert pairwise["left_better_cases"] == 1
    assert pairwise["right_better_cases"] == 1
    assert pairwise["ties"] == 1


def test_extract_json_object_handles_wrapped_text() -> None:
    text = "model output\n{\"has_error\": true, \"error_count\": 2}\nthanks"
    parsed = bench._extract_json_object(text)
    assert parsed == {"has_error": True, "error_count": 2}
