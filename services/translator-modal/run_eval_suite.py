"""Run a batch of NL->Lean evaluation queries against the deployed API."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

DEFAULT_CASES_PATH = Path(__file__).parent / "evals" / "cases.json"
DEFAULT_RESULTS_DIR = Path(__file__).parent / "evals" / "results"


def _load_cases(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError(f"Expected list of cases in {path}")
    return [case for case in payload if isinstance(case, dict)]


def _headers(api_key: str | None) -> dict[str, str]:
    headers = {"content-type": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    return headers


def _post_sync(
    base_url: str,
    api_key: str | None,
    case_payload: dict[str, Any],
    timeout_seconds: int,
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        response = requests.post(
            f"{base_url}/v1/analyze",
            headers=_headers(api_key),
            json=case_payload,
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        return response.json(), None
    except requests.RequestException as exc:
        return None, str(exc)


def _post_async_and_poll(
    base_url: str,
    api_key: str | None,
    case_payload: dict[str, Any],
    submit_timeout_seconds: int,
    poll_interval_seconds: float,
    max_poll_seconds: int,
) -> tuple[dict[str, Any] | None, str | None]:
    try:
        submit_response = requests.post(
            f"{base_url}/v1/analyze/jobs",
            headers=_headers(api_key),
            json=case_payload,
            timeout=submit_timeout_seconds,
        )
        submit_response.raise_for_status()
        submit_json = submit_response.json()
    except requests.RequestException as exc:
        return None, f"submit failed: {exc}"

    call_id = submit_json.get("call_id")
    if not call_id:
        return None, f"submit response missing call_id: {submit_json}"

    deadline = time.monotonic() + max_poll_seconds
    while time.monotonic() < deadline:
        try:
            poll_response = requests.get(
                f"{base_url}/v1/analyze/jobs/{call_id}",
                headers=_headers(api_key),
                timeout=submit_timeout_seconds,
            )
            poll_response.raise_for_status()
            poll_json = poll_response.json()
        except requests.RequestException as exc:
            return None, f"poll failed for {call_id}: {exc}"

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


def _print_summary(rows: list[dict[str, Any]]) -> None:
    def _response(row: dict[str, Any]) -> dict[str, Any]:
        response = row.get("response")
        return response if isinstance(response, dict) else {}

    total = len(rows)
    ok_status = sum(1 for row in rows if _response(row).get("status") == "ok")
    valid_lean = sum(1 for row in rows if _response(row).get("is_valid_lean") is True)
    failed_http = sum(1 for row in rows if row.get("error"))
    print(f"cases={total} status_ok={ok_status} lean_valid={valid_lean} request_failures={failed_http}")
    for row in rows:
        case_id = row.get("case_id", "unknown")
        error = row.get("error")
        if error:
            print(f"- {case_id}: REQUEST_ERROR -> {error}")
            continue
        response = _response(row)
        status = response.get("status")
        is_valid = response.get("is_valid_lean")
        latency = response.get("latency_ms")
        statement_type = response.get("statement_type")
        print(
            f"- {case_id}: status={status} valid={is_valid} latency_ms={latency} "
            f"statement_type={statement_type}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True, help="e.g. https://<app>--<fn>.modal.run")
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--cases-file", default=str(DEFAULT_CASES_PATH))
    parser.add_argument("--results-dir", default=str(DEFAULT_RESULTS_DIR))
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--lean-timeout-seconds", type=int, default=20)
    parser.add_argument("--http-timeout-seconds", type=int, default=240)
    parser.add_argument("--async-jobs", action="store_true", help="Use /v1/analyze/jobs + polling.")
    parser.add_argument("--poll-interval-seconds", type=float, default=2.0)
    parser.add_argument("--max-poll-seconds", type=int, default=600)
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    cases_file = Path(args.cases_file)
    results_dir = Path(args.results_dir)
    results_dir.mkdir(parents=True, exist_ok=True)

    cases = _load_cases(cases_file)
    rows: list[dict[str, Any]] = []

    suite_started = time.time()
    for idx, case in enumerate(cases, start=1):
        case_id = str(case.get("id") or f"case-{idx}")
        payload = {
            "text": case["text"],
            "context": case.get("context"),
            "theorem_name": case.get("theorem_name"),
            "imports": case.get("imports", ["Std"]),
            "temperature": args.temperature,
            "max_new_tokens": args.max_new_tokens,
            "lean_timeout_seconds": args.lean_timeout_seconds,
            "include_raw_model_output": False,
        }
        print(f"[{idx}/{len(cases)}] {case_id} ...")
        started = time.time()
        if args.async_jobs:
            response, error = _post_async_and_poll(
                base_url=base_url,
                api_key=args.api_key,
                case_payload=payload,
                submit_timeout_seconds=args.http_timeout_seconds,
                poll_interval_seconds=args.poll_interval_seconds,
                max_poll_seconds=args.max_poll_seconds,
            )
        else:
            response, error = _post_sync(
                base_url=base_url,
                api_key=args.api_key,
                case_payload=payload,
                timeout_seconds=args.http_timeout_seconds,
            )
        wall_ms = int((time.time() - started) * 1000)
        rows.append(
            {
                "case_id": case_id,
                "payload": payload,
                "response": response,
                "error": error,
                "request_wall_ms": wall_ms,
            }
        )

    suite_ended = time.time()
    report = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "base_url": base_url,
        "async_jobs": args.async_jobs,
        "total_cases": len(cases),
        "suite_wall_ms": int((suite_ended - suite_started) * 1000),
        "rows": rows,
    }
    out_path = results_dir / f"eval-{datetime.now(tz=timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    _print_summary(rows)
    print(f"\nSaved report: {out_path}")


if __name__ == "__main__":
    main()
