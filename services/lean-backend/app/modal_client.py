from __future__ import annotations

import logging
from typing import Any

import httpx

from .models import GeneratedLean
from .settings import Settings, get_settings
from .utils import retry_async

logger = logging.getLogger(__name__)


class ModalClientError(RuntimeError):
    """Raised when the Modal generation endpoint fails."""


class _RetriableModalError(ModalClientError):
    pass


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


def _build_modal_payload(
    prompt: str,
    context_payload: dict[str, Any],
    max_iters: int,
    endpoint_url: str,
) -> dict[str, Any]:
    theorem_name = context_payload.get("theorem_name", context_payload.get("declaration_name"))
    if not isinstance(theorem_name, str) or not theorem_name.strip():
        theorem_name = "generated_theorem"

    imports = _normalize_imports(context_payload.get("imports"))
    if not imports:
        imports = ["Std"]

    temperature = _normalize_temperature(context_payload.get("temperature", 0.0))
    model = context_payload.get("model")

    if endpoint_url.rstrip("/").endswith("/v1/analyze"):
        payload: dict[str, Any] = {
            "text": prompt,
            "theorem_name": theorem_name,
            "imports": imports,
            "temperature": temperature,
        }
        if isinstance(model, str) and model.strip():
            payload["model"] = model.strip()
        return payload

    payload = {
        "text": prompt,
        "theorem_name": theorem_name,
        "imports": imports,
        "temperature": temperature,
        "model": model,
        "prompt": prompt,
        "nl_input": prompt,
        "context": context_payload,
        "max_iters": max_iters,
    }
    return {k: v for k, v in payload.items() if v is not None}


def _normalize_generated_payload(data: dict[str, Any]) -> GeneratedLean:
    lean_code: str | None = None
    metadata: dict[str, Any] = {}

    if isinstance(data.get("lean_code"), str):
        lean_code = data["lean_code"]
        raw_metadata = data.get("metadata", {})
        metadata = raw_metadata if isinstance(raw_metadata, dict) else {"raw_metadata": raw_metadata}
    elif isinstance(data.get("lean_source"), str):
        lean_code = data["lean_source"]
        metadata = {
            "model": data.get("model"),
            "status": data.get("status"),
            "input_text": data.get("input_text"),
            "normalized_text": data.get("normalized_text"),
            "assumptions": data.get("assumptions"),
            "notes": data.get("notes"),
            "statement_type": data.get("statement_type"),
            "declaration_name": data.get("declaration_name"),
            "lean_declaration": data.get("lean_declaration"),
            "diagnostics": data.get("diagnostics"),
            "feedback": data.get("feedback"),
            "is_valid_lean": data.get("is_valid_lean"),
            "latency_ms": data.get("latency_ms"),
        }
        if isinstance(data.get("status"), str) and data["status"].lower() not in {"ok", "success"}:
            feedback = data.get("feedback")
            details = f" feedback={feedback}" if feedback else ""
            raise ModalClientError(f"Modal returned non-ok status='{data['status']}'.{details}")
    elif isinstance(data.get("code"), str):
        lean_code = data["code"]
        metadata = {}
    elif isinstance(data.get("result"), dict):
        result = data["result"]
        if isinstance(result.get("lean_code"), str):
            lean_code = result["lean_code"]
            raw_metadata = result.get("metadata", {})
            metadata = raw_metadata if isinstance(raw_metadata, dict) else {"raw_metadata": raw_metadata}
        elif isinstance(result.get("lean_source"), str):
            lean_code = result["lean_source"]
            metadata = {k: v for k, v in result.items() if k != "lean_source"}

    if not lean_code:
        raise ModalClientError(
            "Modal response missing Lean code. Expected one of: "
            "'lean_code', 'lean_source', 'code', or 'result.lean_code'."
        )

    return GeneratedLean(code=lean_code, metadata=metadata)


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

    headers = {"Content-Type": "application/json"}
    if settings.modal_api_key:
        headers["Authorization"] = f"Bearer {settings.modal_api_key}"

    context_payload = context or {}

    payload = _build_modal_payload(
        prompt=prompt,
        context_payload=context_payload,
        max_iters=max_iters,
        endpoint_url=settings.modal_endpoint_url,
    )

    timeout = httpx.Timeout(settings.modal_timeout_seconds)

    async with httpx.AsyncClient(timeout=timeout) as client:

        async def _call_modal() -> GeneratedLean:
            try:
                response = await client.post(settings.modal_endpoint_url, json=payload, headers=headers)
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

            return _normalize_generated_payload(data)

        attempts = max(1, settings.modal_max_retries + 1)
        return await retry_async(
            _call_modal,
            attempts,
            backoff_seconds=0.5,
            retriable_exceptions=(_RetriableModalError,),
            logger=logger,
            operation_name="modal.generate_lean",
        )
