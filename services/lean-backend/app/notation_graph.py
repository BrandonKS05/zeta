from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from typing import Any

import httpx

from .settings import get_settings
from .utils import extract_json_object, truncate_text

logger = logging.getLogger(__name__)

_MATH_ENV_RE = re.compile(
    r"(?:"
    r"\$\$(.+?)\$\$"
    r"|\$(.+?)\$"
    r"|\\begin\{(?:equation|align|gather|multline|math|displaymath)\*?\}(.+?)\\end\{(?:equation|align|gather|multline|math|displaymath)\*?\}"
    r"|\\\[(.+?)\\\]"
    r"|\\\((.+?)\\\)"
    r")",
    re.DOTALL,
)

_NEWCOMMAND_RE = re.compile(
    r"\\(?:new|renew|provide)command\s*\{?\\(\w+)\}?"
    r"(?:\s*\[\d+\])?"
    r"\s*\{(.+?)\}",
    re.DOTALL,
)

_SYMBOL_RE = re.compile(r"\\([A-Za-z]+)")

_KNOWN_TYPES = {
    "sigma": "matrix/scalar",
    "mu": "measure/mean",
    "alpha": "angle/coefficient",
    "beta": "coefficient/angle",
    "gamma": "function/constant",
    "delta": "variation/difference",
    "epsilon": "small quantity",
    "lambda": "eigenvalue/rate",
    "theta": "angle/parameter",
    "phi": "potential/angle",
    "psi": "wave function",
    "omega": "frequency/domain",
    "rho": "density/correlation",
    "tau": "time constant",
    "xi": "random variable",
    "zeta": "function",
    "eta": "efficiency/coordinate",
    "kappa": "curvature/condition",
    "nu": "frequency/degree",
    "pi": "constant",
    "chi": "distribution/characteristic",
}


_CONTEXT_TYPE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"matrix|\\mathbb\{R\}\^\{[^}]*\\times", re.IGNORECASE), "matrix"),
    (re.compile(r"scalar|step.?size|> *0|< *0|\\in *\\mathbb\{R\}\b", re.IGNORECASE), "scalar"),
    (re.compile(r"vector|\\in *\\mathbb\{R\}\^\{?n\}?(?!\s*\\times)", re.IGNORECASE), "vector"),
    (re.compile(r"measure\b|probability|\\sigma.?algebra|measure space", re.IGNORECASE), "measure"),
    (re.compile(r"function|operator|mapping|\\colon|\\to\b|\\mapsto", re.IGNORECASE), "function"),
    (re.compile(r"set\b|\\subseteq|\\subset|collection", re.IGNORECASE), "set"),
    (re.compile(r"mean|average|expectation|sample mean|\\bar", re.IGNORECASE), "mean"),
    (re.compile(r"rate|learning rate|step size|decay", re.IGNORECASE), "rate"),
    (re.compile(r"angle|radian|degree", re.IGNORECASE), "angle"),
    (re.compile(r"constant|fixed", re.IGNORECASE), "constant"),
    (re.compile(r"eigenvalue|spectral", re.IGNORECASE), "eigenvalue"),
    (re.compile(r"\\sigma.?algebra", re.IGNORECASE), "sigma-algebra"),
]


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return str(value)
    except Exception:
        return ""


def _infer_type_from_context(symbol_name: str, context: str) -> str:
    symbol_name = _as_text(symbol_name)
    context = _as_text(context)
    for pattern, type_name in _CONTEXT_TYPE_PATTERNS:
        if pattern.search(context):
            return type_name
    return _KNOWN_TYPES.get(symbol_name.lower(), "unknown")


def _extract_math_blocks(content: str) -> list[str]:
    content = _as_text(content)
    blocks = []
    for m in _MATH_ENV_RE.finditer(content):
        for g in m.groups():
            if g:
                blocks.append(g.strip())
                break
    return blocks


def _extract_symbols_regex(content: str, file_path: str) -> list[dict[str, Any]]:
    content = _as_text(content)
    file_path = _as_text(file_path) or "unknown.tex"
    math_blocks = _extract_math_blocks(content)
    symbols: dict[str, dict[str, Any]] = {}

    for block in math_blocks:
        block_pos = content.find(block)
        surrounding_start = max(0, block_pos - 120) if block_pos >= 0 else 0
        surrounding_end = min(len(content), (block_pos + len(block) + 120)) if block_pos >= 0 else len(content)
        surrounding_context = content[surrounding_start:surrounding_end]

        for m in _SYMBOL_RE.finditer(block):
            name = m.group(1).lower()
            if name in (
                "frac", "sqrt", "sum", "prod", "int", "lim", "inf", "sup",
                "max", "min", "log", "ln", "exp", "sin", "cos", "tan",
                "left", "right", "begin", "end", "text", "mathrm", "mathbf",
                "mathbb", "mathcal", "operatorname", "displaystyle",
                "cdot", "cdots", "ldots", "dots", "forall", "exists",
                "in", "notin", "subset", "subseteq", "cup", "cap",
                "leq", "geq", "neq", "approx", "equiv", "sim",
                "rightarrow", "leftarrow", "Rightarrow", "Leftarrow",
                "quad", "qquad", "hspace", "vspace", "overline", "underline",
                "hat", "tilde", "bar", "vec", "dot", "ddot",
                "partial", "nabla", "infty", "prime",
            ):
                continue
            if name not in symbols:
                context_start = max(0, m.start() - 30)
                context_end = min(len(block), m.end() + 30)
                math_context = block[context_start:context_end].strip()
                full_context = surrounding_context + " " + math_context
                inferred_type = _infer_type_from_context(name, full_context)
                symbols[name] = {
                    "symbol": f"\\{m.group(1)}",
                    "latex_type": inferred_type,
                    "lean_type": "unknown",
                    "defined_in": file_path,
                    "context_text": math_context,
                }

    for m in _NEWCOMMAND_RE.finditer(content):
        cmd_name = m.group(1)
        cmd_body = m.group(2).strip()
        if cmd_name.lower() not in symbols:
            symbols[cmd_name.lower()] = {
                "symbol": f"\\{cmd_name}",
                "latex_type": "macro",
                "lean_type": "unknown",
                "defined_in": file_path,
                "context_text": cmd_body[:120],
            }

    return list(symbols.values())


