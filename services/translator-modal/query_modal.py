"""Query the deployed Modal `analyze_rpc` function."""

from __future__ import annotations

import argparse
import json

import modal


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-name", default="herald-math-grammarly")
    parser.add_argument(
        "--mode",
        default="analyze",
        choices=["analyze", "generate"],
        help="`generate` skips Lean checking for faster NL->Lean suggestions.",
    )
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
    parser.add_argument("--skip-lean-check", action="store_true")
    parser.add_argument("--include-raw-model-output", action="store_true")
    args = parser.parse_args()

    fn = modal.Function.from_name(args.app_name, "analyze_rpc")
    payload = {
        "text": args.text,
        "context": args.context,
        "theorem_name": args.theorem_name,
        "imports": [item.strip() for item in args.imports.split(",") if item.strip()],
        "max_new_tokens": args.max_new_tokens,
        "temperature": args.temperature,
        "lean_timeout_seconds": args.lean_timeout_seconds,
        "include_raw_model_output": args.include_raw_model_output,
        "skip_lean_check": args.skip_lean_check or args.mode == "generate",
    }

    result = fn.remote(payload)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
