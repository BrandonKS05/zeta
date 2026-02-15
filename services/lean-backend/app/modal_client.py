from __future__ import annotations

import logging
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from .models import GeneratedLean
from .settings import Settings, get_settings
from .utils import retry_async

logger = logging.getLogger(__name__)


class ModalClientError(RuntimeError):
    """Raised when the Modal generation endpoint fails."""


class _RetriableModalError(ModalClientError):
    pass


_ANALYZE_ENDPOINT_SUFFIX = "/v1/analyze"
_GENERATE_ENDPOINT_SUFFIX = "/v1/generate"
_QUERY_ENDPOINT_SUFFIX = "/v1/query"
_COMPLETE_ENDPOINT_SUFFIX = "/v1/complete"
_ANALYZE_ACCEPTED_STATUSES = {"ok", "success", "needs_revision", "unchecked"}

# System prompt for Herald (single POST / endpoint) when used for autocomplete
HERALD_AUTOCOMPLETE_SYSTEM_PROMPT = """You are a math-writing autocomplete model. Your only task is to suggest a short completion for the user's current cursor position.

Rules:
1) You receive the document text and cursor position. Return ONLY the completion suffix to insert at the cursor (do not repeat the prefix).
2) Prefer 1–3 short, natural continuations (a phrase or formula). Prefer mathematical content; no LaTeX declarations like \\documentclass, \\begin{document}, \\end{document}.
3) Return valid JSON with a single key "candidates" whose value is a list of 1–3 strings, e.g. {"candidates": ["c^2.", " c^2 for the hypotenuse."]}.
4) If the prefix is too short or unclear, return {"candidates": []}.
"""
_ANALYZE_METADATA_FIELDS = (
    "model",
    "status",
    "input_text",
    "normalized_text",
    "assumptions",
    "notes",
    "statement_type",
    "declaration_name",
    "lean_declaration",
    "diagnostics",
    "feedback",
    "final_feedback",
    "interpretation",
    "is_valid_lean",
    "mode",
    "iteration_count",
    "iteration_history",
    "latency_ms",
)


def _uses_analyze_payload_shape(endpoint_url: str) -> bool:
    """Translator-modal OpenAPI endpoints expect the analyze-style payload."""
    path = urlsplit(endpoint_url.strip()).path.rstrip("/")
    return (
        path.endswith(_ANALYZE_ENDPOINT_SUFFIX)
        or path.endswith(_GENERATE_ENDPOINT_SUFFIX)
        or path.endswith(_QUERY_ENDPOINT_SUFFIX)
    )


def _uses_backend_payload_shape(endpoint_url: str) -> bool:
    """Root modal endpoints typically proxy lean-backend's nl_input/context schema."""
    path = urlsplit(endpoint_url.strip()).path.rstrip("/")
    return path == ""


def _compact_dict(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value is not None}


def _normalize_imports(raw_imports: Any) -> list[str]:
    if isinstance(raw_imports, list):
        return [str(item).strip() for item in raw_imports if str(item).strip()]
    if isinstance(raw_imports, str) and raw_imports.strip():
        return [raw_imports.strip()]
    return []

 
def _normalize_temperature(raw_temperature: Any) -> float:
    if isinstance(raw_temperature, bool):
        return 0.0
    if isinstance(raw_temperature, (int, float)):
        return float(raw_temperature)
    if isinstance(raw_temperature, str):
        try:
            return float(raw_temperature)
        except ValueError:
            return 0.0
    return 0.0


def _normalize_mode(raw_mode: Any, max_iters: int) -> str | None:
    if isinstance(raw_mode, str):
        candidate = raw_mode.strip().lower()
        if candidate in {"fast", "thinking"}:
            return candidate
    if max_iters > 1:
        return "thinking"
    return None


def _normalize_optional_bool(raw_value: Any) -> bool | None:
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, str):
        lowered = raw_value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return None