async def _extract_with_llm(file_path: str, content: str) -> list[dict[str, Any]] | None:
    file_path = _as_text(file_path) or "unknown.tex"
    content = _as_text(content)
    settings = get_settings()
    if not settings.llm_api_key or not settings.llm_model:
        return None

    math_blocks = _extract_math_blocks(content)
    if not math_blocks:
        return None

    math_sample = "\n".join(math_blocks[:15])

    from .llm_client import _endpoint_url, _extract_message_content, _use_responses_api

    endpoint = _endpoint_url(settings)
    use_responses = _use_responses_api(settings)
    headers = {"Content-Type": "application/json"}
    if settings.llm_api_key:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    system_content = (
        "You are a mathematical notation analyst. Extract all distinct mathematical symbols "
        "(Greek letters, custom operators, named functions) from the LaTeX math below. "
        "For each symbol, determine its semantic type based on context "
        "(e.g. 'matrix', 'scalar', 'set', 'function', 'measure', 'vector', 'operator'). "
        "Return JSON only: {\"symbols\": [{\"symbol\": \"\\\\sigma\", \"latex_type\": \"matrix\", "
        "\"lean_type\": \"Matrix n m R\", \"context_text\": \"...context...\"}]}"
    )
    user_prompt = (
        f"File: {file_path}\n\n"
        f"Math blocks:\n{truncate_text(math_sample, 2000)}\n\n"
        "Extract all mathematical notation symbols with their inferred types. "
        "Return compact JSON with a \"symbols\" array."
    )

    if use_responses:
        payload: dict[str, Any] = {
            "model": settings.llm_model,
            "instructions": system_content,
            "input": user_prompt,
            "max_output_tokens": 800,
        }
    else:
        payload = {
            "model": settings.llm_model,
            "messages": [
                {"role": "system", "content": system_content},
                {"role": "user", "content": user_prompt},
            ],
            "max_completion_tokens": 800,
            "response_format": {"type": "json_object"},
        }

    timeout = httpx.Timeout(settings.llm_timeout_seconds)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(endpoint, json=payload, headers=headers)
        if response.status_code >= 400:
            logger.warning("notation_llm http_error status=%s", response.status_code)
            return None
        data = response.json()
    except Exception as exc:
        logger.warning("notation_llm request_failed error=%s", exc)
        return None

    raw_content = _extract_message_content(data)
    if not raw_content:
        return None

    parsed = extract_json_object(raw_content)
    if not parsed or "symbols" not in parsed:
        return None

    results = []
    raw_symbols = parsed.get("symbols")
    if not isinstance(raw_symbols, list):
        return None

    for item in raw_symbols:
        if not isinstance(item, dict) or not item.get("symbol"):
            continue
        results.append({
            "symbol": str(item["symbol"]),
            "latex_type": str(item.get("latex_type", "unknown")),
            "lean_type": str(item.get("lean_type", "unknown")),
            "defined_in": file_path,
            "context_text": str(item.get("context_text", ""))[:200],
        })

    return results if results else None


async def extract_notations_from_latex(
    file_path: str,
    content: str,
) -> list[dict[str, Any]]:
    file_path = _as_text(file_path) or "unknown.tex"
    content = _as_text(content)
    if not content.strip():
        return []

    llm_result = await _extract_with_llm(file_path, content)
    if llm_result:
        logger.info("notation_extract llm success file=%s symbols=%d", file_path, len(llm_result))
        return llm_result

    regex_result = _extract_symbols_regex(content, file_path)
    logger.info("notation_extract regex fallback file=%s symbols=%d", file_path, len(regex_result))
    return regex_result


def find_cross_file_conflicts(notations: list[Any]) -> list[dict[str, Any]]:
    symbol_defs: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for n in notations:
        if hasattr(n, "symbol"):
            symbol = _as_text(n.symbol)
            latex_type = _as_text(getattr(n, "latex_type", "unknown")) or "unknown"
            defined_in = _as_text(getattr(n, "defined_in", ""))
            context_text = _as_text(getattr(n, "context_text", ""))
        elif isinstance(n, dict):
            symbol = _as_text(n.get("symbol", ""))
            latex_type = _as_text(n.get("latex_type", "unknown")) or "unknown"
            defined_in = _as_text(n.get("defined_in", ""))
            context_text = _as_text(n.get("context_text", ""))
        else:
            continue

        if not symbol:
            continue

        symbol_defs[symbol.lower()].append({
            "latex_type": latex_type,
            "defined_in": defined_in,
            "context_text": context_text,
        })

    conflicts = []
    for symbol, defs in symbol_defs.items():
        if len(defs) < 2:
            continue

        files = {d["defined_in"] for d in defs}
        if len(files) < 2:
            continue

        types = {d["latex_type"] for d in defs}
        if len(types) <= 1:
            continue

        file_list = ", ".join(sorted(files))
        type_list = ", ".join(sorted(types))
        conflicts.append({
            "symbol": symbol,
            "definitions": defs,
            "message": (
                f"Notation drift: {symbol} is used as {type_list} "
                f"across files: {file_list}"
            ),
        })

    return conflicts
