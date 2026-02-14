"""Query the deployed Modal HTTP endpoint from Python."""

from __future__ import annotations

import argparse
import json

import requests


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Modal endpoint URL")
    parser.add_argument("--text", required=True)
    parser.add_argument("--source-lang", default="English")
    parser.add_argument("--target-lang", default="Spanish")
    parser.add_argument("--max-new-tokens", type=int, default=128)
    parser.add_argument("--temperature", type=float, default=0.2)
    args = parser.parse_args()

    payload = {
        "text": args.text,
        "source_lang": args.source_lang,
        "target_lang": args.target_lang,
        "max_new_tokens": args.max_new_tokens,
        "temperature": args.temperature,
    }
    resp = requests.post(args.url, json=payload, timeout=120)
    resp.raise_for_status()
    print(json.dumps(resp.json(), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

