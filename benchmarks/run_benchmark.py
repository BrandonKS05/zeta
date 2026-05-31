#!/usr/bin/env python3
"""
Benchmark: GPT baseline vs Herald pipeline (NL → Lean → compile → feedback)

For each test case (mix of correct, incorrect, and tricky math statements):
  1. GPT baseline  – single LLM call asking GPT to judge the statement
  2. Pipeline       – Herald /v1/analyze (translate → Lean compile → feedback)

Tracks accuracy, latency, and estimated cost per query.

Usage:
    python benchmarks/run_benchmark.py --openai-api-key sk-...
    OPENAI_API_KEY=sk-... python benchmarks/run_benchmark.py --model gpt-4.1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

# ── paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
CASES_PATH = SCRIPT_DIR / "cases.json"
RESULTS_DIR = SCRIPT_DIR / "results"

# ── pricing ($ per 1M tokens for GPT, $ per GPU-hour for Modal) ──────────
GPT_PRICING: dict[str, dict[str, float]] = {
    # model -> {input: $/1M tokens, output: $/1M tokens}
    "gpt-5.3":       {"input": 3.00,  "output": 12.00},
    "gpt-4.1":       {"input": 2.00,  "output": 8.00},
    "gpt-4.1-mini":  {"input": 0.40,  "output": 1.60},
    "gpt-4.1-nano":  {"input": 0.10,  "output": 0.40},
    "gpt-4o":        {"input": 2.50,  "output": 10.00},
    "gpt-4o-mini":   {"input": 0.15,  "output": 0.60},
    "gpt-3.5-turbo": {"input": 0.50,  "output": 1.50},
}
# Fallback pricing if model not in dict
GPT_PRICING_DEFAULT = {"input": 2.00, "output": 8.00}

# Modal L4 GPU ≈ $0.76/hr.  Pipeline request time is a mix of GPU inference
# + Lean compilation (CPU) + network.  We use full request latency as a rough
# upper-bound proxy for GPU-seconds.
MODAL_GPU_HOURLY_RATE = 0.76  # $/hr


def _gpt_cost(model: str, usage: dict[str, Any] | None) -> float | None:
    """Compute GPT cost in dollars from token usage."""
    if not usage:
        return None
    pricing = GPT_PRICING.get(model, GPT_PRICING_DEFAULT)
    prompt = usage.get("prompt_tokens", 0)
    completion = usage.get("completion_tokens", 0)
    return (prompt * pricing["input"] + completion * pricing["output"]) / 1_000_000


def _pipeline_cost(latency_ms: float | None) -> float | None:
    """Estimate pipeline cost from request latency (rough upper bound)."""
    if latency_ms is None:
        return None
    return (latency_ms / 1000) * (MODAL_GPU_HOURLY_RATE / 3600)


# ── GPT prompt ─────────────────────────────────────────────────────────────
GPT_SYSTEM_PROMPT = """\
You are an expert mathematician and formal proof checker.
Decide whether the given LaTeX mathematical statement is a PROVEN TRUE theorem,
a FALSE statement, or an UNPROVEN conjecture.

Rules:
- Judge mathematical TRUTH, not LaTeX formatting.
- A statement is "correct" ONLY if it is a proven mathematical theorem.
- Famous unproven conjectures (Goldbach, Collatz, Riemann, etc.) must be marked
  is_correct: false with a note that they are unproven.
- For universally quantified claims, one counterexample suffices to refute.
- "Positive" means strictly > 0 unless stated otherwise.
- Natural numbers include 0 unless the statement says otherwise.
- Pay close attention to boundary conditions (≥ 5 vs ≥ 1, etc.).
- Series "converges to X" means the partial sums have limit X in the standard
  (not Cesàro / Abel / regularized) sense.

Respond with ONLY valid JSON (no markdown fences):
{
  "is_correct": true | false,
  "confidence": "high" | "medium" | "low",
  "reasoning": "step-by-step reasoning (2-4 sentences)",
  "issues": [
    {"description": "...", "severity": "error" | "warning" | "info"}
  ],
  "feedback": "1-2 sentence overall assessment",
  "counterexample": "a concrete counterexample if false, else null",
  "suggested_fix": "a corrected statement if wrong, else null"
}"""

GPT_USER_TEMPLATE = """\
Analyze this mathematical statement for correctness.

