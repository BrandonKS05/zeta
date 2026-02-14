"""
perturb.py – Add minor typos to informal_statement (both English and LaTeX)
in the FrenzyMath/Herald_statements dataset.

Usage:
    python perturb.py
    python perturb.py --num_copies 2 --max_rows 1000 --output out.jsonl
"""

from __future__ import annotations

import argparse
import json
import random
import re
import string
from pathlib import Path

from datasets import load_dataset

# ── Keyboard neighbours (QWERTY) for realistic substitutions ──────────
NEIGHBOURS: dict[str, str] = {
    "a": "qwsz",  "b": "vghn",  "c": "xdfv",  "d": "erfcxs",
    "e": "rdsw",   "f": "rtgvcd", "g": "tyhbvf", "h": "yujbng",
    "i": "ujko",   "j": "uiknmh", "k": "iolmj",  "l": "opk",
    "m": "njk",    "n": "bhjm",   "o": "iklp",    "p": "ol",
    "q": "wa",     "r": "edft",   "s": "wedxza",  "t": "rfgy",
    "u": "yhji",   "v": "cfgb",   "w": "qase",    "x": "zsdc",
    "y": "tghu",   "z": "asx",
}

# ── Tiny words we never touch ─────────────────────────────────────────
SKIP = {"a", "i", "an", "is", "of", "or", "to", "in", "if", "no",
        "be", "by", "at", "on", "so", "we", "do", "it"}

# ── Regex: find all math/LaTeX spans ──────────────────────────────────
MATH_RE = re.compile(
    r"""
      \$\$.*?\$\$            # $$...$$
    | \$[^$]+?\$             # $...$
    | \\\(.*?\\\)            # \(...\)
    | \\\[.*?\\\]            # \[...\]
    | \\[a-zA-Z]+\{[^}]*\}  # \cmd{arg}
    | \\[a-zA-Z]+            # bare \command
    """,
    re.DOTALL | re.VERBOSE,
)

# ── Inside math: find \command names ──────────────────────────────────
CMD_RE = re.compile(r"\\([a-zA-Z]+)")

# ── Spelling-only typos for common LaTeX commands ─────────────────────
CMD_TYPOS: dict[str, list[str]] = {
    "alpha": ["aplha", "alhpa"], "beta": ["bta", "betta"],
    "gamma": ["gmma", "gama"], "delta": ["dleta", "detla"],
    "epsilon": ["epsioln", "epslion"], "theta": ["theat", "tehta"],
    "lambda": ["lmabda", "lamda"], "sigma": ["simga", "sigmaa"],
    "omega": ["omgea", "onega"], "mu": ["muu"], "nu": ["nuu"],
    "phi": ["pih", "phii"], "psi": ["pis", "psii"],
    "infty": ["infity", "infnty"], "frac": ["farc", "frc"],
    "sqrt": ["sqtr", "squrt"], "sum": ["smu", "summ"],
    "prod": ["pord"], "lim": ["lmi"], "log": ["lgo"],
    "sin": ["sni"], "cos": ["cso"], "tan": ["tna"],
    "exp": ["epx"], "text": ["txet", "texxt"],
    "mathbb": ["mathb", "mathhbb"], "mathcal": ["mathacl", "matcal"],
    "operatorname": ["opertaorname", "operatoname"],
    "leq": ["lep", "leqq"], "geq": ["gep", "geqq"],
    "subset": ["subsett", "subet"], "forall": ["froall", "foraal"],
    "exists": ["exsits", "existss"], "partial": ["partail", "parial"],
    "cdot": ["cdto"], "times": ["tiems"], "equiv": ["euqiv"],
    "approx": ["appox", "aprox"], "circ": ["cric"],
    "mapsto": ["maptso"], "rightarrow": ["rigtharrow"],
}


# ══════════════════════════════════════════════════════════════════════
#  Word-level perturbations (for prose)
# ══════════════════════════════════════════════════════════════════════

def swap_adj(w: str, rng: random.Random) -> str:
    if len(w) < 2: return w
    i = rng.randint(0, len(w) - 2)
    return w[:i] + w[i+1] + w[i] + w[i+2:]

def drop_char(w: str, rng: random.Random) -> str:
    if len(w) < 3: return w
    i = rng.randint(1, len(w) - 1)
    return w[:i] + w[i+1:]

def dup_char(w: str, rng: random.Random) -> str:
    if len(w) < 2: return w
    i = rng.randint(0, len(w) - 1)
    return w[:i+1] + w[i] + w[i+1:]

def sub_neighbour(w: str, rng: random.Random) -> str:
    if len(w) < 2: return w
    cands = [i for i, c in enumerate(w) if c.lower() in NEIGHBOURS]
    if not cands: return w
    i = rng.choice(cands)
    ch = rng.choice(NEIGHBOURS[w[i].lower()])
    if w[i].isupper(): ch = ch.upper()
    return w[:i] + ch + w[i+1:]

def flip_case(w: str, rng: random.Random) -> str:
    alphas = [i for i, c in enumerate(w) if c.isalpha()]
    if not alphas: return w
    i = rng.choice(alphas)
    c = w[i]
    return w[:i] + (c.lower() if c.isupper() else c.upper()) + w[i+1:]

