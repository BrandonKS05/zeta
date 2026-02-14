"""Query the deployed Modal HTTP API endpoint from Python."""

from __future__ import annotations

import argparse
import json

import requests


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
    resp = requests.post(f"{base}/v1/analyze", json=payload, headers=headers, timeout=180)
    resp.raise_for_status()
    print(json.dumps(resp.json(), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