def _build_modal_payload(
    prompt: str,
    context_payload: dict[str, Any],
    max_iters: int,
    endpoint_url: str,
) -> dict[str, Any]:
    theorem_name = context_payload.get("theorem_name", context_payload.get("declaration_name"))
    if not isinstance(theorem_name, str) or not theorem_name.strip():
        theorem_name = "generated_theorem"

    imports = _normalize_imports(context_payload.get("imports")) or ["Std"]
    temperature = _normalize_temperature(context_payload.get("temperature", 0.0))
    model = context_payload.get("model")

    analyze_payload: dict[str, Any] = {
        "text": prompt,
        "theorem_name": theorem_name,
        "imports": imports,
        "temperature": temperature,
    }
    if isinstance(model, str) and model.strip():
        analyze_payload["model"] = model.strip()
    mode = _normalize_mode(context_payload.get("mode"), max_iters)
    if mode is not None:
        analyze_payload["mode"] = mode
    if mode == "thinking":
        analyze_payload["max_iters"] = max_iters

    include_iteration_history = _normalize_optional_bool(context_payload.get("include_iteration_history"))
    if include_iteration_history is not None:
        analyze_payload["include_iteration_history"] = include_iteration_history

    include_raw_model_output = _normalize_optional_bool(context_payload.get("include_raw_model_output"))
    if include_raw_model_output is not None:
        analyze_payload["include_raw_model_output"] = include_raw_model_output

    if _uses_backend_payload_shape(endpoint_url):
        return {
            "nl_input": prompt,
            "context": _compact_dict({
                "theorem_name": theorem_name,
                "imports": imports,
            }),
            "max_iters": max_iters,
        }

    if _uses_analyze_payload_shape(endpoint_url):
        return analyze_payload

    return _compact_dict(
        {
            **analyze_payload,
            "prompt": prompt,
            "nl_input": prompt,
            "context": context_payload,
            "max_iters": max_iters,
        }
    )


def _resolve_modal_endpoint(endpoint_url: str, *, use_generate: bool) -> str:
    normalized = endpoint_url.strip()
    parsed = urlsplit(normalized)
    path = parsed.path.rstrip("/")

    target_suffix = _GENERATE_ENDPOINT_SUFFIX if use_generate else _ANALYZE_ENDPOINT_SUFFIX
    rewritten = False

    if path.endswith(_ANALYZE_ENDPOINT_SUFFIX):
        path = f"{path[: -len(_ANALYZE_ENDPOINT_SUFFIX)]}{target_suffix}"
        rewritten = True
    elif path.endswith(_QUERY_ENDPOINT_SUFFIX):
        path = f"{path[: -len(_QUERY_ENDPOINT_SUFFIX)]}{target_suffix}"
        rewritten = True
    elif path == "" or path == "/":
        path = ""
        rewritten = False

    resolved = urlunsplit((parsed.scheme, parsed.netloc, path if path else "/", parsed.query, parsed.fragment))
    if rewritten:
        logger.info(
            "modal_endpoint_normalized configured=%s resolved=%s use_generate=%s",
            endpoint_url,
            resolved,
            use_generate,
        )
    return resolved


def _is_herald_root_endpoint(modal_endpoint_url: str) -> bool:
    """True if the endpoint is Herald-style: single POST / (no /v1/analyze, /v1/complete, etc.)."""
    normalized = modal_endpoint_url.strip()
    parsed = urlsplit(normalized)
    path = parsed.path.rstrip("/")
    return path == "" or path == "/"


def _modal_base_url(modal_endpoint_url: str) -> str:
    """Return the Modal app base URL (scheme + netloc + /) with no path. Used for autocomplete (translator/Herald)."""
    normalized = modal_endpoint_url.strip()
    parsed = urlsplit(normalized)
    return urlunsplit((parsed.scheme, parsed.netloc, "/", parsed.query, parsed.fragment))