WORD_OPS = [swap_adj, drop_char, dup_char, sub_neighbour, flip_case]


def perturb_word(w: str, rng: random.Random) -> str | None:
    """Try to apply one typo. Returns None if the word can't be changed."""
    stripped = w.strip(string.punctuation + string.whitespace)
    if len(stripped) < 3 or stripped.lower() in SKIP or "\\" in w:
        return None
    rng.shuffle(WORD_OPS)
    for op in WORD_OPS:
        out = op(w, rng)
        if out != w:
            return out
    return None


# ══════════════════════════════════════════════════════════════════════
#  LaTeX span perturbation (spelling-only, never changes meaning)
# ══════════════════════════════════════════════════════════════════════

def perturb_latex(span: str, rng: random.Random) -> str | None:
    """Apply one mild typo inside a LaTeX span. Returns None if nothing changed."""
    cmds = list(CMD_RE.finditer(span))
    if not cmds:
        return None
    rng.shuffle(cmds)
    for m in cmds:
        name = m.group(1)
        if name in CMD_TYPOS:
            rep = rng.choice(CMD_TYPOS[name])
            return span[:m.start(1)] + rep + span[m.end(1):]
        # generic swap for longer commands
        if len(name) >= 4:
            swapped = swap_adj(name, rng)
            if swapped != name:
                return span[:m.start(1)] + swapped + span[m.end(1):]
    return None


# ══════════════════════════════════════════════════════════════════════
#  Main: perturb a full statement
# ══════════════════════════════════════════════════════════════════════

def split_math(text: str) -> list[tuple[str, bool]]:
    """Split into (chunk, is_math) pieces."""
    parts = []
    last = 0
    for m in MATH_RE.finditer(text):
        if m.start() > last:
            parts.append((text[last:m.start()], False))
        parts.append((m.group(), True))
        last = m.end()
    if last < len(text):
        parts.append((text[last:], False))
    return parts


def perturb(text: str, rng: random.Random, target: int = 2) -> str:
    """Add *target* typos across prose and LaTeX."""
    parts = split_math(text)
    out = list(parts)  # mutable copy
    done = 0

    # ── Pass 1: randomly pick words / spans to perturb ────────────────
    # Build a pool of (chunk_idx, word_idx_or_None, is_math)
    pool: list[tuple[int, int | None, bool]] = []
    for ci, (chunk, is_math) in enumerate(parts):
        if is_math:
            pool.append((ci, None, True))
        else:
            for wi, w in enumerate(chunk.split(" ")):
                stripped = w.strip(string.punctuation + string.whitespace)
                if len(stripped) >= 3 and stripped.lower() not in SKIP and "\\" not in w:
                    pool.append((ci, wi, False))

    rng.shuffle(pool)

    for ci, wi, is_math in pool:
        if done >= target:
            break
        if is_math:
            result = perturb_latex(out[ci][0], rng)
            if result is not None:
                out[ci] = (result, True)
                done += 1
        else:
            words = out[ci][0].split(" ")
            result = perturb_word(words[wi], rng)
            if result is not None:
                words[wi] = result
                out[ci] = (" ".join(words), False)
                done += 1

    return "".join(chunk for chunk, _ in out)


# ══════════════════════════════════════════════════════════════════════
#  Dataset processing
# ══════════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="Add typos to Herald_statements.")
    parser.add_argument("--num_copies", type=int, default=1)
    parser.add_argument("--target_typos", type=int, default=2,
                        help="Target number of typos per statement (default: 2).")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--max_rows", type=int, default=None)
    parser.add_argument("--output", type=str, default="perturbed_herald.jsonl")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    print("Loading FrenzyMath/Herald_statements …")
    ds = load_dataset("FrenzyMath/Herald_statements", split="train")
    if args.max_rows:
        ds = ds.select(range(min(args.max_rows, len(ds))))
    print(f"  {len(ds)} rows loaded.")

    out_path = Path(args.output)
    written = 0

    with out_path.open("w", encoding="utf-8") as f:
        for row in ds:
            orig = row["informal_statement"]
            formal = row["formal_statement"]
            rid = row["id"]

            # Clean row
            f.write(json.dumps({
                "id": rid,
                "informal_statement": orig,
                "formal_statement": formal,
                "is_perturbed": False,
            }, ensure_ascii=False) + "\n")
            written += 1

            # Perturbed copies
            for ci in range(args.num_copies):
                pert = perturb(orig, rng, target=args.target_typos)
                f.write(json.dumps({
                    "id": rid,
                    "informal_statement": pert,
                    "formal_statement": formal,
                    "is_perturbed": True,
                    "copy_index": ci,
                }, ensure_ascii=False) + "\n")
                written += 1

    print(f"Wrote {written} rows to {out_path}")

    # Show samples
    print("\n── Samples ──")
    rng2 = random.Random(args.seed + 999)
    for idx in rng2.sample(range(len(ds)), min(6, len(ds))):
        o = ds[idx]["informal_statement"]
        p = perturb(o, random.Random(rng2.randint(0, 2**32)), target=args.target_typos)
        print(f"\n[id={ds[idx]['id']}]")
        print(f"  ORIG: {o[:250]}")
        print(f"  PERT: {p[:250]}")


if __name__ == "__main__":
    main()
