(() => {
  "use strict";

  /** Set to true to mute all logs except chat/assistant (turn off when done debugging). */
  const DEBUG_CHAT_ONLY = true;

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

  if (DEBUG_CHAT_ONLY) {
    const _info = console.info.bind(console);
    const _warn = console.warn.bind(console);
    const chatOnly = (s) => /assistant|chat_send|chat_delete|zeta-chat|tab_message/.test(s);
    console.info = function (...args) {
      if (!chatOnly(String(args[0] ?? ""))) return;
      _info.apply(console, args);
    };
    console.warn = function (...args) {
      if (!chatOnly(String(args[0] ?? ""))) return;
      _warn.apply(console, args);
    };
  }

  const DEFAULT_SHORTCUTS = [
    { trigger: "Ctrl+Shift+Enter", text: "Ctrl+Shift+Enter", keys: ["⌃", "⇧", "↩"], label: "Run checker now", section: "Checking" },
    { trigger: "Cmd+Shift+M", altTrigger: "Ctrl+Shift+M", text: "⌘⇧M / Ctrl+Shift+M", keys: ["⌘/⌃", "⇧", "M"], label: "Request autocomplete (manual)", section: "Checking" },
    { trigger: "Alt+Shift+R", text: "Option+Shift+R", keys: ["⌥", "⇧", "R"], label: "Refresh checker", section: "Checking" },
    { trigger: "Alt+Shift+N", text: "Option+Shift+N", keys: ["⌥", "⇧", "N"], label: "Focus next issue", section: "Issues" },
    { trigger: "Alt+Shift+P", text: "Option+Shift+P", keys: ["⌥", "⇧", "P"], label: "Focus previous issue", section: "Issues" },
    { trigger: "Alt+Shift+A", text: "Option+Shift+A", keys: ["⌥", "⇧", "A"], label: "Apply current fix", section: "Issues" },
    { trigger: "Alt+Shift+U", text: "Option+Shift+U", keys: ["⌥", "⇧", "U"], label: "Undo last action", section: "History & actions" },
    { trigger: "Alt+Shift+C", text: "Option+Shift+C", keys: ["⌥", "⇧", "C"], label: "Clear all chat history", section: "History & actions" },
    { trigger: "Alt+Shift+H", text: "Option+Shift+H", keys: ["⌥", "⇧", "H"], label: "Clear activity history", section: "History & actions" },
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
  const assistantQueueEl = document.getElementById("zeta-assistant-queue");
  const assistantLayout = document.getElementById("zeta-assistant-layout");
  const assistantCollapseBtn = document.getElementById("zeta-assistant-collapse");
  const assistantForm = document.getElementById("zeta-assistant-form");
  const assistantInput = document.getElementById("zeta-assistant-input");
  const assistantSend = document.getElementById("zeta-assistant-send");
  const autoAnalyzeDocumentToggle = document.getElementById("zeta-auto-analyze-document-toggle");
  const autocompleteEnabledToggle = document.getElementById("zeta-autocomplete-enabled-toggle");
  const backendTopKToggle = document.getElementById("zeta-autocomplete-topk-toggle");
  const backendManualToggle = document.getElementById("zeta-autocomplete-manual-toggle");
  const backendStatus = document.getElementById("zeta-backend-status");
  const readinessScore = document.getElementById("zeta-readiness-score");
  const readinessStatus = document.getElementById("zeta-readiness-status");
  const certifiedStamp = document.getElementById("zeta-certified-stamp");
  const certifiedExplainer = document.getElementById("zeta-certified-explainer");
  const precheckDemoBtn = document.getElementById("zeta-precheck-demo");
  const copyReviewerReportBtn = document.getElementById("zeta-copy-reviewer-report");
  const copyStatus = document.getElementById("zeta-copy-status");
  const readinessLoading = document.getElementById("zeta-readiness-loading");
  const readinessError = document.getElementById("zeta-readiness-error");
  const readinessErrorText = document.getElementById("zeta-readiness-error-text");
  const readinessMode = document.getElementById("zeta-readiness-mode");
  const readinessCounts = document.getElementById("zeta-readiness-counts");
  const reviewerConcerns = document.getElementById("zeta-reviewer-concerns");
  const authorFixes = document.getElementById("zeta-author-fixes");
  const counterexampleBox = document.getElementById("zeta-counterexample-box");
  const reviewLedger = document.getElementById("zeta-review-ledger");
  const reviewerReportPreview = document.getElementById("zeta-reviewer-report-preview");

  let hasInitialized = false;
  let hasInitializedPanelNav = false;
  let lastAnimatedShortcutPulseId = 0;
  let currentSettings = {};
  let currentPrecheckReport = null;
  let assistantSnapshot = {
    threads: [],
    activeThreadId: null,
    updatedAt: 0,
  };
  let assistantSending = false;
  let assistantSendingThreadId = null;
  let assistantSendStep = "";
  /** Queue of { threadId, message } for assistant; processed one at a time. */
  const assistantQueue = [];
  let assistantThreadsCollapsed = false;
  const expandedGraphNodeIds = new Set();
  const expandedPipelineStageIds = new Set();
  const previewCache = new Map();
  let pipelineModalRoot = null;
  let pipelineModalCard = null;
  let pipelineModalTitle = null;
  let pipelineModalMeta = null;
  let pipelineModalBody = null;
  const nowTs = () => new Date().toISOString();
  const zetaLogPrefix = (tag) => `[zeta:${tag}] ${nowTs()}`;
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

  function sendActionToActiveTab(action, payload = null) {
    const extras = payload && typeof payload === "object" ? payload : {};
    sendMessageToActiveTab({ type: "zeta-popup-action", action, ...extras }, "popup_action", () => ({
      action,
      chunkId: extras.chunkId || null,
    }));
  }

  function sendMessageToActiveTab(message, tag, extraPayloadFactory = null, onResponse = null) {
    if (!chrome?.tabs?.query || !chrome?.tabs?.sendMessage) {
      console.warn(`${zetaLogPrefix("popup")} tabs_api_unavailable`, { tag });
      if (typeof onResponse === "function") {
        onResponse(null);
      }
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = tabs && tabs[0];
      if (!activeTab?.id) {
        console.warn(`${zetaLogPrefix("popup")} no_active_tab`, { tag });
        if (typeof onResponse === "function") {
          onResponse(null);
        }
        return;
      }
      const extra = typeof extraPayloadFactory === "function" ? extraPayloadFactory() : null;
      console.info(`${zetaLogPrefix("popup")} sending_tab_message`, {
        tag,
        tabId: activeTab.id,
        ...(extra || {}),
      });
      chrome.tabs.sendMessage(activeTab.id, message, (response) => {
        const runtimeError = chrome.runtime?.lastError?.message;
        if (runtimeError) {
          console.warn(`${zetaLogPrefix("popup")} tab_message_failed`, {
            tag,
            error: runtimeError,
            ...(extra || {}),
          });
          if (typeof onResponse === "function") {
            onResponse(null);
          }
        } else {
          console.info(`${zetaLogPrefix("popup")} tab_message_ok`, {
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
    if (ctrlHeld && shiftHeld && (key === "enter" || code === "Enter")) {
      return { action: "refresh-checker", trigger: "Ctrl+Shift+Enter" };
    }
    if (altHeld && shiftHeld && (key === "n" || code === "KeyN")) {
      return { action: "next-issue", trigger: "Alt+Shift+N" };
    }
    if (altHeld && shiftHeld && (key === "p" || code === "KeyP")) {
      return { action: "prev-issue", trigger: "Alt+Shift+P" };
    }
    if (altHeld && shiftHeld && (key === "a" || code === "KeyA")) {
      return { action: "apply-issue", trigger: "Alt+Shift+A" };
    }
    if (altHeld && shiftHeld && (key === "u" || code === "KeyU")) {
      return { action: "undo-last", trigger: "Alt+Shift+U" };
    }
    if (altHeld && shiftHeld && (key === "c" || code === "KeyC")) {
      return { action: "clear-chat-history", trigger: "Alt+Shift+C" };
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
    const row = macrosList.querySelector(`.zeta-shortcut-row[data-shortcut="${key}"]`)
      || macrosList.querySelector(`.zeta-shortcut-row[data-shortcut-alt="${key}"]`);
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
      return `${seconds.toFixed(2).replace(/\.0+$/, "")} s`;
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
        details: details.join("\n"),
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

  function normalizePipelineOutcome(value, fallbackLabel = "") {
    const outcome = String(value || "").trim().toLowerCase();
    if (outcome === "ok" || outcome === "success" || outcome === "completed") {
      return "ok";
    }
    if (outcome === "failed" || outcome === "error") {
      return "failed";
    }
    if (outcome === "skipped") {
      return "skipped";
    }
    if (outcome === "active" || outcome === "running" || outcome === "pending" || outcome === "unknown") {
      return "active";
    }
    const label = String(fallbackLabel || "").toLowerCase();
    if (/\b(fail|error)\b/.test(label)) {
      return "failed";
    }
    if (/\b(done|complete|success|ok|hit)\b/.test(label)) {
      return "ok";
    }
    return "active";
  }

  function pipelineStageDisplayLabel(stageId) {
    const id = String(stageId || "").trim();
    if (id === "patch_lean" || id === "llm_repair_compile" || id === "llm_repair_def_check") return "Patching lean";
    if (id === "modal_generation") return "Model inference";
    if (id === "lean_compile") return "Lean compile";
    if (id === "semantic_validation") return "Semantic validation";
    if (id === "llm_interpretation") return "LLM interpretation";
    if (id === "highlight_resolution") return "Highlight resolution";
    if (id) return id.replace(/_/g, " ");
    return "stage";
  }

  function buildActivityPipelineNodes(parsedTrace) {
    if (!parsedTrace || typeof parsedTrace !== "object") {
      return [];
    }
    const stageNodes = Array.isArray(parsedTrace.stages)
      ? parsedTrace.stages
      : [];
    if (stageNodes.length > 0) {
      return stageNodes.map((stage) => {
        const durationLabel = Number.isFinite(Number(stage.durationMs))
          ? formatInferenceDuration(Number(stage.durationMs))
          : "--";
        const attempted = stage?.attempted === false ? "attempted=false" : "attempted=true";
        return {
          label: pipelineStageDisplayLabel(stage?.stage) || String(stage?.stage || `stage ${stage?.index || "?"}`),
          meta: `${attempted} · ${durationLabel}`,
          outcome: normalizePipelineOutcome(stage?.outcome, stage?.stage),
        };
      });
    }

    const pipelineStep = String(parsedTrace.pipeline?.step || "").trim();
    if (!pipelineStep) {
      return [];
    }
    const elapsed = String(parsedTrace.pipeline?.elapsed || "").trim();
    return [
      {
        label: pipelineStep,
        meta: elapsed ? `elapsed: ${elapsed}` : "",
        outcome: normalizePipelineOutcome("", pipelineStep),
      },
    ];
  }

  function renderActivityPipelineFlow(parsedTrace) {
    const nodes = buildActivityPipelineNodes(parsedTrace);
    if (nodes.length === 0) {
      return null;
    }
    const container = document.createElement("section");
    container.className = "zeta-activity-pipeline";

    const label = document.createElement("p");
    label.className = "zeta-activity-pipeline-label";
    label.textContent = "Pipeline";
    container.appendChild(label);

    const flow = document.createElement("div");
    flow.className = "zeta-activity-pipeline-flow";
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const card = document.createElement("article");
      card.className = `zeta-activity-pipeline-node zeta-activity-pipeline-node--${node.outcome || "active"}`;

      const title = document.createElement("strong");
      title.textContent = truncatePipelineText(node.label || "stage", 92);
      const meta = document.createElement("span");
      meta.textContent = truncatePipelineText(node.meta || "", 96);
      card.append(title, meta);
      flow.appendChild(card);

      if (index < nodes.length - 1) {
        const arrow = document.createElement("span");
        arrow.className = "zeta-activity-pipeline-arrow";
        arrow.textContent = "→";
        flow.appendChild(arrow);
      }
    }

    container.appendChild(flow);
    return container;
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

  function renderPipelineModal(entry, parsedTrace, detailText) {
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
      const rawDetail = typeof detailText === "string" ? detailText : String(entry?.detailText || "").trim();
      if (rawDetail) {
        const raw = document.createElement("pre");
        raw.className = "zeta-activity-detail";
        raw.style.marginTop = "8px";
        raw.textContent = rawDetail;
        pipelineModalBody.appendChild(raw);
      }
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
      name.textContent = `${stage.index}. ${pipelineStageDisplayLabel(stage.stage)}`;
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
      details.textContent = truncatePipelineText(stage.details || "No stage details available.", 6000);
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
    renderPipelineModal(entry, parsedTrace, detailText);
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
    if (parts.length === 0) {
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
    const rawBreakdown = snapshotData.healthBreakdown;
    const breakdown = rawBreakdown && typeof rawBreakdown === "object" && !Array.isArray(rawBreakdown)
      ? rawBreakdown
      : null;
    const cached = Math.max(0, Number(snapshotData.sentenceCached) ?? Number(breakdown?.cachedSentences) ?? 0);
    const pending = Math.max(0, Number(snapshotData.sentencePending) ?? Number(breakdown?.pendingSentences) ?? 0);
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
          const inlinePipeline = renderActivityPipelineFlow(parsedPipeline);
          if (inlinePipeline) {
            li.appendChild(inlinePipeline);
          }

          const actions = document.createElement("div");
          actions.className = "zeta-activity-actions";
          const viewPipelineBtn = document.createElement("button");
          viewPipelineBtn.type = "button";
          viewPipelineBtn.className = "zeta-activity-pipeline-btn";
          viewPipelineBtn.textContent = "View pipeline";
          viewPipelineBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPipelineModal(entry, detailText);
          });
          actions.appendChild(viewPipelineBtn);
          li.appendChild(actions);

          const pre = document.createElement("pre");
          pre.className = "zeta-activity-detail";
          pre.textContent = detailText;
          li.append(pre);
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
      let lastSection = null;
      for (const macro of DEFAULT_SHORTCUTS) {
        const section = macro.section || "Actions";
        if (section !== lastSection) {
          lastSection = section;
          const subhead = document.createElement("li");
          subhead.className = "zeta-macros-subsection";
          subhead.textContent = section;
          macrosList.appendChild(subhead);
        }
        const li = document.createElement("li");
        li.className = "zeta-shortcut-row";
        li.dataset.shortcut = normalizeShortcutKey(macro.trigger);
        if (macro.altTrigger) {
          li.dataset.shortcutAlt = normalizeShortcutKey(macro.altTrigger);
        }
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

  function deleteAssistantThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) {
      return;
    }
    sendMessageToActiveTab(
      {
        type: "zeta-chat-delete-thread",
        threadId: id,
      },
      "chat_delete_thread",
      () => ({ threadId: id }),
      (response) => {
        if (response?.ok && chrome?.storage?.local) {
          chrome.storage.local.get([CHAT_SNAPSHOT_KEY], (result) => {
            if (result && result[CHAT_SNAPSHOT_KEY] != null) {
              renderAssistantSnapshot(result[CHAT_SNAPSHOT_KEY]);
            }
          });
        }
      }
    );
  }

  function escapeHtml(s) {
    const t = String(s ?? "");
    return t
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderMessageBodyWithCodeBlocks(text) {
    const raw = String(text ?? "").trim();
    const fragment = document.createDocumentFragment();
    const parts = raw.split("```");
    for (let i = 0; i < parts.length; i += 1) {
      if (i % 2 === 0) {
        if (parts[i].length > 0) {
          const span = document.createElement("span");
          span.className = "zeta-assistant-message-text";
          span.innerHTML = escapeHtml(parts[i]).replace(/\n/g, "<br>");
          fragment.appendChild(span);
        }
      } else {
        const code = document.createElement("pre");
        code.className = "zeta-assistant-code";
        const codeInner = document.createElement("code");
        const content = parts[i].replace(/^\w*\n?/, "").trim();
        codeInner.textContent = content;
        code.appendChild(codeInner);
        fragment.appendChild(code);
      }
    }
    return fragment;
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
      const sortedThreads = [...threads].sort((a, b) => {
        if (a.id === "general") return -1;
        if (b.id === "general") return 1;
        return 0;
      });
      for (const thread of sortedThreads) {
        const li = document.createElement("li");
        const wrap = document.createElement("div");
        wrap.className = "zeta-assistant-thread-wrap";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "zeta-assistant-thread";
        if (thread.id === activeThreadId) {
          btn.classList.add("is-active");
        }
        if (thread.id === "general") {
          const pinIcon = document.createElement("span");
          pinIcon.className = "zeta-assistant-thread-pin";
          pinIcon.setAttribute("aria-hidden", "true");
          pinIcon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78 0.9A2 2 0 0 0 5 14.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1.76a2 2 0 0 0-1.11-1.79l-1.78-0.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4 1 1 0 0 1-1-1 2 2 0 0 0 0-4 1 1 0 0 1-1-1 2 2 0 0 0 0 4 1 1 0 0 1 1 1 2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
          btn.appendChild(pinIcon);
        }
        const title = document.createElement("strong");
        title.className = "zeta-assistant-thread-title";
        title.textContent = thread.title;
        const meta = document.createElement("p");
        meta.className = "zeta-assistant-thread-meta";
        meta.textContent = `${thread.severity || "unknown"} · ${thread.status || "idle"}`;
        const contentWrap = document.createElement("div");
        contentWrap.className = "zeta-assistant-thread-content";
        contentWrap.append(title, meta);
        btn.append(contentWrap);
        btn.addEventListener("click", () => {
          setAssistantActiveThread(thread.id, true);
        });
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "zeta-assistant-thread-delete";
        deleteBtn.setAttribute("aria-label", "Delete thread");
        deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          deleteAssistantThread(thread.id);
        });
        if (thread.id === "general") {
          deleteBtn.style.display = "none";
        }
        wrap.append(btn, deleteBtn);
        li.appendChild(wrap);
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
        const body = document.createElement("div");
        body.className = "zeta-assistant-message-body";
        body.appendChild(renderMessageBodyWithCodeBlocks(message.text));
        li.append(who, body);
        assistantMessages.appendChild(li);
      }
      const showLoading = (assistantSending && activeThreadId === assistantSendingThreadId) || (activeThread && String(activeThread.status || "") === "thinking");
      if (showLoading) {
        const loadingLi = document.createElement("li");
        loadingLi.className = "zeta-assistant-loading";
        loadingLi.setAttribute("aria-live", "polite");
        const spinner = document.createElement("span");
        spinner.className = "zeta-assistant-spinner";
        spinner.setAttribute("aria-hidden", "true");
        const step = document.createElement("span");
        step.className = "zeta-assistant-loading-step";
        step.textContent = assistantSendStep || "Thinking…";
        loadingLi.append(spinner, step);
        assistantMessages.appendChild(loadingLi);
      }
      const queuedForActive = assistantQueue.filter((q) => q.threadId === activeThreadId);
      const inFlightForActive = assistantSending && assistantSendingThreadId === activeThreadId;
      const queuedExcludingInFlight = inFlightForActive && queuedForActive.length > 0
        ? queuedForActive.slice(1)
        : queuedForActive;
      for (const item of queuedExcludingInFlight) {
        const li = document.createElement("li");
        li.className = "zeta-assistant-message zeta-assistant-message--queued";
        const who = document.createElement("strong");
        who.textContent = "You";
        const body = document.createElement("div");
        body.className = "zeta-assistant-message-body";
        body.textContent = `(Queued) ${item.message}`;
        li.append(who, body);
        assistantMessages.appendChild(li);
      }
      if (messages.length > 0 || showLoading || queuedForActive.length > 0) {
        assistantMessages.scrollTop = assistantMessages.scrollHeight;
      }
    }

    if (assistantMessagesEmpty) {
      const hasMessages = Array.isArray(activeThread?.messages) && activeThread.messages.length > 0;
      const showLoading = (assistantSending && activeThreadId === assistantSendingThreadId) || (activeThread && String(activeThread.status || "") === "thinking");
      const hasQueued = assistantQueue.some((q) => q.threadId === activeThreadId);
      assistantMessagesEmpty.style.display = hasMessages || showLoading || hasQueued ? "none" : "block";
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
    if (assistantQueueEl) {
      const queuedForActive = assistantQueue.filter((q) => q.threadId === activeThreadId);
      const inFlightForActive = assistantSending && assistantSendingThreadId === activeThreadId;
      const n = inFlightForActive && queuedForActive.length > 0 ? queuedForActive.length - 1 : queuedForActive.length;
      if (n > 0) {
        assistantQueueEl.textContent = n === 1 ? "1 message queued" : `${n} messages queued`;
        assistantQueueEl.style.display = "block";
      } else {
        assistantQueueEl.textContent = "";
        assistantQueueEl.style.display = "none";
      }
    }
  }

  function processAssistantQueue() {
    if (assistantQueue.length === 0) {
      assistantSending = false;
      assistantSendingThreadId = null;
      assistantSendStep = "";
      if (assistantSend) assistantSend.disabled = !assistantSnapshot.activeThreadId;
      renderAssistantSnapshot(assistantSnapshot);
      return;
    }
    const item = assistantQueue[0];
    const { threadId, message: text } = item;
    assistantSending = true;
    assistantSendingThreadId = threadId;
    assistantSendStep = "Sending…";
    renderAssistantSnapshot(assistantSnapshot);

    function refetchAndRender() {
      if (!chrome?.storage?.local) return;
      chrome.storage.local.get([CHAT_SNAPSHOT_KEY], (result) => {
        if (result && result[CHAT_SNAPSHOT_KEY] != null) {
          renderAssistantSnapshot(result[CHAT_SNAPSHOT_KEY]);
        }
      });
    }
    window.setTimeout(() => {
      refetchAndRender();
      assistantSendStep = "Thinking…";
      renderAssistantSnapshot(assistantSnapshot);
    }, 80);

    const QUEUE_RESPONSE_TIMEOUT_MS = 95000;
    let responseHandled = false;
    const safetyTimeoutId = window.setTimeout(() => {
      if (responseHandled) return;
      responseHandled = true;
      if (assistantQueue.length > 0 && assistantQueue[0].threadId === threadId) {
        assistantQueue.shift();
      }
      assistantSending = false;
      assistantSendingThreadId = null;
      assistantSendStep = "";
      if (assistantSend) assistantSend.disabled = !assistantSnapshot.activeThreadId;
      if (assistantMeta) assistantMeta.textContent = "Request timed out. You can try again or send the next queued message.";
      renderAssistantSnapshot(assistantSnapshot);
      window.setTimeout(processAssistantQueue, 0);
    }, QUEUE_RESPONSE_TIMEOUT_MS);

    sendMessageToActiveTab(
      { type: "zeta-chat-send", threadId, message: text },
      "chat_send",
      () => ({ threadId, chars: text.length }),
      (response) => {
        if (responseHandled) return;
        responseHandled = true;
        window.clearTimeout(safetyTimeoutId);
        const wasThreadId = threadId;
        if (response == null) {
          console.warn(`${zetaLogPrefix("assistant")} chat_send response is null – tab may be inactive or extension not injected`, {
            hint: "Focus the Overleaf tab and ensure the extension content script is loaded.",
          });
        }
        console.info(`${zetaLogPrefix("assistant")} chat_send response`, {
          ok: response?.ok,
          error: response?.error,
          source: response?.source,
          threadId: response?.threadId,
          hasAnswer: !!response?.answer,
        });
        if (assistantQueue.length > 0 && assistantQueue[0].threadId === wasThreadId) {
          assistantQueue.shift();
        }
        assistantSending = false;
        assistantSendingThreadId = null;
        assistantSendStep = "";
        if (assistantSend) assistantSend.disabled = !assistantSnapshot.activeThreadId;
        if (!response?.ok && assistantMeta) {
          assistantMeta.textContent = "Could not reach Overleaf tab. Focus the Overleaf editor tab and try again.";
        }
        if (response?.ok && response?.answer && response?.threadId) {
          const lastMsg = { role: "assistant", text: response.answer };
          const norm = normalizeAssistantSnapshot(assistantSnapshot);
          const thread = norm.threads.find((t) => t.id === response.threadId);
          if (thread) {
            const alreadyHasAnswer = Array.isArray(thread.messages) && thread.messages.some(
              (m) => m.role === "assistant" && String(m.text || "").trim() === String(response.answer || "").trim()
            );
            if (!alreadyHasAnswer) {
              assistantSnapshot = {
                ...norm,
                threads: norm.threads.map((t) =>
                  t.id !== response.threadId
                    ? t
                    : { ...t, messages: [...(t.messages || []), lastMsg], status: "ready" }
                ),
              };
            }
          } else {
            const newThread = {
              id: response.threadId,
              title: response.threadId === "general" ? "General Assistant" : response.threadId,
              severity: "unknown",
              status: "ready",
              updatedAt: Date.now(),
              isActiveIssue: true,
              issueMessage: "",
              sentenceText: "",
              messages: [lastMsg],
              lastSource: response?.source || "",
              lastLatencyMs: 0,
              lastError: "",
            };
            assistantSnapshot = {
              threads: [...norm.threads.filter((t) => t.id !== response.threadId), newThread],
              activeThreadId: response.threadId,
              updatedAt: Date.now(),
            };
          }
          renderAssistantSnapshot(assistantSnapshot);
        } else if (response?.ok) {
          renderAssistantSnapshot(assistantSnapshot);
        } else {
          renderAssistantSnapshot(assistantSnapshot);
        }
        if (response?.ok && chrome?.storage?.local) {
          refetchAndRender();
          window.setTimeout(refetchAndRender, 100);
          window.setTimeout(refetchAndRender, 350);
        }
        window.setTimeout(processAssistantQueue, 0);
      }
    );
  }

  function sendAssistantPrompt() {
    const threadId = String(assistantSnapshot.activeThreadId || "");
    const text = String(assistantInput?.value || "").trim();
    console.info(`${zetaLogPrefix("assistant")} sendAssistantPrompt`, {
      threadId: threadId || "(empty)",
      hasText: !!text,
      textLength: text.length,
      activeThreadId: assistantSnapshot.activeThreadId,
    });
    if (!threadId || !text) {
      console.warn(`${zetaLogPrefix("assistant")} sendAssistantPrompt skipped`, { reason: !threadId ? "no threadId" : "no text" });
      return;
    }
    if (assistantInput) assistantInput.value = "";
    assistantQueue.push({ threadId, message: text });
    renderAssistantSnapshot(assistantSnapshot);
    if (!assistantSending) {
      processAssistantQueue();
    }
  }

  function graphLabel(chunk) {
    const type = String(chunk?.type || "text");
    if (type === "document") {
      return "Document (Full Scope)";
    }
    if (type === "section") {
      const name = String(chunk?.sectionName || "section");
      const title = String(chunk?.sectionTitle || "").trim();
      const sectionKind = name ? `${name[0].toUpperCase()}${name.slice(1)}` : "Section";
      return title ? `${sectionKind}: ${title}` : `${sectionKind}: Untitled`;
    }
    if (type === "environment") {
      const envKind = toTitleCase(String(chunk?.envName || "environment")) || "Environment";
      const envTitle = extractEnvironmentTitle(chunk);
      return envTitle ? `${envKind}: ${envTitle}` : envKind;
    }
    if (type === "command") {
      return String(chunk?.commandName || "command");
    }
    return "Text";
  }

  function toTitleCase(value) {
    const normalized = String(value || "")
      .replace(/[_-]+/g, " ")
      .trim();
    if (!normalized) {
      return "";
    }
    return normalized
      .split(/\s+/)
      .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "")
      .join(" ");
  }

  function extractEnvironmentTitle(chunk) {
    const text = String(chunk?.text || "");
    if (!text) {
      return "";
    }

    // Supports:
    // \begin{theorem}[Title]
    // \begin{theorem}{Title}
    // \begin{theorem}{Title}{...}
    const beginLine = text.split(/\r?\n/, 1)[0] || "";
    const bracketMatch = beginLine.match(/\\begin\s*\{\s*[^{}]+\s*\}\s*\[([^\]]+)\]/);
    if (bracketMatch && bracketMatch[1]) {
      return String(bracketMatch[1]).trim();
    }

    const braceMatch = beginLine.match(/\\begin\s*\{\s*[^{}]+\s*\}\s*\{([^}]*)\}/);
    if (braceMatch && braceMatch[1]) {
      return String(braceMatch[1]).trim();
    }

    return "";
  }

  function renderHealthTooltip(score, breakdown, cached, pending) {
    if (!healthTooltip) {
      return;
    }
    const details = breakdown && typeof breakdown === "object" && !Array.isArray(breakdown) ? breakdown : null;
    if (!details) {
      healthTooltip.textContent = [
        "Document health",
        "",
        "How is the score calculated?",
        "The score starts at 100. Penalties are subtracted for issue severity, issue density, and unfinished analysis (pending sentences).",
        "",
        "Where are points lost?",
        "See the breakdown below once the document has been analyzed.",
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
    const analyzedFromBreakdown = Number(details.analyzedSentences);
    const analyzedSentences = Number.isFinite(analyzedFromBreakdown) && analyzedFromBreakdown >= 0
      ? analyzedFromBreakdown
      : Math.max(0, Math.max(0, cached) + Math.max(0, pending)) || 1;
    const coverageRatio = Number.isFinite(Number(details.coverageRatio))
      ? Number(details.coverageRatio)
      : analyzedSentences > 0
        ? Math.max(0, cached) / analyzedSentences
        : 1;
    const coveragePct = Math.max(0, Math.min(100, Math.round(coverageRatio * 100)));

    const lines = [
      "Document health",
      "",
      "How is the score calculated?",
      "The score starts at 100. Three penalties are subtracted: (1) severity — issues (errors, warnings, info) reduce the score, scaled by how much of the document was analyzed; (2) density — many issues in a small span add an extra penalty; (3) pending — sentences still being analyzed lower the score until the run completes.",
      "",
      "Where are points lost?",
      "Each issue contributes a severity weight (errors most, then warnings, then info). Those raw points are normalized by the analyzed scope so longer documents are not over-penalized. The list below shows each finding and the points deducted.",
      "",
    ];

    const entries = Array.isArray(details.issueEntries) ? details.issueEntries : [];
    if (entries.length > 0) {
      lines.push("Points lost by issue:");
      for (const e of entries.slice(0, 50)) {
        const msg = String(e?.message || e?.severity || "issue").slice(0, 72);
        const pts = Number(e?.points) ?? 0;
        lines.push(`  • ${msg} (−${pts})`);
      }
      if (entries.length > 50) {
        lines.push(`  … and ${entries.length - 50} more`);
      }
      lines.push("");
    }

    lines.push(
      `Coverage: ${Math.max(0, cached)} of ${analyzedSentences} sentences cached (${coveragePct}%).`,
      `Pending: ${Math.max(0, pending)} sentence(s) in queue.`
    );

    healthTooltip.textContent = lines.join("\n");
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

    const chunkDepth = new Map();
    const depthToIds = new Map();
    function assignDepth(parentId, depth) {
      const children = byParent.get(parentId || rootId) || [];
      for (const chunk of children) {
        const cid = String(chunk?.chunkId || "");
        chunkDepth.set(cid, depth);
        if (!depthToIds.has(depth)) {
          depthToIds.set(depth, []);
        }
        depthToIds.get(depth).push(chunk);
        assignDepth(cid, depth + 1);
      }
    }
    assignDepth(rootId, 0);

    const nonInnermostTextIds = new Set();
    for (const [, nodesAtDepth] of depthToIds) {
      const hasNonTextAtDepth = nodesAtDepth.some((chunk) => String(chunk?.type || "") !== "text");
      if (hasNonTextAtDepth) {
        for (const chunk of nodesAtDepth) {
          if (String(chunk?.type || "") === "text") {
            nonInnermostTextIds.add(String(chunk?.chunkId || ""));
          }
        }
      }
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

    function getVisibleChildren(parentId) {
      const direct = byParent.get(parentId || rootId) || [];
      const out = [];
      for (const chunk of direct) {
        const cid = String(chunk?.chunkId || "");
        if (nonInnermostTextIds.has(cid)) {
          out.push(...getVisibleChildren(cid));
        } else {
          out.push(chunk);
        }
      }
      out.sort((a, b) => (Number(a?.start) || 0) - (Number(b?.start) || 0));
      return out;
    }

    const buildNodes = (parentId, depth) => {
      const children = getVisibleChildren(parentId);
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

        if (isInnermost) {
          const sparkle = document.createElement("button");
          sparkle.type = "button";
          sparkle.className = "zeta-graph-sparkle";
          sparkle.setAttribute("aria-label", "Analyze in Graph View");
          sparkle.title = "Analyze in Graph View";
          sparkle.textContent = "✦";
          sparkle.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setActivePanel("history");
            sendActionToActiveTab("analyze-graph-chunk", {
              chunkId,
              start,
              end,
              chunkType: type,
              label: graphLabel(chunk),
            });
          });
          head.append(title, meta, sparkle);
        } else {
          head.append(title, meta);
        }
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
    const visibleNodeCount = graphList.querySelectorAll(".zeta-graph-node").length;
    graphCount.textContent = `${visibleNodeCount} nodes`;
    graphEmpty.style.display = visibleNodeCount > 0 ? "none" : "block";
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

  async function checkBackendHealth() {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch("http://localhost:8000/v1/status", {
        method: "GET",
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        const llm = data.llm_configured ? "LLM: configured" : "LLM: not configured";
        const modal = data.modal_configured ? " · Modal: configured" : "";
        renderBackendStatus(`Backend: connected · ${llm}${modal}`, "ok");
      } else {
        renderBackendStatus("Backend: unavailable — using deterministic local mode.", "error");
      }
    } catch (_err) {
      window.clearTimeout(timeoutId);
      renderBackendStatus("Backend: unavailable — using deterministic local mode.", "error");
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

  function setPrecheckLoading(message = "Building deterministic demo report...") {
    if (readinessLoading) {
      readinessLoading.style.display = "grid";
      const text = readinessLoading.querySelector("span");
      if (text) text.textContent = message;
    }
    if (readinessError) readinessError.style.display = "none";
    if (readinessScore) readinessScore.textContent = "--/100";
    if (readinessStatus) readinessStatus.textContent = "Preparing pre-check...";
    if (certifiedStamp) {
      certifiedStamp.className = "zeta-certified-stamp zeta-certified-stamp--checking";
      certifiedStamp.textContent = "Checking";
    }
    if (certifiedExplainer) {
      certifiedExplainer.textContent = "Zeta is preparing a prototype scientific pre-check.";
    }
  }

  function setPrecheckError(message) {
    if (readinessLoading) readinessLoading.style.display = "none";
    if (readinessError) readinessError.style.display = "grid";
    if (readinessErrorText) readinessErrorText.textContent = message;
    if (readinessStatus) readinessStatus.textContent = "Pre-Check unavailable";
    if (certifiedStamp) {
      certifiedStamp.className = "zeta-certified-stamp zeta-certified-stamp--needs-review";
      certifiedStamp.textContent = "Not checked";
    }
    if (copyStatus) copyStatus.textContent = "Run Demo Mode after the pre-check engine loads.";
  }

  function stampClassForCertification(certification) {
    const key = String(certification?.key || "");
    if (key === "checking") return "zeta-certified-stamp--checking";
    if (key === "needs_review" || key === "not_checked") return "zeta-certified-stamp--needs-review";
    if (key === "certified_demo_mode") return "zeta-certified-stamp--demo";
    return "zeta-certified-stamp--passed";
  }

  function renderList(target, items, ordered = false) {
    if (!target) return;
    target.replaceChildren();
    for (const item of items || []) {
      const li = document.createElement("li");
      li.innerHTML = escapeHtml(String(item || ""));
      target.appendChild(li);
    }
    if ((items || []).length === 0) {
      const li = document.createElement("li");
      li.textContent = ordered ? "No reviewer concerns detected by the current prototype checks." : "No suggested fixes available.";
      target.appendChild(li);
    }
  }

  function renderReadinessCounts(counts) {
    if (!readinessCounts) return;
    const metrics = [
      ["Definitions", counts.definitionsDetected],
      ["Theorems & lemmas", counts.theoremsLemmasDetected],
      ["Assumptions", counts.assumptionsDetected],
      ["Notation warnings", counts.notationWarnings],
      ["Undefined symbols", counts.undefinedSymbols],
      ["Verification issues", counts.verificationIssues],
    ];
    readinessCounts.replaceChildren();
    for (const [label, value] of metrics) {
      const div = document.createElement("div");
      div.className = "zeta-readiness-metric";
      div.innerHTML = `<strong>${Number(value) || 0}</strong><span>${escapeHtml(label)}</span>`;
      readinessCounts.appendChild(div);
    }
  }

  function renderReviewLedger(events) {
    if (!reviewLedger) return;
    reviewLedger.replaceChildren();
    for (const event of events || []) {
      const li = document.createElement("li");
      li.className = "zeta-ledger-event";
      const status = String(event.status || "info").toLowerCase();
      li.innerHTML = `
        <strong><span class="zeta-ledger-status zeta-ledger-status--${escapeHtml(status)}">${escapeHtml(status)}</span>${escapeHtml(event.title)}</strong>
        <span>${escapeHtml(event.description)}</span>
      `;
      reviewLedger.appendChild(li);
    }
  }

  function renderPrecheckReport(report) {
    currentPrecheckReport = report;
    if (readinessLoading) readinessLoading.style.display = "none";
    if (readinessError) readinessError.style.display = "none";
    if (readinessScore) readinessScore.textContent = `${report.score}/100`;
    if (readinessStatus) readinessStatus.textContent = report.statusBadge;
    if (readinessMode) readinessMode.textContent = report.demoMode ? "Demo Mode" : "Live Document";
    if (certifiedStamp) {
      certifiedStamp.className = `zeta-certified-stamp ${stampClassForCertification(report.certification)}`;
      certifiedStamp.textContent = report.certification.label;
    }
    if (certifiedExplainer) {
      certifiedExplainer.textContent = report.certification.description;
    }
    renderReadinessCounts(report.counts || {});
    renderList(reviewerConcerns, report.topReviewerConcerns || [], true);
    renderList(authorFixes, report.suggestedAuthorFixes || [], false);
    if (counterexampleBox) {
      counterexampleBox.textContent = report.counterexample || "No warning selected. Run Zeta Pre-Check to generate an explanation.";
    }
    renderReviewLedger(report.reviewLedger || []);
    if (copyStatus) {
      copyStatus.textContent = report.demoMode
        ? "Demo Mode is active. Report is ready to copy."
        : "Reviewer report is ready to copy.";
    }
    if (reviewerReportPreview) {
      reviewerReportPreview.value = "";
      reviewerReportPreview.classList.remove("is-visible");
    }
  }

  function runPrecheckDemo() {
    setPrecheckLoading("Running Demo Mode with a sample LaTeX paper...");
    window.setTimeout(() => {
      try {
        const engine = window.__zetaPrecheck;
        if (!engine?.buildPrecheckReport) {
          setPrecheckError("The local pre-check engine is missing. Reload the extension and try again.");
          return;
        }
        const report = engine.buildPrecheckReport(null, {
          demoMode: true,
          timestamp: new Date().toISOString(),
        });
        renderPrecheckReport(report);
      } catch (error) {
        setPrecheckError(`Demo Mode failed: ${String(error?.message || error)}`);
      }
    }, 120);
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }

  async function copyReviewerReport() {
    try {
      const engine = window.__zetaPrecheck;
      if (!engine?.markdownReviewerReport) {
        throw new Error("Pre-check report engine is not loaded.");
      }
      if (!currentPrecheckReport) {
        runPrecheckDemo();
        throw new Error("Report is still generating. Click copy again in a moment.");
      }
      const markdown = engine.markdownReviewerReport(currentPrecheckReport);
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(markdown);
          copied = true;
        } catch (_error) {
          copied = false;
        }
      }
      if (!copied) {
        copied = fallbackCopyText(markdown);
      }
      if (!copied) {
        if (reviewerReportPreview) {
          reviewerReportPreview.value = markdown;
          reviewerReportPreview.classList.add("is-visible");
          reviewerReportPreview.focus();
          reviewerReportPreview.select();
        }
        throw new Error("Clipboard blocked. Markdown report is open below for manual copy.");
      }
      if (copyStatus) copyStatus.textContent = "Reviewer report copied as Markdown.";
      if (reviewerReportPreview) {
        reviewerReportPreview.value = "";
        reviewerReportPreview.classList.remove("is-visible");
      }
    } catch (error) {
      if (copyStatus) copyStatus.textContent = String(error?.message || error);
    }
  }

  function applySettingsToBackendControls(settings) {
    const nextSettings = settings && typeof settings === "object" ? settings : {};
    currentSettings = { ...nextSettings };
    if (autoAnalyzeDocumentToggle) {
      autoAnalyzeDocumentToggle.checked = nextSettings.autoAnalyzeDocument !== false;
    }
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

  function persistAutoAnalyzeDocumentSetting() {
    if (!autoAnalyzeDocumentToggle || typeof chrome === "undefined" || !chrome.storage?.sync) {
      return;
    }
    const enabled = autoAnalyzeDocumentToggle.checked !== false;
    chrome.storage.sync.get({ [SETTINGS_KEY]: {} }, (result) => {
      const settings = result[SETTINGS_KEY] && typeof result[SETTINGS_KEY] === "object"
        ? result[SETTINGS_KEY]
        : {};
      if ((settings.autoAnalyzeDocument !== false) === enabled) {
        return;
      }
      const nextSettings = {
        ...settings,
        autoAnalyzeDocument: enabled,
      };
      chrome.storage.sync.set({ [SETTINGS_KEY]: nextSettings }, () => {
        const runtimeError = chrome.runtime?.lastError?.message;
        if (runtimeError) {
          renderBackendStatus(`Save failed: ${runtimeError}`, "error");
          return;
        }
        currentSettings = { ...nextSettings };
        renderBackendStatus(
          enabled ? "Auto-analyze document enabled." : "Auto-analyze document disabled. Use Run checker to analyze.",
          "ok"
        );
      });
    });
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
            ? "Manual autocomplete enabled. Use Cmd+Shift+M to request suggestions."
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

  if (assistantCollapseBtn && assistantLayout) {
    assistantCollapseBtn.addEventListener("click", () => {
      assistantThreadsCollapsed = !assistantThreadsCollapsed;
      assistantLayout.classList.toggle("is-threads-collapsed", assistantThreadsCollapsed);
      assistantCollapseBtn.textContent = assistantThreadsCollapsed ? ">>" : "\u00AB Collapse";
      assistantCollapseBtn.setAttribute("aria-label", assistantThreadsCollapsed ? "Expand thread list" : "Collapse thread list");
    });
  }

  if (autoAnalyzeDocumentToggle) {
    autoAnalyzeDocumentToggle.addEventListener("change", () => {
      persistAutoAnalyzeDocumentSetting();
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

  if (precheckDemoBtn) {
    precheckDemoBtn.addEventListener("click", () => {
      runPrecheckDemo();
    });
  }

  if (copyReviewerReportBtn) {
    copyReviewerReportBtn.addEventListener("click", () => {
      copyReviewerReport();
    });
  }

  const exportLedgerBtn = document.getElementById("zeta-export-ledger");
  if (exportLedgerBtn) {
    exportLedgerBtn.addEventListener("click", () => {
      const report = currentPrecheckReport;
      const events = report?.reviewLedger || [];
      const exportData = {
        exportedAt: new Date().toISOString(),
        score: report?.score ?? null,
        certification: report?.certification?.label ?? null,
        mode: report?.demoMode ? "demo" : "live",
        events,
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "zeta-ledger.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
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
    console.info(`${zetaLogPrefix("popup")} keydown`, {
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
    console.info(`${zetaLogPrefix("popup")} shortcut_detected`, {
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
        console.warn(`${zetaLogPrefix("popup")} storage_change_render_error`, {
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
    runPrecheckDemo();
    return;
  }

  if (!IS_EMBEDDED) {
    publishSurface("popup");
    notifyActiveTabSurface("popup");
    window.addEventListener("beforeunload", () => {
      publishSurface("none");
    });
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
    checkBackendHealth();
    runPrecheckDemo();
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