def _resolve_modal_complete_url(modal_endpoint_url: str) -> str:
    """Resolve the Modal /v1/complete URL from the configured modal endpoint (e.g. /v1/generate or /v1/analyze)."""
    normalized = modal_endpoint_url.strip()
    parsed = urlsplit(normalized)
    path = parsed.path.rstrip("/")
    if path.endswith(_ANALYZE_ENDPOINT_SUFFIX):
        path = f"{path[: -len(_ANALYZE_ENDPOINT_SUFFIX)]}{_COMPLETE_ENDPOINT_SUFFIX}"
    elif path.endswith(_GENERATE_ENDPOINT_SUFFIX):
        path = f"{path[: -len(_GENERATE_ENDPOINT_SUFFIX)]}{_COMPLETE_ENDPOINT_SUFFIX}"
    elif path.endswith(_QUERY_ENDPOINT_SUFFIX):
        path = f"{path[: -len(_QUERY_ENDPOINT_SUFFIX)]}{_COMPLETE_ENDPOINT_SUFFIX}"
    elif path == "" or path == "/":
        # Default autocomplete contract is /v1/complete even when the configured
        # endpoint is the app root.
        return urlunsplit((parsed.scheme, parsed.netloc, _COMPLETE_ENDPOINT_SUFFIX, parsed.query, parsed.fragment))
    else:
        path = _COMPLETE_ENDPOINT_SUFFIX
    return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))


def _extract_lean_code(candidate: dict[str, Any]) -> tuple[str | None, str | None]:
    for key in ("lean_source", "lean_code", "code"):
        value = candidate.get(key)
        if isinstance(value, str) and value:
            return key, value
    return None, None


def _build_analyze_metadata(candidate: dict[str, Any]) -> dict[str, Any]:
    metadata = _compact_dict({field: candidate.get(field) for field in _ANALYZE_METADATA_FIELDS})
    if metadata:
        return metadata
    return _compact_dict({key: value for key, value in candidate.items() if key != "lean_source"})


def _validate_analyze_status(candidate: dict[str, Any]) -> None:
    status = candidate.get("status")
    if isinstance(status, str) and status.lower() not in _ANALYZE_ACCEPTED_STATUSES:
        feedback = candidate.get("feedback")
        details = f" feedback={feedback}" if feedback else ""
        raise ModalClientError(f"Modal returned non-ok status='{status}'.{details}")


def _normalize_generated_payload(data: dict[str, Any]) -> GeneratedLean:
    candidates: list[dict[str, Any]] = [data]
    nested_result = data.get("result")
    if isinstance(nested_result, dict):
        candidates.append(nested_result)
    for key in ("output", "response", "data"):
        val = data.get(key)
        if isinstance(val, dict):
            candidates.append(val)

    for candidate in candidates:
        code_key, lean_code = _extract_lean_code(candidate)
        if lean_code is None or code_key is None:
            continue

        if code_key == "lean_source":
            _validate_analyze_status(candidate)
            metadata = _build_analyze_metadata(candidate)
            return GeneratedLean(code=lean_code, metadata=metadata)

        if code_key == "lean_code":
            raw_metadata = candidate.get("metadata", {})
            metadata = raw_metadata if isinstance(raw_metadata, dict) else {"raw_metadata": raw_metadata}
            return GeneratedLean(code=lean_code, metadata=metadata)

        return GeneratedLean(code=lean_code, metadata={})

    top_keys = list(data.keys()) if isinstance(data, dict) else []
    raise ModalClientError(
        "Modal response missing Lean code. Expected one of: "
        "'lean_code', 'lean_source', 'code', or 'result.lean_code'. "
        f"Response keys: {top_keys!r}."
    )


