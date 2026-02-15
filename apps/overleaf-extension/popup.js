(() => {
  "use strict";

  const MODE_KEY = "zetaMode";
  const SETTINGS_KEY = "zetaSettings";
  const TELEMETRY_KEY = "zetaTelemetry";
  const PANEL_SNAPSHOT_KEY = "zetaPanelSnapshot";
  const FALLBACK_MODE = "auto";
  const DEFAULT_SHORTCUTS = [
    { trigger: "Ctrl/Cmd+Enter", text: "Cmd+Enter", keys: ["⌘", "↩"], label: "Run checker now" },
    { trigger: "Alt+Shift+U", text: "Option+Shift+U", keys: ["⌥", "⇧", "U"], label: "Undo last action" },
    { trigger: "Alt+Shift+N", text: "Option+Shift+N", keys: ["⌥", "⇧", "N"], label: "Focus next issue" },
    { trigger: "Alt+Shift+P", text: "Option+Shift+P", keys: ["⌥", "⇧", "P"], label: "Focus previous issue" },
    { trigger: "Alt+Shift+R", text: "Option+Shift+R", keys: ["⌥", "⇧", "R"], label: "Refresh checker" },
    { trigger: "Alt+Shift+H", text: "Option+Shift+H", keys: ["⌥", "⇧", "H"], label: "Clear activity history" },
  ];
  const MODE_COPY = {
    fast: "Fast applies immediate underlines while typing.",
    accurate: "Accurate waits briefly for more stable suggestions.",
    auto: "Auto balances speed and stability for long text.",
  };

  const buttons = Array.from(document.querySelectorAll(".zeta-mode-btn"));
  const panelNavButtons = Array.from(document.querySelectorAll(".zeta-top-nav-btn"));
  const panels = Array.from(document.querySelectorAll("[data-panel-content]"));
  const panelNav = document.querySelector(".zeta-top-nav");
  const panelNavIndicator = document.querySelector(".zeta-top-nav-indicator");
  const note = document.getElementById("zeta-mode-note");
  const toggle = document.querySelector(".zeta-mode-toggle");
  const indicator = document.querySelector(".zeta-mode-indicator");
  const inferenceValue = document.getElementById("zeta-last-inference");
  const statusLabel = document.getElementById("zeta-last-status");
  const healthFill = document.getElementById("zeta-health-fill");
  const healthLabel = document.getElementById("zeta-health-label");
  const healthStats = document.getElementById("zeta-health-stats");
  const activityCount = document.getElementById("zeta-activity-count");
  const activityList = document.getElementById("zeta-activity-list");
  const activityEmpty = document.getElementById("zeta-activity-empty");
  const macrosCount = document.getElementById("zeta-macros-count");
  const macrosList = document.getElementById("zeta-macros-list");
  const macrosEmpty = document.getElementById("zeta-macros-empty");

  let hasInitialized = false;
  let hasInitializedPanelNav = false;
  let lastAnimatedShortcutPulseId = 0;
  const nowTs = () => new Date().toISOString();

  function sendActionToActiveTab(action) {
    if (!chrome?.tabs?.query || !chrome?.tabs?.sendMessage) {
      console.warn("[zeta:popup] tabs_api_unavailable", { ts: nowTs() });
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (!activeTab?.id) {
        console.warn("[zeta:popup] no_active_tab_for_action", { ts: nowTs(), action });
        return;
      }
      console.info("[zeta:popup] sending_popup_action", { ts: nowTs(), action, tabId: activeTab.id });
      chrome.tabs.sendMessage(activeTab.id, { type: "zeta-popup-action", action }, (response) => {
        const message = chrome.runtime?.lastError?.message;
        if (message) {
          console.warn("[zeta:popup] action_delivery_failed", { ts: nowTs(), action, error: message });
        } else {
          console.info("[zeta:popup] action_delivery_ok", { ts: nowTs(), action, response: response || null });
        }
      });
    });
  }

  function shortcutMatchFromEvent(event) {
    if (!(event instanceof KeyboardEvent)) {
      return null;
    }
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "");
    const metaHeld = event.metaKey || event.getModifierState?.("Meta");
    const ctrlHeld = event.ctrlKey || event.getModifierState?.("Control");
    const altHeld = event.altKey || event.getModifierState?.("Alt");
    const shiftHeld = event.shiftKey || event.getModifierState?.("Shift");
    if ((metaHeld || ctrlHeld) && (key === "enter" || code === "Enter")) {
      return { action: "refresh-checker", trigger: "Ctrl/Cmd+Enter" };
    }
    if (altHeld && shiftHeld && (key === "n" || code === "KeyN")) {
      return { action: "next-issue", trigger: "Alt+Shift+N" };
    }
    if (altHeld && shiftHeld && (key === "p" || code === "KeyP")) {
      return { action: "prev-issue", trigger: "Alt+Shift+P" };
    }
    if (altHeld && shiftHeld && (key === "u" || code === "KeyU")) {
      return { action: "undo-last", trigger: "Alt+Shift+U" };
    }
    if (altHeld && shiftHeld && (key === "r" || code === "KeyR")) {
      return { action: "refresh-checker", trigger: "Alt+Shift+R" };
    }
    if (altHeld && shiftHeld && (key === "h" || code === "KeyH")) {
      return { action: "clear-history", trigger: "Alt+Shift+H" };
    }
    return null;
  }

  function normalizeShortcutKey(input) {
    return String(input || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/cmd\/ctrl/g, "ctrl/cmd");
  }

  function pulseShortcut(shortcut) {
    if (!macrosList) {
      return;
    }
    const key = normalizeShortcutKey(shortcut);
    if (!key) {
      return;
    }
    const row = macrosList.querySelector(`.zeta-shortcut-row[data-shortcut="${key}"]`);
    if (!row) {
      return;
    }
    row.classList.remove("is-fired");
    // Force reflow so repeated presses retrigger the animation.
    void row.offsetWidth;
    row.classList.add("is-fired");
  }

  function movePanelIndicator(panelName) {
    if (!panelNav || !panelNavIndicator) {
      return;
    }
    const activeButton = panelNavButtons.find((button) => button.dataset.panel === panelName);
    if (!activeButton) {
      return;
    }
    const navRect = panelNav.getBoundingClientRect();
    const buttonRect = activeButton.getBoundingClientRect();
    const left = buttonRect.left - navRect.left;
    panelNavIndicator.style.width = `${buttonRect.width}px`;
    panelNavIndicator.style.transform = `translateX(${left}px)`;
  }

  function setActivePanel(panelName) {
    const selected = String(panelName || "main").toLowerCase();
    for (const button of panelNavButtons) {
      const isActive = button.dataset.panel === selected;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    }
    for (const panel of panels) {
      panel.classList.toggle("is-active", panel.dataset.panelContent === selected);
    }

    movePanelIndicator(selected);
    if (!hasInitializedPanelNav) {
      if (panelNavIndicator) {
        panelNavIndicator.style.transition = "none";
        requestAnimationFrame(() => {
          panelNavIndicator.style.transition =
            "transform 260ms cubic-bezier(0.16, 1, 0.3, 1), width 260ms cubic-bezier(0.16, 1, 0.3, 1)";
        });
      }
      hasInitializedPanelNav = true;
    }
  }

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

  function renderPanelSnapshot(snapshot) {
    const data = snapshot && typeof snapshot === "object" ? snapshot : {};
    const score = Math.max(0, Math.min(100, Number(data.healthScore) || 100));
    const cached = Math.max(0, Number(data.sentenceCached) || 0);
    const pending = Math.max(0, Number(data.sentencePending) || 0);
    const activity = Array.isArray(data.activity) ? data.activity : [];
    const shortcutPulseId = Number(data.shortcutPulseId) || 0;
    const lastShortcut = String(data.lastShortcut || "");
    if (healthFill) {
      healthFill.style.width = `${Math.round(score)}%`;
    }
    if (healthLabel) {
      healthLabel.textContent = String(Math.round(score));
    }
    if (healthStats) {
      healthStats.textContent = `${cached} cached · ${pending} pending`;
    }

    if (activityCount) {
      activityCount.textContent = String(activity.length);
    }
    if (activityList) {
      activityList.replaceChildren();
      for (const entry of activity) {
        const li = document.createElement("li");
        const message = String(entry?.message || "Activity");
        const time = String(entry?.timeLabel || "");
        const strong = document.createElement("strong");
        strong.textContent = message;
        const p = document.createElement("p");
        p.textContent = time;
        li.append(strong, p);
        activityList.appendChild(li);
      }
    }
    if (activityEmpty) {
      activityEmpty.style.display = activity.length > 0 ? "none" : "block";
    }

    if (macrosCount) {
      macrosCount.textContent = `${DEFAULT_SHORTCUTS.length} shortcuts`;
    }
    if (macrosList) {
      macrosList.replaceChildren();
      for (const macro of DEFAULT_SHORTCUTS) {
        const li = document.createElement("li");
        li.className = "zeta-shortcut-row";
        li.dataset.shortcut = normalizeShortcutKey(macro.trigger);
        const left = document.createElement("div");
        left.className = "zeta-shortcut-left";
        const text = document.createElement("strong");
        text.className = "zeta-shortcut-text";
        text.textContent = macro.text;
        const label = document.createElement("span");
        label.className = "zeta-shortcut-label";
        label.textContent = macro.label;
        left.append(text, label);
        const command = document.createElement("div");
        command.className = "zeta-shortcut-kbd-wrap";
        for (const keycap of macro.keys) {
          const kbd = document.createElement("kbd");
          kbd.textContent = keycap;
          command.appendChild(kbd);
        }
        li.append(left, command);
        macrosList.appendChild(li);
      }
    }
    if (macrosEmpty) {
      macrosEmpty.style.display = DEFAULT_SHORTCUTS.length > 0 ? "none" : "block";
    }

    if (shortcutPulseId > 0 && shortcutPulseId !== lastAnimatedShortcutPulseId) {
      lastAnimatedShortcutPulseId = shortcutPulseId;
      pulseShortcut(lastShortcut);
    }
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

  for (const button of panelNavButtons) {
    button.addEventListener("click", () => {
      setActivePanel(button.dataset.panel || "main");
    });
  }

  window.addEventListener("resize", () => {
    const activePanelButton = panelNavButtons.find((button) => button.classList.contains("is-active"));
    if (activePanelButton) {
      movePanelIndicator(activePanelButton.dataset.panel || "main");
    }
    const active = buttons.find((button) => button.classList.contains("is-active"));
    if (active) {
      moveIndicator(active.dataset.mode || FALLBACK_MODE);
    }
  });

  if (document.body) {
    document.body.tabIndex = -1;
    window.setTimeout(() => document.body?.focus(), 0);
  }

  document.addEventListener("keydown", (event) => {
    console.info("[zeta:popup] keydown", {
      ts: nowTs(),
      key: event.key,
      code: event.code,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      target: event.target && event.target.constructor ? event.target.constructor.name : "unknown",
    });
    const match = shortcutMatchFromEvent(event);
    if (!match) {
      return;
    }
    console.info("[zeta:popup] shortcut_detected", {
      ts: nowTs(),
      key: event.key,
      code: event.code,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      action: match.action,
      trigger: match.trigger,
    });
    event.preventDefault();
    event.stopPropagation();
    pulseShortcut(match.trigger);
    sendActionToActiveTab(match.action);
  }, true);

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "sync" && changes[MODE_KEY]) {
        setActiveMode(normalizeMode(changes[MODE_KEY].newValue));
      }
      if (areaName === "local" && changes[TELEMETRY_KEY]) {
        renderTelemetry(changes[TELEMETRY_KEY].newValue);
      }
      if (areaName === "local" && changes[PANEL_SNAPSHOT_KEY]) {
        renderPanelSnapshot(changes[PANEL_SNAPSHOT_KEY].newValue);
      }
    });
  }

  if (typeof chrome === "undefined" || !chrome.storage?.sync) {
    setActivePanel("main");
    setActiveMode(FALLBACK_MODE);
    renderTelemetry(null);
    renderPanelSnapshot(null);
    return;
  }

  chrome.storage.sync.get({ [MODE_KEY]: FALLBACK_MODE }, (result) => {
    setActivePanel("main");
    setActiveMode(normalizeMode(result[MODE_KEY]));
  });

  if (chrome.storage?.local) {
    chrome.storage.local.get({ [TELEMETRY_KEY]: null, [PANEL_SNAPSHOT_KEY]: null }, (result) => {
      renderTelemetry(result[TELEMETRY_KEY]);
      renderPanelSnapshot(result[PANEL_SNAPSHOT_KEY]);
    });
  } else {
    renderTelemetry(null);
    renderPanelSnapshot(null);
  }
})();
