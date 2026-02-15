(() => {
  "use strict";

  const MODE_KEY = "zetaMode";
  const SETTINGS_KEY = "zetaSettings";
  const TELEMETRY_KEY = "zetaTelemetry";
  const PANEL_SNAPSHOT_KEY = "zetaPanelSnapshot";
  const UI_SURFACE_KEY = "zetaUiSurface";
  const FALLBACK_MODE = "auto";
  const IS_EMBEDDED = new URLSearchParams(window.location.search).get("embedded") === "1";
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

  let hasInitialized = false;
  let hasInitializedPanelNav = false;
  let lastAnimatedShortcutPulseId = 0;
  const expandedGraphNodeIds = new Set();
  const previewCache = new Map();
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
    chrome.storage.local.set({
      [UI_SURFACE_KEY]: {
        surface: String(surface || "").toLowerCase(),
        updatedAt: Date.now(),
      },
    });
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

    const parts = [];
    const statusPart = formatStatus(data.status);
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
    const data = snapshot && typeof snapshot === "object" ? snapshot : {};
    const score = Math.max(0, Math.min(100, Number(data.healthScore) || 100));
    const breakdown = data.healthBreakdown && typeof data.healthBreakdown === "object"
      ? data.healthBreakdown
      : null;
    const cached = Math.max(0, Number(data.sentenceCached) || 0);
    const pending = Math.max(0, Number(data.sentencePending) || 0);
    const activity = Array.isArray(data.activity) ? data.activity : [];
    const chunkTree = data.chunkTree && typeof data.chunkTree === "object" ? data.chunkTree : null;
    const activeChunkId = String(data.activeChunkId || chunkTree?.activeChunkId || "");
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
    renderHealthTooltip(score, breakdown, cached, pending);

    if (activityCount) {
      activityCount.textContent = String(activity.length);
    }
    if (activityList) {
      activityList.replaceChildren();
      for (const entry of activity) {
        const li = document.createElement("li");
        li.className = "zeta-activity-row";
        const message = String(entry?.message || "Activity");
        const time = String(entry?.timeLabel || "");
        const detailText = String(entry?.detailText || "").trim();
        const strong = document.createElement("strong");
        strong.textContent = message;
        const p = document.createElement("p");
        p.textContent = time;
        li.append(strong, p);
        if (detailText) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "zeta-activity-toggle";
          toggle.textContent = "View output";
          const pre = document.createElement("pre");
          pre.className = "zeta-activity-detail";
          pre.textContent = detailText;
          pre.hidden = true;
          toggle.addEventListener("click", () => {
            const expanded = pre.hidden;
            pre.hidden = !expanded;
            toggle.textContent = expanded ? "Hide output" : "View output";
          });
          li.append(toggle, pre);
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

    if (shortcutPulseId > 0 && shortcutPulseId !== lastAnimatedShortcutPulseId) {
      lastAnimatedShortcutPulseId = shortcutPulseId;
      pulseShortcut(lastShortcut);
    }
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
    const chunks = Array.isArray(chunkTree?.chunks) ? chunkTree.chunks.slice() : [];
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
    const addChild = (parentId, chunk) => {
      const key = parentId || rootId;
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
    let cursorId = activeChunkId && byId.has(activeChunkId) ? activeChunkId : null;
    while (cursorId) {
      activePath.add(cursorId);
      const cursorChunk = byId.get(cursorId);
      cursorId = cursorChunk?.parentId ? String(cursorChunk.parentId) : null;
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
    });
  }

  if (typeof chrome === "undefined" || !chrome.storage?.sync) {
    setActivePanel("main");
    setActiveMode(FALLBACK_MODE);
    renderTelemetry(null);
    renderPanelSnapshot(null);
    return;
  }

  if (!IS_EMBEDDED) {
    publishSurface("popup");
    notifyActiveTabSurface("popup");
    window.addEventListener("beforeunload", () => publishSurface("none"));
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
