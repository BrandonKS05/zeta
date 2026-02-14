"use strict";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "zeta-http") {
    return false;
  }

  const {
    url,
    method = "POST",
    headers = {},
    body,
    timeoutMs = 15000,
  } = message;

  if (!url || typeof url !== "string") {
    sendResponse({ ok: false, error: "Missing request URL." });
    return false;
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  console.info("[zeta:bg] http_request_start", {
    method,
    url,
    timeoutMs,
  });
  const timerId = setTimeout(() => {
    controller.abort();
  }, Math.max(1000, Number(timeoutMs) || 15000));

  fetch(url, {
    method,
    headers,
    body,
    signal: controller.signal,
    cache: "no-store",
    credentials: "omit",
  })
    .then(async (response) => {
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (_error) {
        json = null;
      }

      console.info("[zeta:bg] http_response", {
        method,
        url,
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt,
      });

      sendResponse({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        text,
        json,
      });
    })
    .catch((error) => {
      const isAbort = error?.name === "AbortError";
      console.warn("[zeta:bg] http_error", {
        method,
        url,
        durationMs: Date.now() - startedAt,
        error: isAbort ? "Request timed out." : String(error?.message || error),
      });
      sendResponse({
        ok: false,
        error: isAbort ? "Request timed out." : String(error?.message || error),
      });
    })
    .finally(() => {
      clearTimeout(timerId);
    });

  return true;
});
