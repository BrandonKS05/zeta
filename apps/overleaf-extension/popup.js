(() => {
  "use strict";

  const MODE_KEY = "zetaMode";
  const SETTINGS_KEY = "zetaSettings";
  const TELEMETRY_KEY = "zetaTelemetry";
  const PANEL_SNAPSHOT_KEY = "zetaPanelSnapshot";
  const CHAT_SNAPSHOT_KEY = "zetaChatSnapshot";
  const UI_SURFACE_KEY = "zetaUiSurface";
  const FALLBACK_MODE = "auto";
  const IS_EMBEDDED = new URLSearchParams(window.location.search).get("embedded") === "1";
  if (IS_EMBEDDED && document.body) {
    document.body.setAttribute("data-zeta-embedded", "1");
  }
  const DEFAULT_SHORTCUTS = [
    { trigger: "Ctrl/Cmd+Enter", text: "Cmd+Enter", keys: ["⌘", "↩"], label: "Run checker now" },
    { trigger: "Alt+Shift+M", text: "Option+Shift+M", keys: ["⌥", "⇧", "M"], label: "Manual autocomplete" },
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
  const healthTooltip = document.getElementById("zeta-health-tooltip");
  const activityCount = document.getElementById("zeta-activity-count");
  const activityList = document.getElementById("zeta-activity-list");
  const activityEmpty = document.getElementById("zeta-activity-empty");
  const macrosCount = document.getElementById("zeta-macros-count");
  const macrosList = document.getElementById("zeta-macros-list");
  const macrosEmpty = document.getElementById("zeta-macros-empty");
  const graphCount = document.getElementById("zeta-graph-count");
  const graphList = document.getElementById("zeta-graph-list");
  const graphEmpty = document.getElementById("zeta-graph-empty");
  const assistantCount = document.getElementById("zeta-assistant-count");
  const assistantThreads = document.getElementById("zeta-assistant-threads");
  const assistantThreadsEmpty = document.getElementById("zeta-assistant-threads-empty");
  const assistantMeta = document.getElementById("zeta-assistant-meta");
  const assistantMessages = document.getElementById("zeta-assistant-messages");
  const assistantMessagesEmpty = document.getElementById("zeta-assistant-messages-empty");
  const assistantForm = document.getElementById("zeta-assistant-form");
  const assistantInput = document.getElementById("zeta-assistant-input");
  const assistantSend = document.getElementById("zeta-assistant-send");
  const autocompleteEnabledToggle = document.getElementById("zeta-autocomplete-enabled-toggle");
  const backendTopKToggle = document.getElementById("zeta-autocomplete-topk-toggle");
  const backendManualToggle = document.getElementById("zeta-autocomplete-manual-toggle");
  const backendStatus = document.getElementById("zeta-backend-status");

  let hasInitialized = false;
  let hasInitializedPanelNav = false;
  let lastAnimatedShortcutPulseId = 0;
  let currentSettings = {};
  let assistantSnapshot = {
    threads: [],
    activeThreadId: null,
    updatedAt: 0,
  };
  const expandedGraphNodeIds = new Set();
  const expandedPipelineStageIds = new Set();
  const previewCache = new Map();
  let pipelineModalRoot = null;
  let pipelineModalCard = null;
  let pipelineModalTitle = null;
  let pipelineModalMeta = null;
  let pipelineModalBody = null;
  const nowTs = () => new Date().toISOString();
  const LATEX_PREVIEW_LIMIT = 160;
  const LATEX_PARSER = window.__zetaLatexParserSimple && typeof window.__zetaLatexParserSimple.parse === "function"
    ? window.__zetaLatexParserSimple
    : null;
  const MATH_COMMAND_SYMBOLS = Object.freeze({
    alpha: "alpha",
    beta: "beta",
    gamma: "gamma",
    delta: "delta",
    epsilon: "epsilon",
    theta: "theta",
    lambda: "lambda",
    mu: "mu",
    pi: "pi",
    sigma: "sigma",
    phi: "phi",
    omega: "omega",
    in: "in",
    notin: "not in",
    leq: "<=",
    geq: ">=",
    neq: "!=",
    approx: "~",
    cdot: "*",
    times: "x",
    to: "->",
    rightarrow: "->",
    leftarrow: "<-",
    iff: "<->",
    implies: "=>",
    forall: "forall",
    exists: "exists",
    sum: "sum",
    prod: "prod",
    int: "int",
    partial: "partial",
    nabla: "nabla",
    pm: "+/-",
    mp: "-/+",
    degree: "deg",
    sin: "sin",
    cos: "cos",
    tan: "tan",
    log: "log",
    ln: "ln",
    exp: "exp",
  });
  const MATH_BLACKBOARD_SYMBOLS = Object.freeze({
    n: "N",
    z: "Z",
    q: "Q",
    r: "R",
    c: "C",
    h: "H",
    p: "P",
  });
  const DROP_TEXT_COMMANDS = new Set([
    "section",
    "subsection",
    "subsubsection",
    "paragraph",
    "subparagraph",
    "part",
    "chapter",
    "title",
    "author",
    "date",
    "subtitle",
    "institute",
    "thanks",
    "dedicatory",
    "maketitle",
    "tableofcontents",
    "listoffigures",
    "listoftables",
    "listofalgorithms",
    "listoftheorems",
    "appendix",
    "frontmatter",
    "mainmatter",
    "backmatter",
    "label",
    "ref",
    "eqref",
    "pageref",
    "autoref",
    "cref",
    "crefrange",
    "cite",
    "citet",
    "citep",
    "citealt",
    "citealp",
    "url",
    "href",
    "bibliography",
    "bibliographystyle",
    "addbibresource",
    "printbibliography",
    "input",
    "include",
    "includeonly",
    "begin",
    "end",
    "newpage",
    "clearpage",
    "cleardoublepage",
    "linebreak",
    "pagebreak",
    "smallskip",
    "medskip",
    "bigskip",
    "vspace",
    "hspace",
    "left",
    "right",
    "displaystyle",
    "textstyle",
    "scriptstyle",
    "scriptscriptstyle",
  ]);
  const UNWRAP_TEXT_COMMANDS = new Set([
    "text",
    "textbf",
    "textit",
    "textrm",
    "textsf",
    "texttt",
    "emph",
    "mathbf",
    "mathit",
    "mathrm",
    "operatorname",
  ]);
  const PREVIEW_ELIGIBLE_CHUNK_TYPES = new Set(["text", "section", "environment"]);

  function publishSurface(surface) {
    if (!chrome?.storage?.local) {
      return;
    }
    try {
      chrome.storage.local.set({
        [UI_SURFACE_KEY]: {
          surface: String(surface || "").toLowerCase(),
          updatedAt: Date.now(),
        },
      }, () => {
        try {
          void chrome.runtime?.lastError;
        } catch (_error) {
          // ignore invalidated context during reload
        }
      });
    } catch (_error) {
      // ignore invalidated context during reload
    }
  }

  function notifyActiveTabSurface(surface) {
    if (!chrome?.tabs?.query || !chrome?.tabs?.sendMessage) {
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (!activeTab?.id) {
        return;
      }
      chrome.tabs.sendMessage(activeTab.id, {
        type: "zeta-ui-surface",
        surface,
      }, () => {
        // no-op; best-effort sync
      });
    });
  }

  function sendActionToActiveTab(action) {
    sendMessageToActiveTab({ type: "zeta-popup-action", action }, "popup_action", () => ({
      action,
    }));
  }

  function sendMessageToActiveTab(message, tag, extraPayloadFactory = null, onResponse = null) {
    if (!chrome?.tabs?.query || !chrome?.tabs?.sendMessage) {
      console.warn("[zeta:popup] tabs_api_unavailable", { ts: nowTs(), tag });
      if (typeof onResponse === "function") {
        onResponse(null);
      }
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (!activeTab?.id) {
        console.warn("[zeta:popup] no_active_tab", { ts: nowTs(), tag });
        if (typeof onResponse === "function") {
          onResponse(null);
        }
        return;
      }
      const extra = typeof extraPayloadFactory === "function" ? extraPayloadFactory() : null;
      console.info("[zeta:popup] sending_tab_message", {
        ts: nowTs(),
        tag,
        tabId: activeTab.id,
        ...(extra || {}),
      });
      chrome.tabs.sendMessage(activeTab.id, message, (response) => {
        const runtimeError = chrome.runtime?.lastError?.message;
        if (runtimeError) {
          console.warn("[zeta:popup] tab_message_failed", {
            ts: nowTs(),
            tag,
            error: runtimeError,
            ...(extra || {}),
          });
          if (typeof onResponse === "function") {
            onResponse(null);
          }
        } else {
          console.info("[zeta:popup] tab_message_ok", {
            ts: nowTs(),
            tag,
            ...(extra || {}),
            response: response || null,
          });
          if (typeof onResponse === "function") {
            onResponse(response || null);
          }
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
    if (altHeld && shiftHeld && (key === "m" || code === "KeyM")) {
      return { action: "manual-autocomplete", trigger: "Alt+Shift+M" };
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
    const navCount = Math.max(1, panelNavButtons.length);
    panelNav.style.setProperty("--zeta-top-nav-count", String(navCount));
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
      return "";
    }
    if (value === "error") {
      return "error";
    }
    if (value === "offline") {
      return "offline";
    }
    return "idle";
  }

  function formatInferenceDuration(valueMs) {
    const ms = Number(valueMs);
    if (!Number.isFinite(ms)) {
      return "--";
    }
    if (ms > 1000) {
      const seconds = ms / 1000;
      return `${seconds.toFixed(seconds >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")} s`;
    }
    return `${Math.round(ms)} ms`;
  }

  function truncatePipelineText(value, maxLength = 520) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength - 3)}...`;
  }

  function parseActivityKeyValueLines(lines) {
    const output = {};
    for (const line of Array.isArray(lines) ? lines : []) {
      const text = String(line || "").trim();
      if (!text) {
        continue;
      }
      const match = text.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!match) {
        continue;
      }
      output[match[1]] = String(match[2] || "").trim();
    }
    return output;
  }

  function parseActivityPipelineTrace(detailText) {
    const lines = String(detailText || "").split(/\r?\n/);
    const sections = {};
    let activeSection = "";
    for (const rawLine of lines) {
      const line = String(rawLine || "");
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (/^[A-Za-z][A-Za-z ]+$/.test(trimmed) && !trimmed.includes(":")) {
        activeSection = trimmed;
        if (!sections[activeSection]) {
          sections[activeSection] = [];
        }
        continue;
      }
      if (!activeSection) {
        continue;
      }
      sections[activeSection].push(trimmed);
    }

    const stageRegex =
      /^\s*(\d+)\.\s+(.+?)\s+·\s+(ok|failed|skipped|unknown)\s+·\s+attempted=(true|false)\s+·\s+duration_ms=([0-9.]+|--)\s*$/i;
    const stages = [];
    for (let index = 0; index < lines.length; index += 1) {
      const stageMatch = String(lines[index] || "").match(stageRegex);
      if (!stageMatch) {
        continue;
      }
      const details = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const detailLine = String(lines[cursor] || "");
        const trimmed = detailLine.trim();
        if (!trimmed) {
          continue;
        }
        if (stageRegex.test(detailLine)) {
          break;
        }
        if (/^\s*\d+\./.test(detailLine) || /^[A-Za-z][A-Za-z ]+$/.test(trimmed)) {
          break;
        }
        if (/^\s+details:\s*/.test(detailLine)) {
          details.push(detailLine.replace(/^\s+details:\s*/, "").trim());
          continue;
        }
        if (/^\s+/.test(detailLine)) {
          details.push(trimmed);
          continue;
        }
        break;
      }
      const durationRaw = String(stageMatch[5] || "--").trim();
      const durationMs = durationRaw === "--" ? null : Number(durationRaw);
      stages.push({
        index: Number(stageMatch[1]) || stages.length + 1,
        stage: String(stageMatch[2] || "").trim(),
        outcome: String(stageMatch[3] || "unknown").toLowerCase(),
        attempted: String(stageMatch[4] || "").toLowerCase() === "true",
        durationMs: Number.isFinite(durationMs) ? durationMs : null,
        details: details.join(" · "),
      });
    }

    const pipeline = parseActivityKeyValueLines(sections.Pipeline);
    const result = parseActivityKeyValueLines(sections.Result);
    const compile = parseActivityKeyValueLines(sections.Compile);
    const translator = parseActivityKeyValueLines(sections.Translator);
    const pipelineTrace = parseActivityKeyValueLines(sections["Pipeline trace"]);

    return {
      sentence: String((sections.Sentence || [])[0] || ""),
      chunk: String((sections.Chunk || [])[0] || ""),
      pipeline,
      result,
      compile,
      translator,
      pipelineTrace,
      stages,
    };
  }

  function ensurePipelineModal() {
    if (pipelineModalRoot) {
      return;
    }
    pipelineModalRoot = document.createElement("div");
    pipelineModalRoot.className = "zeta-pipeline-modal";
    pipelineModalRoot.hidden = true;
    pipelineModalRoot.innerHTML = `
      <div class="zeta-pipeline-modal-backdrop" data-close-pipeline-modal="1"></div>
      <section class="zeta-pipeline-modal-card" role="dialog" aria-modal="true" aria-label="Pipeline trace">
        <header class="zeta-pipeline-modal-head">
          <div>
            <h3 class="zeta-pipeline-modal-title"></h3>
            <p class="zeta-pipeline-modal-meta"></p>
          </div>
          <button type="button" class="zeta-pipeline-modal-close" data-close-pipeline-modal="1">Close</button>
        </header>
        <div class="zeta-pipeline-modal-body"></div>
      </section>
    `;
    document.body.appendChild(pipelineModalRoot);
    pipelineModalCard = pipelineModalRoot.querySelector(".zeta-pipeline-modal-card");
    pipelineModalTitle = pipelineModalRoot.querySelector(".zeta-pipeline-modal-title");
    pipelineModalMeta = pipelineModalRoot.querySelector(".zeta-pipeline-modal-meta");
    pipelineModalBody = pipelineModalRoot.querySelector(".zeta-pipeline-modal-body");
    if (pipelineModalCard) {
      pipelineModalCard.setAttribute("tabindex", "-1");
    }

    pipelineModalRoot.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest("[data-close-pipeline-modal]")) {
        closePipelineModal();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (String(event.key || "") !== "Escape") {
        return;
      }
      if (!pipelineModalRoot || pipelineModalRoot.hidden) {
        return;
      }
      closePipelineModal();
    });
  }

  function closePipelineModal() {
    if (!pipelineModalRoot) {
      return;
    }
    pipelineModalRoot.hidden = true;
    pipelineModalRoot.classList.remove("is-open");
  }

  function togglePipelineStage(stageId, body, toggle) {
    if (!body || !toggle) {
      return;
    }
    const nextExpanded = body.hidden;
    body.hidden = !nextExpanded;
    toggle.setAttribute("aria-expanded", String(nextExpanded));
    if (nextExpanded) {
      expandedPipelineStageIds.add(stageId);
    } else {
      expandedPipelineStageIds.delete(stageId);
    }
  }

  function renderPipelineModal(entry, parsedTrace) {
    ensurePipelineModal();
    if (!pipelineModalRoot || !pipelineModalTitle || !pipelineModalMeta || !pipelineModalBody) {
      return;
    }
    const title = String(entry?.message || "Pipeline trace");
    const time = String(entry?.timeLabel || "");
    pipelineModalTitle.textContent = title;
    pipelineModalMeta.textContent = time || "No timestamp";
    pipelineModalBody.replaceChildren();

    const summaryItems = [];
    if (parsedTrace.pipeline.url) {
      summaryItems.push(`url: ${parsedTrace.pipeline.url}`);
    }
    if (parsedTrace.pipeline.inference) {
      summaryItems.push(`inference: ${parsedTrace.pipeline.inference}`);
    } else if (parsedTrace.pipeline.inference_ms) {
      summaryItems.push(`inference_ms: ${parsedTrace.pipeline.inference_ms}`);
    }
    if (parsedTrace.result.compile_failed) {
      summaryItems.push(`compile_failed: ${parsedTrace.result.compile_failed}`);
    }
    if (parsedTrace.result.semantic_failed) {
      summaryItems.push(`semantic_failed: ${parsedTrace.result.semantic_failed}`);
    }
    if (parsedTrace.chunk) {
      summaryItems.push(`chunk: ${parsedTrace.chunk}`);
    }
    if (parsedTrace.sentence) {
      summaryItems.push(`sentence: ${truncatePipelineText(parsedTrace.sentence, 220)}`);
    }

    if (summaryItems.length > 0) {
      const summary = document.createElement("p");
      summary.className = "zeta-pipeline-summary";
      summary.textContent = summaryItems.join(" · ");
      pipelineModalBody.appendChild(summary);
    }

    if (!Array.isArray(parsedTrace.stages) || parsedTrace.stages.length === 0) {
      const empty = document.createElement("p");
      empty.className = "zeta-hint";
      empty.textContent = "No structured pipeline stages were found for this activity.";
      pipelineModalBody.appendChild(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "zeta-pipeline-stage-list";
    const traceKey = `${title}|${time}|${parsedTrace.chunk}`;
    for (let index = 0; index < parsedTrace.stages.length; index += 1) {
      const stage = parsedTrace.stages[index];
      const stageId = `${traceKey}|${stage.index}|${stage.stage}`;
      const card = document.createElement("article");
      card.className = `zeta-pipeline-stage zeta-pipeline-stage--${stage.outcome || "unknown"}`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "zeta-pipeline-stage-toggle";
      toggle.setAttribute("aria-expanded", "false");
      const name = document.createElement("strong");
      name.className = "zeta-pipeline-stage-name";
      name.textContent = `${stage.index}. ${stage.stage}`;
      const meta = document.createElement("span");
      meta.className = "zeta-pipeline-stage-meta";
      const durationLabel = Number.isFinite(Number(stage.durationMs))
        ? formatInferenceDuration(Number(stage.durationMs))
        : "--";
      meta.textContent = `${stage.outcome || "unknown"} · attempted=${stage.attempted ? "true" : "false"} · ${durationLabel}`;
      toggle.append(name, meta);

      const body = document.createElement("div");
      body.className = "zeta-pipeline-stage-body";
      body.hidden = true;
      const details = document.createElement("p");
      details.className = "zeta-pipeline-stage-details";
      details.textContent = truncatePipelineText(stage.details || "No stage details available.", 800);
      body.appendChild(details);

      const isExpanded = expandedPipelineStageIds.has(stageId) || index === 0;
      if (isExpanded) {
        body.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        expandedPipelineStageIds.add(stageId);
      }
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePipelineStage(stageId, body, toggle);
      });

      card.append(toggle, body);
      list.appendChild(card);
    }

    pipelineModalBody.appendChild(list);
  }

  function openPipelineModal(entry, detailText) {
    const parsedTrace = parseActivityPipelineTrace(detailText);
    renderPipelineModal(entry, parsedTrace);
    if (!pipelineModalRoot || !pipelineModalCard) {
      return;
    }
    pipelineModalRoot.hidden = false;
    requestAnimationFrame(() => {
      pipelineModalRoot.classList.add("is-open");
      pipelineModalCard.focus();
    });
  }

  function renderTelemetry(telemetry) {
    let snapshotData;
    try {
      snapshotData = telemetry && typeof telemetry === "object" ? telemetry : {};
    } catch (_error) {
      snapshotData = {};
    }
    const inferenceMs = Number(snapshotData.inferenceMs);
    const pendingCount = Number(snapshotData.pendingCount) || 0;
    const updatedAt = Number(snapshotData.updatedAt);

    if (inferenceValue) {
      inferenceValue.textContent = formatInferenceDuration(inferenceMs);
    }

    if (!statusLabel) {
      return;
    }

    const parts = [];
    const statusPart = formatStatus(snapshotData.status);
    if (statusPart) {
      parts.push(statusPart);
    }
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
    let snapshotData;
    try {
      snapshotData = snapshot && typeof snapshot === "object" ? snapshot : {};
    } catch (_error) {
      snapshotData = {};
    }
    const score = Math.max(0, Math.min(100, Number(snapshotData.healthScore) || 100));
    const breakdown = snapshotData.healthBreakdown && typeof snapshotData.healthBreakdown === "object"
      ? snapshotData.healthBreakdown
      : null;
    const cached = Math.max(0, Number(snapshotData.sentenceCached) || 0);
    const pending = Math.max(0, Number(snapshotData.sentencePending) || 0);
    const activity = Array.isArray(snapshotData.activity) ? snapshotData.activity : [];
    const chunkTree = snapshotData.chunkTree && typeof snapshotData.chunkTree === "object"
      ? snapshotData.chunkTree
      : null;
    const activeChunkId = String(snapshotData.activeChunkId || chunkTree?.activeChunkId || "");
    const snapshotShortcutPulseId = Number(snapshotData.shortcutPulseId) || 0;
    const snapshotLastShortcut = String(snapshotData.lastShortcut || "");
    if (healthFill) {
      healthFill.style.width = `${Math.round(score)}%`;
    }
    if (healthLabel) {
      healthLabel.textContent = String(Math.round(score));
    }
    if (healthStats) {
      healthStats.textContent = `${cached} cached · ${pending} pending`;
    }
    renderHealthTooltip(score, breakdown, cached, pending);

    if (activityCount) {
      activityCount.textContent = `${activity.length} item${activity.length === 1 ? "" : "s"}`;
    }
    if (activityList) {
      activityList.replaceChildren();
      for (let activityIndex = 0; activityIndex < activity.length; activityIndex += 1) {
        const entry = activity[activityIndex];
        const li = document.createElement("li");
        li.className = "zeta-activity-row";
        const message = String(entry?.message || "Activity");
        const time = String(entry?.timeLabel || "");
        const detailText = String(entry?.detailText || "").trim();
        const parsedPipeline = detailText ? parseActivityPipelineTrace(detailText) : null;
        const hasPipelineStages = !!(parsedPipeline && Array.isArray(parsedPipeline.stages) && parsedPipeline.stages.length > 0);
        const head = document.createElement("div");
        head.className = "zeta-activity-head";
        const strong = document.createElement("strong");
        strong.className = "zeta-activity-title";
        strong.textContent = message;
        const stamp = document.createElement("span");
        stamp.className = "zeta-activity-time";
        stamp.textContent = time;
        head.append(strong, stamp);
        li.append(head);
        if (!detailText) {
          li.classList.add("is-compact");
        }
        if (detailText) {
          const actions = document.createElement("div");
          actions.className = "zeta-activity-actions";
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "zeta-activity-toggle";
          toggle.textContent = "View output";
          const pre = document.createElement("pre");
          pre.className = "zeta-activity-detail";
          pre.textContent = detailText;
          pre.hidden = true;
          const toggleExpanded = () => {
            const expanded = pre.hidden;
            pre.hidden = !expanded;
            toggle.textContent = expanded ? "Hide output" : "View output";
            li.classList.toggle("is-expanded", expanded);
          };
          toggle.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleExpanded();
          });
          actions.appendChild(toggle);
          if (hasPipelineStages) {
            const pipelineButton = document.createElement("button");
            pipelineButton.type = "button";
            pipelineButton.className = "zeta-activity-toggle zeta-activity-pipeline-btn";
            pipelineButton.textContent = "View pipeline";
            pipelineButton.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              openPipelineModal({
                message,
                timeLabel: time,
                index: activityIndex,
              }, detailText);
            });
            actions.appendChild(pipelineButton);
          }
          li.addEventListener("click", (event) => {
            const target = event.target;
            if (
              target instanceof Element
              && target.closest(".zeta-activity-detail, .zeta-activity-actions, .zeta-activity-toggle")
            ) {
              return;
            }
            toggleExpanded();
          });
          li.append(actions, pre);
        }
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

    renderGraphTree(chunkTree, activeChunkId);

    if (
      Number.isFinite(snapshotShortcutPulseId) &&
      snapshotShortcutPulseId > 0 &&
      snapshotShortcutPulseId !== lastAnimatedShortcutPulseId
    ) {
      lastAnimatedShortcutPulseId = snapshotShortcutPulseId;
      pulseShortcut(snapshotLastShortcut);
    }
  }

  function normalizeAssistantSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return {
        threads: [],
        activeThreadId: null,
        updatedAt: 0,
      };
    }
    const threads = Array.isArray(snapshot.threads)
      ? snapshot.threads
          .map((thread) => {
            if (!thread || typeof thread !== "object") {
              return null;
            }
            const messages = Array.isArray(thread.messages)
              ? thread.messages
                  .map((message) => {
                    if (!message || typeof message !== "object") {
                      return null;
                    }
                    const role = message.role === "assistant" ? "assistant" : "user";
                    const text = String(message.text || "").trim();
                    if (!text) {
                      return null;
                    }
                    return {
                      role,
                      text,
                      createdAt: Number(message.createdAt) || 0,
                      error: !!message.error,
                    };
                  })
                  .filter(Boolean)
              : [];
            return {
              id: String(thread.id || "").trim(),
              title: String(thread.title || "Issue thread"),
              severity: String(thread.severity || "unknown"),
              status: String(thread.status || "idle"),
              updatedAt: Number(thread.updatedAt) || 0,
              isActiveIssue: thread.isActiveIssue !== false,
              issueMessage: String(thread.issueMessage || ""),
              sentenceText: String(thread.sentenceText || ""),
              messages,
              lastSource: String(thread.lastSource || ""),
              lastLatencyMs: Number(thread.lastLatencyMs) || 0,
              lastError: String(thread.lastError || ""),
            };
          })
          .filter((thread) => thread && thread.id)
      : [];
    const activeThreadId = String(snapshot.activeThreadId || "");
    return {
      threads,
      activeThreadId: activeThreadId || (threads[0]?.id || null),
      updatedAt: Number(snapshot.updatedAt) || 0,
    };
  }

  function formatAssistantMeta(thread) {
    if (!thread) {
      return "Select an issue thread.";
    }
    const parts = [];
    parts.push(`${thread.severity || "unknown"}`);
    if (thread.status) {
      parts.push(thread.status);
    }
    if (thread.lastSource) {
      parts.push(thread.lastSource);
    }
    if (Number.isFinite(thread.lastLatencyMs) && thread.lastLatencyMs > 0) {
      parts.push(`${Math.round(thread.lastLatencyMs)} ms`);
    }
    if (thread.lastError) {
      parts.push("last request failed");
    }
    return parts.join(" · ");
  }

  function setAssistantActiveThread(threadId, notifyTab = false) {
    const id = String(threadId || "").trim();
    if (!id) {
      assistantSnapshot = {
        ...assistantSnapshot,
        activeThreadId: null,
      };
      renderAssistantSnapshot(assistantSnapshot);
      return;
    }
    assistantSnapshot = {
      ...assistantSnapshot,
      activeThreadId: id,
    };
    renderAssistantSnapshot(assistantSnapshot);
    if (notifyTab) {
      sendMessageToActiveTab(
        {
          type: "zeta-chat-open-thread",
          threadId: id,
        },
        "chat_open_thread",
        () => ({ threadId: id })
      );
    }
  }

  function renderAssistantSnapshot(snapshot) {
    const normalized = normalizeAssistantSnapshot(snapshot);
    assistantSnapshot = normalized;
    const threads = normalized.threads;
    const activeThreadId = normalized.activeThreadId || null;
    const activeThread = threads.find((thread) => thread.id === activeThreadId) || null;

    if (assistantCount) {
      assistantCount.textContent = `${threads.length} threads`;
    }

    if (assistantThreads) {
      assistantThreads.replaceChildren();
      for (const thread of threads) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "zeta-assistant-thread";
        if (thread.id === activeThreadId) {
          btn.classList.add("is-active");
        }
        const title = document.createElement("strong");
        title.className = "zeta-assistant-thread-title";
        title.textContent = thread.title;
        const meta = document.createElement("p");
        meta.className = "zeta-assistant-thread-meta";
        meta.textContent = `${thread.severity || "unknown"} · ${thread.status || "idle"}`;
        btn.append(title, meta);
        btn.addEventListener("click", () => {
          setAssistantActiveThread(thread.id, true);
        });
        li.appendChild(btn);
        assistantThreads.appendChild(li);
      }
    }
    if (assistantThreadsEmpty) {
      assistantThreadsEmpty.style.display = threads.length > 0 ? "none" : "block";
    }

    if (assistantMeta) {
      assistantMeta.textContent = activeThread ? formatAssistantMeta(activeThread) : "Select an issue thread.";
    }

    if (assistantMessages) {
      assistantMessages.replaceChildren();
      const messages = Array.isArray(activeThread?.messages) ? activeThread.messages : [];
      for (const message of messages) {
        const li = document.createElement("li");
        li.className = `zeta-assistant-message zeta-assistant-message--${message.role}`;
        if (message.error) {
          li.classList.add("zeta-assistant-message--error");
        }
        const who = document.createElement("strong");
        who.textContent = message.role === "assistant" ? "Zeta" : "You";
        const body = document.createElement("p");
        body.textContent = message.text;
        li.append(who, body);
        assistantMessages.appendChild(li);
      }
      if (messages.length > 0) {
        assistantMessages.scrollTop = assistantMessages.scrollHeight;
      }
    }

    if (assistantMessagesEmpty) {
      const hasMessages = Array.isArray(activeThread?.messages) && activeThread.messages.length > 0;
      assistantMessagesEmpty.style.display = hasMessages ? "none" : "block";
    }

    if (assistantInput) {
      assistantInput.disabled = !activeThread;
      if (activeThread) {
        assistantInput.placeholder = "Ask why this error exists...";
      } else {
        assistantInput.placeholder = "Select a thread first.";
      }
    }
    if (assistantSend) {
      assistantSend.disabled = !activeThread;
    }
  }

  function sendAssistantPrompt() {
    const threadId = String(assistantSnapshot.activeThreadId || "");
    const text = String(assistantInput?.value || "").trim();
    if (!threadId || !text) {
      return;
    }

    if (assistantSend) {
      assistantSend.disabled = true;
    }
    if (assistantInput) {
      assistantInput.value = "";
    }

    sendMessageToActiveTab(
      {
        type: "zeta-chat-send",
        threadId,
        message: text,
      },
      "chat_send",
      () => ({ threadId, chars: text.length }),
      (response) => {
        if (assistantSend) {
          assistantSend.disabled = false;
        }
        if (!response?.ok && assistantMeta) {
          assistantMeta.textContent = "Could not reach Overleaf tab. Focus the Overleaf editor tab and try again.";
        }
      }
    );
  }

  function graphLabel(chunk) {
    const type = String(chunk?.type || "text");
    if (type === "document") {
      return "Document | Full Scope";
    }
    if (type === "section") {
      const name = String(chunk?.sectionName || "section");
      const title = String(chunk?.sectionTitle || "").trim();
      const sectionKind = name ? `${name[0].toUpperCase()}${name.slice(1)}` : "Section";
      return title ? `${sectionKind} | ${title}` : `${sectionKind} | Untitled`;
    }
    if (type === "environment") {
      return String(chunk?.envName || "environment");
    }
    if (type === "command") {
      return String(chunk?.commandName || "command");
    }
    return "Text";
  }

  function renderHealthTooltip(score, breakdown, cached, pending) {
    if (!healthTooltip) {
      return;
    }
    const details = breakdown && typeof breakdown === "object" ? breakdown : null;
    if (!details) {
      healthTooltip.textContent = [
        "Health score formula:",
        "100 - severity penalty - density penalty - pending penalty.",
      ].join("\n");
      return;
    }

    const counts = details.severityCounts && typeof details.severityCounts === "object"
      ? details.severityCounts
      : {};
    const issueCount = Math.max(0, Number(details.issueCount) || 0);
    const severityPenalty = Math.max(0, Number(details.normalizedSeverityPenalty) || 0);
    const densityPenalty = Math.max(0, Number(details.densityPenalty) || 0);
    const pendingPenalty = Math.max(0, Number(details.pendingPenalty) || 0);
    const analyzedSentences = Math.max(
      0,
      Number(details.analyzedSentences) || (Math.max(0, cached) + Math.max(0, pending))
    );
    const coverageRatio = Number.isFinite(Number(details.coverageRatio))
      ? Number(details.coverageRatio)
      : analyzedSentences > 0
        ? Math.max(0, cached) / analyzedSentences
        : 1;
    const coveragePct = Math.max(0, Math.min(100, Math.round(coverageRatio * 100)));

    healthTooltip.textContent = [
      `Health score = 100 - severity(${severityPenalty}) - density(${densityPenalty}) - pending(${pendingPenalty}) = ${Math.round(score)}`,
      "",
      `Issues: ${issueCount} total`,
      `error ${Number(counts.error) || 0} · warning ${Number(counts.warning) || 0} · info ${Number(counts.info) || 0} · unknown ${Number(counts.unknown) || 0}`,
      "",
      `Coverage: ${Math.max(0, cached)} cached / ${analyzedSentences} analyzed (${coveragePct}%)`,
      `Pending queue: ${Math.max(0, pending)}`,
    ].join("\n");
  }

  function normalizePreviewSpacing(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  function truncatePreview(value) {
    const normalized = normalizePreviewSpacing(value);
    if (!normalized) {
      return "";
    }
    if (normalized.length <= LATEX_PREVIEW_LIMIT) {
      return normalized;
    }
    return `${normalized.slice(0, LATEX_PREVIEW_LIMIT - 3).trim()}...`;
  }

  function flattenNodeList(nodes, inMathMode = false) {
    if (!Array.isArray(nodes)) {
      return "";
    }
    return nodes
      .map((node) => flattenLatexNode(node, inMathMode))
      .join(" ");
  }

  function flattenCommandNode(node, inMathMode = false) {
    const name = String(node?.name || "").toLowerCase();
    const args = Array.isArray(node?.args) ? node.args : [];
    const argText = args.map((arg) => flattenLatexNode(arg, inMathMode)).join(" ");

    if (inMathMode) {
      if (name === "frac") {
        const top = flattenLatexNode(args[0], true);
        const bottom = flattenLatexNode(args[1], true);
        if (top || bottom) {
          return `${top}/${bottom}`;
        }
      }
      if (name === "sqrt") {
        const body = flattenLatexNode(args[0], true);
        return body ? `sqrt(${body})` : "sqrt";
      }
      if (name === "mathbb") {
        const key = normalizePreviewSpacing(flattenLatexNode(args[0], true)).toLowerCase();
        if (key && MATH_BLACKBOARD_SYMBOLS[key]) {
          return MATH_BLACKBOARD_SYMBOLS[key];
        }
        return key ? key.toUpperCase() : "";
      }
      if (MATH_COMMAND_SYMBOLS[name]) {
        return MATH_COMMAND_SYMBOLS[name];
      }
    }

    if (DROP_TEXT_COMMANDS.has(name)) {
      return "";
    }
    if (UNWRAP_TEXT_COMMANDS.has(name)) {
      return argText;
    }
    if (argText) {
      return argText;
    }
    return "";
  }

  function flattenLatexNode(node, inMathMode = false) {
    if (!node || typeof node !== "object") {
      return "";
    }

    const kind = String(node.kind || "");
    if (kind === "text.string" || kind === "math.character") {
      return String(node.content || "");
    }
    if (kind === "space" || kind === "linebreak" || kind === "parbreak") {
      return " ";
    }
    if (kind === "arg.group" || kind === "arg.optional") {
      return flattenNodeList(node.content, inMathMode);
    }
    if (kind === "inlineMath" || kind === "displayMath") {
      return flattenNodeList(node.content, true);
    }
    if (kind === "superscript") {
      const value = normalizePreviewSpacing(flattenLatexNode(node.arg, true));
      return value ? `^${value}` : "";
    }
    if (kind === "subscript") {
      const value = normalizePreviewSpacing(flattenLatexNode(node.arg, true));
      return value ? `_${value}` : "";
    }
    if (kind === "command") {
      return flattenCommandNode(node, inMathMode);
    }
    if (Array.isArray(node.content)) {
      return flattenNodeList(node.content, inMathMode);
    }
    if (node.arg) {
      return flattenLatexNode(node.arg, inMathMode);
    }
    return "";
  }

  function extractPreviewWithParser(source) {
    if (!LATEX_PARSER || !source) {
      return "";
    }
    try {
      const ast = LATEX_PARSER.parse(source);
      const fromAst = flattenLatexNode(ast, false);
      return normalizePreviewSpacing(fromAst);
    } catch (_error) {
      return "";
    }
  }

  function extractPreviewWithFallback(source) {
    if (!source) {
      return "";
    }
    let text = String(source || "");
    text = text.replace(
      /\\(?:begin|end|section|subsection|subsubsection|paragraph|subparagraph|part|chapter|title|author|date|subtitle|institute|thanks|dedicatory|label|ref|eqref|pageref|autoref|cref|cite|citet|citep|citealt|citealp)\*?(?:\s*\[[^\]]*\])?(?:\s*\{[^{}]*\})?/g,
      " "
    );
    text = text.replace(/\\mathbb\s*\{\s*([A-Za-z])\s*\}/g, (_, letter) => {
      const key = String(letter || "").toLowerCase();
      return MATH_BLACKBOARD_SYMBOLS[key] || String(letter || "").toUpperCase();
    });
    for (const [command, replacement] of Object.entries(MATH_COMMAND_SYMBOLS)) {
      text = text.replace(new RegExp(`\\\\${command}\\b`, "g"), ` ${replacement} `);
    }
    text = text
      .replace(/\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])?/g, " ")
      .replace(/[{}]/g, " ")
      .replace(/%[^\n]*/g, " ");
    return normalizePreviewSpacing(text);
  }

  function graphPreviewText(chunk) {
    const candidates = [];
    if (typeof chunk?.text === "string") {
      candidates.push(chunk.text);
    }
    if (Array.isArray(chunk?.sentences)) {
      candidates.push(
        chunk.sentences
          .map((sentence) => String(sentence?.text || "").trim())
          .filter(Boolean)
          .join(" ")
      );
    }

    const raw = candidates.find((value) => String(value || "").trim()) || "";
    if (!raw) {
      return "";
    }

    const cacheKey = `${String(chunk?.chunkId || "")}|${raw}`;
    const cached = previewCache.get(cacheKey);
    if (typeof cached === "string") {
      return cached;
    }
    if (previewCache.size > 500) {
      previewCache.clear();
    }

    const parsedPreview = extractPreviewWithParser(raw);
    const fallbackPreview = parsedPreview ? "" : extractPreviewWithFallback(raw);
    const preview = truncatePreview(parsedPreview || fallbackPreview);
    previewCache.set(cacheKey, preview);
    return preview;
  }

  function renderGraphTree(chunkTree, activeChunkId) {
    if (!graphList || !graphCount || !graphEmpty) {
      return;
    }

    graphList.replaceChildren();
    const rawChunks = Array.isArray(chunkTree?.chunks) ? chunkTree.chunks.slice() : [];
    const rawById = new Map(
      rawChunks
        .map((chunk) => [String(chunk?.chunkId || ""), chunk])
        .filter(([chunkId]) => !!chunkId)
    );
    // Hide command-only chunks (e.g. \maketitle, \title, \newpage) from the visual tree.
    const hiddenCommandIds = new Set(
      rawChunks
        .filter((chunk) => String(chunk?.type || "") === "command")
        .map((chunk) => String(chunk?.chunkId || ""))
        .filter(Boolean)
    );
    const chunks = rawChunks.filter((chunk) => !hiddenCommandIds.has(String(chunk?.chunkId || "")));
    if (chunks.length === 0) {
      expandedGraphNodeIds.clear();
      graphCount.textContent = "0 nodes";
      graphEmpty.style.display = "block";
      return;
    }

    chunks.sort((a, b) => (Number(a?.start) || 0) - (Number(b?.start) || 0));
    const byParent = new Map();
    const byId = new Map();
    const rootId = "__root__";
    const resolveVisibleParentId = (parentId) => {
      let cursorId = parentId ? String(parentId) : null;
      while (cursorId && hiddenCommandIds.has(cursorId)) {
        const hiddenChunk = rawById.get(cursorId);
        cursorId = hiddenChunk?.parentId ? String(hiddenChunk.parentId) : null;
      }
      return cursorId;
    };
    const addChild = (parentId, chunk) => {
      const key = resolveVisibleParentId(parentId) || rootId;
      const bucket = byParent.get(key) || [];
      bucket.push(chunk);
      byParent.set(key, bucket);
      if (chunk?.chunkId) {
        byId.set(String(chunk.chunkId), chunk);
      }
    };
    for (const chunk of chunks) {
      addChild(chunk?.parentId, chunk);
    }
    for (const bucket of byParent.values()) {
      bucket.sort((a, b) => (Number(a?.start) || 0) - (Number(b?.start) || 0));
    }

    const activePath = new Set();
    let cursorId = activeChunkId ? String(activeChunkId) : null;
    while (cursorId && !byId.has(cursorId)) {
      const rawChunk = rawById.get(cursorId);
      let parentId = rawChunk?.parentId ? String(rawChunk.parentId) : null;
      parentId = resolveVisibleParentId(parentId);
      cursorId = parentId;
    }
    while (cursorId) {
      activePath.add(cursorId);
      const cursorChunk = byId.get(cursorId) || rawById.get(cursorId);
      const parentId = resolveVisibleParentId(cursorChunk?.parentId ? String(cursorChunk.parentId) : null);
      cursorId = parentId && byId.has(parentId) ? parentId : null;
    }

    const buildNodes = (parentId, depth) => {
      const children = byParent.get(parentId || rootId) || [];
      const list = depth === 0 ? document.createDocumentFragment() : document.createElement("ul");
      if (depth > 0) {
        list.className = "zeta-graph-children";
      }
      for (const chunk of children) {
        const chunkId = String(chunk?.chunkId || "");
        const childList = buildNodes(chunkId, depth + 1);
        const isInnermost = childList.childElementCount === 0;
        const li = document.createElement("li");
        li.className = "zeta-graph-node";
        li.dataset.chunkId = chunkId;
        if (activeChunkId && chunkId === activeChunkId) {
          li.classList.add("is-active");
        }

        const head = document.createElement("button");
        head.type = "button";
        head.className = "zeta-graph-head";
        head.setAttribute("aria-expanded", "false");

        const title = document.createElement("strong");
        title.className = "zeta-graph-title";
        title.textContent = graphLabel(chunk);

        const meta = document.createElement("span");
        meta.className = "zeta-graph-meta";
        const start = Number.isInteger(chunk?.start) ? chunk.start : 0;
        const end = Number.isInteger(chunk?.end) ? chunk.end : 0;
        const type = String(chunk?.type || "text");
        meta.textContent = `${type} · ${start}-${end}`;

        head.append(title, meta);
        li.appendChild(head);

        const body = document.createElement("div");
        body.className = "zeta-graph-body";
        if (isInnermost && PREVIEW_ELIGIBLE_CHUNK_TYPES.has(String(chunk?.type || "text"))) {
          const previewText = graphPreviewText(chunk);
          if (previewText) {
            const preview = document.createElement("p");
            preview.className = "zeta-graph-preview";
            preview.textContent = previewText;
            body.append(preview);
          }
        }
        if (body.childElementCount > 0) {
          li.appendChild(body);
        }

        if (childList.childElementCount > 0) {
          li.appendChild(childList);
        }

        const shouldExpand = depth === 0 || activePath.has(chunkId) || expandedGraphNodeIds.has(chunkId);
        if (shouldExpand) {
          li.classList.add("is-expanded");
          head.setAttribute("aria-expanded", "true");
          expandedGraphNodeIds.add(chunkId);
        }

        head.addEventListener("click", () => {
          const expanded = li.classList.toggle("is-expanded");
          head.setAttribute("aria-expanded", expanded ? "true" : "false");
          if (expanded) {
            expandedGraphNodeIds.add(chunkId);
          } else {
            expandedGraphNodeIds.delete(chunkId);
          }
        });

        list.appendChild(li);
      }
      return list;
    };

    const tree = buildNodes(rootId, 0);
    graphList.appendChild(tree);
    graphCount.textContent = `${chunks.length} nodes`;
    graphEmpty.style.display = graphList.children.length > 0 ? "none" : "block";
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

  function renderBackendStatus(message, tone = "muted") {
    if (!backendStatus) {
      return;
    }
    backendStatus.classList.remove("is-ok", "is-error");
    if (tone === "ok") {
      backendStatus.classList.add("is-ok");
    } else if (tone === "error") {
      backendStatus.classList.add("is-error");
    }
    backendStatus.textContent = String(message || "").trim();
  }

  function applySettingsToBackendControls(settings) {
    const nextSettings = settings && typeof settings === "object" ? settings : {};
    currentSettings = { ...nextSettings };
    if (autocompleteEnabledToggle) {
      autocompleteEnabledToggle.checked = nextSettings.autocompleteEnabled !== false;
    }
    if (backendTopKToggle) {
      backendTopKToggle.checked = nextSettings.autocompleteShowTopK === true;
    }
    if (backendManualToggle) {
      backendManualToggle.checked = nextSettings.autocompleteManualTrigger === true;
    }
  }

  function persistAutocompleteEnabledSetting() {
    if (!autocompleteEnabledToggle || typeof chrome === "undefined" || !chrome.storage?.sync) {
      return;
    }
    const enabled = autocompleteEnabledToggle.checked !== false;
    chrome.storage.sync.get({ [SETTINGS_KEY]: {} }, (result) => {
      const settings = result[SETTINGS_KEY] && typeof result[SETTINGS_KEY] === "object"
        ? result[SETTINGS_KEY]
        : {};
      if ((settings.autocompleteEnabled !== false) === enabled) {
        return;
      }
      const nextSettings = {
        ...settings,
        autocompleteEnabled: enabled,
      };
      chrome.storage.sync.set({ [SETTINGS_KEY]: nextSettings }, () => {
        const runtimeError = chrome.runtime?.lastError?.message;
        if (runtimeError) {
          renderBackendStatus(`Save failed: ${runtimeError}`, "error");
          return;
        }
        currentSettings = { ...nextSettings };
        renderBackendStatus(enabled ? "Autocomplete enabled." : "Autocomplete disabled.", "ok");
      });
    });
  }

  function persistAutocompleteTopKSetting() {
    if (!backendTopKToggle || typeof chrome === "undefined" || !chrome.storage?.sync) {
      return;
    }
    const enabled = backendTopKToggle.checked === true;
    chrome.storage.sync.get({ [SETTINGS_KEY]: {} }, (result) => {
      const settings = result[SETTINGS_KEY] && typeof result[SETTINGS_KEY] === "object"
        ? result[SETTINGS_KEY]
        : {};
      if (settings.autocompleteShowTopK === enabled) {
        return;
      }
      const nextSettings = {
        ...settings,
        autocompleteShowTopK: enabled,
      };
      chrome.storage.sync.set({ [SETTINGS_KEY]: nextSettings }, () => {
        const runtimeError = chrome.runtime?.lastError?.message;
        if (runtimeError) {
          renderBackendStatus(`Save failed: ${runtimeError}`, "error");
          return;
        }
        currentSettings = { ...nextSettings };
        renderBackendStatus(
          enabled ? "Top-K autocomplete list enabled." : "Top-K autocomplete list disabled (inline ghost mode).",
          "ok"
        );
      });
    });
  }

  function persistAutocompleteManualSetting() {
    if (!backendManualToggle || typeof chrome === "undefined" || !chrome.storage?.sync) {
      return;
    }
    const enabled = backendManualToggle.checked === true;
    chrome.storage.sync.get({ [SETTINGS_KEY]: {} }, (result) => {
      const settings = result[SETTINGS_KEY] && typeof result[SETTINGS_KEY] === "object"
        ? result[SETTINGS_KEY]
        : {};
      if (settings.autocompleteManualTrigger === enabled) {
        return;
      }
      const nextSettings = {
        ...settings,
        autocompleteManualTrigger: enabled,
      };
      chrome.storage.sync.set({ [SETTINGS_KEY]: nextSettings }, () => {
        const runtimeError = chrome.runtime?.lastError?.message;
        if (runtimeError) {
          renderBackendStatus(`Save failed: ${runtimeError}`, "error");
          return;
        }
        currentSettings = { ...nextSettings };
        renderBackendStatus(
          enabled
            ? "Manual autocomplete enabled. Use Alt+Shift+M to request suggestions."
            : "Autocomplete will run automatically while typing.",
          "ok"
        );
      });
    });
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

  if (assistantForm) {
    assistantForm.addEventListener("submit", (event) => {
      event.preventDefault();
      sendAssistantPrompt();
    });
  }

  if (autocompleteEnabledToggle) {
    autocompleteEnabledToggle.addEventListener("change", () => {
      persistAutocompleteEnabledSetting();
    });
  }

  if (backendTopKToggle) {
    backendTopKToggle.addEventListener("change", () => {
      persistAutocompleteTopKSetting();
    });
  }

  if (backendManualToggle) {
    backendManualToggle.addEventListener("change", () => {
      persistAutocompleteManualSetting();
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
      try {
      if (areaName === "sync" && changes[MODE_KEY]) {
        setActiveMode(normalizeMode(changes[MODE_KEY].newValue));
      }
      if (areaName === "sync" && changes[SETTINGS_KEY]) {
        const nextSettings = changes[SETTINGS_KEY].newValue;
        applySettingsToBackendControls(nextSettings);
        renderBackendStatus("Autocomplete settings synced.", "ok");
        if (nextSettings && typeof nextSettings === "object" && typeof nextSettings.mode === "string") {
          setActiveMode(normalizeMode(nextSettings.mode));
        }
      }
      if (areaName === "local" && changes[UI_SURFACE_KEY] && !IS_EMBEDDED) {
        const nextSurface = String(changes[UI_SURFACE_KEY].newValue?.surface || "").toLowerCase();
        if (nextSurface === "side") {
          window.close();
          return;
        }
      }
      if (areaName === "local" && changes[TELEMETRY_KEY]) {
        renderTelemetry(changes[TELEMETRY_KEY].newValue);
      }
      if (areaName === "local" && changes[PANEL_SNAPSHOT_KEY]) {
        renderPanelSnapshot(changes[PANEL_SNAPSHOT_KEY].newValue);
      }
      if (areaName === "local" && changes[CHAT_SNAPSHOT_KEY]) {
        renderAssistantSnapshot(changes[CHAT_SNAPSHOT_KEY].newValue);
      }
      } catch (error) {
        console.warn("[zeta:popup] storage_change_render_error", {
          ts: nowTs(),
          message: String(error?.message || error),
        });
      }
    });
  }

  if (typeof chrome === "undefined" || !chrome.storage?.sync) {
    setActivePanel("main");
    setActiveMode(FALLBACK_MODE);
    applySettingsToBackendControls({});
    renderBackendStatus("Running without sync storage; autocomplete settings are local-only.", "error");
    renderTelemetry(null);
    renderPanelSnapshot(null);
    renderAssistantSnapshot(null);
    return;
  }

  if (!IS_EMBEDDED) {
    publishSurface("popup");
    notifyActiveTabSurface("popup");
    window.addEventListener("beforeunload", () => publishSurface("none"));
  }

  chrome.storage.sync.get({ [MODE_KEY]: FALLBACK_MODE, [SETTINGS_KEY]: {} }, (result) => {
    const settings = result[SETTINGS_KEY] && typeof result[SETTINGS_KEY] === "object"
      ? result[SETTINGS_KEY]
      : {};
    const modeFromSettings = typeof settings.mode === "string" ? settings.mode : result[MODE_KEY];
    setActivePanel("main");
    setActiveMode(normalizeMode(modeFromSettings));
    applySettingsToBackendControls(settings);
    renderBackendStatus("Autocomplete uses the deployed Modal endpoint.");
  });

  if (chrome.storage?.local) {
    chrome.storage.local.get(
      { [TELEMETRY_KEY]: null, [PANEL_SNAPSHOT_KEY]: null, [CHAT_SNAPSHOT_KEY]: null },
      (result) => {
      renderTelemetry(result[TELEMETRY_KEY]);
      renderPanelSnapshot(result[PANEL_SNAPSHOT_KEY]);
        renderAssistantSnapshot(result[CHAT_SNAPSHOT_KEY]);
      }
    );
  } else {
    renderTelemetry(null);
    renderPanelSnapshot(null);
    renderAssistantSnapshot(null);
  }
})();
