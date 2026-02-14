"""Run Herald vs GPT error-detection benchmark with confusion-matrix metrics."""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

DEFAULT_CASES_PATH = Path(__file__).parent / "evals" / "cases_error_detection_proofnetsharp.json"
DEFAULT_RESULTS_DIR = Path(__file__).parent / "evals" / "results"


def _load_cases(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError(f"Expected list of cases in {path}")
    rows: list[dict[str, Any]] = []
    for idx, row in enumerate(payload, start=1):
        if not isinstance(row, dict):
            continue
        if not isinstance(row.get("text"), str):
            continue
        gold = row.get("gold")
        if not isinstance(gold, dict):
            raise ValueError(f"Row {idx} is missing `gold` label object")
        has_error = gold.get("has_error")
        error_count = gold.get("error_count")
        if not isinstance(has_error, bool):
            raise ValueError(f"Row {idx} has non-boolean gold.has_error")
        if not isinstance(error_count, int) or error_count < 0:
            raise ValueError(f"Row {idx} has invalid gold.error_count")
        rows.append(row)
    return rows


def _headers(api_key: str | None) -> dict[str, str]:
    headers = {"content-type": "application/json"}
    if api_key:
        headers["authorization"] = f"Bearer {api_key}"
    return headers


def _sleep_backoff(backoff_seconds: float, attempt: int) -> None:
    if backoff_seconds <= 0:
        return
    time.sleep(backoff_seconds * (2**attempt))


def _request_json_with_retries(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    json_payload: dict[str, Any] | None,
    timeout_seconds: int,
    retries: int,
    retry_backoff_seconds: float,
) -> tuple[dict[str, Any] | None, str | None]:
    attempt = 0
    while True:
        try:
            response = requests.request(
                method=method,
                url=url,
                headers=headers,
                json=json_payload,
                timeout=timeout_seconds,
            )
            response.raise_for_status()
            return response.json(), None
        except requests.RequestException as exc:
            if attempt >= retries:
                return None, str(exc)
            _sleep_backoff(retry_backoff_seconds, attempt)
            attempt += 1
        except ValueError as exc:
            return None, f"non-JSON response from {url}: {exc}"


def _extract_json_object(text: str) -> dict[str, Any] | None:
    content = text.strip()
    if not content:
        return None

    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = content.find("{")
    end = content.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        parsed = json.loads(content[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0"}:
            return False
    return None


def _safe_float_div(num: float, den: float) -> float | None:
    if den == 0:
        return None
    return num / den


def _extract_chat_message_content(payload: dict[str, Any]) -> str | None:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return None
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return None
    message = first_choice.get("message")
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    chunks.append(text)
        if chunks:
            return "\n".join(chunks)
    return None


def _count_error_diagnostics(diagnostics: Any) -> int:
    if not isinstance(diagnostics, list):
        return 0
    count = 0
    for diag in diagnostics:
        if not isinstance(diag, dict):
            continue
        severity = str(diag.get("severity") or "").lower().strip()
        if severity in {"", "error", "unknown"}:
            count += 1
    return count


def _categorize_herald_message(message: str) -> str:
    lowered = message.lower()
    if "unknown identifier" in lowered:
        return "unknown_identifier"
    if "type mismatch" in lowered:
        return "type_mismatch"
    if "parse" in lowered or "expected token" in lowered:
        return "parse_error"
    if "import" in lowered:
        return "import_error"
    if "timeout" in lowered:
        return "timeout"
    return "lean_error"


def _post_herald_sync(
    base_url: str,
    api_key: str | None,
    payload: dict[str, Any],
    *,
    timeout_seconds: int,
    retries: int,
    retry_backoff_seconds: float,
) -> tuple[dict[str, Any] | None, str | None]:
    headers = {"content-type": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    return _request_json_with_retries(
        method="POST",
        url=f"{base_url}/v1/analyze",
        headers=headers,
        json_payload=payload,
        timeout_seconds=timeout_seconds,
        retries=retries,
        retry_backoff_seconds=retry_backoff_seconds,
    )


def _post_herald_async_and_poll(
    base_url: str,
    api_key: str | None,
    payload: dict[str, Any],
    *,
    submit_timeout_seconds: int,
    poll_interval_seconds: float,
    max_poll_seconds: int,
    retries: int,
    retry_backoff_seconds: float,
) -> tuple[dict[str, Any] | None, str | None]:
    headers = {"content-type": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key

    submit_json, submit_error = _request_json_with_retries(
        method="POST",
        url=f"{base_url}/v1/analyze/jobs",
        headers=headers,
        json_payload=payload,
        timeout_seconds=submit_timeout_seconds,
        retries=retries,
        retry_backoff_seconds=retry_backoff_seconds,
    )
    if submit_error:
        return None, f"submit failed: {submit_error}"
    if submit_json is None:
        return None, "submit failed: empty response body"

    call_id = submit_json.get("call_id")
    if not call_id:
        return None, f"submit response missing call_id: {submit_json}"

    deadline = time.monotonic() + max_poll_seconds
    while time.monotonic() < deadline:
        poll_json, poll_error = _request_json_with_retries(
            method="GET",
            url=f"{base_url}/v1/analyze/jobs/{call_id}",
            headers=headers,
            json_payload=None,
            timeout_seconds=submit_timeout_seconds,
            retries=retries,
            retry_backoff_seconds=retry_backoff_seconds,
        )
        if poll_error:
            return None, f"poll failed for {call_id}: {poll_error}"
        if poll_json is None:
            return None, f"poll failed for {call_id}: empty response body"

        status = poll_json.get("status")
        if status == "completed":
            result = poll_json.get("result")
            if isinstance(result, dict):
                return result, None
            return None, f"completed response missing result payload: {poll_json}"
        if status in {"failed", "expired"}:
            return None, f"job {status}: {poll_json}"
        time.sleep(poll_interval_seconds)

    return None, f"poll timeout after {max_poll_seconds}s for call_id={call_id}"


def _predict_herald(
    case: dict[str, Any],
    *,
    base_url: str,
    api_key: str | None,
    async_jobs: bool,
    timeout_seconds: int,
    poll_interval_seconds: float,
    max_poll_seconds: int,
    retries: int,
    retry_backoff_seconds: float,
) -> dict[str, Any]:
    payload = {
        "text": case["text"],
        "context": case.get("context"),
        "theorem_name": case.get("theorem_name"),
        "imports": case.get("imports", ["Std"]),
        "temperature": 0.0,
        "max_new_tokens": 128,
        "lean_timeout_seconds": 20,
        "include_raw_model_output": False,
    }

    if async_jobs:
        response_json, error = _post_herald_async_and_poll(
            base_url=base_url,
            api_key=api_key,
            payload=payload,
            submit_timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
            max_poll_seconds=max_poll_seconds,
            retries=retries,
            retry_backoff_seconds=retry_backoff_seconds,
        )
    else:
        response_json, error = _post_herald_sync(
            base_url=base_url,
            api_key=api_key,
            payload=payload,
            timeout_seconds=timeout_seconds,
            retries=retries,
            retry_backoff_seconds=retry_backoff_seconds,
        )

    if error:
        return {
            "available": False,
            "request_error": error,
        }
    if response_json is None:
        return {
            "available": False,
            "request_error": "empty response body",
        }

    status = str(response_json.get("status") or "")
    is_valid_lean = bool(response_json.get("is_valid_lean"))
    has_error = not is_valid_lean
    diagnostics = response_json.get("diagnostics")
    diagnostic_count = _count_error_diagnostics(diagnostics)
    if has_error:
        predicted_count = max(1, diagnostic_count)
    else:
        predicted_count = 0

    predicted_types: list[str] = []
    if isinstance(diagnostics, list):
        for item in diagnostics:
            if not isinstance(item, dict):
                continue
            message = str(item.get("message") or "").strip()
            if not message:
                continue
            predicted_types.append(_categorize_herald_message(message))
    if not predicted_types and has_error:
        if status:
            predicted_types.append(status)
        else:
            predicted_types.append("unknown_error")

    return {
        "available": True,
        "request_error": None,
        "has_error": has_error,
        "error_count": predicted_count,
        "error_types": sorted(dict.fromkeys(predicted_types)),
        "status": status,
        "latency_ms": _coerce_int(response_json.get("latency_ms")),
    }


def _predict_gpt(
    case: dict[str, Any],
    *,
    base_url: str,
    api_key: str,
    model: str,
    timeout_seconds: int,
    retries: int,
    retry_backoff_seconds: float,
) -> dict[str, Any]:
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    system_prompt = (
        "You are a strict mathematical writing checker. "
        "Return JSON only with keys: has_error (boolean), error_count (integer >= 0), "
        "error_types (array of short snake_case strings), rationale (string). "
        "Count distinct mathematical, notation, and LaTeX issues."
    )
    context = case.get("context")
    context_text = context if isinstance(context, str) and context.strip() else "(none)"
    user_prompt = (
        "Assess this theorem statement for errors.\n\n"
        f"Statement:\n{case['text']}\n\n"
        f"Context:\n{context_text}\n\n"
        "Output strict JSON only."
    )
    payload = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    response_json, error = _request_json_with_retries(
        method="POST",
        url=endpoint,
        headers=_headers(api_key),
        json_payload=payload,
        timeout_seconds=timeout_seconds,
        retries=retries,
        retry_backoff_seconds=retry_backoff_seconds,
    )
    if error:
        return {
            "available": False,
            "request_error": error,
        }
    if response_json is None:
        return {
            "available": False,
            "request_error": "empty response body",
        }

    content = _extract_chat_message_content(response_json)
    if not content:
        return {
            "available": False,
            "request_error": "missing message content",
        }

    parsed = _extract_json_object(content)
    if parsed is None:
        return {
            "available": False,
            "request_error": "model output is not valid JSON object",
        }

    has_error = _coerce_bool(parsed.get("has_error"))
    if has_error is None:
        return {
            "available": False,
            "request_error": "model JSON missing valid has_error field",
        }

    error_count = _coerce_int(parsed.get("error_count"))
    if error_count is None:
        error_count = 1 if has_error else 0
    if error_count < 0:
        error_count = 0

    raw_types = parsed.get("error_types")
    error_types: list[str] = []
    if isinstance(raw_types, list):
        error_types = [str(item).strip() for item in raw_types if str(item).strip()]

    return {
        "available": True,
        "request_error": None,
        "has_error": has_error,
        "error_count": error_count,
        "error_types": error_types,
        "status": "ok",
    }


def _compute_system_metrics(rows: list[dict[str, Any]], system: str) -> dict[str, Any]:
    tp = tn = fp = fn = 0
    scored = 0
    count_rows = 0
    abs_error_sum = 0.0
    exact_count_matches = 0
    total_gold_count = 0
    total_pred_count = 0

    for row in rows:
        prediction = row.get("predictions", {}).get(system)
        if not isinstance(prediction, dict):
            continue
        if not bool(prediction.get("available")):
            continue

        gold = row["gold"]
        gold_has_error = bool(gold["has_error"])
        pred_has_error = prediction.get("has_error")
        if not isinstance(pred_has_error, bool):
            continue
        scored += 1

        if gold_has_error and pred_has_error:
            tp += 1
        elif (not gold_has_error) and (not pred_has_error):
            tn += 1
        elif (not gold_has_error) and pred_has_error:
            fp += 1
        elif gold_has_error and (not pred_has_error):
            fn += 1

        pred_count = prediction.get("error_count")
        if isinstance(pred_count, int) and pred_count >= 0:
            gold_count = int(gold["error_count"])
            count_rows += 1
            abs_error_sum += abs(pred_count - gold_count)
            total_gold_count += gold_count
            total_pred_count += pred_count
            if pred_count == gold_count:
                exact_count_matches += 1

    total = len(rows)
    precision = _safe_float_div(tp, tp + fp)
    recall = _safe_float_div(tp, tp + fn)
    specificity = _safe_float_div(tn, tn + fp)
    accuracy = _safe_float_div(tp + tn, scored)
    f1 = (
        _safe_float_div(2 * precision * recall, precision + recall)
        if precision is not None and recall is not None
        else None
    )

    return {
        "total_cases": total,
        "scored_cases": scored,
        "coverage": _safe_float_div(scored, total),
        "confusion": {
            "tp": tp,
            "tn": tn,
            "fp": fp,
            "fn": fn,
        },
        "precision": precision,
        "recall": recall,
        "specificity": specificity,
        "accuracy": accuracy,
        "f1": f1,
        "count_metrics": {
            "cases_with_count_prediction": count_rows,
            "mae": _safe_float_div(abs_error_sum, count_rows),
            "exact_match_rate": _safe_float_div(exact_count_matches, count_rows),
            "total_gold_error_count": total_gold_count,
            "total_pred_error_count": total_pred_count,
            "abs_total_count_gap": abs(total_pred_count - total_gold_count),
        },
    }


def _compute_pairwise_count_closeness(
    rows: list[dict[str, Any]],
    left_system: str,
    right_system: str,
) -> dict[str, Any]:
    compared = 0
    left_better = 0
    right_better = 0
    ties = 0

    for row in rows:
        predictions = row.get("predictions")
        if not isinstance(predictions, dict):
            continue
        left = predictions.get(left_system)
        right = predictions.get(right_system)
        if not isinstance(left, dict) or not isinstance(right, dict):
            continue
        if not bool(left.get("available")) or not bool(right.get("available")):
            continue
        left_count = left.get("error_count")
        right_count = right.get("error_count")
        if not isinstance(left_count, int) or not isinstance(right_count, int):
            continue

        gold_count = int(row["gold"]["error_count"])
        left_delta = abs(left_count - gold_count)
        right_delta = abs(right_count - gold_count)
        compared += 1

        if left_delta < right_delta:
            left_better += 1
        elif right_delta < left_delta:
            right_better += 1
        else:
            ties += 1

    return {
        "systems": [left_system, right_system],
        "compared_cases": compared,
        "left_better_cases": left_better,
        "right_better_cases": right_better,
        "ties": ties,
        "left_better_rate": _safe_float_div(left_better, compared),
        "right_better_rate": _safe_float_div(right_better, compared),
    }


def _print_system_summary(system: str, summary: dict[str, Any]) -> None:
    confusion = summary["confusion"]
    print(
        f"[{system}] coverage={summary['scored_cases']}/{summary['total_cases']} "
        f"tp={confusion['tp']} tn={confusion['tn']} fp={confusion['fp']} fn={confusion['fn']}"
    )
    print(
        f"[{system}] precision={summary['precision']} recall={summary['recall']} "
        f"specificity={summary['specificity']} accuracy={summary['accuracy']} f1={summary['f1']}"
    )
    count_metrics = summary["count_metrics"]
    print(
        f"[{system}] count_mae={count_metrics['mae']} exact_count_match_rate={count_metrics['exact_match_rate']} "
        f"total_gold_count={count_metrics['total_gold_error_count']} "
        f"total_pred_count={count_metrics['total_pred_error_count']}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases-file", default=str(DEFAULT_CASES_PATH))
    parser.add_argument("--results-dir", default=str(DEFAULT_RESULTS_DIR))
    parser.add_argument("--max-cases", type=int, default=0)
    parser.add_argument("--systems", default="herald,gpt", help="Comma-separated subset of: herald,gpt")

    parser.add_argument("--herald-base-url", default=None)
    parser.add_argument("--herald-api-key", default=None)
    parser.add_argument("--herald-async-jobs", action="store_true")
    parser.add_argument("--herald-http-timeout-seconds", type=int, default=240)
    parser.add_argument("--herald-poll-interval-seconds", type=float, default=2.0)
    parser.add_argument("--herald-max-poll-seconds", type=int, default=600)

    parser.add_argument("--openai-base-url", default="https://api.openai.com/v1")
    parser.add_argument("--openai-model", default="gpt-5-mini")
    parser.add_argument("--openai-api-key", default=os.environ.get("OPENAI_API_KEY"))
    parser.add_argument("--openai-timeout-seconds", type=int, default=60)

    parser.add_argument("--request-retries", type=int, default=3)
    parser.add_argument("--retry-backoff-seconds", type=float, default=0.75)
    args = parser.parse_args()

    systems = [item.strip() for item in args.systems.split(",") if item.strip()]
    allowed_systems = {"herald", "gpt"}
    unknown_systems = [item for item in systems if item not in allowed_systems]
    if unknown_systems:
        raise SystemExit(f"Unsupported systems: {', '.join(unknown_systems)}")

    if "herald" in systems and not args.herald_base_url:
        raise SystemExit("--herald-base-url is required when `herald` is selected.")
    if "gpt" in systems and not args.openai_api_key:
        raise SystemExit("OPENAI_API_KEY or --openai-api-key is required when `gpt` is selected.")

    cases_path = Path(args.cases_file)
    results_dir = Path(args.results_dir)
    results_dir.mkdir(parents=True, exist_ok=True)

    cases = _load_cases(cases_path)
    if args.max_cases > 0:
        cases = cases[: args.max_cases]

    rows: list[dict[str, Any]] = []
    started = time.time()
    for idx, case in enumerate(cases, start=1):
        case_id = str(case.get("id") or f"case-{idx}")
        print(f"[{idx}/{len(cases)}] {case_id}")
        row = {
            "case_id": case_id,
            "gold": case["gold"],
            "predictions": {},
        }

        if "herald" in systems:
            row["predictions"]["herald"] = _predict_herald(
                case,
                base_url=str(args.herald_base_url).rstrip("/"),
                api_key=args.herald_api_key,
                async_jobs=args.herald_async_jobs,
                timeout_seconds=args.herald_http_timeout_seconds,
                poll_interval_seconds=args.herald_poll_interval_seconds,
                max_poll_seconds=args.herald_max_poll_seconds,
                retries=args.request_retries,
                retry_backoff_seconds=args.retry_backoff_seconds,
            )
        if "gpt" in systems:
            row["predictions"]["gpt"] = _predict_gpt(
                case,
                base_url=args.openai_base_url,
                api_key=str(args.openai_api_key),
                model=args.openai_model,
                timeout_seconds=args.openai_timeout_seconds,
                retries=args.request_retries,
                retry_backoff_seconds=args.retry_backoff_seconds,
            )

        rows.append(row)

    summaries = {system: _compute_system_metrics(rows, system) for system in systems}
    pairwise: dict[str, Any] = {}
    if "herald" in systems and "gpt" in systems:
        pairwise = _compute_pairwise_count_closeness(rows, "herald", "gpt")

    ended = time.time()
    report = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "cases_file": str(cases_path),
        "systems": systems,
        "total_cases": len(cases),
        "suite_wall_ms": int((ended - started) * 1000),
        "summaries": summaries,
        "pairwise_count_closeness": pairwise,
        "rows": rows,
    }

    out_path = results_dir / f"error-benchmark-{datetime.now(tz=timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    for system in systems:
        _print_system_summary(system, summaries[system])
    if pairwise:
        print(
            "[pairwise] "
            f"compared={pairwise['compared_cases']} herald_better={pairwise['left_better_cases']} "
            f"gpt_better={pairwise['right_better_cases']} ties={pairwise['ties']}"
        )
    print(f"Saved report: {out_path}")


if __name__ == "__main__":
    main()