async def generate_lean(
    prompt: str,
    context: dict[str, Any] | None = None,
    max_iters: int = 1,
    *,
    settings: Settings | None = None,
) -> GeneratedLean:
    settings = settings or get_settings()
    if not settings.modal_endpoint_url:
        raise ModalClientError("MODAL_ENDPOINT_URL is not configured")
    context_payload = context or {}
    mode = _normalize_mode(context_payload.get("mode"), max_iters)
    use_generate_default = bool(getattr(settings, "modal_use_generate_endpoint", True))
    use_generate = use_generate_default and mode != "thinking" and max_iters <= 1
    endpoint_url = _resolve_modal_endpoint(
        settings.modal_endpoint_url,
        use_generate=use_generate,
    )

    headers = {"Content-Type": "application/json"}
    if settings.modal_api_key:
        # Support both gateway-style bearer auth and translator-modal's x-api-key auth.
        headers["Authorization"] = f"Bearer {settings.modal_api_key}"
        headers["x-api-key"] = settings.modal_api_key

    payload = _build_modal_payload(
        prompt=prompt,
        context_payload=context_payload,
        max_iters=max_iters,
        endpoint_url=endpoint_url,
    )
    logger.info(
        "modal_request_prepared endpoint=%s prompt_chars=%s max_iters=%s theorem_name=%s",
        endpoint_url,
        len(prompt),
        max_iters,
        payload.get("theorem_name"),
    )

    timeout = httpx.Timeout(settings.modal_timeout_seconds)

    async with httpx.AsyncClient(timeout=timeout) as client:

        async def _call_modal() -> GeneratedLean:
            request_started = time.perf_counter()
            try:
                response = await client.post(endpoint_url, json=payload, headers=headers)
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                raise _RetriableModalError(f"Modal request transport error: {exc}") from exc

            if response.status_code >= 500:
                raise _RetriableModalError(
                    f"Modal server error {response.status_code}: {response.text[:500]}"
                )
            if response.status_code == 202:
                raise ModalClientError(
                    "Modal returned 202 Accepted (async job). Translation expects a synchronous "
                    "response with lean_code. Use an endpoint that returns 200 with the result in the body, "
                    "or implement polling for the job URL."
                )
            if response.status_code >= 400:
                logger.warning(
                    "modal_request_failed (request that got this response): url=%s method=POST status=%s response_preview=%s payload_keys=%s nl_input_len=%s",
                    endpoint_url,
                    response.status_code,
                    (response.text or "")[:400],
                    list(payload.keys()),
                    len(str(payload.get("nl_input", payload.get("prompt", "")))),
                )
                logger.info(
                    "modal_request_body_for_debug url=%s body=%s",
                    endpoint_url,
                    payload,
                )
                raise ModalClientError(
                    f"Modal returned HTTP {response.status_code}: {response.text[:500]}"
                )

            try:
                data = response.json()
            except ValueError as exc:
                raise ModalClientError("Modal returned non-JSON response") from exc

            if not isinstance(data, dict):
                raise ModalClientError("Modal response JSON is not an object")

            logger.info(
                "modal_response_received status=%s body_chars=%s duration_ms=%.2f",
                response.status_code,
                len(response.text or ""),
                (time.perf_counter() - request_started) * 1000,
            )
            generated = _normalize_generated_payload(data)
            logger.info(
                "modal_response_normalized metadata_keys=%s code_chars=%s",
                sorted(generated.metadata.keys()),
                len(generated.code),
            )
            return generated

        attempts = max(1, settings.modal_max_retries + 1)
        return await retry_async(
            _call_modal,
            attempts,
            backoff_seconds=0.5,
            retriable_exceptions=(_RetriableModalError,),
            logger=logger,
            operation_name="modal.generate_lean",
        )


