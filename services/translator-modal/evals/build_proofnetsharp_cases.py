"""Build paragraph-level eval cases from the ProofNet# Hugging Face dataset."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

DEFAULT_OUTPUT_PATH = Path(__file__).parent / "cases_proofnetsharp_paragraph.json"
DEFAULT_DATASET = "PAug/ProofNetSharp"


def _sanitize_name(raw: str, fallback_idx: int) -> str:
    candidate = re.sub(r"[^A-Za-z0-9_]", "_", raw).strip("_")
    if not candidate:
        candidate = f"proofnet_case_{fallback_idx}"
    if candidate[0].isdigit():
        candidate = f"s_{candidate}"
    return candidate[:80]


def _pick(row: dict[str, Any], keys: list[str]) -> str:
    for key in keys:
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _word_count(text: str) -> int:
    return len([token for token in re.split(r"\s+", text.strip()) if token])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--split", default="valid")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_PATH))
    parser.add_argument("--max-cases", type=int, default=100)
    parser.add_argument("--min-proof-words", type=int, default=80)
    parser.add_argument("--max-context-chars", type=int, default=1600)
    parser.add_argument(
        "--input-mode",
        default="statement_with_proof_context",
        choices=[
            "statement_with_proof_context",
            "proof_with_statement_context",
            "statement_only",
            "proof_only",
        ],
        help=(
            "How to map ProofNetSharp fields into request payload text/context. "
            "Use `proof_with_statement_context` to test nl_proof-driven prompting."
        ),
    )
    args = parser.parse_args()

    try:
        from datasets import load_dataset
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing dependency: datasets. Install with `pip install -r requirements-dev.txt`."
        ) from exc

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    dataset = load_dataset(args.dataset, split=args.split)

    cases: list[dict[str, Any]] = []
    for idx, row in enumerate(dataset, start=1):
        if not isinstance(row, dict):
            continue
        statement = _pick(
            row,
            ["nl_statement", "informal_statement", "statement", "problem", "prompt"],
        )
        proof = _pick(
            row,
            ["nl_proof", "informal_proof", "proof", "solution", "reasoning"],
        )
        if not statement or not proof:
            continue
        if _word_count(proof) < args.min_proof_words:
            continue

        proof_excerpt = proof[: args.max_context_chars]
        source_id = str(row.get("id") or row.get("name") or f"proofnet_{idx}")
        theorem_name = _sanitize_name(source_id, idx)

        text = statement
        context = (
            "Formalize only the central theorem statement from this paragraph-level proof sketch:\n\n"
            f"{proof_excerpt}"
        )
        if args.input_mode == "proof_with_statement_context":
            text = proof_excerpt
            context = (
                "From this proof sketch, infer and formalize only the main theorem statement.\n\n"
                f"Target informal statement:\n{statement}"
            )
        elif args.input_mode == "statement_only":
            text = statement
            context = None
        elif args.input_mode == "proof_only":
            text = proof_excerpt
            context = (
                "Infer and formalize only the central theorem statement from this proof sketch."
            )

        cases.append(
            {
                "id": f"proofnetsharp-{theorem_name}",
                "text": text,
                "context": context,
                "theorem_name": theorem_name,
                "imports": ["Mathlib"],
                "metadata": {
                    "dataset": args.dataset,
                    "split": args.split,
                    "source_id": source_id,
                    "proof_word_count": _word_count(proof),
                    "input_mode": args.input_mode,
                },
            }
        )
        if len(cases) >= args.max_cases:
            break

    output_path.write_text(json.dumps(cases, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(cases)} cases to {output_path}")


if __name__ == "__main__":
    main()
