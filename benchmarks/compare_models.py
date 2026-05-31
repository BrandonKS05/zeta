#!/usr/bin/env python3
"""
Model comparison benchmark: Herald_translator vs DeepSeek-Prover-V2-7B

Runs 20 problems through both /v1/analyze endpoints and compares:
  - JSON parse success rate
  - Lean type extraction success rate
  - Lean compile success rate (is_valid_lean)
  - Semantic match (expected_correct vs is_valid_lean)
  - Latency

Usage:
    python benchmarks/compare_models.py \
        --herald-url  https://<your-herald-app>.modal.run \
        --deepseek-url https://<your-deepseek-app>.modal.run \
        [--cases benchmarks/cases_hard20.json] \
        [--out benchmarks/results/compare_TIMESTAMP.json]

Both endpoints must serve the /v1/analyze API from modal_app.py.
Pass --api-key if the Modal apps require an API_KEY header.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CASES = SCRIPT_DIR / "cases_hard20.json"
RESULTS_DIR = SCRIPT_DIR / "results"

REQUEST_TIMEOUT = 120  # seconds per request


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _post_analyze(base_url: str, case: dict[str, Any], api_key: str | None) -> tuple[dict[str, Any], float]:
    """POST to /v1/analyze and return (response_dict, latency_seconds)."""
    url = base_url.rstrip("/") + "/v1/analyze"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key

    payload = {
        "text": case["text"],
        "theorem_name": case.get("theorem_name"),
        "imports": case.get("imports", ["Std"]),
        "temperature": 0.0,
        "max_new_tokens": 256,
        "mode": "fast",
        "max_iters": 1,
        "skip_lean_check": False,
    }
    if case.get("context"):
        payload["context"] = case["context"]

    t0 = time.perf_counter()
    try:
        resp = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        latency = time.perf_counter() - t0
        resp.raise_for_status()
        return resp.json(), latency
    except requests.exceptions.Timeout:
        latency = time.perf_counter() - t0
        return {"_error": "timeout", "_latency": latency}, latency
    except requests.exceptions.HTTPError as exc:
        latency = time.perf_counter() - t0
        body = ""
        try:
            body = exc.response.text[:400]
        except Exception:
            pass
        return {"_error": f"http_{exc.response.status_code}", "_body": body}, latency
    except Exception as exc:
        latency = time.perf_counter() - t0
        return {"_error": str(exc)}, latency


# ── scoring ───────────────────────────────────────────────────────────────────

def _score_response(result: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    """Extract per-case metrics from a /v1/analyze response."""
    error = result.get("_error")
    if error:
        return {
            "error": error,
            "json_ok": False,
            "statement_extracted": False,
            "lean_valid": False,
            "correct_label": False,
            "latency_ms": int((result.get("_latency") or 0) * 1000),
        }

    statement = result.get("statement_type") or result.get("lean_source") or ""
    lean_valid: bool = bool(result.get("is_valid_lean"))
    expected: bool = bool(case.get("expected_correct", True))

    return {
        "error": None,
        "json_ok": True,
        "statement_extracted": bool(statement.strip()),
        "lean_valid": lean_valid,
        "correct_label": lean_valid == expected,
        "status": result.get("status"),
        "statement_type": statement[:200],
        "latency_ms": result.get("latency_ms") or 0,
        "diagnostics": [d.get("message", "") for d in (result.get("diagnostics") or [])[:2]],
    }


def _aggregate(scores: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(scores)
    if n == 0:
        return {}
    errors = sum(1 for s in scores if s.get("error"))
    json_ok = sum(1 for s in scores if s.get("json_ok"))
    extracted = sum(1 for s in scores if s.get("statement_extracted"))
    lean_valid = sum(1 for s in scores if s.get("lean_valid"))
    correct = sum(1 for s in scores if s.get("correct_label"))
    latencies = [s["latency_ms"] for s in scores if s.get("latency_ms")]
    return {
        "n": n,
        "errors": errors,
        "json_parse_rate": round(json_ok / n, 3),
        "extraction_rate": round(extracted / n, 3),
        "lean_valid_rate": round(lean_valid / n, 3),
        "accuracy": round(correct / n, 3),
        "latency_p50_ms": round(statistics.median(latencies)) if latencies else None,
        "latency_p90_ms": round(statistics.quantiles(latencies, n=10)[8]) if len(latencies) >= 10 else None,
        "latency_mean_ms": round(statistics.mean(latencies)) if latencies else None,
    }


# ── main ──────────────────────────────────────────────────────────────────────

def run(args: argparse.Namespace) -> None:
    cases_path = Path(args.cases)
    if not cases_path.exists():
        sys.exit(f"Cases file not found: {cases_path}")
    with cases_path.open() as f:
        all_cases: list[dict[str, Any]] = json.load(f)

    cases = all_cases[: args.n]
    print(f"Running {len(cases)} problems against two endpoints.")
    print(f"  Herald:   {args.herald_url}")
    print(f"  DeepSeek: {args.deepseek_url}")
    print()

    herald_scores: list[dict[str, Any]] = []
    deepseek_scores: list[dict[str, Any]] = []
    per_case: list[dict[str, Any]] = []

    for i, case in enumerate(cases, 1):
        cid = case.get("id", f"case-{i}")
        print(f"[{i:2d}/{len(cases)}] {cid}")

        h_result, h_lat = _post_analyze(args.herald_url, case, args.api_key)
        h_score = _score_response(h_result, case)
        h_score["latency_ms"] = h_score.get("latency_ms") or int(h_lat * 1000)

        d_result, d_lat = _post_analyze(args.deepseek_url, case, args.api_key)
        d_score = _score_response(d_result, case)
        d_score["latency_ms"] = d_score.get("latency_ms") or int(d_lat * 1000)

        herald_scores.append(h_score)
        deepseek_scores.append(d_score)

        h_mark = "✓" if h_score["lean_valid"] else "✗"
        d_mark = "✓" if d_score["lean_valid"] else "✗"
        print(
            f"  Herald  {h_mark} valid={h_score['lean_valid']}  "
            f"status={h_score.get('status','-'):18s}  {h_score['latency_ms']}ms"
        )
        print(
            f"  DeepSeek{d_mark} valid={d_score['lean_valid']}  "
            f"status={d_score.get('status','-'):18s}  {d_score['latency_ms']}ms"
        )

        per_case.append({
            "id": cid,
            "text": case["text"][:120],
            "expected_correct": case.get("expected_correct"),
            "herald": h_score,
            "deepseek": d_score,
        })

    h_agg = _aggregate(herald_scores)
    d_agg = _aggregate(deepseek_scores)

    print()
    print("=" * 60)
    print(f"{'Metric':<28} {'Herald':>12} {'DeepSeek-V2-7B':>14}")
    print("-" * 60)
    for key in ("json_parse_rate", "extraction_rate", "lean_valid_rate", "accuracy",
                "latency_p50_ms", "latency_mean_ms"):
        hv = h_agg.get(key, "-")
        dv = d_agg.get(key, "-")
        print(f"  {key:<26} {str(hv):>12} {str(dv):>14}")
    print("=" * 60)

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "herald_url": args.herald_url,
        "deepseek_url": args.deepseek_url,
        "n_cases": len(cases),
        "cases_file": str(cases_path),
        "herald_summary": h_agg,
        "deepseek_summary": d_agg,
        "per_case": per_case,
    }

    out_path: Path
    if args.out:
        out_path = Path(args.out)
    else:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        out_path = RESULTS_DIR / f"compare_{ts}.json"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nFull results written to: {out_path}")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Compare Herald vs DeepSeek-Prover-V2-7B on 20 problems.")
    p.add_argument(
        "--herald-url",
        required=True,
        help="Base URL of the Herald Modal deployment (e.g. https://user--herald-math-grammarly-api.modal.run)",
    )
    p.add_argument(
        "--deepseek-url",
        required=True,
        help="Base URL of the DeepSeek-Prover-V2-7B Modal deployment",
    )
    p.add_argument(
        "--cases",
        default=str(DEFAULT_CASES),
        help=f"Path to JSON cases file (default: {DEFAULT_CASES})",
    )
    p.add_argument(
        "--n",
        type=int,
        default=20,
        help="Number of problems to run (default: 20)",
    )
    p.add_argument(
        "--api-key",
        default=os.environ.get("ZETA_API_KEY"),
        help="API key for both Modal deployments (env: ZETA_API_KEY)",
    )
    p.add_argument(
        "--out",
        default=None,
        help="Output JSON path (default: benchmarks/results/compare_TIMESTAMP.json)",
    )
    return p.parse_args()


if __name__ == "__main__":
    run(_parse_args())
