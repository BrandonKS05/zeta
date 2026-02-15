#!/usr/bin/env python3
"""
Demo-finding script for (1) analyze, (2) autocomplete, (3) underlines.

- Analyze: NL → Lean + feedback; good for “sophisticated translation” demos.
- Autocomplete: Prefixes with complicated math symbols → top and top-k completions
  (extension uses max_candidates=3; we test both top-1 and top-k for demo clips).
- Underlines: Find text that yields YELLOW (suggestion / minor) vs RED (error / major).
  Frontend: .zeta-highlight--warning = yellow, .zeta-highlight--error = red.

Usage:
  # Analyze (original behavior)
  python evals/demo_algebra_topology.py --task analyze --base-url https://... --limit 5

  # Autocomplete with fancy symbols (top and top-k)
  python evals/demo_algebra_topology.py --task complete --base-url https://...

  # Find red vs yellow underline inputs
  python evals/demo_algebra_topology.py --task underlines --base-url https://...

  # All
  python evals/demo_algebra_topology.py --task all --base-url https://... --out results/demo.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import requests

# Default Modal endpoint (must match Overleaf extension MODAL_BASE_URL if using same deployment)
DEFAULT_BASE_URL = "https://amirzeinali--herald-translator-translator-v1-translate-batch.modal.run"

# ---------------------------------------------------------------------------
# Autocomplete: prefixes with sophisticated math (LaTeX and Unicode).
# Cursor at end of each string. Use for both top (max_candidates=1) and top-k.
# ---------------------------------------------------------------------------
AUTOCOMPLETE_PREFIXES_SOPHISTICATED = [
    # LaTeX-style (Overleaf)
    r"For all $x \in G$, $x \cdot e = ",
    r"The fundamental group $\pi_1(S^1) \cong ",
    r"Let $\varphi \colon G \to H$ be a homomorphism. Then $\ker \varphi ",
    r"For $n \in \mathbb{N}$, $n + ",
    r"The kernel $\ker f = \{ x \in G : f(x) = ",
    r"A subgroup $N \trianglelefteq G$ is normal iff $\forall g \in G,\, g N g^{-1} ",
    r"The quotient group $G\,/\,N$ is abelian when $[G,G] \subseteq ",
    r"The first homology $H_1(S^1; \mathbb{Z}) \cong ",
    r"A continuous map $f \colon X \to Y$ induces $\pi_1(f) \colon \pi_1(X) \to ",
    r"The wedge sum $S^1 \vee S^1$ has $\pi_1(S^1 \vee S^1) \cong ",
    r"The tensor product $M \otimes_R N$ satisfies $m \otimes ",
    r"The direct limit $\varinjlim G_i$ is the quotient of $\bigsqcup_i G_i$ by ",
    r"For a ring $R$, the spectrum $\operatorname{Spec} R = \{ \mathfrak{p} \triangleleft R : ",
    r"The derived subgroup $[G,G] = \langle [g,h] : g,h \in ",
    r"The free product $G \ast H$ consists of words in $G \sqcup H$ modulo ",
    # Unicode / mixed (still valid in many editors)
    "For all x ∈ G, x · e = ",
    "The fundamental group π₁(S¹) ≅ ",
    "Let φ : G → H be a homomorphism. Then ker φ ",
    "For n ∈ ℕ, n + ",
    "The kernel ker f = { x ∈ G : f(x) = ",
    "A subgroup N ⊴ G is normal iff ∀ g ∈ G, g N g⁻¹ ",
    "The quotient G/N is abelian when [G,G] ⊆ ",
    "The first homology H₁(S¹; ℤ) ≅ ",
    "A continuous map f : X → Y induces π₁(f) : π₁(X) → ",
    "The wedge S¹ ∨ S¹ has π₁(S¹ ∨ S¹) ≅ ",
    "The tensor product M ⊗_R N satisfies m ⊗ ",
    "The direct limit lim G_i is the quotient of ∐_i G_i by ",
    "For a ring R, Spec R = { 𝔭 ⊲ R : ",
    "The derived subgroup [G,G] = ⟨ [g,h] : g,h ∈ ",
    "The free product G ∗ H consists of words in G ⊔ H modulo ",
]

# ---------------------------------------------------------------------------
# Underlines: text that should yield RED (error) vs YELLOW (warning).
# Frontend maps: severity "error" → red, "warning" → yellow.
# ---------------------------------------------------------------------------
UNDERLINE_RED_CANDIDATES = [
    # Major / semantic errors → red underline (interpretation items or Lean error)
    "For all n in Nat, n + 2 = 2n.",
    "Every group is abelian.",
    "The fundamental group of S^2 is the integers.",
    "For all x in a group G, x * x = e.",
    "The kernel of a homomorphism is a subgroup of the codomain.",
    "Every ring is a field.",
    "The fundamental group of the circle is trivial.",
    "For all n in Nat, n * 0 = n.",
    "For all n in Nat, n^2 ≤ n + 3.",
    "A group has exactly one element.",
]
UNDERLINE_YELLOW_CANDIDATES = [
    # Minor / suggestion → yellow (Lean warning or chunk-level “review” with warning)
    # Lean can emit warnings (e.g. unused variable); NL that compiles but triggers warning.
    "For all n and m in Nat, n + 0 = n.",
    "For every natural number n, n + 0 = n.",
    "Let n and k be natural numbers. Then n + 0 = n.",
]

# Abstract algebra & algebraic topology statements: mix of correct, classic, and slightly wrong (for correction demos)
ALGEBRA_TOPOLOGY_STATEMENTS = [
    # --- Abstract algebra (groups, rings, homomorphisms) ---
    "Every group has an identity element.",
    "The kernel of a group homomorphism is a normal subgroup.",
    "A ring R is an integral domain if and only if it has no zero divisors.",
    "For all n in Nat, n + 0 = n.",
    "Every finite group of prime order is cyclic.",
    "If G is a group and H is a subgroup of G, then the index of H in G divides the order of G.",
    "A subgroup N of G is normal if and only if for all g in G, g N g^{-1} = N.",
    "The set of invertible elements of a ring forms a group under multiplication.",
    "Every field is an integral domain.",
    "If phi is a group homomorphism from G to H, then G mod ker(phi) is isomorphic to im(phi).",
    "Every group of order 4 is abelian.",
    "The center of a group is a normal subgroup.",
    "A group homomorphism is injective if and only if its kernel is trivial.",
    "For all natural numbers n and m, n + m = m + n.",
    "The symmetric group S_n has order n factorial.",
    "Every subgroup of a cyclic group is cyclic.",
    "A ring is a field if and only if every nonzero element has a multiplicative inverse.",
    "The identity element of a group is unique.",
    "For all x in a group G, x * e = x and e * x = x where e is the identity.",
    # --- Algebraic topology ---
    "The fundamental group of the circle is isomorphic to the integers.",
    "A path-connected space is simply connected if and only if its fundamental group is trivial.",
    "The first homology group of the circle is isomorphic to the integers.",
    "A continuous map between topological spaces induces a homomorphism on fundamental groups.",
    "The fundamental group of the wedge of two circles is the free group on two generators.",
    "A covering map induces an injection on fundamental groups.",
    "The fundamental group of the torus is the direct product of two copies of the integers.",
    "The fundamental group of the 2-sphere is trivial.",
    "If X is path-connected and simply connected, then the fundamental group of X is trivial.",
    "The fundamental group is a functor from the category of pointed topological spaces to the category of groups.",
    # --- Intentionally wrong or informal (to trigger cool corrections / feedback) ---
    "Every group is abelian.",
    "The fundamental group of S^2 is the integers.",
    "For all x in a group, x * x = e.",
    "A group has exactly one element.",
    "The kernel of a homomorphism is a subgroup of the codomain.",
    "Every ring is a field.",
    "The fundamental group of the circle is trivial.",
    "For all n in Nat, n * 0 = n.",
]


def _follow_303_poll(
    session: requests.Session,
    base_url: str,
    location: str,
    headers: dict,
    timeout_seconds: int,
    poll_interval: float = 2.0,
    poll_timeout_seconds: int = 300,
) -> dict:
    """Follow Modal 303 redirects until we get a final JSON result."""
    deadline = time.monotonic() + poll_timeout_seconds
    url = urljoin(f"{base_url.rstrip('/')}/", location)
    while time.monotonic() < deadline:
        resp = session.get(url, headers=headers, timeout=timeout_seconds, allow_redirects=False)
        if resp.status_code == 303:
            url = urljoin(f"{base_url.rstrip('/')}/", resp.headers.get("location", ""))
            time.sleep(poll_interval)
            continue
        resp.raise_for_status()
        return resp.json()
    raise TimeoutError(f"Poll timeout after {poll_timeout_seconds}s")


def analyze(
    base_url: str,
    text: str,
    *,
    imports: list[str] | None = None,
    mode: str = "fast",
    timeout_seconds: int = 120,
    poll_timeout_seconds: int = 300,
) -> dict:
    base_url = base_url.rstrip("/")
    url = f"{base_url}/v1/analyze"
    payload = {
        "text": text,
        "imports": imports or ["Std"],
        "mode": mode,
        "max_new_tokens": 256,
        "temperature": 0.0,
        "lean_timeout_seconds": 25,
    }
    session = requests.Session()
    resp = session.post(url, json=payload, timeout=timeout_seconds, allow_redirects=False)
    if resp.status_code == 303:
        location = resp.headers.get("location")
        if not location:
            resp.raise_for_status()
        return _follow_303_poll(
            session, base_url, location, {},
            timeout_seconds=timeout_seconds,
            poll_timeout_seconds=poll_timeout_seconds,
        )
    resp.raise_for_status()
    return resp.json()


def complete(
    base_url: str,
    text: str,
    cursor_offset: int | None = None,
    *,
    max_candidates: int = 3,
    imports: list[str] | None = None,
    timeout_seconds: int = 90,
    poll_timeout_seconds: int = 120,
) -> dict:
    """Call /v1/complete. cursor_offset defaults to len(text) (cursor at end)."""
    base_url = base_url.rstrip("/")
    url = f"{base_url}/v1/complete"
    offset = cursor_offset if cursor_offset is not None else len(text)
    payload = {
        "text": text,
        "cursor_offset": offset,
        "imports": imports or ["Std"],
        "max_candidates": max_candidates,
        "max_new_tokens": 48,
        "temperature": 0.35,
    }
    session = requests.Session()
    resp = session.post(url, json=payload, timeout=timeout_seconds, allow_redirects=False)
    if resp.status_code == 303:
        location = resp.headers.get("location")
        if not location:
            resp.raise_for_status()
        return _follow_303_poll(
            session, base_url, location, {},
            timeout_seconds=timeout_seconds,
            poll_timeout_seconds=poll_timeout_seconds,
        )
    resp.raise_for_status()
    return resp.json()


def _first_issue_severity(analyze_result: dict) -> str | None:
    """
    Infer severity of the first range-bound or chunk-level issue.
    Returns 'error' (red), 'warning' (yellow), or None.
    """
    diags = analyze_result.get("diagnostics") or []
    interp = analyze_result.get("interpretation")
    items = (interp.get("items") if isinstance(interp, dict) else None) or []
    # Interpretation items are shown as error in the frontend
    if items:
        return "error"
    if not diags:
        return None
    for d in diags:
        sev = (d.get("severity") or "").strip().lower()
        if sev in ("error", "warning", "info"):
            return sev
    return "error" if diags else None


def is_demo_worthy(result: dict) -> tuple[bool, str]:
    """Return (is_worthy, short_reason)."""
    status = result.get("status") or ""
    is_valid = result.get("is_valid_lean", False)
    st = (result.get("statement_type") or "").strip()
    feedback = result.get("feedback") or []
    interpretation = result.get("interpretation")
    items = (interpretation.get("items") if isinstance(interpretation, dict) else None) or []

    if is_valid and st:
        return True, "valid_lean"
    if status == "needs_revision" and (len(feedback) > 0 or len(result.get("diagnostics") or []) > 0):
        return True, "has_feedback"
    if items:
        return True, "semantic_interpretation"
    if st and len(st) > 20:
        return True, "has_statement_type"
    return False, ""


def run_task_complete(base_url: str, out_path: Path | None, delay: float, imports: list[str]) -> dict:
    """Run autocomplete on sophisticated-symbol prefixes; top-1 and top-k."""
    prefixes = AUTOCOMPLETE_PREFIXES_SOPHISTICATED
    results = {"top1": [], "topk": []}
    for i, text in enumerate(prefixes):
        print(f"[complete {i + 1}/{len(prefixes)}] prefix_len={len(text)}", flush=True)
        for label, max_cand in [("top1", 1), ("topk", 5)]:
            try:
                r = complete(base_url, text, max_candidates=max_cand, imports=imports)
                candidates = []
                for c in r.get("candidates") or []:
                    comp = c.get("completion") if isinstance(c, dict) else c
                    if isinstance(comp, str) and comp.strip():
                        candidates.append(comp.strip())
                if not candidates and isinstance(r.get("selected_completion"), str):
                    candidates = [r["selected_completion"].strip()]
                results[label].append({
                    "prefix": text,
                    "prefix_preview": text[:80] + ("..." if len(text) > 80 else ""),
                    "candidates": candidates[:max_cand],
                })
                if candidates:
                    print(f"  {label}: {candidates[0][:60]}...", flush=True)
            except requests.RequestException as e:
                print(f"  {label} ERROR: {e}", flush=True)
                results[label].append({"prefix": text, "error": str(e)})
            if delay > 0:
                time.sleep(delay)
    print("\n--- AUTOCOMPLETE DEMO (sophisticated symbols) ---")
    print("Use these prefixes in the editor; accept top-1 or cycle top-k for the video.")
    for entry in results["top1"][:5]:
        if "error" not in entry:
            print(f"  Prefix: {entry['prefix_preview']}")
            print(f"  Top:   {entry['candidates'][0][:70] if entry['candidates'] else '—'}...")
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump({"autocomplete": results}, f, indent=2, ensure_ascii=False)
    return results


def run_task_underlines(base_url: str, out_path: Path | None, delay: float, imports: list[str]) -> dict:
    """Find inputs that yield red (error) vs yellow (warning) underlines."""
    red_inputs: list[dict] = []
    yellow_inputs: list[dict] = []
    errors: list[dict] = []
    for label, candidates in [("RED (error)", UNDERLINE_RED_CANDIDATES), ("YELLOW (warning)", UNDERLINE_YELLOW_CANDIDATES)]:
        print(f"\n--- {label} candidates ---", flush=True)
        for text in candidates:
            try:
                result = analyze(base_url, text, imports=imports)
                sev = _first_issue_severity(result)
                entry = {"input": text, "severity": sev, "status": result.get("status"), "is_valid_lean": result.get("is_valid_lean")}
                if sev == "error":
                    red_inputs.append(entry)
                    print(f"  RED:   {text[:55]}...", flush=True)
                elif sev == "warning":
                    yellow_inputs.append(entry)
                    print(f"  YELLOW: {text[:55]}...", flush=True)
                else:
                    print(f"  other: {text[:55]}... severity={sev}", flush=True)
            except requests.RequestException as e:
                errors.append({"input": text, "error": str(e)})
                print(f"  ERROR: {e}", flush=True)
            if delay > 0:
                time.sleep(delay)
    out = {
        "red_underline_demo": red_inputs,
        "yellow_underline_demo": yellow_inputs,
        "request_errors": errors,
    }
    print("\n--- UNDERLINE DEMO (red = error, yellow = suggestion) ---")
    print("RED (major): use these for error underline clips.")
    for e in red_inputs[:5]:
        print(f"  {e['input']}")
    print("YELLOW (minor): use these for suggestion underline clips.")
    for e in yellow_inputs[:5]:
        print(f"  {e['input']}")
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Find demo-worthy algebra/topology results (analyze, complete, underlines).")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Modal API base URL")
    parser.add_argument("--task", choices=["analyze", "complete", "underlines", "all"], default="analyze")
    parser.add_argument("--limit", type=int, default=None, help="Max analyze statements (analyze task)")
    parser.add_argument("--out", type=Path, default=None, help="Write results to this JSON file")
    parser.add_argument("--mode", choices=["fast", "thinking"], default="fast")
    parser.add_argument("--imports", default="Std,Mathlib")
    parser.add_argument("--delay", type=float, default=0.5)
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    imports = [s.strip() for s in args.imports.split(",") if s.strip()]

    if args.task == "complete":
        run_task_complete(base_url, args.out, args.delay, imports)
        return
    if args.task == "underlines":
        run_task_underlines(base_url, args.out, args.delay, imports)
        return
    if args.task == "all":
        ac = run_task_complete(base_url, None, args.delay, imports)
        ul = run_task_underlines(base_url, None, args.delay, imports)
        combined = {"autocomplete": ac, "underlines": ul}
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            with open(args.out, "w") as f:
                json.dump(combined, f, indent=2, ensure_ascii=False)
            print(f"\nCombined results written to {args.out}")
        return

    # --- analyze (original) ---
    statements = ALGEBRA_TOPOLOGY_STATEMENTS
    if args.limit is not None:
        statements = statements[: args.limit]
    all_results: list[dict] = []
    demo_highlights: list[dict] = []

    for i, text in enumerate(statements):
        print(f"[{i + 1}/{len(statements)}] {text[:60]}{'...' if len(text) > 60 else ''}", flush=True)
        try:
            result = analyze(base_url, text, imports=imports, mode=args.mode)
        except requests.RequestException as e:
            print(f"  ERROR: {e}", flush=True)
            all_results.append({"input": text, "error": str(e)})
            if args.delay > 0:
                time.sleep(args.delay)
            continue

        result["_input"] = text
        all_results.append(result)
        worthy, reason = is_demo_worthy(result)
        if worthy:
            demo_highlights.append({
                "input": text,
                "reason": reason,
                "status": result.get("status"),
                "is_valid_lean": result.get("is_valid_lean"),
                "statement_type": result.get("statement_type"),
                "feedback_preview": (result.get("feedback") or [])[:3],
                "interpretation_items": (
                    [it.get("error") for it in (result.get("interpretation") or {}).get("items") or []]
                    if isinstance(result.get("interpretation"), dict) else []
                ),
            })
            print(f"  -> DEMO: {reason} | valid_lean={result.get('is_valid_lean')}", flush=True)
        else:
            print(f"  -> skip ({result.get('status')})", flush=True)
        if args.delay > 0:
            time.sleep(args.delay)

    print("\n" + "=" * 60)
    print("DEMO HIGHLIGHTS (analyze)")
    print("=" * 60)
    for h in demo_highlights:
        print(f"\nInput: {h['input']}")
        print(f"  Reason: {h['reason']} | status={h['status']} | valid_lean={h['is_valid_lean']}")
        if h.get("statement_type"):
            st = h["statement_type"]
            print(f"  Lean: {st[:120]}{'...' if len(st) > 120 else ''}")
        if h.get("feedback_preview"):
            for f in h["feedback_preview"]:
                print(f"  Feedback: {f[:100]}...")
        if h.get("interpretation_items"):
            for it in h["interpretation_items"]:
                print(f"  Interpretation: {it}")

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with open(args.out, "w") as f:
            json.dump({"all_results": all_results, "demo_highlights": demo_highlights}, f, indent=2, ensure_ascii=False)
        print(f"\nFull results written to {args.out}")

    print(f"\nTotal: {len(demo_highlights)} demo-worthy out of {len(statements)} tried.")
    sys.exit(0 if demo_highlights else 1)


if __name__ == "__main__":
    main()
