"""Query the deployed Modal HTTP API endpoint from Python."""

from __future__ import annotations

import argparse
import json
import time
from urllib.parse import urljoin

import requests


def _json_object_or_raise(resp: requests.Response) -> dict[str, object]:
    if not resp.content:
        raise RuntimeError(f"Expected JSON body, got empty response (HTTP {resp.status_code}).")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise RuntimeError(f"Response is not valid JSON (HTTP {resp.status_code}).") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"Expected JSON object response, got {type(payload).__name__}.")
    return payload


def _follow_modal_redirect(
    *,
    session: requests.Session,
    base_url: str,
    initial_location: str,
    headers: dict[str, str],
    request_timeout_seconds: int,
    poll_interval_seconds: float,
    poll_timeout_seconds: int,
) -> dict[str, object]:
    deadline = time.monotonic() + poll_timeout_seconds
    poll_url = urljoin(f"{base_url}/", initial_location)

    while True:
        if time.monotonic() > deadline:
            raise TimeoutError("Timed out while waiting for redirected Modal function result.")

        resp = session.get(
            poll_url,
            headers=headers,
            allow_redirects=False,
            timeout=request_timeout_seconds,
        )
        if resp.status_code == 303:
            next_location = resp.headers.get("location")
            if not next_location:
                raise RuntimeError("Received HTTP 303 without a Location header while polling.")
            poll_url = urljoin(f"{base_url}/", next_location)
            time.sleep(poll_interval_seconds)
            continue

        resp.raise_for_status()
        return _json_object_or_raise(resp)


def _poll_async_job(
    *,
    session: requests.Session,
    base_url: str,
    poll_url: str,
    headers: dict[str, str],
    request_timeout_seconds: int,
    poll_interval_seconds: float,
    poll_timeout_seconds: int,
) -> dict[str, object]:
    deadline = time.monotonic() + poll_timeout_seconds

    while True:
        if time.monotonic() > deadline:
            raise TimeoutError("Timed out while waiting for async job completion.")

        resp = session.get(
            poll_url,
            headers=headers,
            timeout=request_timeout_seconds,
            allow_redirects=False,
        )
        if resp.status_code == 303:
            next_location = resp.headers.get("location")
            if not next_location:
                raise RuntimeError("Received HTTP 303 without a Location header while polling async job.")
            poll_url = urljoin(f"{base_url}/", next_location)
            time.sleep(poll_interval_seconds)
            continue
        resp.raise_for_status()
        payload = _json_object_or_raise(resp)
        status = str(payload.get("status") or "")

        if status == "completed":
            result = payload.get("result")
            if isinstance(result, dict):
                return result
            raise RuntimeError("Async job completed but response was missing `result` object.")

        if status in {"failed", "expired"}:
            raise RuntimeError(json.dumps(payload, indent=2, ensure_ascii=False))

        time.sleep(poll_interval_seconds)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True, help="Modal endpoint base URL")
    parser.add_argument("--text", required=True)
    parser.add_argument("--context", default=None)
    parser.add_argument("--theorem-name", default=None)
    parser.add_argument(
        "--imports",
        default="Std",
        help="Comma-separated Lean imports. Example: Std,Mathlib",
    )
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--lean-timeout-seconds", type=int, default=20)
    parser.add_argument(
        "--mode",
        choices=["fast", "thinking"],
        default="fast",
        help="fast: single-pass (default), thinking: iterative Lean rewrite loop",
    )
    parser.add_argument(
        "--max-iters",
        type=int,
        default=3,
        help="Maximum thinking-mode iterations (ignored in fast mode).",
    )
    parser.add_argument(
        "--include-iteration-history",
        action="store_true",
        help="Include per-iteration attempt metadata in the response (thinking mode).",
    )
    parser.add_argument("--include-raw-model-output", action="store_true")
    parser.add_argument("--api-key", default=None)
    parser.add_argument(
        "--async-jobs",
        action="store_true",
        help="Use /v1/analyze/jobs + polling instead of blocking /v1/analyze.",
    )
    parser.add_argument(
        "--request-timeout-seconds",
        type=int,
        default=180,
        help="HTTP request timeout per call (submit/poll).",
    )
    parser.add_argument(
        "--poll-interval-seconds",
        type=float,
        default=2.0,
        help="Polling interval for async/redirected responses.",
    )
    parser.add_argument(
        "--poll-timeout-seconds",
        type=int,
        default=900,
        help="Maximum wall-clock time to wait for final result.",
    )
    args = parser.parse_args()

    payload = {
        "text": args.text,
        "context": args.context,
        "theorem_name": args.theorem_name,
        "imports": [item.strip() for item in args.imports.split(",") if item.strip()],
        "max_new_tokens": args.max_new_tokens,
        "temperature": args.temperature,
        "lean_timeout_seconds": args.lean_timeout_seconds,
        "mode": args.mode,
        "max_iters": args.max_iters,
        "include_iteration_history": args.include_iteration_history,
        "include_raw_model_output": args.include_raw_model_output,
    }
    headers = {}
    if args.api_key:
        headers["x-api-key"] = args.api_key

    base = args.base_url.rstrip("/")
    session = requests.Session()

    if args.async_jobs:
        submit = session.post(
            f"{base}/v1/analyze/jobs",
            json=payload,
            headers=headers,
            timeout=args.request_timeout_seconds,
            allow_redirects=False,
        )
        if submit.status_code == 303:
            location = submit.headers.get("location")
            if not location:
                raise RuntimeError("Received HTTP 303 from /v1/analyze/jobs without a Location header.")
            submit_payload = _follow_modal_redirect(
                session=session,
                base_url=base,
                initial_location=location,
                headers=headers,
                request_timeout_seconds=args.request_timeout_seconds,
                poll_interval_seconds=args.poll_interval_seconds,
                poll_timeout_seconds=args.poll_timeout_seconds,
            )
        else:
            submit.raise_for_status()
            submit_payload = _json_object_or_raise(submit)
        poll_path = submit_payload.get("poll_path")
        if not isinstance(poll_path, str) or not poll_path:
            raise RuntimeError("Async submit response is missing `poll_path`.")
        poll_url = urljoin(f"{base}/", poll_path)
        result = _poll_async_job(
            session=session,
            base_url=base,
            poll_url=poll_url,
            headers=headers,
            request_timeout_seconds=args.request_timeout_seconds,
            poll_interval_seconds=args.poll_interval_seconds,
            poll_timeout_seconds=args.poll_timeout_seconds,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    resp = session.post(
        f"{base}/v1/analyze",
        json=payload,
        headers=headers,
        timeout=args.request_timeout_seconds,
        allow_redirects=False,
    )
    if resp.status_code == 303:
        location = resp.headers.get("location")
        if not location:
            raise RuntimeError("Received HTTP 303 from /v1/analyze without a Location header.")
        result = _follow_modal_redirect(
            session=session,
            base_url=base,
            initial_location=location,
            headers=headers,
            request_timeout_seconds=args.request_timeout_seconds,
            poll_interval_seconds=args.poll_interval_seconds,
            poll_timeout_seconds=args.poll_timeout_seconds,
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    resp.raise_for_status()
    print(json.dumps(_json_object_or_raise(resp), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
