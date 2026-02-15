from __future__ import annotations

import re
from dataclasses import dataclass

from .models import (
    HighlightChunk,
    HighlightItemResult,
    HighlightRange,
    HighlightResolveRequest,
    HighlightResolveResponse,
    HighlightSentence,
    InterpretationItem,
)

_QUOTED_RE = re.compile(r"`([^`]+)`|'([^']+)'|\"([^\"]+)\"")
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_']{2,}")
_UNKNOWN_SYMBOL_RE = re.compile(
    r"(?:unknown|undeclared)\s+(?:constant|identifier|symbol)\s+([A-Za-z_][A-Za-z0-9_'.]*)",
    re.IGNORECASE,
)

_STOPWORDS = {
    "and",
    "are",
    "for",
    "from",
    "have",
    "into",
    "that",
    "the",
    "this",
    "with",
    "could",
    "likely",
    "error",
    "failed",
    "compile",
    "compilation",
    "lean",
    "latex",
    "line",
    "column",
    "proof",
    "theorem",
}


@dataclass(frozen=True)
class _SpanMatch:
    chunk: HighlightChunk
    start_in_chunk: int
    end_in_chunk: int
    source: str
    confidence: float


def _chunk_end(chunk: HighlightChunk) -> int:
    inferred_end = chunk.start + len(chunk.text)
    if chunk.end is None:
        return inferred_end
    return max(chunk.end, inferred_end)


def _contains_global_span(chunk: HighlightChunk, start: int, end: int) -> bool:
    chunk_end = _chunk_end(chunk)
    return chunk.start <= start < end <= chunk_end


def _ordered_chunks(
    chunks: list[HighlightChunk], active_chunk_id: str | None
) -> list[HighlightChunk]:
    ordered = sorted(chunks, key=lambda chunk: chunk.start)
    if not active_chunk_id:
        return ordered

    active = [chunk for chunk in ordered if chunk.chunk_id == active_chunk_id]
    others = [chunk for chunk in ordered if chunk.chunk_id != active_chunk_id]
    return [*active, *others]