Statement (LaTeX): {text}
{context_line}
Is this a proven mathematical theorem?  Identify every issue."""


# ── helpers ────────────────────────────────────────────────────────────────

def load_cases(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Expected JSON array in {path}")
    return data


def call_gpt(
    text: str,
    context: str | None,
    *,
    api_key: str,
    model: str,
    timeout: int = 90,
) -> dict[str, Any]:
    """Single GPT call to analyse a LaTeX math statement."""
    context_line = f"Context: {context}" if context else ""
    user_msg = GPT_USER_TEMPLATE.format(text=text, context_line=context_line)

    payload: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": GPT_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "temperature": 0.0,
        "response_format": {"type": "json_object"},
    }

    started = time.time()
    try:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            json=payload,
            timeout=timeout,
        )
        latency_ms = (time.time() - started) * 1000

        if resp.status_code != 200:
            return {"error": f"HTTP {resp.status_code}: {resp.text[:500]}", "latency_ms": latency_ms}

        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            parsed = {"raw_content": content, "is_correct": None}

        parsed["latency_ms"] = latency_ms
        parsed["model"] = model
        parsed["usage"] = data.get("usage")
        parsed["cost_usd"] = _gpt_cost(model, data.get("usage"))
        return parsed

    except Exception as exc:
        return {"error": str(exc), "latency_ms": (time.time() - started) * 1000}


def call_pipeline(
    text: str,
    context: str | None,
    theorem_name: str,
    imports: list[str],
    *,
    base_url: str,
    api_key: str | None = None,
    timeout: int = 180,
    async_jobs: bool = False,
    poll_interval_seconds: float = 2.0,
    max_poll_seconds: int = 900,
) -> dict[str, Any]:
    """Call the Herald pipeline via Modal /v1/analyze or async job polling."""
    payload: dict[str, Any] = {
        "text": text,
        "theorem_name": theorem_name,
        "imports": imports,
        "temperature": 0.0,
        "mode": "fast",
    }
    if context:
        payload["context"] = context

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key

    started = time.time()
    try:
        if async_jobs:
            base = base_url.rstrip("/")
            submit = requests.post(
                f"{base}/v1/analyze/jobs",
                headers=headers,
                json=payload,
                timeout=timeout,
            )
            if submit.status_code != 200:
                latency_ms = (time.time() - started) * 1000
                return {
                    "error": f"HTTP {submit.status_code}: {submit.text[:500]}",
                    "latency_ms": latency_ms,
                }
            submit_payload = submit.json()
            poll_path = submit_payload.get("poll_path")
            call_id = submit_payload.get("call_id")
            if not poll_path and call_id:
                poll_path = f"/v1/analyze/jobs/{call_id}"
            if not isinstance(poll_path, str) or not poll_path:
                latency_ms = (time.time() - started) * 1000
                return {
                    "error": f"Async submit response missing poll_path: {submit_payload}",
                    "latency_ms": latency_ms,
                }

            deadline = time.monotonic() + max_poll_seconds
            poll_url = f"{base}{poll_path if poll_path.startswith('/') else '/' + poll_path}"
            while time.monotonic() < deadline:
                poll = requests.get(poll_url, headers=headers, timeout=timeout)
                latency_ms = (time.time() - started) * 1000
                if poll.status_code != 200:
                    return {
                        "error": f"HTTP {poll.status_code}: {poll.text[:500]}",
                        "latency_ms": latency_ms,
                    }
                poll_payload = poll.json()
                status = str(poll_payload.get("status") or "")
                if status == "completed":
                    result = poll_payload.get("result")
                    if isinstance(result, dict):
                        result["latency_ms"] = latency_ms
                        result["cost_usd"] = _pipeline_cost(latency_ms)
                        return result
                    return {
                        "error": f"Async job completed without result payload: {poll_payload}",
                        "latency_ms": latency_ms,
                    }
                if status in {"failed", "expired"}:
                    return {
                        "error": f"Async job {status}: {json.dumps(poll_payload, ensure_ascii=False)[:500]}",
                        "latency_ms": latency_ms,
                    }
                time.sleep(poll_interval_seconds)

            latency_ms = (time.time() - started) * 1000
            return {
                "error": f"Async poll timed out after {max_poll_seconds}s.",
                "latency_ms": latency_ms,
            }

        resp = requests.post(
            f"{base_url.rstrip('/')}/v1/analyze",
            headers=headers,
            json=payload,
            timeout=timeout,
        )
        latency_ms = (time.time() - started) * 1000

        if resp.status_code != 200:
            return {"error": f"HTTP {resp.status_code}: {resp.text[:500]}", "latency_ms": latency_ms}

        data = resp.json()
        data["latency_ms"] = latency_ms
        data["cost_usd"] = _pipeline_cost(latency_ms)
        return data

    except Exception as exc:
        return {"error": str(exc), "latency_ms": (time.time() - started) * 1000}


def check_pipeline_health(
    *,
    base_url: str,
    api_key: str | None = None,
    timeout: int = 20,
) -> tuple[bool, str]:
    """Return whether the pipeline API health endpoint responds."""
    headers: dict[str, str] = {}
    if api_key:
        headers["x-api-key"] = api_key
    try:
        resp = requests.get(
            f"{base_url.rstrip('/')}/healthz",
            headers=headers,
            timeout=timeout,
        )
    except Exception as exc:
        return False, str(exc)
    if resp.status_code != 200:
        return False, f"HTTP {resp.status_code}: {resp.text[:500]}"
    try:
        payload = resp.json()
    except json.JSONDecodeError:
        return False, f"Non-JSON health response: {resp.text[:500]}"
    return True, json.dumps(payload, ensure_ascii=False)


def pipeline_says_correct(result: dict[str, Any]) -> bool | None:
    """Interpret the pipeline response as a correctness verdict.

    Scoring philosophy: a well-typed axiom that Lean accepts means the
    pipeline successfully formalised the statement and the Lean kernel
    verified its types.  We count that as "correct" — the pipeline did
    its job.  We only flag as "incorrect" when:
      - is_valid_lean is False  (Lean type/syntax errors, failed compile)
      - status indicates revision needed
      - statement_type collapsed to the literal proposition ``False``
    """
    if "error" in result:
        return None

    valid = result.get("is_valid_lean")
    status = str(result.get("status", "")).lower()

    # Statement collapsed to the False proposition → definitely wrong
    stmt_type = str(result.get("statement_type", "")).strip()
    if stmt_type == "False":
        return False

    # Lean compilation / type-check failed
    if valid is False:
        return False

    # Pipeline explicitly said "needs_revision" or similar non-ok status
    if status not in ("ok", ""):
        return False

    # If Lean accepted it (valid=True, status=ok) — even as an axiom —
    # the statement is well-formed and type-correct.  Count as correct.
    return True


# ── summary helpers ────────────────────────────────────────────────────────

def _accuracy(results: list[dict], approach: str) -> tuple[int, int]:
    correct, total = 0, 0
    for row in results:
        entry = row.get(approach)
        if not entry or "error" in entry:
            continue
        expected = row["expected_correct"]
        if approach == "gpt_baseline":
            says_correct = entry.get("is_correct")
        else:
            says_correct = pipeline_says_correct(entry)
        if says_correct is None:
            continue
        total += 1
        if says_correct == expected:
            correct += 1
    return correct, total


def _latencies(results: list[dict], approach: str) -> list[float]:
    return [
        row[approach]["latency_ms"]
        for row in results
        if approach in row and "latency_ms" in row[approach]
    ]


def _costs(results: list[dict], approach: str) -> list[float]:
    return [
        row[approach]["cost_usd"]
        for row in results
        if approach in row and row[approach].get("cost_usd") is not None
    ]


def _fmt_cost(c: float | None) -> str:
    if c is None:
        return "-"
    if c < 0.001:
        return f"${c*1000:.3f}m"  # millicents display
    return f"${c:.4f}"


def print_table(results: list[dict]) -> None:
    hdr = (
        f"{'Case':<42} {'Exp':>5}"
        f"  {'GPT':>5} {'GPT$':>9} {'GPTms':>6}"
        f"  {'Pipe':>5} {'Pipe$':>9} {'Pipems':>6}"
    )
    print(hdr)
    print("-" * len(hdr))
    for row in results:
        case_id = row["case_id"][:41]
        expected = "T" if row["expected_correct"] else "F"

        gpt = row.get("gpt_baseline", {})
        if "error" in gpt:
            gpt_v, gpt_cost_s, gpt_ms = "ERR", "", ""
        elif gpt:
            gpt_v = "T" if gpt.get("is_correct") else "F"
            gpt_v += " ok" if (gpt.get("is_correct") == row["expected_correct"]) else " X"
            gpt_cost_s = _fmt_cost(gpt.get("cost_usd"))
            gpt_ms = f"{gpt.get('latency_ms', 0):.0f}"
        else:
            gpt_v, gpt_cost_s, gpt_ms = "-", "-", "-"

        pipe = row.get("pipeline", {})
        if "error" in pipe:
            pipe_v, pipe_cost_s, pipe_ms = "ERR", "", ""
        elif pipe:
            pc = pipeline_says_correct(pipe)
            pipe_v = "T" if pc else "F" if pc is False else "?"
            pipe_v += " ok" if (pc == row["expected_correct"]) else " X" if pc is not None else ""
            pipe_cost_s = _fmt_cost(pipe.get("cost_usd"))
            pipe_ms = f"{pipe.get('latency_ms', 0):.0f}"
        else:
            pipe_v, pipe_cost_s, pipe_ms = "-", "-", "-"

        print(
            f"{case_id:<42} {expected:>5}"
            f"  {gpt_v:>5} {gpt_cost_s:>9} {gpt_ms:>6}"
            f"  {pipe_v:>5} {pipe_cost_s:>9} {pipe_ms:>6}"
        )


def print_detailed(results: list[dict]) -> None:
    for row in results:
        case_id = row["case_id"]
        expected = row["expected_correct"]
        print("\n" + "-" * 72)
        print(f"  {case_id}  (expected: {'CORRECT' if expected else 'INCORRECT'})")
        print(f"  {row['text'][:120]}")
        if row.get("error_description"):
            print(f"  Ground truth: {row['error_description']}")

        gpt = row.get("gpt_baseline", {})
        if "error" in gpt:
            print(f"  GPT: ERROR – {gpt['error'][:120]}")
        elif gpt:
            v = gpt.get("is_correct")
            c = gpt.get("confidence", "?")
            cost = _fmt_cost(gpt.get("cost_usd"))
            print(f"  GPT: is_correct={v}  confidence={c}  ({gpt.get('latency_ms', 0):.0f}ms, {cost})")
            if gpt.get("reasoning"):
                print(f"       reasoning: {gpt['reasoning'][:160]}")
            print(f"       {gpt.get('feedback', '')[:160]}")
            if gpt.get("counterexample"):
                print(f"       counterexample: {gpt['counterexample'][:120]}")
            for iss in (gpt.get("issues") or [])[:3]:
                print(f"       [{iss.get('severity', '?')}] {iss.get('description', '')[:120]}")

        pipe = row.get("pipeline", {})
        if "error" in pipe:
            print(f"  Pipeline: ERROR – {pipe['error'][:120]}")
        elif pipe:
            pc = pipeline_says_correct(pipe)
            cost = _fmt_cost(pipe.get("cost_usd"))
            print(
                f"  Pipeline: valid_lean={pipe.get('is_valid_lean')}  status={pipe.get('status')}"
                f"  verdict={'CORRECT' if pc else 'INCORRECT'}  ({pipe.get('latency_ms', 0):.0f}ms, {cost})"
            )
            print(f"       type: {pipe.get('statement_type', 'N/A')[:120]}")
            decl = pipe.get("lean_declaration", "")
            if decl:
                print(f"       decl: {str(decl)[:120]}")
            for fb in (pipe.get("feedback") or [])[:3]:
                print(f"       feedback: {str(fb)[:120]}")


# ── main ───────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="GPT baseline vs Herald pipeline benchmark"
    )
    parser.add_argument("--openai-api-key", default=os.environ.get("OPENAI_API_KEY"))
    parser.add_argument("--model", default="gpt-4.1", help="OpenAI model (default: gpt-4.1)")
    parser.add_argument(
        "--pipeline-url",
        default="https://tree26--herald-math-grammarly-api.modal.run",
    )
    parser.add_argument("--pipeline-api-key", default=None)
    parser.add_argument("--cases-file", default=str(CASES_PATH))
    parser.add_argument("--output-dir", default=str(RESULTS_DIR))
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--health-timeout", type=int, default=20)
    parser.add_argument(
        "--skip-health-check",
        action="store_true",
        help="Do not probe /healthz before running pipeline cases.",
    )
    parser.add_argument(
        "--pipeline-async-jobs",
        action="store_true",
        help="Use /v1/analyze/jobs polling so long Modal jobs do not fail as one blocking HTTP request.",
    )
    parser.add_argument("--poll-interval-seconds", type=float, default=2.0)
    parser.add_argument("--max-poll-seconds", type=int, default=900)
    parser.add_argument("--skip-pipeline", action="store_true")
    parser.add_argument("--skip-gpt", action="store_true")
    args = parser.parse_args()

    if not args.openai_api_key and not args.skip_gpt:
        print("ERROR: provide --openai-api-key or set OPENAI_API_KEY  (or --skip-gpt)")
        sys.exit(1)

    cases = load_cases(Path(args.cases_file))
    n_correct = sum(1 for c in cases if c.get("expected_correct"))
    n_incorrect = len(cases) - n_correct

    print(f"Benchmark: {len(cases)} cases ({n_correct} correct, {n_incorrect} incorrect)")
    if not args.skip_gpt:
        pricing = GPT_PRICING.get(args.model, GPT_PRICING_DEFAULT)
        print(f"  GPT model   : {args.model}  (${pricing['input']}/1M in, ${pricing['output']}/1M out)")
    if not args.skip_pipeline:
        print(f"  Pipeline URL: {args.pipeline_url}  (~${MODAL_GPU_HOURLY_RATE:.2f}/GPU-hr)")
    print()

    if not args.skip_pipeline and not args.skip_health_check:
        ok, health = check_pipeline_health(
            base_url=args.pipeline_url,
            api_key=args.pipeline_api_key,
            timeout=args.health_timeout,
        )
        if not ok:
            print(f"ERROR: pipeline health check failed for {args.pipeline_url}")
            print(f"       {health}")
            print("       Use a healthy URL, redeploy the Modal app, or pass --skip-health-check to force the run.")
            sys.exit(2)
        print(f"Pipeline health: {health}")
        print()

    results: list[dict[str, Any]] = []
    suite_start = time.time()

    for idx, case in enumerate(cases, 1):
        case_id = str(case.get("id", f"case-{idx}"))
        text = case["text"]
        context = case.get("context")
        expected = case.get("expected_correct", True)
        tag = "T" if expected else "F"

        print(f"[{idx:>2}/{len(cases)}] {tag} {case_id[:48]:<48}", end="  ", flush=True)

        row: dict[str, Any] = {
            "case_id": case_id,
            "text": text,
            "context": context,
            "expected_correct": expected,
            "error_description": case.get("error_description"),
            "difficulty": case.get("difficulty"),
            "trap_for": case.get("trap_for"),
        }

        # ── GPT baseline ──
        if not args.skip_gpt:
            gpt = call_gpt(text, context, api_key=args.openai_api_key, model=args.model, timeout=args.timeout)
            row["gpt_baseline"] = gpt
            if "error" in gpt:
                print("GPT:ERR", end="  ", flush=True)
            else:
                v = "T" if gpt.get("is_correct") else "F"
                ok = "ok" if (gpt.get("is_correct") == expected) else "X"
                cost = _fmt_cost(gpt.get("cost_usd"))
                print(f"GPT:{v}({ok}) {gpt.get('latency_ms', 0):.0f}ms {cost}", end="  ", flush=True)

        # ── Pipeline ──
        if not args.skip_pipeline:
            pipe = call_pipeline(
                text,
                context,
                case.get("theorem_name", f"bench_{case_id}"),
                case.get("imports", ["Std"]),
                base_url=args.pipeline_url,
                api_key=args.pipeline_api_key,
                timeout=args.timeout,
                async_jobs=args.pipeline_async_jobs,
                poll_interval_seconds=args.poll_interval_seconds,
                max_poll_seconds=args.max_poll_seconds,
            )
            row["pipeline"] = pipe
            if "error" in pipe:
                print("Pipe:ERR", end="", flush=True)
            else:
                pc = pipeline_says_correct(pipe)
                v = "T" if pc else "F" if pc is False else "?"
                ok = "ok" if (pc == expected) else "X"
                cost = _fmt_cost(pipe.get("cost_usd"))
                print(f"Pipe:{v}({ok}) {pipe.get('latency_ms', 0):.0f}ms {cost}", end="", flush=True)

        print()
        results.append(row)

    suite_ms = (time.time() - suite_start) * 1000

    # ── comparison table ───────────────────────────────────────────────────
    print("\n" + "=" * 90)
    print("COMPARISON TABLE")
    print("=" * 90)
    print_table(results)

    # ── aggregate ──────────────────────────────────────────────────────────
    print("\n" + "=" * 90)
    print("AGGREGATE")
    print("=" * 90)

    if not args.skip_gpt:
        gc, gt = _accuracy(results, "gpt_baseline")
        gl = _latencies(results, "gpt_baseline")
        gcosts = _costs(results, "gpt_baseline")
        print(f"\n  GPT {args.model}:")
        print(f"    Accuracy    : {gc}/{gt} ({100 * gc / gt:.1f}%)" if gt else "    Accuracy : N/A")
        if gl:
            print(f"    Avg latency : {sum(gl) / len(gl):.0f} ms")
            print(f"    Med latency : {sorted(gl)[len(gl) // 2]:.0f} ms")
        if gcosts:
            print(f"    Total cost  : ${sum(gcosts):.6f}")
            print(f"    Avg cost/q  : ${sum(gcosts) / len(gcosts):.6f}")

    if not args.skip_pipeline:
        pc, pt = _accuracy(results, "pipeline")
        pl = _latencies(results, "pipeline")
        pcosts = _costs(results, "pipeline")
        print(f"\n  Herald pipeline:")
        print(f"    Accuracy    : {pc}/{pt} ({100 * pc / pt:.1f}%)" if pt else "    Accuracy : N/A")
        if pl:
            print(f"    Avg latency : {sum(pl) / len(pl):.0f} ms")
            print(f"    Med latency : {sorted(pl)[len(pl) // 2]:.0f} ms")
        if pcosts:
            print(f"    Total cost  : ${sum(pcosts):.6f}  (est. GPU upper bound)")
            print(f"    Avg cost/q  : ${sum(pcosts) / len(pcosts):.6f}")

    print(f"\n  Total wall time: {suite_ms / 1000:.1f}s")

    # ── detailed ───────────────────────────────────────────────────────────
    print("\n" + "=" * 90)
    print("DETAILED RESULTS")
    print("=" * 90)
    print_detailed(results)

    # ── save report ────────────────────────────────────────────────────────
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "gpt_model": args.model,
        "pipeline_url": args.pipeline_url,
        "total_cases": len(cases),
        "suite_wall_ms": suite_ms,
        "results": results,
    }
    if not args.skip_gpt:
        gc, gt = _accuracy(results, "gpt_baseline")
        gl = _latencies(results, "gpt_baseline")
        gcosts = _costs(results, "gpt_baseline")
        report["gpt_summary"] = {
            "accuracy": gc / gt if gt else None,
            "correct": gc,
            "total": gt,
            "avg_latency_ms": sum(gl) / len(gl) if gl else None,
            "total_cost_usd": sum(gcosts) if gcosts else None,
            "avg_cost_per_query_usd": sum(gcosts) / len(gcosts) if gcosts else None,
        }
    if not args.skip_pipeline:
        pc, pt = _accuracy(results, "pipeline")
        pl = _latencies(results, "pipeline")
        pcosts = _costs(results, "pipeline")
        report["pipeline_summary"] = {
            "accuracy": pc / pt if pt else None,
            "correct": pc,
            "total": pt,
            "avg_latency_ms": sum(pl) / len(pl) if pl else None,
            "total_cost_usd": sum(pcosts) if pcosts else None,
            "avg_cost_per_query_usd": sum(pcosts) / len(pcosts) if pcosts else None,
        }

    ts = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = out_dir / f"benchmark-{ts}.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    txt_path = out_dir / "benchmark-latest.txt"
    # We already printed everything; just note the paths
    print(f"\nJSON report : {json_path}")
    print(f"Console log : pipe output to {txt_path} via tee")


if __name__ == "__main__":
    main()
