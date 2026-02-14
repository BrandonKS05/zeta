"""Build labeled error-detection benchmark cases from existing theorem statements.

This script avoids manual labeling by creating synthetic corrupted variants with
known error counts and types.
"""

from __future__ import annotations

import argparse
import json
import random
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

DEFAULT_INPUT_PATH = Path(__file__).parent / "cases_proofnetsharp_paragraph.json"
DEFAULT_OUTPUT_PATH = Path(__file__).parent / "cases_error_detection_proofnetsharp.json"


@dataclass(frozen=True)
class MutationResult:
    text: str
    error_type: str
    description: str


Mutator = Callable[[str, random.Random], MutationResult | None]


def _load_cases(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError(f"Expected list of cases in {path}")
    return [row for row in payload if isinstance(row, dict) and isinstance(row.get("text"), str)]


def _sanitize_name(raw: str, fallback_idx: int) -> str:
    candidate = re.sub(r"[^A-Za-z0-9_]", "_", raw).strip("_")
    if not candidate:
        candidate = f"case_{fallback_idx}"
    if candidate[0].isdigit():
        candidate = f"s_{candidate}"
    return candidate[:80]


def _mutate_drop_inline_math_closer(text: str, _: random.Random) -> MutationResult | None:
    match = re.search(r"\$[^$\n]{3,}\$", text)
    if not match:
        return None
    broken = match.group(0)[:-1]
    mutated = text[: match.start()] + broken + text[match.end() :]
    return MutationResult(
        text=mutated,
        error_type="missing_inline_math_delimiter",
        description="Removed the closing `$` from one inline math segment.",
    )


def _mutate_drop_right_brace(text: str, rng: random.Random) -> MutationResult | None:
    positions = [idx for idx, char in enumerate(text) if char == "}"]
    if not positions:
        return None
    drop_idx = rng.choice(positions)
    mutated = text[:drop_idx] + text[drop_idx + 1 :]
    return MutationResult(
        text=mutated,
        error_type="unbalanced_braces",
        description="Removed one `}` to create unbalanced braces.",
    )


def _mutate_typo_latex_command(text: str, rng: random.Random) -> MutationResult | None:
    replacements = {
        r"\mathbb": r"\mathbbb",
        r"\frac": r"\fracc",
        r"\sqrt": r"\squrt",
        r"\begin": r"\begiin",
        r"\end": r"\ennd",
    }
    candidates = [cmd for cmd in replacements if cmd in text]
    if not candidates:
        return None
    target = rng.choice(candidates)
    mutated = text.replace(target, replacements[target], 1)
    return MutationResult(
        text=mutated,
        error_type="latex_command_typo",
        description=f"Misspelled LaTeX command `{target}`.",
    )


def _mutate_break_fraction(text: str, _: random.Random) -> MutationResult | None:
    match = re.search(r"\\frac\s*\{[^{}]+\}\s*\{[^{}]+\}", text)
    if not match:
        return None
    segment = match.group(0)
    if not segment.endswith("}"):
        return None
    broken = segment[:-1]
    mutated = text[: match.start()] + broken + text[match.end() :]
    return MutationResult(
        text=mutated,
        error_type="malformed_fraction",
        description="Removed the final `}` from a `\\frac{...}{...}` expression.",
    )


def _mutate_flip_quantifier(text: str, rng: random.Random) -> MutationResult | None:
    substitutions = [
        ("For all", "There exists"),
        ("for all", "there exists"),
        ("Every", "Some"),
        ("every", "some"),
    ]
    candidates = [(old, new) for old, new in substitutions if old in text]
    if not candidates:
        return None
    old, new = rng.choice(candidates)
    mutated = text.replace(old, new, 1)
    return MutationResult(
        text=mutated,
        error_type="quantifier_flip",
        description=f"Changed quantifier phrase `{old}` to `{new}`.",
    )


def _mutate_flip_inequality(text: str, rng: random.Random) -> MutationResult | None:
    substitutions = [
        (r"\le", r"\ge"),
        (r"\ge", r"\le"),
        ("<=", ">="),
        (">=", "<="),
        (" < ", " > "),
        (" > ", " < "),
        (" at most ", " at least "),
        (" at least ", " at most "),
    ]
    candidates = [(old, new) for old, new in substitutions if old in text]
    if not candidates:
        return None
    old, new = rng.choice(candidates)
    mutated = text.replace(old, new, 1)
    return MutationResult(
        text=mutated,
        error_type="inequality_flip",
        description=f"Flipped inequality token `{old}` to `{new}`.",
    )


def _mutate_insert_unknown_command(text: str, _: random.Random) -> MutationResult | None:
    if r"\unknownsymbol" in text:
        return None
    suffix = r" \unknownsymbol"
    if text.endswith("."):
        mutated = f"{text[:-1]}{suffix}."
    else:
        mutated = f"{text}{suffix}"
    return MutationResult(
        text=mutated,
        error_type="unknown_latex_command",
        description="Inserted unknown command `\\unknownsymbol`.",
    )


MUTATORS: list[Mutator] = [
    _mutate_drop_inline_math_closer,
    _mutate_drop_right_brace,
    _mutate_typo_latex_command,
    _mutate_break_fraction,
    _mutate_flip_quantifier,
    _mutate_flip_inequality,
    _mutate_insert_unknown_command,
]


def _apply_mutations(
    text: str,
    rng: random.Random,
    target_error_count: int,
) -> tuple[str, list[MutationResult]]:
    mutated = text
    applied: list[MutationResult] = []
    unused = list(MUTATORS)
    rng.shuffle(unused)
    while unused and len(applied) < target_error_count:
        mutator = unused.pop()
        result = mutator(mutated, rng)
        if result is None:
            continue
        if result.text == mutated:
            continue
        mutated = result.text
        applied.append(result)
    return mutated, applied


def _build_dataset_rows(
    base_cases: list[dict[str, Any]],
    *,
    max_base_cases: int,
    corruptions_per_base: int,
    max_errors_per_corrupted: int,
    seed: int,
) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    selected = list(base_cases)
    rng.shuffle(selected)
    if max_base_cases > 0:
        selected = selected[:max_base_cases]

    rows: list[dict[str, Any]] = []
    for idx, base in enumerate(selected, start=1):
        base_id = str(base.get("id") or f"base-{idx}")
        theorem_name = _sanitize_name(str(base.get("theorem_name") or base_id), idx)
        imports = base.get("imports")
        imports_list = imports if isinstance(imports, list) and imports else ["Mathlib"]
        context = base.get("context")
        context_text = context if isinstance(context, str) else None
        text = str(base.get("text"))
        metadata = base.get("metadata")
        metadata_payload = metadata if isinstance(metadata, dict) else {}

        rows.append(
            {
                "id": f"{base_id}__clean",
                "base_case_id": base_id,
                "variant": "clean",
                "text": text,
                "context": context_text,
                "theorem_name": f"{theorem_name}_clean",
                "imports": imports_list,
                "gold": {
                    "has_error": False,
                    "error_count": 0,
                    "error_types": [],
                    "label_source": "source_statement",
                },
                "metadata": {
                    "source_id": str(metadata_payload.get("source_id") or base_id),
                    "source_dataset": metadata_payload.get("dataset"),
                    "source_split": metadata_payload.get("split"),
                },
            }
        )

        for corruption_idx in range(corruptions_per_base):
            target_errors = rng.randint(1, max(1, max_errors_per_corrupted))
            corrupted_text, applied = _apply_mutations(
                text=text,
                rng=rng,
                target_error_count=target_errors,
            )
            if not applied:
                continue
            rows.append(
                {
                    "id": f"{base_id}__err_{corruption_idx + 1}",
                    "base_case_id": base_id,
                    "variant": "corrupted",
                    "text": corrupted_text,
                    "context": context_text,
                    "theorem_name": f"{theorem_name}_err_{corruption_idx + 1}",
                    "imports": imports_list,
                    "gold": {
                        "has_error": True,
                        "error_count": len(applied),
                        "error_types": [item.error_type for item in applied],
                        "label_source": "synthetic_injection",
                    },
                    "metadata": {
                        "source_id": str(metadata_payload.get("source_id") or base_id),
                        "source_dataset": metadata_payload.get("dataset"),
                        "source_split": metadata_payload.get("split"),
                        "mutations": [
                            {
                                "error_type": item.error_type,
                                "description": item.description,
                            }
                            for item in applied
                        ],
                    },
                }
            )

    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-cases", default=str(DEFAULT_INPUT_PATH))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_PATH))
    parser.add_argument("--max-base-cases", type=int, default=400)
    parser.add_argument("--corruptions-per-base", type=int, default=1)
    parser.add_argument("--max-errors-per-corrupted", type=int, default=2)
    parser.add_argument("--seed", type=int, default=20260214)
    args = parser.parse_args()

    input_path = Path(args.input_cases)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    base_cases = _load_cases(input_path)
    rows = _build_dataset_rows(
        base_cases,
        max_base_cases=args.max_base_cases,
        corruptions_per_base=max(0, args.corruptions_per_base),
        max_errors_per_corrupted=max(1, args.max_errors_per_corrupted),
        seed=args.seed,
    )

    output_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    positives = sum(1 for row in rows if bool(row.get("gold", {}).get("has_error")))
    negatives = len(rows) - positives
    avg_error_count = (
        sum(int(row.get("gold", {}).get("error_count", 0)) for row in rows) / len(rows) if rows else 0.0
    )

    print(f"Loaded {len(base_cases)} base cases from {input_path}")
    print(f"Wrote {len(rows)} benchmark rows to {output_path}")
    print(
        "Distribution: "
        f"has_error=true {positives}, has_error=false {negatives}, "
        f"avg_gold_error_count={avg_error_count:.2f}"
    )


if __name__ == "__main__":
    main()
