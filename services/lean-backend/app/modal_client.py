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
_ANALYZE_ACCEPTED_STATUSES = {"ok", "success", "needs_revision", "unchecked"}
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
    "is_valid_lean",
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
            "context": context_payload,
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
    elif path == "":
        # Root translator endpoint is valid and should be used as-is.
        return normalized

    resolved = urlunsplit((parsed.scheme, parsed.netloc, path or "/", parsed.query, parsed.fragment))
    if rewritten:
        logger.info(
            "modal_endpoint_normalized configured=%s resolved=%s use_generate=%s",
            endpoint_url,
            resolved,
            use_generate,
        )
    return resolved


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

    raise ModalClientError(
        "Modal response missing Lean code. Expected one of: "
        "'lean_code', 'lean_source', 'code', or 'result.lean_code'."
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
    endpoint_url = _resolve_modal_endpoint(
        settings.modal_endpoint_url,
        use_generate=bool(getattr(settings, "modal_use_generate_endpoint", True)),
    )

    headers = {"Content-Type": "application/json"}
    if settings.modal_api_key:
        # Support both gateway-style bearer auth and translator-modal's x-api-key auth.
        headers["Authorization"] = f"Bearer {settings.modal_api_key}"
        headers["x-api-key"] = settings.modal_api_key

    context_payload = context or {}
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
            if response.status_code >= 400:
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