def _build_herald_autocomplete_payload(
    request_payload: dict[str, Any],
    system_prompt: str,
) -> dict[str, Any]:
    """Build payload for Herald POST / (V1 Translate). Herald should accept system_prompt and use it for autocomplete.
    We send context as a dict so serve.py can do context.get('theorem_name', 'unnamed') without AttributeError;
    the document text is in context['document']."""
    text = request_payload.get("text") or ""
    cursor = request_payload.get("cursor_offset")
    if cursor is None or (isinstance(text, str) and cursor > len(text)):
        cursor = len(text) if isinstance(text, str) else 0
    prefix = text[:cursor] if isinstance(text, str) and isinstance(cursor, int) else text
    raw_context = request_payload.get("context")
    context_str = raw_context if isinstance(raw_context, str) else ""
    context_payload: dict[str, Any] = {
        "theorem_name": "unnamed",
        "imports": list(request_payload.get("imports") or ["Std"]),
        "document": context_str,
    }
    return {
        "text": text,
        "cursor_offset": cursor,
        "context": context_payload,
        "system_prompt": system_prompt,
        "max_new_tokens": min(int(request_payload.get("max_new_tokens") or 24), 64),
        "temperature": float(request_payload.get("temperature") or 0.35),
        "autocomplete_mode": True,
    }


def _normalize_herald_complete_response(raw: dict[str, Any], request_payload: dict[str, Any]) -> dict[str, Any]:
    """Convert Herald translate response into the shape the extension expects (candidates, selected_completion)."""
    candidates: list[str] = []
    text = request_payload.get("text") or ""
    cursor = request_payload.get("cursor_offset")
    if cursor is None:
        cursor = len(text) if isinstance(text, str) else 0
    prefix = text[:cursor] if isinstance(text, str) else ""

    if isinstance(raw.get("candidates"), list):
        for c in raw["candidates"]:
            if isinstance(c, str) and c.strip():
                candidates.append(c.strip())
                continue
            if isinstance(c, dict):
                for key in ("completion", "text", "output", "result"):
                    val = c.get(key)
                    if isinstance(val, str) and val.strip():
                        candidates.append(val.strip())
                        break

    # Support OpenAI-style and chat-style wrappers from upstream proxies.
    choices = raw.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            for key in ("text", "completion", "output"):
                val = choice.get(key)
                if isinstance(val, str) and val.strip():
                    candidates.append(val.strip())
            message = choice.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    candidates.append(content.strip())
            delta = choice.get("delta")
            if isinstance(delta, dict):
                content = delta.get("content")
                if isinstance(content, str) and content.strip():
                    candidates.append(content.strip())
    for key in ("lean_code", "text", "output", "completion", "result"):
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            suffix = val.strip()
            if suffix.startswith(prefix):
                suffix = suffix[len(prefix) :].strip()
            if suffix and suffix not in candidates:
                candidates.append(suffix)
    nested = raw.get("result") if isinstance(raw.get("result"), dict) else None
    if nested and not candidates:
        if isinstance(nested.get("lean_code"), str) and nested["lean_code"].strip():
            candidates.append(nested["lean_code"].strip())
        if isinstance(nested.get("text"), str) and nested["text"].strip():
            candidates.append(nested["text"].strip())

    deduped: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        normalized = str(item or "").strip()
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(normalized)
    candidates = deduped

    selected = candidates[0] if candidates else None
    upstream_reasons = raw.get("no_suggestion_reasons")
    if isinstance(upstream_reasons, list):
        reasons = [str(reason).strip() for reason in upstream_reasons if str(reason).strip()]
    else:
        reasons = []
    if not reasons and not candidates:
        reasons = ["Herald returned no completion"]
    no_suggestion_debug: dict[str, Any] | None = None
    if not candidates:
        raw_preview = ""
        try:
            raw_preview = json.dumps(raw, ensure_ascii=False)[:800]
        except Exception:
            raw_preview = str(raw)[:800]
        no_suggestion_debug = {
            "upstream_keys": sorted(raw.keys()),
            "raw_preview": raw_preview,
            "has_choices": isinstance(raw.get("choices"), list),
            "has_candidates": isinstance(raw.get("candidates"), list),
        }

    return {
        "model": raw.get("model", "herald"),
        "status": "ok" if candidates else "no_suggestion",
        "input_text": text,
        "prefix_text": prefix,
        "selected_completion": selected,
        "candidates": [{"completion": c, "score": 1.0, "model_score": 1.0, "retrieval_score": 0.0, "syntax_score": 0.0, "rejected_reasons": []} for c in candidates],
        "cache_hit": False,
        "latency_ms": int(raw.get("latency_ms", 0)),
        "timings_ms": raw.get("timings_ms") or {},
        "no_suggestion_reasons": [] if candidates else reasons,
        "no_suggestion_debug": no_suggestion_debug,
    }


