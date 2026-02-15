(() => {
  "use strict";

  const zeta = window.__zetaContent || (window.__zetaContent = {});
  const {
    SETTINGS_KEY,
    MODE_KEY,
    IGNORED_KEY,
    TELEMETRY_KEY,
    PANEL_SNAPSHOT_KEY,
    UI_SURFACE_KEY,
    CACHE_TTL_MS,
    DEFAULT_SETTINGS,
    SEVERITY_WEIGHT,
    clamp,
    shortHash,
    normalizeMode,
    normalizeScope,
    modeToDebounce,
    modeToLabel,
    ensureArray,
    storageSyncGet,
    storageSyncSet,
    storageLocalGet,
    storageLocalSet,
    normalizeSeverity,
    logTrace,
    DomLineAdapter,
    TextareaAdapter,
    ContentEditableAdapter,
    ZetaOverlay,
    ZetaPopover,
    ZetaPanel,
  } = zeta;

const LATEX_SECTION_LEVELS = Object.freeze({
  part: 0,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
});

const LATEX_SECTION_COMMAND_NAMES = Object.freeze(Object.keys(LATEX_SECTION_LEVELS));

const LATEX_DELIMITER_COMMAND_SPECS = Object.freeze([
  { commandName: "title", requiresBracedArg: true },
  { commandName: "author", requiresBracedArg: true },
  { commandName: "date", requiresBracedArg: true },
  { commandName: "subtitle", requiresBracedArg: true },
  { commandName: "institute", requiresBracedArg: true },
  { commandName: "thanks", requiresBracedArg: true },
  { commandName: "dedicatory", requiresBracedArg: true },
  { commandName: "keywords", requiresBracedArg: true },
  { commandName: "keyword", requiresBracedArg: true },
  { commandName: "maketitle", requiresBracedArg: false },
  { commandName: "tableofcontents", requiresBracedArg: false },
  { commandName: "listoffigures", requiresBracedArg: false },
  { commandName: "listoftables", requiresBracedArg: false },
  { commandName: "listofalgorithms", requiresBracedArg: false },
  { commandName: "listoftheorems", requiresBracedArg: false },
  { commandName: "appendix", requiresBracedArg: false },
  { commandName: "frontmatter", requiresBracedArg: false },
  { commandName: "mainmatter", requiresBracedArg: false },
  { commandName: "backmatter", requiresBracedArg: false },
  { commandName: "input", requiresBracedArg: true },
  { commandName: "include", requiresBracedArg: true },
  { commandName: "includeonly", requiresBracedArg: true },
  { commandName: "bibliography", requiresBracedArg: true },
  { commandName: "bibliographystyle", requiresBracedArg: true },
  { commandName: "addbibresource", requiresBracedArg: true },
  { commandName: "printbibliography", requiresBracedArg: false },
  { commandName: "label", requiresBracedArg: true },
  { commandName: "ref", requiresBracedArg: true },
  { commandName: "eqref", requiresBracedArg: true },
  { commandName: "pageref", requiresBracedArg: true },
  { commandName: "autoref", requiresBracedArg: true },
  { commandName: "cref", requiresBracedArg: true },
  { commandName: "Cref", requiresBracedArg: true },
  { commandName: "cite", requiresBracedArg: true },
  { commandName: "citet", requiresBracedArg: true },
  { commandName: "citep", requiresBracedArg: true },
  { commandName: "citealt", requiresBracedArg: true },
  { commandName: "citealp", requiresBracedArg: true },
  { commandName: "url", requiresBracedArg: true },
  { commandName: "href", requiresBracedArg: true },
  { commandName: "footnote", requiresBracedArg: true },
  { commandName: "includegraphics", requiresBracedArg: true },
  { commandName: "newpage", requiresBracedArg: false },
  { commandName: "clearpage", requiresBracedArg: false },
  { commandName: "cleardoublepage", requiresBracedArg: false },
  { commandName: "pagebreak", requiresBracedArg: false },
  { commandName: "linebreak", requiresBracedArg: false },
  { commandName: "smallskip", requiresBracedArg: false },
  { commandName: "medskip", requiresBracedArg: false },
  { commandName: "bigskip", requiresBracedArg: false },
  { commandName: "vspace", requiresBracedArg: true },
  { commandName: "hspace", requiresBracedArg: true },
]);

function escapeRegexLiteral(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLatexCommandRegex(commandName, requiresBracedArg) {
  const escaped = escapeRegexLiteral(commandName);
  const optionalArgPattern = "(?:\\s*\\[[^\\]]*\\])?";
  const mandatoryBracedPattern = "\\s*\\{[^{}]*\\}";
  if (requiresBracedArg) {
    return new RegExp(`\\\\${escaped}\\*?${optionalArgPattern}${mandatoryBracedPattern}`, "g");
  }
  return new RegExp(`\\\\${escaped}\\*?${optionalArgPattern}`, "g");
}

const LATEX_SECTION_BLOCK_REGEX = new RegExp(
  `\\\\(${LATEX_SECTION_COMMAND_NAMES.map(escapeRegexLiteral).join("|")})\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\}`,
  "g"
);

const LATEX_DELIMITER_COMMAND_REGEX_SPECS = Object.freeze(
  LATEX_DELIMITER_COMMAND_SPECS.map((spec) => ({
    commandName: String(spec.commandName || "").toLowerCase(),
    regex: buildLatexCommandRegex(spec.commandName, !!spec.requiresBracedArg),
  }))
);

const NON_ANALYZABLE_LATEX_COMMANDS = new Set([
  "documentclass",
  "usepackage",
  "begin",
  "end",
  "newcommand",
  "renewcommand",
  "providecommand",
  "declaremathoperator",
  ...LATEX_SECTION_COMMAND_NAMES.map((name) => String(name || "").toLowerCase()),
  ...LATEX_DELIMITER_COMMAND_REGEX_SPECS.map((spec) => spec.commandName),
  "label",
  "ref",
  "eqref",
  "pageref",
  "autoref",
  "cref",
  "cite",
  "citet",
  "citep",
]);

class ZetaApp {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.ignoredKeys = new Set();

    this.overlay = new ZetaOverlay();
    this.popover = new ZetaPopover(
      (issue) => this.applyIssue(issue),
      (issue) => this.ignoreIssue(issue)
    );

    this.panel = new ZetaPanel({
      onTogglePanel: (open) => this.togglePanel(open),
      onRunNow: () => this.runAnalysis("manual", true),
      onRegenerate: () => this.runAnalysis("regenerate", true),
      onUndoLast: () => this.undoLastAction(),
      onClearHistory: () => this.clearActivityHistory(),
      onScopeChange: (scope) => this.updateSettings({ scope: normalizeScope(scope) }, true),
      onModeChange: (mode) => this.updateSettings({ mode: normalizeMode(mode) }, true),
      onSaveSettings: (next) => this.saveSettingsFromPanel(next),
      onApplyIssue: (index) => this.applyIssueByIndex(index),
      onIgnoreIssue: (index) => this.ignoreIssueByIndex(index),
      onFocusIssue: (index) => this.focusIssue(index),
      onNextIssue: () => this.focusNextIssue(),
      onPrevIssue: () => this.focusPrevIssue(),
    });

    this.adapters = [];
    this.activeAdapter = null;
    this.scanTimer = null;
    this.scheduledTimer = null;
    this.snapshotSyncTimer = null;
    this.activeRequestId = 0;
    this.lastAnalyzedSignature = "";
    this.lastRun = null;
    this.focusedIssueIndex = -1;
    this.responseCache = new Map();
    this.sentenceCache = new Map();
    this.chunkTree = null;
    this.activeChunkId = null;
    this.lastInferenceMs = null;
    this.lastTelemetry = null;
    this.lastPanelSnapshotSignature = "";
    this.currentHealthScore = 100;
    this.currentHealthBreakdown = {
      score: 100,
      issueCount: 0,
      severityCounts: { error: 0, warning: 0, info: 0, unknown: 0 },
      rawSeverityPenalty: 0,
      normalizedSeverityPenalty: 0,
      densityPenalty: 0,
      pendingPenalty: 0,
      cachedSentences: 0,
      pendingSentences: 0,
      analyzedSentences: 0,
      coverageRatio: 1,
    };
    this.currentSentenceCached = 0;
    this.currentSentencePending = 0;
    this.currentMacroList = [];
    this.activityEntries = [];
    this.undoStack = [];
    this.lastShortcut = "";
    this.shortcutPulseId = 0;

    this.boundSelectionChange = this.handleSelectionChange.bind(this);
    this.boundFocusIn = this.handleFocusIn.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundScheduleByScroll = this.scheduleRender.bind(this);
    this.boundStorageChange = this.handleStorageChange.bind(this);
    this.boundRuntimeMessage = this.handleRuntimeMessage.bind(this);
  }

  async init() {
    await this.loadSettings();
    this.panel.setSettings(this.settings);
    this.panel.setOpen(!!this.settings.panelOpen);
    storageLocalSet({
      [UI_SURFACE_KEY]: {
        surface: "none",
        updatedAt: Date.now(),
      },
    });
    this.panel.setStatus("idle", "Idle");
    this.panel.setGlobalState("ready", "global · waiting");
    this.panel.setInferenceTime(null, 0);
    this.setSentenceStats(0, 0);
    this.panel.setHealth(100);
    this.panel.setActivity(this.activityEntries, false);
    this.persistTelemetry({
      status: "idle",
      pendingCount: 0,
      inferenceMs: null,
    });
    this.persistPanelSnapshot({
      status: "idle",
      issueCount: 0,
      chunkTree: null,
      activeChunkId: null,
    });

    this.refreshAdapters();
    this.activateInitialAdapter();
    this.attachGlobalListeners();

    if (this.activeAdapter) {
      this.scheduleAnalysis("init", true);
    } else {
      this.panel.setStatus("idle", "Focus a text editor to start.");
      this.panel.setGlobalState("offline", "global · no editor");
      this.persistTelemetry({
        status: "offline",
        pendingCount: 0,
      });
    }

    this.scanTimer = window.setInterval(() => {
      this.refreshAdapters();
    }, 1800);
  }

  async loadSettings() {
    const syncValues = await storageSyncGet({
      [SETTINGS_KEY]: DEFAULT_SETTINGS,
      [MODE_KEY]: DEFAULT_SETTINGS.mode,
    });

    const localValues = await storageLocalGet({
      [IGNORED_KEY]: [],
    });

    const merged = {
      ...DEFAULT_SETTINGS,
      ...(syncValues[SETTINGS_KEY] || {}),
    };
    merged.mode = normalizeMode(syncValues[MODE_KEY] || merged.mode);
    merged.scope = normalizeScope(merged.scope);
    merged.theme = "light";
    merged.requestTimeoutMs = clamp(Number(merged.requestTimeoutMs) || DEFAULT_SETTINGS.requestTimeoutMs, 2000, 120000);
    merged.retries = clamp(Number(merged.retries) || 0, 0, 4);
    merged.backendUrl = merged.backendUrl || DEFAULT_SETTINGS.backendUrl;
    merged.notationStrictness = ["relaxed", "balanced", "strict"].includes(merged.notationStrictness)
      ? merged.notationStrictness
      : "balanced";
    // Always start minimized to keep the editor unobstructed by default.
    merged.panelOpen = false;

    this.settings = merged;
    this.ignoredKeys = new Set(ensureArray(localValues[IGNORED_KEY]).filter(Boolean));
  }

  attachGlobalListeners() {
    document.addEventListener("selectionchange", this.boundSelectionChange, true);
    document.addEventListener("focusin", this.boundFocusIn, true);
    document.addEventListener("keydown", this.boundKeyDown, true);

    window.addEventListener("scroll", this.boundScheduleByScroll, true);
    window.addEventListener("resize", this.boundScheduleByScroll);

    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener(this.boundStorageChange);
    }
    if (chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(this.boundRuntimeMessage);
    }
  }

  detachGlobalListeners() {
    document.removeEventListener("selectionchange", this.boundSelectionChange, true);
    document.removeEventListener("focusin", this.boundFocusIn, true);
    document.removeEventListener("keydown", this.boundKeyDown, true);

    window.removeEventListener("scroll", this.boundScheduleByScroll, true);
    window.removeEventListener("resize", this.boundScheduleByScroll);

    if (chrome?.storage?.onChanged) {
      chrome.storage.onChanged.removeListener(this.boundStorageChange);
    }
    if (chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(this.boundRuntimeMessage);
    }
  }

  handleRuntimeMessage(message, _sender, sendResponse) {
    if (message && message.type === "zeta-ui-surface") {
      const surface = String(message.surface || "").toLowerCase();
      console.info("[zeta:content] ui_surface_received", {
        ts: new Date().toISOString(),
        surface,
      });
      if (surface === "popup" && this.settings.panelOpen) {
        this.settings.panelOpen = false;
        this.panel.setOpen(false);
      }
      sendResponse?.({ ok: true, surface });
      return true;
    }

    if (!message || message.type !== "zeta-popup-action") {
      return false;
    }

    const action = String(message.action || "");
    console.info("[zeta:content] popup_action_received", {
      ts: new Date().toISOString(),
      action,
    });

    const run = async () => {
      if (action === "refresh-checker") {
        this.runAnalysis("popup-macro", true);
        this.addActivity("Macro: refresh checker.", "info");
        return;
      }
      if (action === "undo-last") {
        await this.undoLastAction();
        return;
      }
      if (action === "clear-history") {
        this.clearActivityHistory();
        this.addActivity("Macro: cleared activity history.", "info");
        return;
      }
      if (action === "next-issue") {
        this.focusNextIssue();
        this.addActivity("Macro: focused next issue.", "info");
        return;
      }
      if (action === "prev-issue") {
        this.focusPrevIssue();
        this.addActivity("Macro: focused previous issue.", "info");
        return;
      }
      this.addActivity(`Macro not recognized: ${action}`, "error");
    };

    run()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message || error || "Unknown macro action error"),
        });
      });
    return true;
  }

  handleStorageChange(changes, areaName) {
    if (areaName === "local" && changes[UI_SURFACE_KEY]?.newValue) {
      const nextSurface = String(changes[UI_SURFACE_KEY].newValue.surface || "").toLowerCase();
      if (nextSurface === "popup" && this.settings.panelOpen) {
        this.settings.panelOpen = false;
        this.panel.setOpen(false);
      }
      return;
    }

    if (areaName !== "sync") {
      return;
    }

    let changed = false;

    if (changes[MODE_KEY]) {
      const nextMode = normalizeMode(changes[MODE_KEY].newValue);
      if (nextMode !== this.settings.mode) {
        this.settings.mode = nextMode;
        changed = true;
      }
    }

    if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue) {
      const nextSettings = {
        ...this.settings,
        ...changes[SETTINGS_KEY].newValue,
      };
      nextSettings.mode = normalizeMode(nextSettings.mode);
      nextSettings.scope = normalizeScope(nextSettings.scope);
      nextSettings.theme = "light";
      nextSettings.panelOpen = this.settings.panelOpen;
      this.settings = nextSettings;
      changed = true;
    }

    if (changed) {
      this.panel.setSettings(this.settings);
      this.panel.setOpen(!!this.settings.panelOpen);
      this.scheduleAnalysis("storage-change", true);
    }
  }

  refreshAdapters() {
    const existingRoots = new Set(this.adapters.map((adapter) => adapter.root));

    const roots = [];
    const pushUnique = (element) => {
      if (!element || roots.includes(element)) {
        return;
      }
      if (!element.isConnected) {
        return;
      }
      if (element.closest(".zeta-shell")) {
        return;
      }
      if (
        element.getAttribute?.("contenteditable") === "true" &&
        element.closest(".cm-editor, .ace_editor")
      ) {
        return;
      }
      roots.push(element);
    };

    document.querySelectorAll(".cm-editor").forEach(pushUnique);
    document.querySelectorAll(".ace_editor").forEach(pushUnique);
    document.querySelectorAll("textarea, input[type='text'], input[type='search']").forEach(pushUnique);
    document.querySelectorAll("[contenteditable='true']").forEach(pushUnique);

    for (const adapter of this.adapters.slice()) {
      if (!adapter.isConnected() || !roots.includes(adapter.root)) {
        adapter.destroy();
        this.adapters = this.adapters.filter((item) => item !== adapter);
        if (this.activeAdapter === adapter) {
          this.activeAdapter = null;
        }
      }
    }

    for (const root of roots) {
      if (existingRoots.has(root)) {
        continue;
      }

      const adapter = this.buildAdapter(root);
      if (!adapter) {
        continue;
      }

      adapter.setupObservers(
        () => {
          if (adapter === this.activeAdapter) {
            this.scheduleChunkSnapshotSync("typing");
            if (this.settings.checkOnType) {
              this.scheduleAnalysis("typing");
            }
            this.scheduleRender();
          }
        },
        () => {
          if (adapter === this.activeAdapter) {
            this.scheduleRender();
          }
        }
      );

      this.adapters.push(adapter);
    }

    if (!this.activeAdapter) {
      this.activateInitialAdapter();
      if (!this.activeAdapter) {
        this.panel.setGlobalState("offline", "global · no editor");
      }
    }
  }

  buildAdapter(root) {
    if (root.matches(".cm-editor")) {
      const content = root.querySelector(".cm-content");
      const scroller = root.querySelector(".cm-scroller") || root;
      if (!content) {
        return null;
      }
      return new DomLineAdapter(root, content, ".cm-line", scroller);
    }

    if (root.matches(".ace_editor")) {
      const content = root.querySelector(".ace_text-layer");
      const scroller = root.querySelector(".ace_scroller") || root;
      if (!content) {
        return null;
      }
      return new DomLineAdapter(root, content, ".ace_line", scroller);
    }

    if (root instanceof HTMLTextAreaElement || root instanceof HTMLInputElement) {
      return new TextareaAdapter(root);
    }

    if (root.getAttribute("contenteditable") === "true") {
      return new ContentEditableAdapter(root);
    }

    return null;
  }

  activateInitialAdapter() {
    const focused = document.activeElement;
    if (focused instanceof Element) {
      const fromFocus = this.adapters.find((adapter) => adapter.containsNode(focused));
      if (fromFocus) {
        this.setActiveAdapter(fromFocus);
        return;
      }
    }

    const first = this.adapters[0];
    if (first) {
      this.setActiveAdapter(first);
    }
  }

  setActiveAdapter(adapter) {
    if (!adapter || this.activeAdapter === adapter) {
      return;
    }
    this.activeAdapter = adapter;
    this.panel.setStatus("idle", `Ready on ${adapter.constructor.name}`);
    this.panel.setGlobalState("ready", "global · editor connected");
    this.scheduleChunkSnapshotSync("adapter-switch");
    this.scheduleAnalysis("adapter-switch", true);
  }

  handleFocusIn(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const adapter = this.adapters.find((item) => item.containsNode(target));
    if (adapter) {
      this.setActiveAdapter(adapter);
    }
  }

  handleSelectionChange() {
    if (!this.activeAdapter || !this.lastRun) {
      return;
    }
    this.syncPopoverWithCaret();
  }

  handleKeyDown(event) {
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "");
    const metaHeld = event.metaKey || event.getModifierState?.("Meta");
    const ctrlHeld = event.ctrlKey || event.getModifierState?.("Control");
    const altHeld = event.altKey || event.getModifierState?.("Alt");
    const shiftHeld = event.shiftKey || event.getModifierState?.("Shift");
    const ts = new Date().toISOString();

    console.info("[zeta:content] keydown", {
      ts,
      key: event.key,
      code,
      alt: altHeld,
      shift: shiftHeld,
      meta: metaHeld,
      ctrl: ctrlHeld,
      target: event.target && event.target.constructor ? event.target.constructor.name : "unknown",
    });

    if (altHeld && shiftHeld && (key === "n" || code === "KeyN")) {
      event.preventDefault();
      console.info("[zeta:content] shortcut_match", {
        ts,
        shortcut: "Alt+Shift+N",
        action: "next-issue",
      });
      this.markShortcutTriggered("Alt+Shift+N");
      this.focusNextIssue();
      return;
    }

    if (altHeld && shiftHeld && (key === "p" || code === "KeyP")) {
      event.preventDefault();
      console.info("[zeta:content] shortcut_match", {
        ts,
        shortcut: "Alt+Shift+P",
        action: "prev-issue",
      });
      this.markShortcutTriggered("Alt+Shift+P");
      this.focusPrevIssue();
      return;
    }

    if (altHeld && shiftHeld && (key === "a" || code === "KeyA")) {
      event.preventDefault();
      if (this.focusedIssueIndex >= 0) {
        this.applyIssueByIndex(this.focusedIssueIndex);
      }
      return;
    }

    if (altHeld && shiftHeld && (key === "u" || code === "KeyU")) {
      event.preventDefault();
      console.info("[zeta:content] shortcut_match", {
        ts,
        shortcut: "Alt+Shift+U",
        action: "undo-last",
      });
      this.markShortcutTriggered("Alt+Shift+U");
      this.undoLastAction();
      return;
    }

    if (altHeld && shiftHeld && (key === "r" || code === "KeyR")) {
      event.preventDefault();
      console.info("[zeta:content] shortcut_match", {
        ts,
        shortcut: "Alt+Shift+R",
        action: "refresh-checker",
      });
      this.markShortcutTriggered("Alt+Shift+R");
      this.runAnalysis("shortcut-refresh", true);
      return;
    }

    if (altHeld && shiftHeld && (key === "h" || code === "KeyH")) {
      event.preventDefault();
      console.info("[zeta:content] shortcut_match", {
        ts,
        shortcut: "Alt+Shift+H",
        action: "clear-history",
      });
      this.markShortcutTriggered("Alt+Shift+H");
      this.clearActivityHistory();
      return;
    }

    if ((metaHeld || ctrlHeld) && (key === "enter" || code === "Enter")) {
      event.preventDefault();
      console.info("[zeta:content] shortcut_match", {
        ts,
        shortcut: "Ctrl/Cmd+Enter",
        action: "refresh-checker",
      });
      this.markShortcutTriggered("Ctrl/Cmd+Enter");
      this.runAnalysis("shortcut", true);
    }
  }

  markShortcutTriggered(shortcut) {
    this.lastShortcut = String(shortcut || "");
    this.shortcutPulseId = Date.now();
    this.persistPanelSnapshot({
      lastShortcut: this.lastShortcut,
      shortcutPulseId: this.shortcutPulseId,
    });
  }

  async updateSettings(nextPartial, rerun) {
    const next = {
      ...this.settings,
      ...nextPartial,
    };
    next.mode = normalizeMode(next.mode);
    next.scope = normalizeScope(next.scope);
    next.theme = "light";

    await storageSyncSet({
      [SETTINGS_KEY]: next,
      [MODE_KEY]: next.mode,
    });

    this.settings = next;
    this.panel.setSettings(this.settings);

    if (rerun) {
      this.scheduleAnalysis("settings", true);
    }
  }

  async saveSettingsFromPanel(nextValues) {
    const merged = {
      ...this.settings,
      backendUrl: nextValues.backendUrl || this.settings.backendUrl,
      requestTimeoutMs: clamp(Number(nextValues.requestTimeoutMs) || this.settings.requestTimeoutMs, 2000, 120000),
      retries: clamp(Number(nextValues.retries) || 0, 0, 4),
      checkOnType: !!nextValues.checkOnType,
      notationStrictness: ["relaxed", "balanced", "strict"].includes(nextValues.notationStrictness)
        ? nextValues.notationStrictness
        : "balanced",
    };

    await this.updateSettings(merged, false);
    this.panel.setStatus("idle", "Settings saved.");
    this.addActivity("Saved panel settings.", "info");
    this.scheduleAnalysis("settings-save", true);
  }

  async togglePanel(forceOpen) {
    const nextOpen = !!forceOpen;
    this.settings.panelOpen = nextOpen;
    this.panel.setOpen(nextOpen);
    storageLocalSet({
      [UI_SURFACE_KEY]: {
        surface: nextOpen ? "side" : "none",
        updatedAt: Date.now(),
      },
    });
    if (nextOpen) {
      this.scheduleChunkSnapshotSync("typing");
    }
  }

  setSentenceStats(cachedCount, pendingCount) {
    this.currentSentenceCached = Math.max(0, Number(cachedCount) || 0);
    this.currentSentencePending = Math.max(0, Number(pendingCount) || 0);
    const nextHealth = this.computeHealthBreakdown(this.lastRun?.issues || []);
    this.currentHealthScore = nextHealth.score;
    this.currentHealthBreakdown = nextHealth;
    this.panel.setSentenceStats(this.currentSentenceCached, this.currentSentencePending);
    this.panel.setHealth(this.currentHealthScore);
    this.persistPanelSnapshot();
  }

  extractMacroNames(text) {
    const source = String(text || "");
    if (!source) {
      return [];
    }

    const names = new Set();
    const patterns = [
      /\\(?:re)?newcommand\s*\{\\([A-Za-z@]+)\}/g,
      /\\providecommand\s*\{\\([A-Za-z@]+)\}/g,
      /\\def\s*\\([A-Za-z@]+)/g,
      /\\DeclareMathOperator\s*\{\\([A-Za-z@]+)\}/g,
    ];

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const name = String(match[1] || "").trim();
        if (name) {
          names.add(`\\${name}`);
        }
      }
    }

    return Array.from(names).sort().slice(0, 80);
  }

  persistPanelSnapshot(partial = {}) {
    const serializedChunkTree = this.serializeChunkTree(this.chunkTree);
    const next = {
      healthScore: Math.round(this.currentHealthScore),
      healthBreakdown: this.currentHealthBreakdown,
      sentenceCached: this.currentSentenceCached,
      sentencePending: this.currentSentencePending,
      issueCount: ensureArray(this.lastRun?.issues).length,
      inferenceMs: Number.isFinite(this.lastInferenceMs) ? Math.round(this.lastInferenceMs) : null,
      status: this.lastTelemetry?.status || "idle",
      queuePending: Number(this.lastTelemetry?.pendingCount) || 0,
      activity: this.activityEntries.slice(0, 24),
      macros: this.currentMacroList.slice(0, 80),
      lastShortcut: this.lastShortcut,
      shortcutPulseId: this.shortcutPulseId,
      chunkTree: serializedChunkTree,
      activeChunkId: this.activeChunkId,
      updatedAt: Date.now(),
      ...partial,
    };

    const signature = shortHash(
      JSON.stringify({
        healthScore: next.healthScore,
        healthBreakdown: next.healthBreakdown
          ? `${next.healthBreakdown.score}|${next.healthBreakdown.issueCount}|` +
            `${next.healthBreakdown.normalizedSeverityPenalty}|${next.healthBreakdown.densityPenalty}|` +
            `${next.healthBreakdown.pendingPenalty}|${next.healthBreakdown.cachedSentences}|` +
            `${next.healthBreakdown.pendingSentences}`
          : null,
        sentenceCached: next.sentenceCached,
        sentencePending: next.sentencePending,
        issueCount: next.issueCount,
        inferenceMs: next.inferenceMs,
        status: next.status,
        queuePending: next.queuePending,
        activity: next.activity.map((entry) => `${entry.id}|${entry.level}|${entry.message}`),
        macros: next.macros,
        lastShortcut: next.lastShortcut,
        shortcutPulseId: next.shortcutPulseId,
        chunkTreeHash: shortHash(
          JSON.stringify(
            ensureArray(next.chunkTree?.chunks).map((chunk) => (
              `${chunk.chunkId}|${chunk.parentId || ""}|${chunk.start}|${chunk.end}|${chunk.type || ""}|` +
              `${shortHash(String(chunk.text || ""))}|` +
              `${ensureArray(chunk.sentences).map((sentence) => (
                `${sentence.start}|${sentence.end}|${shortHash(String(sentence.text || ""))}`
              )).join(";")}`
            ))
          )
        ),
        activeChunkId: next.activeChunkId,
      })
    );

    if (signature === this.lastPanelSnapshotSignature) {
      return;
    }

    this.lastPanelSnapshotSignature = signature;
    storageLocalSet({
      [PANEL_SNAPSHOT_KEY]: next,
    });
  }

  serializeChunkTree(chunkTree) {
    if (!chunkTree || typeof chunkTree !== "object") {
      return null;
    }

    const chunks = ensureArray(chunkTree.chunks).map((chunk) => ({
      chunkId: chunk.chunkId,
      parentId: chunk.parentId || null,
      type: chunk.type || "text",
      start: Number.isInteger(chunk.start) ? chunk.start : 0,
      end: Number.isInteger(chunk.end) ? chunk.end : 0,
      text: String(chunk.text || ""),
      sectionName: chunk.sectionName || null,
      sectionTitle: chunk.sectionTitle || null,
      envName: chunk.envName || null,
      commandName: chunk.commandName || null,
      sentences: ensureArray(chunk.sentences).map((sentence) => ({
        sentenceId: sentence.sentenceId || null,
        start: Number.isInteger(sentence.start) ? sentence.start : 0,
        end: Number.isInteger(sentence.end) ? sentence.end : 0,
        text: String(sentence.text || ""),
      })),
    }));

    return {
      chunks,
      activeChunkId: chunkTree.activeChunkId || null,
      leafCount: ensureArray(chunkTree.leafChunks).length,
    };
  }

  persistTelemetry(partial = {}) {
    const next = {
      inferenceMs: Number.isFinite(this.lastInferenceMs) ? Math.round(this.lastInferenceMs) : null,
      status: "idle",
      pendingCount: 0,
      mode: this.settings.mode,
      scope: this.settings.scope,
      updatedAt: Date.now(),
      ...partial,
    };

    const sameAsLast =
      this.lastTelemetry &&
      this.lastTelemetry.inferenceMs === next.inferenceMs &&
      this.lastTelemetry.status === next.status &&
      this.lastTelemetry.pendingCount === next.pendingCount &&
      this.lastTelemetry.mode === next.mode &&
      this.lastTelemetry.scope === next.scope;
    if (sameAsLast) {
      return;
    }

    this.lastTelemetry = next;
    storageLocalSet({
      [TELEMETRY_KEY]: next,
    });
    this.persistPanelSnapshot({
      inferenceMs: next.inferenceMs,
      status: next.status,
      queuePending: next.pendingCount,
    });
  }

  scheduleAnalysis(reason, immediate = false) {
    if (!this.activeAdapter) {
      return;
    }

    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }

    const delay = immediate ? 0 : modeToDebounce(this.settings.mode);
    this.scheduledTimer = window.setTimeout(() => {
      this.scheduledTimer = null;
      this.runAnalysis(reason, immediate);
    }, delay);
  }

  scheduleChunkSnapshotSync(reason) {
    if (!this.activeAdapter) {
      return;
    }
    if (this.snapshotSyncTimer) {
      clearTimeout(this.snapshotSyncTimer);
      this.snapshotSyncTimer = null;
    }
    const delay = reason === "typing" ? 90 : 0;
    this.snapshotSyncTimer = window.setTimeout(() => {
      this.snapshotSyncTimer = null;
      this.syncChunkSnapshotFromEditor(reason);
    }, delay);
  }

  syncChunkSnapshotFromEditor(reason = "typing") {
    const adapter = this.activeAdapter;
    if (!adapter || !adapter.isConnected()) {
      return;
    }
    const effectiveScope = this.resolveScopeForReason(reason);
    const snapshot = adapter.getScopeSnapshot(effectiveScope);
    const scopeText = String(snapshot.text || "");

    if (!scopeText.trim()) {
      this.chunkTree = null;
      this.activeChunkId = null;
      this.persistPanelSnapshot({
        chunkTree: null,
        activeChunkId: null,
      });
      return;
    }

    const caretOffset = this.resolveCaretOffsetInScope(snapshot, adapter);
    const chunkWindow = this.resolveChunkWindow(snapshot, caretOffset);
    this.chunkTree = this.buildChunkTree(
      chunkWindow.text,
      chunkWindow.caretOffset,
      chunkWindow.baseOffset
    );
    this.activeChunkId = this.chunkTree?.activeChunkId || null;
    this.persistPanelSnapshot({
      chunkTree: this.serializeChunkTree(this.chunkTree),
      activeChunkId: this.activeChunkId,
    });
  }

  resolveScopeForReason(reason) {
    // Always analyze the full editor while typing to keep backend context complete.
    if (reason === "typing" || reason === "init" || reason === "adapter-switch") {
      return "document";
    }
    return normalizeScope(this.settings.scope);
  }

  async runAnalysis(reason, force = false) {
    const adapter = this.activeAdapter;
    if (!adapter || !adapter.isConnected()) {
      this.panel.setStatus("error", "No active editor.");
      this.panel.setGlobalState("offline", "global · no editor");
      this.persistTelemetry({
        status: "offline",
        pendingCount: 0,
      });
      return;
    }

    const effectiveScope = this.resolveScopeForReason(reason);
    const snapshot = adapter.getScopeSnapshot(effectiveScope);
    this.currentMacroList = this.extractMacroNames(snapshot.context || snapshot.text || "");
    const scopeText = String(snapshot.text || "");
    logTrace("analysis_begin", {
      reason,
      force,
      requestedScope: this.settings.scope,
      effectiveScope,
      chars: scopeText.length,
    });
    if (!scopeText.trim()) {
      this.lastRun = {
        snapshot,
        diagnostics: [],
        issues: [],
      };
      this.chunkTree = null;
      this.activeChunkId = null;
      this.focusedIssueIndex = -1;
      this.panel.setStatus("idle", "Nothing to analyze in this scope.");
      this.panel.setIssues([], -1);
      this.panel.setHealth(100);
      this.panel.setGlobalState("ready", "global · waiting");
      this.panel.setInferenceTime(this.lastInferenceMs, 0);
      this.setSentenceStats(0, 0);
      this.persistTelemetry({
        status: "idle",
        pendingCount: 0,
      });
      this.persistPanelSnapshot({
        healthScore: 100,
        healthBreakdown: this.computeHealthBreakdown([]),
        issueCount: 0,
        chunkTree: null,
        activeChunkId: null,
      });
      this.overlay.clear();
      this.popover.close();
      return;
    }

    const proseSpans = this.extractProseSpans(scopeText);
    const caretOffset = this.resolveCaretOffsetInScope(snapshot, adapter);
    const chunkWindow = this.resolveChunkWindow(snapshot, caretOffset);
    this.chunkTree = this.buildChunkTree(
      chunkWindow.text,
      chunkWindow.caretOffset,
      chunkWindow.baseOffset
    );
    this.activeChunkId = this.chunkTree?.activeChunkId || null;
    const localIssues = this.detectLocalMathTypos(scopeText, proseSpans);
    const sentencePlan = this.buildSentencePlan(snapshot, force, proseSpans);
    logTrace("analysis_plan", {
      cachedSentences: sentencePlan.cachedCount,
      pendingSentences: sentencePlan.pending.length,
      localIssues: localIssues.length,
    });
    const signature = shortHash(
      JSON.stringify({
        scope: snapshot.scope,
        mode: this.settings.mode,
        notationStrictness: this.settings.notationStrictness,
        backendUrl: this.settings.backendUrl,
        signatures: sentencePlan.activeSignatures,
      })
    );

    this.lastAnalyzedSignature = signature;
    const requestId = this.activeRequestId + 1;
    this.activeRequestId = requestId;

    const rerenderFromCache = () => {
      const cachedSentenceIssues = this.collectSentenceIssues(sentencePlan.activeKeys);
      const mergedIssues = this.mergeIssues(localIssues, cachedSentenceIssues)
        .filter((issue) => !this.ignoredKeys.has(issue.key));

      this.lastRun = {
        snapshot,
        diagnostics: [],
        issues: mergedIssues,
      };

      if (mergedIssues.length === 0) {
        this.focusedIssueIndex = -1;
      } else if (this.focusedIssueIndex < 0) {
        this.focusedIssueIndex = 0;
      } else {
        this.focusedIssueIndex = clamp(this.focusedIssueIndex, 0, mergedIssues.length - 1);
      }

      this.renderState(this.lastRun);
    };

    this.setSentenceStats(sentencePlan.cachedCount, sentencePlan.pending.length);
    this.panel.setInferenceTime(this.lastInferenceMs, sentencePlan.pending.length);
    this.persistTelemetry({
      status: sentencePlan.pending.length > 0 ? "analyzing" : "ready",
      pendingCount: sentencePlan.pending.length,
    });
    rerenderFromCache();

    if (sentencePlan.pending.length === 0) {
      this.panel.setStatus("success", "All cached sentences are up to date.");
      this.panel.setGlobalState("ready", "global · synced");
      this.persistTelemetry({
        status: "ready",
        pendingCount: 0,
      });
      this.syncPopoverWithCaret();
      return;
    }

    this.panel.setGlobalState(
      "analyzing",
      `global · analyzing ${sentencePlan.pending.length} sentence${sentencePlan.pending.length === 1 ? "" : "s"}`
    );

    for (let i = 0; i < sentencePlan.pending.length; i += 1) {
      if (requestId !== this.activeRequestId) {
        return;
      }

      const sentenceEntry = sentencePlan.pending[i];
      const remaining = sentencePlan.pending.length - i;
      logTrace("sentence_check_start", {
        index: i + 1,
        total: sentencePlan.pending.length,
        sentenceKey: sentenceEntry.key,
        chars: sentenceEntry.text.length,
      });
      this.panel.setStatus(
        "analyzing",
        `Analyzing sentence ${i + 1}/${sentencePlan.pending.length} (${modeToLabel(this.settings.mode)})...`
      );
      this.panel.setInferenceTime(this.lastInferenceMs, remaining);

      await this.analyzeSentenceEntry(sentenceEntry, snapshot, reason);
      logTrace("sentence_check_done", {
        sentenceKey: sentenceEntry.key,
        status: sentenceEntry.status,
        inferenceMs: sentenceEntry.inferenceMs,
        issueCount: ensureArray(sentenceEntry.issues).length,
      });

      if (requestId !== this.activeRequestId) {
        return;
      }

      if (sentenceEntry.activityLog && sentenceEntry.shouldAnalyze) {
        this.addActivity(
          sentenceEntry.activityLog.message,
          sentenceEntry.activityLog.level,
          null,
          sentenceEntry.activityLog.detailText
        );
        sentenceEntry.activityLog = null;
      }

      const pendingLeft = sentencePlan.pending.length - i - 1;
      this.setSentenceStats(sentencePlan.cachedCount, pendingLeft);
      this.panel.setInferenceTime(this.lastInferenceMs, pendingLeft);
      this.persistTelemetry({
        status: pendingLeft > 0 ? "analyzing" : "ready",
        pendingCount: pendingLeft,
      });
      rerenderFromCache();
    }

    const finalIssues = ensureArray(this.lastRun?.issues);
    const hasError = finalIssues.some((issue) => normalizeSeverity(issue.severity) === "error");

    this.panel.setStatus(
      hasError ? "error" : "success",
      hasError ? "Completed with actionable feedback." : "Check complete."
    );
    this.panel.setGlobalState(hasError ? "error" : "ready", hasError ? "global · review needed" : "global · synced");
    this.persistTelemetry({
      status: hasError ? "error" : "ready",
      pendingCount: 0,
    });

    if (reason !== "typing" || hasError) {
      this.addActivity(
        hasError
          ? `Completed check with ${finalIssues.length} feedback items needing attention.`
          : `Completed check with ${finalIssues.length} feedback items.`,
        hasError ? "error" : "success"
      );
    }

    this.syncPopoverWithCaret();
  }

  buildSentencePlan(snapshot, force, proseSpans) {
    const segments = this.collectInnermostSentenceSegments(snapshot, proseSpans);
    const now = Date.now();
    const activeKeys = [];
    const activeSignatures = [];
    const pending = [];
    const occurrenceByBase = new Map();

    for (const segment of segments) {
      const sentenceText = String(segment.text || "").trim();
      if (!sentenceText) {
        continue;
      }

      const chunkKey = String(segment.chunkId || "scope");
      const base = shortHash(`${chunkKey}|${sentenceText}`);
      const occurrence = occurrenceByBase.get(base) || 0;
      occurrenceByBase.set(base, occurrence + 1);
      const key = `${chunkKey}:${base}:${occurrence}`;
      const shouldAnalyze = sentenceText.endsWith(".");

      const signature = shortHash(
        JSON.stringify({
          chunkId: chunkKey,
          text: sentenceText,
          mode: this.settings.mode,
          notationStrictness: this.settings.notationStrictness,
          backendUrl: this.settings.backendUrl,
          shouldAnalyze,
        })
      );

      let entry = this.sentenceCache.get(key);
      if (!entry || entry.signature !== signature) {
        entry = {
          key,
          signature,
          text: sentenceText,
          start: segment.start,
          end: segment.end,
          chunkId: segment.chunkId || null,
          shouldAnalyze,
          status: "pending",
          issues: [],
          diagnostics: [],
          hasError: false,
          inferenceMs: null,
          updatedAt: 0,
          lastSeenAt: now,
        };
        this.sentenceCache.set(key, entry);
      } else {
        entry.text = sentenceText;
        entry.start = segment.start;
        entry.end = segment.end;
        entry.chunkId = segment.chunkId || null;
        entry.shouldAnalyze = shouldAnalyze;
        entry.lastSeenAt = now;
      }

      if (!shouldAnalyze) {
        entry.status = "skipped";
        entry.issues = [];
        entry.diagnostics = [];
        entry.hasError = false;
        entry.updatedAt = now;
        continue;
      }

      const stale = now - (entry.updatedAt || 0) > CACHE_TTL_MS;
      const needsFetch = force || entry.status === "pending" || stale;
      if (needsFetch) {
        entry.status = "pending";
        pending.push(entry);
      }

      activeKeys.push(key);
      activeSignatures.push(signature);
    }

    const activeSet = new Set(activeKeys);
    for (const [key, entry] of this.sentenceCache.entries()) {
      if (activeSet.has(key)) {
        continue;
      }
      if (now - (entry.lastSeenAt || 0) > 5 * 60 * 1000) {
        this.sentenceCache.delete(key);
      }
    }

    return {
      activeKeys,
      activeSignatures,
      pending,
      cachedCount: activeKeys.length,
    };
  }

  collectInnermostSentenceSegments(snapshot, proseSpans) {
    const chunkTree = this.chunkTree;
    if (chunkTree && Array.isArray(chunkTree.leafChunks) && chunkTree.leafChunks.length > 0) {
      const activeChunkId = this.activeChunkId || chunkTree.activeChunkId || chunkTree.leafChunks[0].chunkId;
      const activeLeaf = chunkTree.leafChunks.find((chunk) => chunk.chunkId === activeChunkId) || chunkTree.leafChunks[0];
      if (activeLeaf) {
        return ensureArray(activeLeaf.sentences)
          .filter((sentence) => Number.isInteger(sentence.start) && Number.isInteger(sentence.end) && sentence.end > sentence.start)
          .map((sentence) => ({
            text: String(sentence.text || ""),
            start: sentence.start,
            end: sentence.end,
            chunkId: activeLeaf.chunkId,
          }));
      }
    }

    return this.splitLatexAwareSentences(snapshot.text, proseSpans)
      .filter((sentence) => Number.isInteger(sentence.start) && Number.isInteger(sentence.end) && sentence.end > sentence.start)
      .map((sentence) => ({
        text: String(sentence.text || ""),
        start: sentence.start,
        end: sentence.end,
        chunkId: null,
      }));
  }

  resolveCaretOffsetInScope(snapshot, adapter) {
    let caret = null;

    try {
      const visible = adapter.getVisibleTextSnapshot();
      caret = adapter.getCaretOffset(visible);
    } catch (_error) {
      caret = null;
    }

    if (!Number.isInteger(caret)) {
      try {
        caret = adapter.getCaretOffset();
      } catch (_error) {
        caret = null;
      }
    }

    if (!Number.isInteger(caret)) {
      return null;
    }

    if (caret < snapshot.scopeStart || caret > snapshot.scopeEnd) {
      return null;
    }

    return clamp(caret - snapshot.scopeStart, 0, String(snapshot.text || "").length);
  }

  findDocumentBodyStart(text) {
    const source = String(text || "");
    const match = source.match(/\\begin\s*\{\s*document\s*}/);
    return match ? match.index + match[0].length : -1;
  }

  resolveChunkWindow(snapshot, caretOffset) {
    const scopeText = String(snapshot.text || "");
    const sourceText = String(snapshot.sourceText || snapshot.context || scopeText);
    const scopeStart = Number.isInteger(snapshot.scopeStart) ? snapshot.scopeStart : 0;
    const scopeEnd = Number.isInteger(snapshot.scopeEnd) ? snapshot.scopeEnd : scopeStart + scopeText.length;
    const docBodyStart = this.findDocumentBodyStart(sourceText);

    if (docBodyStart === -1) {
      return {
        text: scopeText,
        baseOffset: 0,
        caretOffset,
      };
    }

    if (docBodyStart >= scopeEnd) {
      return {
        text: "",
        baseOffset: 0,
        caretOffset: null,
      };
    }

    const bodyStartInScope = Math.max(0, docBodyStart - scopeStart);
    const text = scopeText.slice(bodyStartInScope);
    let nextCaret = null;
    if (Number.isInteger(caretOffset) && caretOffset >= bodyStartInScope) {
      nextCaret = caretOffset - bodyStartInScope;
    }

    return {
      text,
      baseOffset: bodyStartInScope,
      caretOffset: nextCaret,
    };
  }

  buildChunkTree(scopeText, caretOffset, baseOffset = 0) {
    const text = String(scopeText || "");
    const rootId = "__root__";
    const chunks = [];
    const leafChunks = [];
    const chunkById = new Map();

    const addChunk = (chunk, leaf = false) => {
      chunks.push(chunk);
      chunkById.set(chunk.chunkId, chunk);
      if (leaf) {
        leafChunks.push(chunk);
      }
    };

    if (!text.trim()) {
      return {
        chunks,
        leafChunks,
        chunkById,
        activeChunkId: null,
      };
    }

    const documentAnchor = this.buildChunkAnchor(text.slice(0, 240));
    const documentChunk = this.createChunk({
      chunkId: `document-${shortHash(`${baseOffset}|${text.length}|${documentAnchor}`)}`,
      type: "document",
      start: baseOffset,
      end: baseOffset + text.length,
      text,
      includeSentences: false,
    });
    addChunk(documentChunk, false);

    const sectionMetas = this.parseSectionBlocks(text, baseOffset);
    const envMetas = this.parseEnvironmentBlocks(text, baseOffset);
    const commandMetas = this.parseCommandBlocks(text, baseOffset);

    const sectionChunks = sectionMetas.map((meta) => {
      return this.createChunk({
        chunkId: meta.chunkId,
        type: "section",
        start: meta.start,
        end: meta.end,
        text: text.slice(meta.startLocal, meta.endLocal),
        includeSentences: false,
        sectionName: meta.name,
        sectionTitle: meta.title,
        sectionLevel: meta.level,
        commandEnd: meta.commandEnd,
      });
    });

    const envChunks = envMetas.map((meta) => {
      return this.createChunk({
        chunkId: meta.chunkId,
        type: "environment",
        start: meta.start,
        end: meta.end,
        text: text.slice(meta.startLocal, meta.endLocal),
        includeSentences: false,
        envName: meta.envName,
        bodyStart: meta.bodyStart,
        bodyEnd: meta.bodyEnd,
        closeEnd: meta.closeEnd,
      });
    });

    const commandChunks = commandMetas.map((meta) => {
      return this.createChunk({
        chunkId: meta.chunkId,
        type: "command",
        start: meta.start,
        end: meta.end,
        text: text.slice(meta.startLocal, meta.endLocal),
        includeSentences: false,
        commandName: meta.commandName,
      });
    });

    const envById = new Map(envChunks.map((chunk) => [chunk.chunkId, chunk]));

    for (const sectionChunk of sectionChunks) {
      let parentId = this.pickSectionParentId(sectionChunk, sectionChunks);
      if (!parentId) {
        parentId = this.pickContainingEnvironmentId(sectionChunk, envChunks);
      }
      sectionChunk.parentId = parentId || documentChunk.chunkId;
    }

    for (let i = 0; i < envChunks.length; i += 1) {
      const envChunk = envChunks[i];
      const meta = envMetas[i];
      const parentEnvId = meta.parentEnvId;
      if (parentEnvId && envById.has(parentEnvId)) {
        envChunk.parentId = parentEnvId;
        continue;
      }
      const sectionParentId = this.pickContainingSectionId(envChunk, sectionChunks);
      envChunk.parentId = sectionParentId || documentChunk.chunkId;
    }

    for (const commandChunk of commandChunks) {
      const envParentId = this.pickContainingEnvironmentId(commandChunk, envChunks);
      if (envParentId) {
        commandChunk.parentId = envParentId;
        continue;
      }
      const sectionParentId = this.pickContainingSectionId(commandChunk, sectionChunks);
      commandChunk.parentId = sectionParentId || documentChunk.chunkId;
    }

    const structuralChunks = [...sectionChunks, ...envChunks, ...commandChunks];
    for (const chunk of structuralChunks) {
      addChunk(chunk, false);
    }

    const childrenByParent = new Map();
    const pushChild = (parentId, child) => {
      const key = parentId || rootId;
      const bucket = childrenByParent.get(key) || [];
      bucket.push(child);
      childrenByParent.set(key, bucket);
    };

    pushChild(documentChunk.parentId, documentChunk);
    for (const chunk of structuralChunks) {
      pushChild(chunk.parentId, chunk);
    }

    for (const bucket of childrenByParent.values()) {
      bucket.sort((a, b) => (a.start || 0) - (b.start || 0));
    }

    const textIndexByParent = new Map();
    const addTextLeaf = (parentId, rawStart, rawEnd) => {
      const localStart = rawStart - baseOffset;
      const localEnd = rawEnd - baseOffset;
      const spans = this.splitWithoutEndTokens(text, localStart, localEnd);
      for (const [spanStart, spanEnd] of spans) {
        const [trimmedLocalStart, trimmedLocalEnd] = this.trimSpan(text, spanStart, spanEnd);
        if (trimmedLocalEnd <= trimmedLocalStart) {
          continue;
        }

        const start = baseOffset + trimmedLocalStart;
        const end = baseOffset + trimmedLocalEnd;
        const leafText = text.slice(trimmedLocalStart, trimmedLocalEnd);
        const anchor = this.buildChunkAnchor(leafText);
        const index = textIndexByParent.get(parentId) || 0;
        textIndexByParent.set(parentId, index + 1);

        const leafChunk = this.createChunk({
          chunkId: this.buildTextChunkId(parentId, index, anchor, start),
          type: "text",
          start,
          end,
          text: leafText,
          parentId: parentId === rootId ? undefined : parentId,
        });
        addChunk(leafChunk, true);
      }
    };

    const walkContainer = (parentId, regionStart, regionEnd) => {
      if (regionEnd <= regionStart) {
        return;
      }

      const children = ensureArray(childrenByParent.get(parentId))
        .filter((child) => child.start < regionEnd && child.end > regionStart)
        .sort((a, b) => (a.start || 0) - (b.start || 0));
      let cursor = regionStart;

      for (const child of children) {
        const childStart = clamp(child.start, regionStart, regionEnd);
        if (childStart > cursor) {
          addTextLeaf(parentId, cursor, childStart);
        }

        const childRegion = this.getChildRegionForChunk(child);
        const nestedStart = Math.max(regionStart, childRegion.start);
        const nestedEnd = Math.min(regionEnd, childRegion.end);
        if (nestedEnd > nestedStart) {
          walkContainer(child.chunkId, nestedStart, nestedEnd);
        }

        const postChildCursor = this.getPostChildCursor(child);
        cursor = Math.max(cursor, Math.min(regionEnd, postChildCursor));
      }

      if (cursor < regionEnd) {
        addTextLeaf(parentId, cursor, regionEnd);
      }
    };

    const rootStart = baseOffset;
    const rootEnd = baseOffset + text.length;
    walkContainer(documentChunk.chunkId, rootStart, rootEnd);

    if (leafChunks.length === 0) {
      addTextLeaf(documentChunk.chunkId, rootStart, rootEnd);
    }

    chunks.sort((a, b) => (a.start || 0) - (b.start || 0));
    leafChunks.sort((a, b) => (a.start || 0) - (b.start || 0));

    const absoluteCaret = Number.isInteger(caretOffset) ? baseOffset + caretOffset : null;
    const activeChunkId = this.selectActiveChunkId(leafChunks, absoluteCaret);
    return {
      chunks,
      leafChunks,
      chunkById,
      activeChunkId,
    };
  }

  createChunk(input) {
    const includeSentences = input.includeSentences !== false;
    const chunk = {
      chunkId: input.chunkId,
      type: input.type,
      start: input.start,
      end: input.end,
      text: input.text,
      parentId: input.parentId || undefined,
      sentences: includeSentences
        ? this.buildChunkSentences(input.text, input.start, input.chunkId)
        : [],
      envName: input.envName || undefined,
      sectionName: input.sectionName || undefined,
      sectionTitle: input.sectionTitle || undefined,
      commandName: input.commandName || undefined,
      sectionLevel: Number.isInteger(input.sectionLevel) ? input.sectionLevel : undefined,
      commandEnd: Number.isInteger(input.commandEnd) ? input.commandEnd : undefined,
      bodyStart: Number.isInteger(input.bodyStart) ? input.bodyStart : undefined,
      bodyEnd: Number.isInteger(input.bodyEnd) ? input.bodyEnd : undefined,
      closeEnd: Number.isInteger(input.closeEnd) ? input.closeEnd : undefined,
    };
    return chunk;
  }

  parseSectionBlocks(text, baseOffset = 0) {
    const source = String(text || "");
    const blocks = [];
    const regex = LATEX_SECTION_BLOCK_REGEX;
    regex.lastIndex = 0;

    let match;
    while ((match = regex.exec(source)) !== null) {
      const raw = String(match[0] || "");
      const name = String(match[1] || "").toLowerCase();
      const titleMatch = raw.match(/\{([^}]*)\}\s*$/);
      const title = titleMatch ? String(titleMatch[1] || "").trim() : "";
      const startLocal = match.index;
      const commandEndLocal = match.index + match[0].length;
      const level = LATEX_SECTION_LEVELS[name] ?? 6;
      blocks.push({
        kind: "section",
        name,
        title,
        level,
        startLocal,
        commandEndLocal,
        start: baseOffset + startLocal,
        commandEnd: baseOffset + commandEndLocal,
      });
    }

    for (let i = 0; i < blocks.length; i += 1) {
      const current = blocks[i];
      let endLocal = source.length;
      for (let j = i + 1; j < blocks.length; j += 1) {
        if (blocks[j].level <= current.level) {
          endLocal = blocks[j].startLocal;
          break;
        }
      }

      current.endLocal = endLocal;
      current.end = baseOffset + endLocal;
      const anchor = this.buildChunkAnchor(source.slice(current.startLocal, Math.min(endLocal, current.startLocal + 120)));
      current.chunkId = this.buildSectionChunkId(i, current.name, anchor, current.start);
    }

    return blocks;
  }

  parseEnvironmentBlocks(text, baseOffset = 0) {
    const source = String(text || "");
    const blocks = [];
    const regex = /\\(begin|end)\s*\{\s*([^{}]+?)\s*\}/g;
    const stack = [];
    let envIndex = 0;

    let match;
    while ((match = regex.exec(source)) !== null) {
      const kind = String(match[1] || "").toLowerCase();
      const envName = String(match[2] || "").trim();
      const tokenStartLocal = match.index;
      const tokenEndLocal = match.index + match[0].length;
      const normalizedEnvName = envName.toLowerCase();

      if (!envName || normalizedEnvName === "document") {
        continue;
      }

      if (kind === "begin") {
        const parentEnvId = stack.length > 0 ? stack[stack.length - 1].chunkId : null;
        const anchor = this.buildChunkAnchor(
          source.slice(tokenEndLocal, Math.min(source.length, tokenEndLocal + 100))
        );
        const chunkId = this.buildEnvironmentChunkId(
          envIndex,
          envName,
          anchor,
          baseOffset + tokenStartLocal
        );
        stack.push({
          envName,
          chunkId,
          startLocal: tokenStartLocal,
          bodyStartLocal: tokenEndLocal,
          parentEnvId,
          envIndex,
        });
        envIndex += 1;
        continue;
      }

      let openIdx = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].envName === envName) {
          openIdx = i;
          break;
        }
      }
      if (openIdx === -1) {
        continue;
      }

      const removed = stack.splice(openIdx);
      const open = removed[0];
      const endLocal = tokenStartLocal;
      const bodyEndLocal = tokenStartLocal;
      if (endLocal < open.startLocal) {
        continue;
      }

      blocks.push({
        kind: "environment",
        envName: open.envName,
        chunkId: open.chunkId,
        parentEnvId: open.parentEnvId,
        startLocal: open.startLocal,
        endLocal,
        bodyStartLocal: open.bodyStartLocal,
        bodyEndLocal,
        start: baseOffset + open.startLocal,
        end: baseOffset + endLocal,
        bodyStart: baseOffset + open.bodyStartLocal,
        bodyEnd: baseOffset + bodyEndLocal,
        closeEnd: baseOffset + tokenEndLocal,
      });
    }

    for (const open of stack) {
      const endLocal = source.length;
      const bodyEndLocal = source.length;
      if (endLocal < open.startLocal) {
        continue;
      }
      blocks.push({
        kind: "environment",
        envName: open.envName,
        chunkId: open.chunkId,
        parentEnvId: open.parentEnvId,
        startLocal: open.startLocal,
        endLocal,
        bodyStartLocal: open.bodyStartLocal,
        bodyEndLocal,
        start: baseOffset + open.startLocal,
        end: baseOffset + endLocal,
        bodyStart: baseOffset + open.bodyStartLocal,
        bodyEnd: baseOffset + bodyEndLocal,
        closeEnd: baseOffset + endLocal,
      });
    }

    blocks.sort((a, b) => a.startLocal - b.startLocal);
    return blocks;
  }

  parseCommandBlocks(text, baseOffset = 0) {
    const source = String(text || "");
    const blocks = [];
    let commandIndex = 0;

    for (const spec of LATEX_DELIMITER_COMMAND_REGEX_SPECS) {
      spec.regex.lastIndex = 0;
      let match;
      while ((match = spec.regex.exec(source)) !== null) {
        const startLocal = match.index;
        const endLocal = match.index + match[0].length;
        const anchor = this.buildChunkAnchor(match[0]);
        blocks.push({
          kind: "command",
          commandName: spec.commandName,
          startLocal,
          endLocal,
          start: baseOffset + startLocal,
          end: baseOffset + endLocal,
          chunkId: this.buildCommandChunkId(commandIndex, spec.commandName, anchor, baseOffset + startLocal),
        });
        commandIndex += 1;
      }
    }

    blocks.sort((a, b) => a.startLocal - b.startLocal);
    return blocks;
  }

  pickSectionParentId(sectionChunk, sectionChunks) {
    const currentLevel = Number.isInteger(sectionChunk.sectionLevel) ? sectionChunk.sectionLevel : 99;
    let best = null;
    for (const candidate of sectionChunks) {
      if (candidate.chunkId === sectionChunk.chunkId) {
        continue;
      }
      const candidateLevel = Number.isInteger(candidate.sectionLevel) ? candidate.sectionLevel : 99;
      if (candidateLevel >= currentLevel) {
        continue;
      }
      if (candidate.start > sectionChunk.start || candidate.end <= sectionChunk.start) {
        continue;
      }
      if (!best || candidate.start > best.start) {
        best = candidate;
      }
    }
    return best?.chunkId || null;
  }

  pickContainingSectionId(targetChunk, sectionChunks) {
    let best = null;
    for (const candidate of sectionChunks) {
      if (candidate.start > targetChunk.start || candidate.end < targetChunk.end) {
        continue;
      }
      if (!best || candidate.start > best.start) {
        best = candidate;
      }
    }
    return best?.chunkId || null;
  }

  pickContainingEnvironmentId(targetChunk, envChunks) {
    let best = null;
    for (const candidate of envChunks) {
      if (candidate.start > targetChunk.start || candidate.end < targetChunk.end) {
        continue;
      }
      if (!best || candidate.start > best.start) {
        best = candidate;
      }
    }
    return best?.chunkId || null;
  }

  getChildRegionForChunk(chunk) {
    if (chunk.type === "section") {
      const start = Number.isInteger(chunk.commandEnd) ? chunk.commandEnd : chunk.start;
      return { start, end: chunk.end };
    }
    if (chunk.type === "environment") {
      const start = Number.isInteger(chunk.bodyStart) ? chunk.bodyStart : chunk.start;
      const end = Number.isInteger(chunk.bodyEnd) ? chunk.bodyEnd : chunk.end;
      return { start, end };
    }
    if (chunk.type === "command") {
      return { start: chunk.end, end: chunk.end };
    }
    return { start: chunk.start, end: chunk.end };
  }

  getPostChildCursor(chunk) {
    if (chunk.type === "environment" && Number.isInteger(chunk.closeEnd)) {
      return chunk.closeEnd;
    }
    return chunk.end;
  }

  splitWithoutEndTokens(text, start, end) {
    const source = String(text || "");
    const left = clamp(start, 0, source.length);
    const right = clamp(end, 0, source.length);
    if (right <= left) {
      return [];
    }

    const spans = [];
    const regex = /\\end\s*\{\s*[^{}]+?\s*\}/g;
    regex.lastIndex = left;
    let cursor = left;
    let match;

    while ((match = regex.exec(source)) !== null) {
      const tokenStart = match.index;
      const tokenEnd = match.index + match[0].length;
      if (tokenStart >= right) {
        break;
      }
      if (tokenStart > cursor) {
        spans.push([cursor, Math.min(tokenStart, right)]);
      }
      cursor = Math.max(cursor, Math.min(tokenEnd, right));
      if (cursor >= right) {
        break;
      }
    }

    if (cursor < right) {
      spans.push([cursor, right]);
    }

    return spans;
  }

  trimSpan(text, start, end) {
    const source = String(text || "");
    let left = clamp(start, 0, source.length);
    let right = clamp(end, 0, source.length);

    while (left < right && /\s/.test(source[left])) {
      left += 1;
    }
    while (right > left && /\s/.test(source[right - 1])) {
      right -= 1;
    }

    return [left, right];
  }

  buildChunkSentences(chunkText, chunkStart, chunkId) {
    const sentences = [];
    const spans = this.splitLatexAwareSentences(chunkText);
    for (let i = 0; i < spans.length; i += 1) {
      const span = spans[i];
      const sentenceText = String(span.text || "").trim();
      if (!sentenceText) {
        continue;
      }
      const anchor = this.buildChunkAnchor(sentenceText);
      sentences.push({
        sentenceId: this.buildSentenceId(chunkId, i, anchor),
        chunkId,
        start: chunkStart + span.start,
        end: chunkStart + span.end,
        text: sentenceText,
      });
    }
    return sentences;
  }

  buildChunkAnchor(text) {
    const normalized = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return normalized.slice(0, 40) || "chunk";
  }

  buildSectionChunkId(sectionIndex, sectionName, anchor, start) {
    return `section-${sectionIndex}-${shortHash(`${sectionName}|${start}|${anchor}`)}`;
  }

  buildEnvironmentChunkId(envIndex, envName, anchor, start) {
    return `env-${envIndex}-${shortHash(`${envName}|${start}|${anchor}`)}`;
  }

  buildCommandChunkId(commandIndex, commandName, anchor, start) {
    return `cmd-${commandIndex}-${shortHash(`${commandName}|${start}|${anchor}`)}`;
  }

  buildTextChunkId(parentId, textIndex, anchor, start) {
    return `text-${shortHash(`${parentId}|${textIndex}|${start}|${anchor}`)}`;
  }

  buildSentenceId(chunkId, sentenceIndex, anchor) {
    return `sentence-${chunkId}-${sentenceIndex}-${shortHash(`${chunkId}|${sentenceIndex}|${anchor}`)}`;
  }

  selectActiveChunkId(leafChunks, caretOffset) {
    if (!leafChunks.length) {
      return null;
    }

    if (!Number.isInteger(caretOffset)) {
      return leafChunks[0].chunkId;
    }

    for (const chunk of leafChunks) {
      if (caretOffset >= chunk.start && caretOffset <= chunk.end) {
        return chunk.chunkId;
      }
    }

    let bestChunk = leafChunks[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const chunk of leafChunks) {
      const distance = caretOffset < chunk.start
        ? chunk.start - caretOffset
        : caretOffset - chunk.end;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestChunk = chunk;
      }
    }

    return bestChunk.chunkId;
  }

  stripLatexComment(line) {
    const input = String(line || "");
    for (let i = 0; i < input.length; i += 1) {
      if (input[i] !== "%") {
        continue;
      }

      let backslashes = 0;
      for (let j = i - 1; j >= 0 && input[j] === "\\"; j -= 1) {
        backslashes += 1;
      }

      if (backslashes % 2 === 0) {
        return input.slice(0, i);
      }
    }
    return input;
  }

  isAnalyzableLatexLine(rawLine) {
    const line = this.stripLatexComment(rawLine).trim();
    if (!line) {
      return false;
    }

    const commandMatch = line.match(/^\\([a-zA-Z@]+)\*?/);
    if (commandMatch) {
      const command = String(commandMatch[1] || "").toLowerCase();
      if (NON_ANALYZABLE_LATEX_COMMANDS.has(command)) {
        return false;
      }
    }

    const probe = line
      .replace(/\\[a-zA-Z@]+\*?(?:\s*\[[^\]]*\])?(?:\s*\{[^{}]*\})?/g, " ")
      .replace(/\$[^$]*\$/g, " ")
      .replace(/\\\(|\\\)|\\\[|\\\]/g, " ")
      .replace(/[{}[\]^_~&]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const wordCount = (probe.match(/[A-Za-z]{2,}/g) || []).length;
    if (wordCount >= 2) {
      return true;
    }
    if (wordCount === 1 && /[.!?]/.test(line)) {
      return true;
    }
    return false;
  }

  extractProseSpans(sourceText) {
    const source = String(sourceText || "");
    const spans = [];
    if (!source.trim()) {
      return spans;
    }

    const pushSpan = (rawStart, rawEnd) => {
      let start = clamp(rawStart, 0, source.length);
      let end = clamp(rawEnd, 0, source.length);
      while (start < end && /\s/.test(source[start])) {
        start += 1;
      }
      while (end > start && /\s/.test(source[end - 1])) {
        end -= 1;
      }
      if (end > start) {
        spans.push({
          start,
          end,
          text: source.slice(start, end),
        });
      }
    };

    let lineStart = 0;
    let spanStart = null;
    let spanEnd = null;

    while (lineStart <= source.length) {
      const newlineIndex = source.indexOf("\n", lineStart);
      const lineEnd = newlineIndex === -1 ? source.length : newlineIndex;
      const nextLineStart = newlineIndex === -1 ? source.length + 1 : newlineIndex + 1;
      const lineText = source.slice(lineStart, lineEnd);
      const keepLine = this.isAnalyzableLatexLine(lineText);

      if (keepLine) {
        if (spanStart === null) {
          spanStart = lineStart;
        }
        spanEnd = newlineIndex === -1 ? lineEnd : newlineIndex + 1;
      } else if (spanStart !== null && spanEnd !== null) {
        pushSpan(spanStart, spanEnd);
        spanStart = null;
        spanEnd = null;
      }

      if (newlineIndex === -1) {
        break;
      }
      lineStart = nextLineStart;
    }

    if (spanStart !== null && spanEnd !== null) {
      pushSpan(spanStart, spanEnd);
    }

    return spans;
  }

  splitLatexAwareSentences(text, proseSpans) {
    const source = String(text || "");
    if (!source.trim()) {
      return [];
    }

    const spans = Array.isArray(proseSpans) ? proseSpans : this.extractProseSpans(source);
    const segments = [];
    for (const span of spans) {
      if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.end <= span.start) {
        continue;
      }
      const sentenceSegments = this.splitSpanIntoSentences(source, span.start, span.end);
      for (const segment of sentenceSegments) {
        segments.push(segment);
      }
    }
    return segments;
  }

  splitSpanIntoSentences(source, spanStart, spanEnd) {
    const segments = [];
    let rawStart = spanStart;
    let i = spanStart;
    let inInlineDollar = false;
    let inDoubleDollar = false;
    let inParenMath = false;
    let inBracketMath = false;
    let mathEnvDepth = 0;
    const mathEnvPattern = /^(equation|align|gather|multline|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|split|math|displaymath|eqnarray|array)\*?$/;

    const pushSegment = (rawEnd) => {
      let start = clamp(rawStart, spanStart, spanEnd);
      let end = clamp(rawEnd, spanStart, spanEnd);

      while (start < end && /\s/.test(source[start])) {
        start += 1;
      }
      while (end > start && /\s/.test(source[end - 1])) {
        end -= 1;
      }

      if (end > start) {
        segments.push({
          start,
          end,
          text: source.slice(start, end),
        });
      }
      rawStart = clamp(rawEnd, spanStart, spanEnd);
    };

    while (i < spanEnd) {
      if (source.startsWith("\\begin{", i)) {
        const close = source.indexOf("}", i + 7);
        const envName = close === -1 ? "" : source.slice(i + 7, close).trim();
        if (mathEnvPattern.test(envName)) {
          mathEnvDepth += 1;
        }
        i = close === -1 ? i + 6 : close + 1;
        continue;
      }
      if (source.startsWith("\\end{", i)) {
        const close = source.indexOf("}", i + 5);
        const envName = close === -1 ? "" : source.slice(i + 5, close).trim();
        if (mathEnvPattern.test(envName)) {
          mathEnvDepth = Math.max(0, mathEnvDepth - 1);
        }
        i = close === -1 ? i + 4 : close + 1;
        continue;
      }
      if (source.startsWith("\\(", i)) {
        inParenMath = true;
        i += 2;
        continue;
      }
      if (source.startsWith("\\)", i)) {
        inParenMath = false;
        i += 2;
        continue;
      }
      if (source.startsWith("\\[", i)) {
        inBracketMath = true;
        i += 2;
        continue;
      }
      if (source.startsWith("\\]", i)) {
        inBracketMath = false;
        i += 2;
        continue;
      }

      const ch = source[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }

      if (ch === "$") {
        const escaped = i > 0 && source[i - 1] === "\\";
        if (!escaped && source[i + 1] === "$") {
          inDoubleDollar = !inDoubleDollar;
          i += 2;
          continue;
        }
        if (!escaped && !inDoubleDollar) {
          inInlineDollar = !inInlineDollar;
        }
      }

      const insideMath = inInlineDollar || inDoubleDollar || inParenMath || inBracketMath || mathEnvDepth > 0;
      if (!insideMath) {
        const next = source[i + 1] || "";
        const prev = source[i - 1] || "";
        const punctuationBreak = ".!?;".includes(ch) && (next === "" || /\s/.test(next));
        const decimalPoint = ch === "." && /\d/.test(prev) && /\d/.test(next);
        const blankLineBreak = ch === "\n" && next === "\n";

        if ((punctuationBreak && !decimalPoint) || blankLineBreak) {
          const consume = blankLineBreak ? 2 : 1;
          pushSegment(i + consume);
          i += consume;
          continue;
        }
      }

      i += 1;
    }

    pushSegment(spanEnd);
    if (segments.length === 0 && source.slice(spanStart, spanEnd).trim()) {
      let start = clamp(spanStart, 0, source.length);
      let end = clamp(spanEnd, 0, source.length);
      while (start < end && /\s/.test(source[start])) {
        start += 1;
      }
      while (end > start && /\s/.test(source[end - 1])) {
        end -= 1;
      }
      if (end > start) {
        segments.push({
          start,
          end,
          text: source.slice(start, end),
        });
      }
    }
    return segments;
  }

  collectSentenceIssues(activeKeys) {
    const issues = [];
    for (const key of activeKeys) {
      const sentenceEntry = this.sentenceCache.get(key);
      if (!sentenceEntry) {
        continue;
      }

      const sentenceIssues = ensureArray(sentenceEntry.issues);
      for (let i = 0; i < sentenceIssues.length; i += 1) {
        const issue = sentenceIssues[i];
        const startOffset = Number.isInteger(issue.start)
          ? sentenceEntry.start + issue.start
          : null;
        const endOffset = Number.isInteger(issue.end)
          ? sentenceEntry.start + issue.end
          : null;

        issues.push({
          ...issue,
          start: startOffset,
          end: endOffset,
          key: `${sentenceEntry.key}:${issue.key || i}:${startOffset ?? "na"}`,
          sentenceKey: sentenceEntry.key,
          sentenceInferenceMs: sentenceEntry.inferenceMs,
        });
      }
    }
    return issues;
  }

  async analyzeSentenceEntry(sentenceEntry, snapshot, reason) {
    const sentenceSnapshot = {
      ...snapshot,
      text: sentenceEntry.text,
      context: snapshot.context,
    };

    const startedAt = performance.now();
    sentenceEntry.activityLog = null;
    try {
      const requestResult = await this.fetchWithCache(
        sentenceEntry.signature,
        sentenceSnapshot,
        `${reason}:sentence`
      );
      const responsePayload = requestResult.payload;
      const normalized = this.normalizeBackendResponse(responsePayload, sentenceEntry.text);
      sentenceEntry.issues = ensureArray(normalized.issues);
      sentenceEntry.diagnostics = ensureArray(normalized.diagnostics);
      sentenceEntry.hasError = !!normalized.hasError;
      sentenceEntry.status = "ready";
      sentenceEntry.inferenceMs = performance.now() - startedAt;
      sentenceEntry.activityLog = this.buildSentenceActivityLog(
        sentenceEntry,
        responsePayload,
        normalized,
        requestResult.request,
        requestResult.cacheHit
      );
    } catch (error) {
      const message = String(error?.message || error || "Request failed.");
      sentenceEntry.hasError = true;
      sentenceEntry.status = "error";
      sentenceEntry.inferenceMs = performance.now() - startedAt;
      const priorIssues = ensureArray(sentenceEntry.issues).filter(
        (item) => item?.id !== `sentence-error-${sentenceEntry.key}`
      );
      sentenceEntry.issues = [
        ...priorIssues,
        {
          id: `sentence-error-${sentenceEntry.key}`,
          key: `sentence-error-${sentenceEntry.key}`,
          category: "backend",
          severity: "error",
          message: `Backend request failed: ${message}`,
          start: null,
          end: null,
          targetText: null,
          replacement: null,
          source: "backend",
        },
      ];
      sentenceEntry.activityLog = this.buildSentenceActivityLog(
        sentenceEntry,
        null,
        { diagnostics: [], hasError: true },
        null,
        false,
        message
      );
    } finally {
      sentenceEntry.updatedAt = Date.now();
      sentenceEntry.lastSeenAt = sentenceEntry.updatedAt;
      sentenceEntry.inferenceMs = performance.now() - startedAt;
      this.lastInferenceMs = sentenceEntry.inferenceMs;
    }
  }

  async fetchWithCache(signature, snapshot, reason) {
    const cached = this.responseCache.get(signature);
    const now = Date.now();
    if (cached && now - cached.timestamp <= CACHE_TTL_MS) {
      return {
        payload: cached.payload,
        cacheHit: true,
        request: cached.request || null,
      };
    }

    const request = this.buildBackendPayload(snapshot, reason);
    const response = await this.sendBackendRequest(request);
    this.responseCache.set(signature, {
      timestamp: now,
      payload: response,
      request,
    });

    for (const [key, value] of this.responseCache.entries()) {
      if (now - value.timestamp > CACHE_TTL_MS) {
        this.responseCache.delete(key);
      }
    }

    return {
      payload: response,
      cacheHit: false,
      request,
    };
  }

  buildBackendPayload(snapshot, reason) {
    const url = this.settings.backendUrl;
    const isAnalyzeEndpoint =
      /\/v1\/(analyze|query|generate)/.test(url) || /modal\.run/.test(url);

    if (isAnalyzeEndpoint) {
      return {
        requestUrl: url,
        requestBody: {
          text: snapshot.text,
          context: snapshot.context.slice(0, 6000),
          theorem_name: "zeta_candidate",
          imports: ["Std"],
          temperature: this.settings.mode === "accurate" ? 0.1 : 0.0,
          max_new_tokens: this.settings.mode === "accurate" ? 220 : 140,
          skip_lean_check: false,
          include_raw_model_output: false,
          zeta_meta: {
            reason,
            scope: snapshot.scope,
            notation: this.settings.notationStrictness,
          },
        },
      };
    }

    return {
      requestUrl: url,
      requestBody: {
        nl_input: snapshot.text,
        context: {
          source_scope: snapshot.scope,
          notation_strictness: this.settings.notationStrictness,
          original_context: snapshot.context.slice(0, 7000),
        },
        max_iters: this.settings.mode === "accurate" ? 2 : 1,
      },
    };
  }

  logBackendPipeline(responseJson) {
    const pipeline = responseJson?.pipeline;
    if (!pipeline || !Array.isArray(pipeline.stages)) {
      return;
    }

    logTrace("backend_pipeline", {
      totalDurationMs: pipeline.total_duration_ms,
      semantic: pipeline.semantic || null,
    });

    for (const stage of pipeline.stages) {
      logTrace("backend_stage", {
        stage: stage.stage,
        attempted: stage.attempted,
        success: stage.success,
        durationMs: stage.duration_ms,
        details: stage.details || {},
      });
    }
  }

  async sendBackendRequest(request) {
    const attempts = Math.max(0, Number(this.settings.retries) || 0) + 1;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      logTrace("backend_request_send", {
        attempt,
        attempts,
        url: request.requestUrl,
        timeoutMs: this.settings.requestTimeoutMs,
        requestKeys: Object.keys(request.requestBody || {}),
      });
      try {
        const startedAt = performance.now();
        const response = await this.sendHttpMessage({
          url: request.requestUrl,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request.requestBody),
          timeoutMs: this.settings.requestTimeoutMs,
        });
        logTrace("backend_response_received", {
          attempt,
          status: response.status,
          ok: response.ok,
          durationMs: performance.now() - startedAt,
        });

        if (!response.ok) {
          const detail = response.json?.detail || response.text || response.statusText || "Request failed";
          logTrace("backend_response_error", {
            attempt,
            status: response.status,
            detail,
          });
          throw new Error(`Backend ${response.status || "error"}: ${detail}`);
        }

        if (!response.json) {
          throw new Error("Backend returned non-JSON response.");
        }

        this.logBackendPipeline(response.json);

        return response.json;
      } catch (error) {
        lastError = error;
        logTrace("backend_request_failed", {
          attempt,
          message: String(error?.message || error),
        });
        const retryable = attempt < attempts;
        if (!retryable) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 260 * attempt));
      }
    }

    throw lastError || new Error("Unknown backend error");
  }

  sendHttpMessage(payload) {
    return new Promise((resolve, reject) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error("Chrome runtime bridge unavailable."));
        return;
      }

      chrome.runtime.sendMessage(
        {
          type: "zeta-http",
          ...payload,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response) {
            reject(new Error("No response from background fetch."));
            return;
          }
          if (response.ok) {
            resolve(response);
            return;
          }
          reject(new Error(response.error || `HTTP error ${response.status || "unknown"}`));
        }
      );
    });
  }

  detectLocalMathTypos(scopeText, proseSpans) {
    const source = String(scopeText || "");
    const spans = Array.isArray(proseSpans) ? proseSpans : this.extractProseSpans(source);
    const issues = [];

    const pushIssue = (start, end, message, replacement, category = "math-typo", severity = "warning") => {
      const safeStart = clamp(Number(start) || 0, 0, source.length);
      const safeEnd = clamp(Number(end) || safeStart, safeStart, source.length);
      const targetText = source.slice(safeStart, safeEnd);
      issues.push({
        id: `local-${issues.length + 1}`,
        key: this.buildIssueKey({
          category,
          message,
          targetText,
          replacement,
        }),
        category,
        severity,
        message,
        start: safeStart,
        end: safeEnd,
        targetText,
        replacement: replacement || null,
        source: "local",
      });
    };

    const patternRules = [
      { regex: /==/g, replacement: "=", message: "Use '=' for Lean equality." },
      { regex: /\+\+/g, replacement: "+", message: "Duplicate '+' looks like a typo." },
      { regex: /--+/g, replacement: "-", message: "Repeated '-' may be a math typo." },
      { regex: /<=</g, replacement: "<=", message: "Malformed relation '<=<'." },
      { regex: />=>/g, replacement: ">=", message: "Malformed relation '>=>'." },
      { regex: /\^\^/g, replacement: "^", message: "Duplicate exponent marker '^' detected." },
    ];

    const scanChunk = (chunkText, baseOffset) => {
      for (const rule of patternRules) {
        rule.regex.lastIndex = 0;
        let match;
        while ((match = rule.regex.exec(chunkText)) !== null) {
          const start = baseOffset + match.index;
          const end = start + match[0].length;
          pushIssue(start, end, rule.message, rule.replacement);
        }
      }

      const stack = [];
      const openers = {
        "(": ")",
        "[": "]",
        "{": "}",
      };
      const closers = {
        ")": "(",
        "]": "[",
        "}": "{",
      };

      for (let i = 0; i < chunkText.length; i += 1) {
        const ch = chunkText[i];
        if (openers[ch]) {
          stack.push({ ch, index: i });
        } else if (closers[ch]) {
          const top = stack[stack.length - 1];
          if (!top || top.ch !== closers[ch]) {
            pushIssue(baseOffset + i, baseOffset + i + 1, `Unbalanced '${ch}' bracket.`, null, "math-typo", "error");
          } else {
            stack.pop();
          }
        }
      }

      for (const unclosed of stack) {
        pushIssue(
          baseOffset + unclosed.index,
          baseOffset + unclosed.index + 1,
          `Unclosed '${unclosed.ch}' bracket.`,
          null,
          "math-typo",
          "error"
        );
      }

      const dollarCount = (chunkText.match(/\$/g) || []).length;
      if (dollarCount % 2 !== 0) {
        const idx = chunkText.lastIndexOf("$");
        pushIssue(
          idx === -1 ? baseOffset : baseOffset + idx,
          idx === -1 ? baseOffset + 1 : baseOffset + idx + 1,
          "Unpaired '$' math delimiter.",
          null,
          "math-typo",
          "error"
        );
      }
    };

    for (const span of spans) {
      if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.end <= span.start) {
        continue;
      }
      const chunkText = source.slice(span.start, span.end);
      if (!chunkText.trim()) {
        continue;
      }
      scanChunk(chunkText, span.start);
    }

    return issues;
  }

  normalizeBackendResponse(response, scopeText) {
    const diagnostics =
      ensureArray(response.compile?.diagnostics).length > 0
        ? ensureArray(response.compile?.diagnostics)
        : ensureArray(response.diagnostics);

    const interpretationItems = ensureArray(response.interpretation?.items);
    const topSuggestions = ensureArray(response.interpretation?.suggestions);
    const feedbackItems = ensureArray(response.feedback);
    const semanticReasons = ensureArray(response.pipeline?.semantic?.reasons);

    const issues = [];

    for (const item of interpretationItems) {
      const start = Number.isInteger(item.latex_start) ? item.latex_start : null;
      const end = Number.isInteger(item.latex_end) ? item.latex_end : null;
      const excerpt = item.latex_excerpt || null;
      const targetText =
        start !== null && end !== null && end > start
          ? scopeText.slice(start, end)
          : excerpt;

      const message =
        item.error || item.suggested_fix || item.probable_cause || "Interpretation issue";

      issues.push({
        id: `interp-${issues.length + 1}`,
        key: this.buildIssueKey({
          category: "math-typo",
          message,
          targetText,
          replacement: item.replacement,
        }),
        category: "math-typo",
        severity: "error",
        message,
        start,
        end,
        targetText,
        replacement: item.replacement || null,
        source: "backend",
      });
    }

    for (const diag of diagnostics) {
      const severity = normalizeSeverity(diag.severity);
      const location =
        Number.isInteger(diag.line) && Number.isInteger(diag.column)
          ? ` (L${diag.line}:C${diag.column})`
          : "";

      issues.push({
        id: `diag-${issues.length + 1}`,
        key: this.buildIssueKey({
          category: "lean-diagnostic",
          message: `${diag.message || "Lean diagnostic"}${location}`,
          targetText: null,
          replacement: null,
        }),
        category: "lean-diagnostic",
        severity,
        message: `${diag.message || "Lean diagnostic"}${location}`,
        start: null,
        end: null,
        targetText: null,
        replacement: null,
        source: "backend",
        line: diag.line,
        column: diag.column,
      });
    }

    for (const suggestion of [...topSuggestions, ...feedbackItems]) {
      const text = String(suggestion || "").trim();
      if (!text) {
        continue;
      }

      issues.push({
        id: `hint-${issues.length + 1}`,
        key: this.buildIssueKey({
          category: "hint",
          message: text,
          targetText: null,
          replacement: null,
        }),
        category: "hint",
        severity: "info",
        message: text,
        start: null,
        end: null,
        targetText: null,
        replacement: null,
        source: "backend",
      });
    }

    for (const reason of semanticReasons) {
      const text = String(reason || "").trim();
      if (!text) {
        continue;
      }
      issues.push({
        id: `semantic-${issues.length + 1}`,
        key: this.buildIssueKey({
          category: "semantic-validation",
          message: text,
          targetText: null,
          replacement: null,
        }),
        category: "semantic-validation",
        severity: "error",
        message: text,
        start: null,
        end: null,
        targetText: null,
        replacement: null,
        source: "backend",
      });
    }

    for (const issue of issues) {
      if (
        !Number.isInteger(issue.start) &&
        issue.targetText &&
        issue.targetText.length > 0
      ) {
        const idx = scopeText.indexOf(issue.targetText);
        if (idx !== -1) {
          issue.start = idx;
          issue.end = idx + issue.targetText.length;
        }
      }
    }

    const hasCompileErrors =
      response.compile?.success === false ||
      response.is_valid_lean === false ||
      response.pipeline?.semantic?.success === false ||
      diagnostics.some((diag) => normalizeSeverity(diag.severity) === "error");

    return {
      diagnostics,
      issues,
      hasError: hasCompileErrors,
    };
  }

  mergeIssues(localIssues, backendIssues) {
    const merged = [];
    const seen = new Set();
    for (const issue of [...localIssues, ...backendIssues]) {
      if (!issue || !issue.key) {
        continue;
      }
      if (seen.has(issue.key)) {
        continue;
      }
      seen.add(issue.key);
      merged.push(issue);
    }
    return merged;
  }

  buildIssueKey(input) {
    return shortHash(
      `${input.category || "issue"}|${input.message || ""}|${input.targetText || ""}|${input.replacement || ""}`
    );
  }

  truncateActivityText(text, maxLength = 1800) {
    const value = String(text || "");
    if (!value) {
      return "";
    }
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}\n...[truncated]`;
  }

  formatSentenceLabel(sentenceText) {
    const compact = String(sentenceText || "").replace(/\s+/g, " ").trim();
    if (!compact) {
      return "sentence";
    }
    if (compact.length <= 92) {
      return compact;
    }
    return `${compact.slice(0, 89)}...`;
  }

  buildSentenceActivityLog(sentenceEntry, responsePayload, normalized, request, cacheHit, errorMessage = null) {
    const compile = responsePayload?.compile || {};
    const diagnostics = ensureArray(normalized?.diagnostics);
    const compileSuccess = compile?.success === true;
    const level = errorMessage || normalized?.hasError ? "error" : "success";
    const sentenceLabel = this.formatSentenceLabel(sentenceEntry.text);
    const sourceLabel = cacheHit ? "cache" : "aws";
    const message = errorMessage
      ? `${sourceLabel} · failed · ${sentenceLabel}`
      : `${sourceLabel} · ${compileSuccess ? "compiled" : "review"} · ${sentenceLabel}`;

    const detailLines = [
      `Sentence`,
      this.truncateActivityText(sentenceEntry.text, 500),
      "",
      `Chunk`,
      String(sentenceEntry.chunkId || this.activeChunkId || "innermost"),
      "",
      `Pipeline`,
      `url: ${String(request?.requestUrl || this.settings.backendUrl)}`,
      `cache_hit: ${cacheHit ? "true" : "false"}`,
      `inference_ms: ${Number.isFinite(sentenceEntry.inferenceMs) ? Math.round(sentenceEntry.inferenceMs) : "--"}`,
    ];

    if (errorMessage) {
      detailLines.push("", "Error", this.truncateActivityText(errorMessage, 1200));
      return {
        message,
        level,
        detailText: detailLines.join("\n"),
      };
    }

    detailLines.push(
      "",
      "Compile",
      `success: ${compileSuccess ? "true" : "false"}`,
      `diagnostics: ${diagnostics.length}`
    );

    const stdout = this.truncateActivityText(compile?.stdout, 1600);
    const stderr = this.truncateActivityText(compile?.stderr, 1600);
    const leanCode = this.truncateActivityText(responsePayload?.lean_code, 2200);
    if (stdout) {
      detailLines.push("", "stdout", stdout);
    }
    if (stderr) {
      detailLines.push("", "stderr", stderr);
    }
    if (leanCode) {
      detailLines.push("", "lean_code", leanCode);
    }
    if (diagnostics.length > 0) {
      const diagnosticText = diagnostics
        .slice(0, 10)
        .map((diag, index) => `${index + 1}. ${diag?.severity || "info"} · ${diag?.message || "diagnostic"}`)
        .join("\n");
      detailLines.push("", "diagnostics", this.truncateActivityText(diagnosticText, 1400));
    }

    return {
      message,
      level,
      detailText: detailLines.join("\n"),
    };
  }

  addActivity(message, level = "info", undoAction = null, detailText = "") {
    const now = new Date();
    const entry = {
      id: `act-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
      message,
      level,
      detailText: this.truncateActivityText(detailText, 7000),
      timeLabel: now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    };

    this.activityEntries.unshift(entry);
    if (this.activityEntries.length > 60) {
      this.activityEntries.length = 60;
    }

    if (undoAction) {
      this.undoStack.push(undoAction);
      if (this.undoStack.length > 30) {
        this.undoStack.shift();
      }
    }

    this.panel.setActivity(this.activityEntries, this.undoStack.length > 0);
    this.persistPanelSnapshot();
  }

  clearActivityHistory() {
    this.activityEntries = [];
    this.undoStack = [];
    this.panel.setActivity(this.activityEntries, false);
    this.panel.setStatus("idle", "Activity history cleared.");
    this.persistPanelSnapshot();
  }

  async undoLastAction() {
    const action = this.undoStack.pop();
    if (!action) {
      this.panel.setActivity(this.activityEntries, false);
      this.panel.setStatus("idle", "Nothing to undo.");
      this.persistPanelSnapshot();
      return;
    }

    if (action.type === "unignore") {
      this.ignoredKeys.delete(action.issueKey);
      await storageLocalSet({
        [IGNORED_KEY]: Array.from(this.ignoredKeys).slice(-1500),
      });
      this.addActivity("Undid ignore action.", "success");
      this.scheduleAnalysis("undo-unignore", true);
      return;
    }

    if (action.type === "editor-undo") {
      if (!this.activeAdapter) {
        this.undoStack.push(action);
        this.addActivity("Undo failed: no active editor.", "error");
        return;
      }

      this.activeAdapter.focus();
      let ok = false;
      if (typeof document.execCommand === "function") {
        try {
          ok = document.execCommand("undo");
        } catch (_error) {
          ok = false;
        }
      }

      if (!ok) {
        this.undoStack.push(action);
        this.addActivity("Undo not available in this editor state.", "error");
        return;
      }

      this.addActivity("Undid last replacement.", "success");
      this.scheduleAnalysis("undo-edit", true);
      return;
    }

    this.addActivity("Undo action type not supported.", "error");
  }

  renderState(state) {
    const issues = ensureArray(state.issues);

    const breakdown = this.computeHealthBreakdown(issues);
    const score = breakdown.score;
    this.currentHealthScore = score;
    this.currentHealthBreakdown = breakdown;
    this.currentMacroList = this.extractMacroNames(
      state?.snapshot?.context || state?.snapshot?.text || ""
    );
    this.panel.setHealth(score);
    this.panel.setIssues(issues, this.focusedIssueIndex);
    this.persistPanelSnapshot({
      healthScore: score,
      healthBreakdown: breakdown,
      issueCount: issues.length,
      chunkTree: this.serializeChunkTree(this.chunkTree),
      activeChunkId: this.activeChunkId,
    });

    if (this.activeAdapter && state.snapshot) {
      this.overlay.render(this.activeAdapter, issues, state.snapshot);
    } else {
      this.overlay.clear();
    }
  }

  computeHealthBreakdown(issues) {
    const issueList = ensureArray(issues);
    const severityCounts = {
      error: 0,
      warning: 0,
      info: 0,
      unknown: 0,
    };

    let rawSeverityPenalty = 0;
    for (const issue of issueList) {
      const severity = normalizeSeverity(issue?.severity);
      if (Object.prototype.hasOwnProperty.call(severityCounts, severity)) {
        severityCounts[severity] += 1;
      } else {
        severityCounts.unknown += 1;
      }
      rawSeverityPenalty += SEVERITY_WEIGHT[severity] || SEVERITY_WEIGHT.unknown;
    }

    const cachedSentences = Math.max(0, Number(this.currentSentenceCached) || 0);
    const pendingSentences = Math.max(0, Number(this.currentSentencePending) || 0);
    const analyzedSentences = cachedSentences + pendingSentences;
    const denominator = Math.max(1, analyzedSentences);

    // Severity impact is damped by analyzed scope size so longer documents are not over-penalized.
    const normalizedSeverityPenalty = Math.min(
      74,
      Math.round(rawSeverityPenalty / Math.sqrt(denominator))
    );
    // Density punishes many findings in a small amount of analyzed text.
    const densityPenalty = Math.min(16, Math.round((issueList.length / denominator) * 18));
    // Pending work lowers confidence in the score while analysis is still in flight.
    const pendingPenalty = Math.min(12, Math.round((pendingSentences / denominator) * 12));

    const score = clamp(
      100 - normalizedSeverityPenalty - densityPenalty - pendingPenalty,
      0,
      100
    );
    const coverageRatio = analyzedSentences > 0 ? cachedSentences / analyzedSentences : 1;

    return {
      score,
      issueCount: issueList.length,
      severityCounts,
      rawSeverityPenalty,
      normalizedSeverityPenalty,
      densityPenalty,
      pendingPenalty,
      cachedSentences,
      pendingSentences,
      analyzedSentences,
      coverageRatio,
    };
  }

  computeHealthScore(issues) {
    return this.computeHealthBreakdown(issues).score;
  }

  scheduleRender() {
    if (!this.lastRun) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (!this.lastRun || !this.activeAdapter) {
        return;
      }
      this.overlay.render(this.activeAdapter, this.lastRun.issues, this.lastRun.snapshot);
      this.syncPopoverWithCaret();
    });
  }

  focusIssue(index) {
    if (!this.lastRun) {
      return;
    }
    const issues = this.lastRun.issues;
    if (!issues || issues.length === 0) {
      return;
    }
    const nextIndex = clamp(index, 0, issues.length - 1);
    this.focusedIssueIndex = nextIndex;
    this.panel.setIssues(issues, this.focusedIssueIndex);
    this.panel.scrollIssueIntoView(this.focusedIssueIndex);

    const issue = issues[nextIndex];
    if (!issue || !this.activeAdapter) {
      return;
    }

    const row = this.overlay.rectIssueMap.find((entry) => entry.issue.key === issue.key);
    if (row) {
      this.popover.open(issue, row.rect);
    }
  }

  focusNextIssue() {
    if (!this.lastRun || this.lastRun.issues.length === 0) {
      return;
    }
    const next = this.focusedIssueIndex < this.lastRun.issues.length - 1
      ? this.focusedIssueIndex + 1
      : 0;
    this.focusIssue(next);
  }

  focusPrevIssue() {
    if (!this.lastRun || this.lastRun.issues.length === 0) {
      return;
    }
    const prev = this.focusedIssueIndex > 0
      ? this.focusedIssueIndex - 1
      : this.lastRun.issues.length - 1;
    this.focusIssue(prev);
  }

  applyIssueByIndex(index) {
    if (!this.lastRun) {
      return;
    }
    const issue = this.lastRun.issues[index];
    if (!issue) {
      return;
    }
    this.applyIssue(issue);
  }

  ignoreIssueByIndex(index) {
    if (!this.lastRun) {
      return;
    }
    const issue = this.lastRun.issues[index];
    if (!issue) {
      return;
    }
    this.ignoreIssue(issue);
  }

  async ignoreIssue(issue) {
    this.ignoredKeys.add(issue.key);
    await storageLocalSet({
      [IGNORED_KEY]: Array.from(this.ignoredKeys).slice(-1500),
    });

    if (!this.lastRun) {
      return;
    }

    this.lastRun.issues = this.lastRun.issues.filter((item) => item.key !== issue.key);
    this.focusedIssueIndex = clamp(this.focusedIssueIndex, -1, this.lastRun.issues.length - 1);
    this.renderState(this.lastRun);
    this.popover.close();
    this.panel.setStatus("idle", "Issue ignored.");
    this.addActivity(
      `Ignored suggestion: ${issue.message}`,
      "info",
      { type: "unignore", issueKey: issue.key }
    );
  }

  applyIssue(issue) {
    if (!this.activeAdapter || !this.lastRun) {
      return;
    }
    if (!issue.replacement) {
      this.panel.setStatus("error", "No replacement available for this issue.");
      return;
    }

    const ok = this.activeAdapter.replaceIssue(issue, issue.replacement, this.lastRun.snapshot);
    if (!ok) {
      this.panel.setStatus("error", "Could not apply replacement at current cursor location.");
      return;
    }

    this.panel.setStatus("idle", "Replacement applied.");
    this.popover.close();
    this.addActivity(
      `Applied suggestion${issue.targetText ? ` for '${issue.targetText}'` : ""}.`,
      "success",
      { type: "editor-undo" }
    );
    this.scheduleAnalysis("apply", true);
  }

  syncPopoverWithCaret() {
    if (!this.lastRun || !this.activeAdapter) {
      this.popover.close();
      return;
    }

    const snapshot = this.activeAdapter.getVisibleTextSnapshot();
    const caretOffset = this.activeAdapter.getCaretOffset(snapshot);
    if (!Number.isInteger(caretOffset)) {
      this.popover.close();
      return;
    }

    let best = null;
    for (const issue of this.lastRun.issues) {
      let start = null;
      let end = null;
      if (Number.isInteger(issue.start) && Number.isInteger(issue.end)) {
        start = this.lastRun.snapshot.scopeStart + issue.start;
        end = this.lastRun.snapshot.scopeStart + issue.end;
      } else if (issue.targetText) {
        const idx = snapshot.text.indexOf(issue.targetText);
        if (idx !== -1) {
          start = idx;
          end = idx + issue.targetText.length;
        }
      }

      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        continue;
      }

      if (caretOffset >= start && caretOffset <= end) {
        best = issue;
        break;
      }
    }

    if (!best) {
      this.popover.close();
      return;
    }

    const row = this.overlay.rectIssueMap.find((entry) => entry.issue.key === best.key);
    if (!row) {
      this.popover.close();
      return;
    }

    if (this.popover.currentIssue?.key === best.key) {
      this.popover.position(row.rect);
    } else {
      this.popover.open(best, row.rect);
    }
  }

  destroy() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
    }
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
    }
    if (this.snapshotSyncTimer) {
      clearTimeout(this.snapshotSyncTimer);
    }
    storageLocalSet({
      [UI_SURFACE_KEY]: {
        surface: "none",
        updatedAt: Date.now(),
      },
    });

    this.detachGlobalListeners();
    this.popover.close();
    this.overlay.remove();
    this.panel.remove();

    for (const adapter of this.adapters) {
      adapter.destroy();
    }
    this.adapters = [];
  }
}

  zeta.ZetaApp = ZetaApp;
})();
