(() => {
  "use strict";

  const MODE_KEY = "zetaMode";
  const SETTINGS_KEY = "zetaSettings";
  const TELEMETRY_KEY = "zetaTelemetry";
  const FALLBACK_MODE = "auto";
  const MODE_COPY = {
    fast: "Fast applies immediate underlines while typing.",
    accurate: "Accurate waits briefly for more stable suggestions.",
    auto: "Auto balances speed and stability for long text.",
  };

  const buttons = Array.from(document.querySelectorAll(".zeta-mode-btn"));
  const note = document.getElementById("zeta-mode-note");
  const toggle = document.querySelector(".zeta-mode-toggle");
  const indicator = document.querySelector(".zeta-mode-indicator");
  const inferenceValue = document.getElementById("zeta-last-inference");
  const statusLabel = document.getElementById("zeta-last-status");

  let hasInitialized = false;

  function normalizeMode(mode) {
    if (mode === "fast" || mode === "accurate" || mode === "auto") {
      return mode;
    }
    return FALLBACK_MODE;
  }

  function moveIndicator(mode) {
    if (!toggle || !indicator) {
      return;
    }

    const activeButton = buttons.find((button) => button.dataset.mode === mode);
    if (!activeButton) {
      return;
    }

    const toggleRect = toggle.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    const left = buttonRect.left - toggleRect.left;
    indicator.style.width = `${buttonRect.width}px`;
    indicator.style.transform = `translateX(${left}px)`;
  }

  function formatStatus(status) {
    const value = String(status || "idle").toLowerCase();
    if (value === "ready") {
      return "ready";
    }
    if (value === "analyzing") {
      return "analyzing";
    }
    if (value === "error") {
      return "error";
    }
    if (value === "offline") {
      return "offline";
    }
    return "idle";
  }

  function renderTelemetry(telemetry) {
    const data = telemetry && typeof telemetry === "object" ? telemetry : {};
    const inferenceMs = Number(data.inferenceMs);
    const pendingCount = Number(data.pendingCount) || 0;
    const updatedAt = Number(data.updatedAt);

    if (inferenceValue) {
      inferenceValue.textContent = Number.isFinite(inferenceMs) ? `${Math.round(inferenceMs)} ms` : "--";
    }

    if (!statusLabel) {
      return;
    }

    const parts = [formatStatus(data.status)];
    if (pendingCount > 0) {
      parts.push(`${pendingCount} queued`);
    }
    if (Number.isFinite(updatedAt) && updatedAt > 0) {
      parts.push(
        new Date(updatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
    } else {
      parts.push("waiting for a run");
    }
    statusLabel.textContent = parts.join(" · ");
  }

  function setActiveMode(mode) {
    const normalized = normalizeMode(mode);
    for (const button of buttons) {
      const isActive = button.dataset.mode === normalized;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    }

    moveIndicator(normalized);

    if (note) {
      note.textContent = MODE_COPY[normalized];
    }

    if (!hasInitialized) {
      if (indicator) {
        indicator.style.transition = "none";
        requestAnimationFrame(() => {
          indicator.style.transition = "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), width 260ms cubic-bezier(0.16, 1, 0.3, 1)";
        });
      }
      hasInitialized = true;
    }
  }

  function persistMode(mode) {
    if (typeof chrome === "undefined" || !chrome.storage?.sync) {
      return;
    }

    const normalized = normalizeMode(mode);
    chrome.storage.sync.get({ [SETTINGS_KEY]: {} }, (result) => {
      const settings = result[SETTINGS_KEY] || {};
      settings.mode = normalized;
      chrome.storage.sync.set({
        [MODE_KEY]: normalized,
        [SETTINGS_KEY]: settings,
      });
    });
  }

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const mode = normalizeMode(button.dataset.mode);
      setActiveMode(mode);
      persistMode(mode);
    });
  }

  window.addEventListener("resize", () => {
    const active = buttons.find((button) => button.classList.contains("is-active"));
    if (active) {
      moveIndicator(active.dataset.mode || FALLBACK_MODE);
    }
  });

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync" && changes[MODE_KEY]) {
        setActiveMode(normalizeMode(changes[MODE_KEY].newValue));
      }
      if (areaName === "local" && changes[TELEMETRY_KEY]) {
        renderTelemetry(changes[TELEMETRY_KEY].newValue);
      }
    });
  }

  if (typeof chrome === "undefined" || !chrome.storage?.sync) {
    setActiveMode(FALLBACK_MODE);
    renderTelemetry(null);
    return;
  }

  chrome.storage.sync.get({ [MODE_KEY]: FALLBACK_MODE }, (result) => {
    setActiveMode(normalizeMode(result[MODE_KEY]));
  });

  if (chrome.storage?.local) {
    chrome.storage.local.get({ [TELEMETRY_KEY]: null }, (result) => {
      renderTelemetry(result[TELEMETRY_KEY]);
    });
  } else {
    renderTelemetry(null);
  }
})();
