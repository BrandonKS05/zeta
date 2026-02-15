(() => {
  "use strict";

  const zeta = window.__zetaContent || (window.__zetaContent = {});

  const SETTINGS_KEY = "zetaSettings";
  const MODE_KEY = "zetaMode";
  const IGNORED_KEY = "zetaIgnoredIssueKeys";
  const TELEMETRY_KEY = "zetaTelemetry";
  const PANEL_SNAPSHOT_KEY = "zetaPanelSnapshot";
  const CACHE_TTL_MS = 90 * 1000;
  const MAX_HIGHLIGHT_RECTS = 120;

  const DEFAULT_SETTINGS = {
    backendUrl: "http://13.57.35.202:8000/v1/lean/solve",
    mode: "auto",
    scope: "document",
    theme: "light",
    checkOnType: true,
    requestTimeoutMs: 18000,
    retries: 1,
    notationStrictness: "balanced",
    panelOpen: false,
  };
  
  const MODE_SET = new Set(["fast", "accurate", "auto"]);
  const SCOPE_SET = new Set(["selection", "paragraph", "document"]);
  const THEME_SET = new Set(["dark", "light"]);
  const LOG_PREFIX = "[zeta]";
  const SEVERITY_WEIGHT = {
    error: 18,
    warning: 8,
    info: 3,
    unknown: 6,
  };

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function shortHash(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
    }
    return String(hash);
  }

  function normalizeMode(mode) {
    return MODE_SET.has(mode) ? mode : DEFAULT_SETTINGS.mode;
  }

  function normalizeScope(scope) {
    return SCOPE_SET.has(scope) ? scope : DEFAULT_SETTINGS.scope;
  }

  function normalizeTheme(theme) {
    return THEME_SET.has(theme) ? theme : DEFAULT_SETTINGS.theme;
  }

  function modeToDebounce(mode) {
    if (mode === "fast") {
      return 130;
    }
    if (mode === "accurate") {
      return 420;
    }
    return 220;
  }

  function modeToLabel(mode) {
    if (mode === "fast") {
      return "Fast";
    }
    if (mode === "accurate") {
      return "Accurate";
    }
    return "Auto";
  }

  function ensureArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function storageSyncGet(defaults) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        resolve(defaults);
        return;
      }
      chrome.storage.sync.get(defaults, (result) => resolve(result));
    });
  }

  function storageSyncSet(payload) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        resolve();
        return;
      }
      chrome.storage.sync.set(payload, () => resolve());
    });
  }

  function storageLocalGet(defaults) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve(defaults);
        return;
      }
      chrome.storage.local.get(defaults, (result) => resolve(result));
    });
  }

  function storageLocalSet(payload) {
    return new Promise((resolve) => {
      if (!chrome?.storage?.local) {
        resolve();
        return;
      }
      chrome.storage.local.set(payload, () => resolve());
    });
  }

  function extractText(node) {
    return String(node?.textContent || "");
  }

  function normalizeSeverity(raw) {
    const value = String(raw || "unknown").toLowerCase();
    if (value.includes("error")) {
      return "error";
    }
    if (value.includes("warn")) {
      return "warning";
    }
    if (value.includes("info")) {
      return "info";
    }
    return "unknown";
  }

  function logTrace(event, payload) {
    try {
      if (typeof payload === "undefined") {
        console.info(`${LOG_PREFIX} ${event}`);
      } else {
        console.info(`${LOG_PREFIX} ${event}`, payload);
      }
    } catch (_error) {
      // ignore console failures
    }
  }

  Object.assign(zeta, {
    SETTINGS_KEY,
    MODE_KEY,
    IGNORED_KEY,
    TELEMETRY_KEY,
    PANEL_SNAPSHOT_KEY,
    CACHE_TTL_MS,
    MAX_HIGHLIGHT_RECTS,
    DEFAULT_SETTINGS,
    LOG_PREFIX,
    SEVERITY_WEIGHT,
    clamp,
    shortHash,
    normalizeMode,
    normalizeScope,
    normalizeTheme,
    modeToDebounce,
    modeToLabel,
    ensureArray,
    storageSyncGet,
    storageSyncSet,
    storageLocalGet,
    storageLocalSet,
    extractText,
    normalizeSeverity,
    logTrace,
  });
})();