async def complete_autocomplete(
    request_payload: dict[str, Any],
    *,
    system_prompt: str | None = None,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Call Modal /v1/complete, or Herald POST / with autocomplete system prompt when endpoint is root."""
    settings = settings or get_settings()
    if not settings.modal_endpoint_url:
        raise ModalClientError(
            "MODAL_ENDPOINT_URL is not configured. Set it on the lean-backend server (e.g. to your Modal app URL like https://user--app.modal.run or .../v1/generate) so autocomplete can run."
        )
    complete_url = _resolve_modal_complete_url(settings.modal_endpoint_url)
    fallback_url = _modal_base_url(settings.modal_endpoint_url)
    url_candidates: list[str] = [complete_url]
    if fallback_url not in url_candidates:
        url_candidates.append(fallback_url)
    logger.info(
        "modal_autocomplete_request configured=%s resolved_urls=%s",
        settings.modal_endpoint_url,
        url_candidates,
    )
    herald_system = (system_prompt or getattr(settings, "modal_complete_system_prompt", None) or HERALD_AUTOCOMPLETE_SYSTEM_PROMPT).strip()
    payload = _build_herald_autocomplete_payload(request_payload, herald_system)

    headers = {"Content-Type": "application/json"}
    if settings.modal_api_key:
        headers["Authorization"] = f"Bearer {settings.modal_api_key}"
        headers["x-api-key"] = settings.modal_api_key
    timeout = httpx.Timeout(getattr(settings, "modal_timeout_seconds", 20.0) * 1.5)
    async with httpx.AsyncClient(timeout=timeout) as client:
        last_http_error: ModalClientError | None = None
        for index, candidate_url in enumerate(url_candidates):
            try:
                response = await client.post(candidate_url, json=payload, headers=headers)
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                raise ModalClientError(f"Modal complete request failed: {exc}") from exc

            if response.status_code >= 400:
                body_preview = (response.text or "")[:400].strip()
                hint = ""
                if response.status_code == 502:
                    hint = " Modal app may be cold or failing; check the Modal dashboard."
                elif response.status_code == 500:
                    hint = (
                        " The Modal app must accept autocomplete payload and return a completion-shaped response."
                    )
                # If /v1/complete is unavailable, allow one fallback attempt at app root.
                if index < len(url_candidates) - 1 and response.status_code in {404, 405}:
                    continue
                last_http_error = ModalClientError(
                    f"Modal complete returned HTTP {response.status_code}: {body_preview or 'no body'}.{hint}"
                )
                break

            try:
                data = response.json()
            except ValueError:
                last_http_error = ModalClientError("Modal complete returned non-JSON response")
                break
            if not isinstance(data, dict):
                last_http_error = ModalClientError("Modal complete returned non-object response")
                break

            normalized = _normalize_herald_complete_response(data, request_payload)
            if (
                isinstance(normalized, dict)
                and normalized.get("status") == "no_suggestion"
                and isinstance(normalized.get("no_suggestion_debug"), dict)
            ):
                debug = dict(normalized["no_suggestion_debug"])
                try:
                    request_preview = json.dumps(payload, ensure_ascii=False)[:800]
                except Exception:
                    request_preview = str(payload)[:800]
                debug["request_url"] = candidate_url
                debug["request_preview"] = request_preview
                normalized["no_suggestion_debug"] = debug
            return normalized

        if last_http_error is not None:
            raise last_http_error
        raise ModalClientError("Modal complete returned no usable response")