def _trim_candidate(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate:
        return None
    return candidate


# LaTeX <-> Unicode so we can try both when matching excerpt to chunk (e.g. \geq vs ≥)
_LATEX_TO_UNICODE = (
    (r"\geq", "≥"),
    (r"\leq", "≤"),
    (r"\neq", "≠"),
    (r"\mathbb{N}", "ℕ"),
    (r"\in", "∈"),
    (r"\forall", "∀"),
    (r"\exists", "∃"),
)


def _excerpt_search_variants(query: str) -> list[str]:
    """Return [query, ...] with LaTeX/Unicode variants so we can find in chunk text either way."""
    q = query.strip().strip("$")
    if not q:
        return []
    seen = {q}
    out = [q]
    # Unicode -> LaTeX (so if LLM returns "≥" we also try "\geq" in chunk)
    for latex, unicode_char in _LATEX_TO_UNICODE:
        if unicode_char in q:
            v = q.replace(unicode_char, latex)
            if v not in seen:
                seen.add(v)
                out.append(v)
    # LaTeX -> Unicode
    for latex, unicode_char in _LATEX_TO_UNICODE:
        if latex in q:
            v = q.replace(latex, unicode_char)
            if v not in seen:
                seen.add(v)
                out.append(v)
    return out


def _find_text_in_chunk(chunk: HighlightChunk, query: str) -> tuple[int, int] | None:
    direct = chunk.text.find(query)
    if direct != -1:
        return direct, direct + len(query)

    lower_index = chunk.text.lower().find(query.lower())
    if lower_index != -1:
        return lower_index, lower_index + len(query)

    # Try LaTeX/Unicode variants so chunk "n + 2 \geq n + 3" matches LLM excerpt "n + 2 ≥ n + 3"
    for variant in _excerpt_search_variants(query):
        if variant == query:
            continue
        idx = chunk.text.find(variant)
        if idx != -1:
            return idx, idx + len(variant)
        idx_lower = chunk.text.lower().find(variant.lower())
        if idx_lower != -1:
            return idx_lower, idx_lower + len(variant)

    return None


def _lookup_sentence_id(
    sentences: list[HighlightSentence], abs_start: int, abs_end: int
) -> str | None:
    for sentence in sentences:
        if (
            sentence.sentence_id
            and sentence.start is not None
            and sentence.end is not None
            and sentence.start < abs_end
            and sentence.end > abs_start
        ):
            return sentence.sentence_id
    return None


def _as_range(match: _SpanMatch, item_index: int) -> HighlightRange:
    abs_start = match.chunk.start + match.start_in_chunk
    abs_end = match.chunk.start + match.end_in_chunk
    return HighlightRange(
        chunk_id=match.chunk.chunk_id,
        item_index=item_index,
        start=abs_start,
        end=abs_end,
        start_in_chunk=match.start_in_chunk,
        end_in_chunk=match.end_in_chunk,
        text=match.chunk.text[match.start_in_chunk : match.end_in_chunk],
        source=match.source,
        confidence=match.confidence,
        sentence_id=_lookup_sentence_id(match.chunk.sentences, abs_start, abs_end),
    )


def _resolve_by_latex_span(
    item: InterpretationItem,
    chunks: list[HighlightChunk],
    active_chunk_id: str | None,
) -> _SpanMatch | None:
    if item.latex_start is None or item.latex_end is None:
        return None
    if item.latex_end <= item.latex_start:
        return None

    start = item.latex_start
    end = item.latex_end

    for chunk in _ordered_chunks(chunks, active_chunk_id):
        if _contains_global_span(chunk, start, end):
            return _SpanMatch(
                chunk=chunk,
                start_in_chunk=start - chunk.start,
                end_in_chunk=end - chunk.start,
                source="latex_span",
                confidence=0.99,
            )

    # Fallback: treat interpretation offsets as local chunk offsets.
    ordered_chunks = _ordered_chunks(chunks, active_chunk_id)
    if len(ordered_chunks) == 1:
        chunk = ordered_chunks[0]
        if 0 <= start < end <= len(chunk.text):
            return _SpanMatch(
                chunk=chunk,
                start_in_chunk=start,
                end_in_chunk=end,
                source="latex_span",
                confidence=0.92,
            )

    for chunk in ordered_chunks:
        if 0 <= start < end <= len(chunk.text):
            return _SpanMatch(
                chunk=chunk,
                start_in_chunk=start,
                end_in_chunk=end,
                source="latex_span",
                confidence=0.88,
            )

    return None


def _resolve_by_text(
    query: str | None,
    chunks: list[HighlightChunk],
    active_chunk_id: str | None,
    *,
    source: str,
    confidence: float,
) -> _SpanMatch | None:
    value = _trim_candidate(query)
    if not value:
        return None

    for chunk in _ordered_chunks(chunks, active_chunk_id):
        span = _find_text_in_chunk(chunk, value)
        if span is None:
            continue
        return _SpanMatch(
            chunk=chunk,
            start_in_chunk=span[0],
            end_in_chunk=span[1],
            source=source,
            confidence=confidence,
        )

    return None


def _extract_quoted_candidates(item: InterpretationItem) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    for field in [item.error, item.probable_cause, item.suggested_fix]:
        if not field:
            continue
        for match in _QUOTED_RE.finditer(field):
            group = next((value for value in match.groups() if value), None)
            candidate = _trim_candidate(group)
            if not candidate or len(candidate) < 2:
                continue
            key = candidate.lower()
            if key in seen:
                continue
            seen.add(key)
            candidates.append(candidate)

    symbol_match = _UNKNOWN_SYMBOL_RE.search(item.error)
    if symbol_match:
        symbol = symbol_match.group(1).strip()
        if symbol and symbol.lower() not in seen:
            seen.add(symbol.lower())
            candidates.append(symbol)

    replacement = _trim_candidate(item.replacement)
    if replacement and len(replacement) <= 200 and replacement.lower() not in seen:
        candidates.append(replacement)

    candidates.sort(key=len, reverse=True)
    return candidates


def _extract_keywords(item: InterpretationItem) -> list[str]:
    raw = " ".join(
        part
        for part in [item.error, item.probable_cause, item.suggested_fix]
        if isinstance(part, str)
    )
    seen: set[str] = set()
    tokens: list[str] = []
    for match in _WORD_RE.finditer(raw):
        token = match.group(0).strip()
        key = token.lower()
        if key in seen or key in _STOPWORDS:
            continue
        seen.add(key)
        tokens.append(token)
    tokens.sort(key=len, reverse=True)
    return tokens


def _resolve_item(
    item: InterpretationItem,
    chunks: list[HighlightChunk],
    active_chunk_id: str | None,
) -> _SpanMatch | None:
    by_span = _resolve_by_latex_span(item, chunks, active_chunk_id)
    if by_span is not None:
        return by_span

    by_excerpt = _resolve_by_text(
        item.latex_excerpt,
        chunks,
        active_chunk_id,
        source="latex_excerpt",
        confidence=0.9,
    )
    if by_excerpt is not None:
        return by_excerpt

    for candidate in _extract_quoted_candidates(item):
        by_quote = _resolve_by_text(
            candidate,
            chunks,
            active_chunk_id,
            source="quoted_text",
            confidence=0.8,
        )
        if by_quote is not None:
            return by_quote

    by_replacement = _resolve_by_text(
        item.replacement,
        chunks,
        active_chunk_id,
        source="replacement_text",
        confidence=0.72,
    )
    if by_replacement is not None:
        return by_replacement

    for keyword in _extract_keywords(item):
        by_keyword = _resolve_by_text(
            keyword,
            chunks,
            active_chunk_id,
            source="keyword",
            confidence=0.6,
        )
        if by_keyword is not None:
            return by_keyword

    return None


def resolve_highlights(payload: HighlightResolveRequest) -> HighlightResolveResponse:
    chunks = payload.chunks
    items = payload.interpretation.items
    active_chunk_id = payload.active_chunk_id.strip() or None

    highlights: list[HighlightRange] = []
    item_results: list[HighlightItemResult] = []
    unresolved_items: list[int] = []

    for item_index, item in enumerate(items):
        match = _resolve_item(item, chunks, active_chunk_id)
        if match is None:
            unresolved_items.append(item_index)
            item_results.append(
                HighlightItemResult(
                    item_index=item_index,
                    error=item.error,
                    resolved=False,
                    ranges=[],
                    reason="no_text_match",
                )
            )
            continue

        resolved_range = _as_range(match, item_index)
        highlights.append(resolved_range)
        item_results.append(
            HighlightItemResult(
                item_index=item_index,
                error=item.error,
                resolved=True,
                ranges=[resolved_range],
                reason=match.source,
            )
        )

    return HighlightResolveResponse(
        highlights=highlights,
        items=item_results,
        unresolved_items=unresolved_items,
    )
