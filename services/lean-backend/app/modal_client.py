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


def _normalize_generated_payload(data: dict[str, Any]) -> GeneratedLean:
    lean_code: str | None = None
    metadata: dict[str, Any] = {}

    if isinstance(data.get("lean_code"), str):
        lean_code = data["lean_code"]
        raw_metadata = data.get("metadata", {})
        metadata = raw_metadata if isinstance(raw_metadata, dict) else {"raw_metadata": raw_metadata}
    elif isinstance(data.get("code"), str):
        lean_code = data["code"]
        metadata = {}
    elif isinstance(data.get("result"), dict):
        result = data["result"]
        if isinstance(result.get("lean_code"), str):
            lean_code = result["lean_code"]
            raw_metadata = result.get("metadata", {})
            metadata = raw_metadata if isinstance(raw_metadata, dict) else {"raw_metadata": raw_metadata}

    if not lean_code:
        raise ModalClientError("Modal response missing Lean code in 'lean_code' field")

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

    payload = {
        "prompt": prompt,
        "nl_input": prompt,
        "context": context or {},
        "max_iters": max_iters,
    }

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
