"use strict";

/** Set to true to mute all logs except chat/explain (turn off when done debugging). */
const DEBUG_CHAT_ONLY = true;
const zetaLogPrefix = (tag) => `[zeta:${tag}] ${new Date().toISOString()}`;

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
  const isChatExplain = typeof url === "string" && url.includes("/v1/chat/explain");
  const isComplete = typeof url === "string" && url.includes("/v1/complete");
  if (!DEBUG_CHAT_ONLY || isChatExplain || isComplete) {
    console.info(`${zetaLogPrefix("bg")} http_request_start`, {
      method,
      url,
      timeoutMs,
      isChatExplain,
      isComplete,
    });
  }
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

      const durationMs = Date.now() - startedAt;
      if (!DEBUG_CHAT_ONLY || isChatExplain || isComplete) {
        console.info(`${zetaLogPrefix("bg")} http_response`, {
          method,
          url,
          status: response.status,
          ok: response.ok,
          durationMs,
        });
      }
      if (isComplete && json) {
        console.info(`${zetaLogPrefix("bg")} complete response`, {
          durationMs,
          serverLatencyMs: json.latency_ms,
          timings_ms: json.timings_ms,
          cache_hit: json.cache_hit,
        });
      }
      if (isChatExplain) {
        console.info(`${zetaLogPrefix("bg")} chat/explain response detail`, {
          status: response.status,
          ok: response.ok,
          durationMs,
          source: json?.source,
          fallback_reason: json?.fallback_reason,
          answerLength: typeof json?.answer === "string" ? json.answer.length : 0,
          error: json?.detail ? String(json.detail).slice(0, 300) : undefined,
        });
      }

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
      if (!DEBUG_CHAT_ONLY || isChatExplain || isComplete) {
        console.warn(`${zetaLogPrefix("bg")} http_error`, {
          method,
          url,
          durationMs: Date.now() - startedAt,
          error: isAbort ? "Request timed out." : String(error?.message || error),
          isChatExplain,
          isComplete,
        });
      }
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
