(() => {
  "use strict";

  const MODE_KEY = "zetaMode";
  const FALLBACK_MODE = "auto";
  const MODE_COPY = {
    fast: "Fast applies immediate underlines while typing.",
    accurate: "Accurate waits briefly for more stable suggestions.",
    auto: "Auto stays fast unless the editor becomes very large.",
  };

  const buttons = Array.from(document.querySelectorAll(".zeta-mode-btn"));
  const note = document.getElementById("zeta-mode-note");
  const toggle = document.querySelector(".zeta-mode-toggle");
  const indicator = document.querySelector(".zeta-mode-indicator");

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
    chrome.storage.sync.set({ [MODE_KEY]: normalized });

    if (chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "zeta-mode-changed", mode: normalized });
    }
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

  if (typeof chrome === "undefined" || !chrome.storage?.sync) {
    setActiveMode(FALLBACK_MODE);
    return;
  }

  chrome.storage.sync.get({ [MODE_KEY]: FALLBACK_MODE }, (result) => {
    setActiveMode(normalizeMode(result[MODE_KEY]));
  });
})();
