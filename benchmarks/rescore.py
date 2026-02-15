#!/usr/bin/env python3
"""Re-score existing benchmark JSON results with updated pipeline verdict logic.

New rule: a well-typed axiom that Lean accepts (is_valid_lean=True, status=ok)
counts as CORRECT, even if it's an unproven axiom.  Only count as incorrect when
compilation fails, status is needs_revision, or statement collapses to False.
"""

import json
import sys
from pathlib import Path


def pipeline_says_correct(result: dict) -> bool | None:
    if "error" in result:
        return None
    valid = result.get("is_valid_lean")
    status = str(result.get("status", "")).lower()
    stmt_type = str(result.get("statement_type", "")).strip()
    if stmt_type == "False":
        return False
    if valid is False:
        return False
    if status not in ("ok", ""):
        return False
    return True


def rescore(path: Path) -> None:
    data = json.loads(path.read_text())
    results = data.get("results", [])

    gpt_correct, gpt_total = 0, 0
    pipe_correct, pipe_total = 0, 0
    gpt_costs, pipe_costs = [], []
    gpt_lats, pipe_lats = [], []

    for row in results:
        expected = row.get("expected_correct")

        gpt = row.get("gpt_baseline")
        if gpt and "error" not in gpt and gpt.get("is_correct") is not None:
            gpt_total += 1
            if gpt["is_correct"] == expected:
                gpt_correct += 1
            if gpt.get("cost_usd") is not None:
                gpt_costs.append(gpt["cost_usd"])
            if gpt.get("latency_ms") is not None:
                gpt_lats.append(gpt["latency_ms"])

        pipe = row.get("pipeline")
        if pipe and "error" not in pipe:
            verdict = pipeline_says_correct(pipe)
            if verdict is not None:
                pipe_total += 1
                if verdict == expected:
                    pipe_correct += 1
            if pipe.get("cost_usd") is not None:
                pipe_costs.append(pipe["cost_usd"])
            if pipe.get("latency_ms") is not None:
                pipe_lats.append(pipe["latency_ms"])

    # Update summaries in-place
    if "gpt_summary" in data:
        data["gpt_summary"]["correct"] = gpt_correct
        data["gpt_summary"]["total"] = gpt_total
        data["gpt_summary"]["accuracy"] = gpt_correct / gpt_total if gpt_total else None

    if "pipeline_summary" in data:
        data["pipeline_summary"]["correct"] = pipe_correct
        data["pipeline_summary"]["total"] = pipe_total
        data["pipeline_summary"]["accuracy"] = pipe_correct / pipe_total if pipe_total else None

    path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    print(f"{path.name}:  GPT {gpt_correct}/{gpt_total}  Pipeline {pipe_correct}/{pipe_total}")


if __name__ == "__main__":
    results_dir = Path(__file__).resolve().parent / "results"
    files = sorted(results_dir.glob("benchmark-*.json"))
    for f in files:
        rescore(f)
