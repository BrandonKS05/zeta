from __future__ import annotations

import asyncio
import contextvars
import json
import logging
from typing import Any, Awaitable, Callable, TypeVar

T = TypeVar("T")

request_id_ctx: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get()
        return True


def configure_logging(level: str = "INFO") -> None:
    root_logger = logging.getLogger()
    if root_logger.handlers:
        for handler in root_logger.handlers:
            if not any(isinstance(log_filter, RequestIdFilter) for log_filter in handler.filters):
                handler.addFilter(RequestIdFilter())
    else:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s request_id=%(request_id)s %(message)s"
            )
        )
        handler.addFilter(RequestIdFilter())
        root_logger.addHandler(handler)

    root_logger.setLevel(level.upper())


def truncate_text(text: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    omitted = len(text) - max_chars
    return f"{text[:max_chars]}\n...<truncated {omitted} chars>"


async def retry_async(
    operation: Callable[[], Awaitable[T]],
    attempts: int,
    *,
    backoff_seconds: float = 0.5,
    retriable_exceptions: tuple[type[BaseException], ...],
    logger: logging.Logger | None = None,
    operation_name: str = "operation",
) -> T:
    if attempts < 1:
        raise ValueError("attempts must be >= 1")

    last_exception: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await operation()
        except retriable_exceptions as exc:
            last_exception = exc
            if attempt == attempts:
                break
            if logger:
                logger.warning(
                    "%s failed on attempt %s/%s: %s",
                    operation_name,
                    attempt,
                    attempts,
                    exc,
                )
            await asyncio.sleep(backoff_seconds * attempt)

    if last_exception is None:
        raise RuntimeError(f"{operation_name} failed without raising an exception")
    raise last_exception


def extract_json_object(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if not text:
        return None

    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None

    try:
        payload = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None

    return payload if isinstance(payload, dict) else None
