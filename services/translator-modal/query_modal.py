"""Query the deployed Modal function directly from Python."""

from __future__ import annotations

import argparse
import json

import modal


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-name", default="herald-translator")
    parser.add_argument("--text", required=True)
    parser.add_argument("--source-lang", default="English")
    parser.add_argument("--target-lang", default="Spanish")
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--temperature", type=float, default=0.2)
    args = parser.parse_args()

    fn = modal.Function.from_name(args.app_name, "translate_rpc")
    result = fn.remote(
        text=args.text,
        source_lang=args.source_lang,
        target_lang=args.target_lang,
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

