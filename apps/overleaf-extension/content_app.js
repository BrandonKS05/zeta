(() => {
  "use strict";

  const zeta = window.__zetaContent || (window.__zetaContent = {});
  const {
    DEBUG_CHAT_ONLY = false,
    SETTINGS_KEY,
    MODE_KEY,
    IGNORED_KEY,
    TELEMETRY_KEY,
    PANEL_SNAPSHOT_KEY,
    CHAT_SNAPSHOT_KEY,
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

  const zetaLogPrefix = (tag) => `[zeta:${tag}] ${new Date().toISOString()}`;

  if (DEBUG_CHAT_ONLY) {
    const _info = console.info.bind(console);
    const _warn = console.warn.bind(console);
    const chatOnly = (s) => /assistant|zeta-chat|sendChatForThread|chat endpoint|chat_request|chat_send|chat_delete|autocomplete/.test(s);
    console.info = function (...args) {
      if (!chatOnly(String(args[0] ?? ""))) return;
      _info.apply(console, args);
    };
    console.warn = function (...args) {
      if (!chatOnly(String(args[0] ?? ""))) return;
      _warn.apply(console, args);
    };
  }

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

const AUTOCOMPLETE_DEBOUNCE_MS = 1000;
const AUTOCOMPLETE_CACHE_TTL_MS = 30 * 1000;
const AUTOCOMPLETE_MIN_FRAGMENT_CHARS = 8;
const AUTOCOMPLETE_MIN_FRAGMENT_WORDS = 2;
const AUTOCOMPLETE_MAX_TEXT_WINDOW = 16000;
const AUTOCOMPLETE_MAX_CONTEXT_WINDOW = 2400;
const MODAL_BASE_URL =
  "https://amirzeinali--herald-translator-translator-v1-translate-batch.modal.run";
const DEFAULT_MODAL_ANALYZE_URL = `${MODAL_BASE_URL}/v1/analyze`;
const DEFAULT_LEAN_SOLVE_URL = "http://13.57.35.202:8000/v1/lean/solve";
const DEFAULT_LEAN_COMPLETE_URL = "http://13.57.35.202:8000/v1/lean/complete";
const HARDCODED_ANALYZE_URL = DEFAULT_LEAN_SOLVE_URL;
const HARDCODED_COMPLETE_URL = DEFAULT_LEAN_COMPLETE_URL;

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
      onRunNow: () => this.requestAnalysis("manual", true),
      onRegenerate: () => this.requestAnalysis("regenerate", true),
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
    this.analysisRunInProgress = false;
    this.pendingAnalysisReason = "";
    this.pendingAnalysisForce = false;
    this.lastAnalyzedSignature = "";
    this.lastRun = null;
    this.focusedIssueIndex = -1;
    this.responseCache = new Map();
    this.inFlightSentenceRequests = new Map();
    this.sentenceCache = new Map();
    this.chunkTree = null;
    this.activeChunkId = null;
    this.graphChunkTree = null;
    this.graphActiveChunkId = null;
    this.graphAnalysisTarget = null;
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
    this.chatThreads = [];
    this.chatById = new Map();
    this.activeChatThreadId = null;
    this.lastChatSnapshotSignature = "";
    this.pinnedPopoverIssueKey = "";
    this.autocompleteTimer = null;
    this.autocompleteCache = new Map();
    this.autocompleteRequestSeq = 0;
    this.autocompleteInFlight = false;
    this.autocompletePendingSince = 0;
    this.autocompleteQueuedReason = "";
    this.activeAutocomplete = null;
    this.autocompleteAwaitingUserInput = false;
    this.tabGhostElement = null;
    this.autocompleteBackoffUntil = 0;
    this.autocompleteLastErrorKey = "";
    this.autocompleteLastErrorAt = 0;
    this.autocompleteGeneratedSentenceBoundaries = [];

    this.boundSelectionChange = this.handleSelectionChange.bind(this);
    this.boundFocusIn = this.handleFocusIn.bind(this);
    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundScheduleByScroll = this.scheduleRender.bind(this);
    this.boundStorageChange = this.handleStorageChange.bind(this);
    this.boundRuntimeMessage = this.handleRuntimeMessage.bind(this);
  }

  async init() {
    await this.loadSettings();
    await this.loadChatSnapshot();
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

    this.ensureTabGhostElement();
    this.refreshAdapters();
    this.activateInitialAdapter();
    this.attachGlobalListeners();

    if (this.activeAdapter) {
      this.scheduleAnalysis("init", true);
      this.scheduleAutocomplete("init", true);
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
    merged.autocompleteEnabled = merged.autocompleteEnabled !== false;
    merged.autoAnalyzeDocument = merged.autoAnalyzeDocument !== false;
    merged.autocompleteShowTopK = merged.autocompleteShowTopK === true;
    merged.autocompleteManualTrigger = merged.autocompleteManualTrigger === true;
    merged.backendUrl = HARDCODED_ANALYZE_URL;
    merged.notationStrictness = ["relaxed", "balanced", "strict"].includes(merged.notationStrictness)
      ? merged.notationStrictness
      : "balanced";
    // Always start minimized to keep the editor unobstructed by default.
    merged.panelOpen = false;

    this.settings = merged;
    this.ignoredKeys = new Set(ensureArray(localValues[IGNORED_KEY]).filter(Boolean));
  }

  async loadChatSnapshot() {
    const localValues = await storageLocalGet({
      [CHAT_SNAPSHOT_KEY]: null,
    });
    const snapshot = localValues[CHAT_SNAPSHOT_KEY];
    if (!snapshot || typeof snapshot !== "object") {
      this.chatThreads = [];
      this.chatById = new Map();
      this.activeChatThreadId = null;
      this.persistChatSnapshot();
      return;
    }

    let parsedThreads = [];
    const rawThreads = Array.isArray(snapshot.threads) ? snapshot.threads : [];
    for (const rawThread of rawThreads) {
      if (!rawThread || typeof rawThread !== "object") {
        continue;
      }
      const id = String(rawThread.id || "").trim();
      if (!id) {
        continue;
      }
      const messages = [];
      const rawMessages = Array.isArray(rawThread.messages) ? rawThread.messages : [];
      for (const rawMessage of rawMessages) {
        if (!rawMessage || typeof rawMessage !== "object") {
          continue;
        }
        const text = String(rawMessage.text || "").trim();
        if (!text) {
          continue;
        }
        messages.push({
          id: String(rawMessage.id || `msg-${Date.now()}`),
          role: rawMessage.role === "assistant" ? "assistant" : "user",
          text,
          createdAt: Number(rawMessage.createdAt) || Date.now(),
          error: !!rawMessage.error,
        });
      }

      parsedThreads.push({
        id,
        title: String(rawThread.title || "Issue thread"),
        issueKey: String(rawThread.issueKey || ""),
        category: String(rawThread.category || "issue"),
        severity: String(rawThread.severity || "unknown"),
        issueMessage: String(rawThread.issueMessage || ""),
        targetText: String(rawThread.targetText || ""),
        replacement: String(rawThread.replacement || ""),
        line: Number.isInteger(rawThread.line) ? rawThread.line : null,
        column: Number.isInteger(rawThread.column) ? rawThread.column : null,
        source: String(rawThread.source || ""),
        sentenceText: String(rawThread.sentenceText || ""),
        chunkId: String(rawThread.chunkId || ""),
        compileSuccess: typeof rawThread.compileSuccess === "boolean" ? rawThread.compileSuccess : null,
        diagnostics: Array.isArray(rawThread.diagnostics) ? rawThread.diagnostics : [],
        semanticReasons: Array.isArray(rawThread.semanticReasons) ? rawThread.semanticReasons : [],
        leanCode: String(rawThread.leanCode || ""),
        requestUrl: String(rawThread.requestUrl || ""),
        issueSignature: String(rawThread.issueSignature || ""),
        status: String(rawThread.status || "idle"),
        lastSource: String(rawThread.lastSource || ""),
        lastLatencyMs: Number(rawThread.lastLatencyMs) || 0,
        lastError: String(rawThread.lastError || ""),
        isActiveIssue: rawThread.isActiveIssue !== false,
        updatedAt: Number(rawThread.updatedAt) || Date.now(),
        createdAt: Number(rawThread.createdAt) || Date.now(),
        messages,
      });
    }

    parsedThreads.sort((a, b) => b.updatedAt - a.updatedAt);
    const existingGeneralThread = parsedThreads.find((thread) => thread.id === "general") || null;
    const normalizedGeneralThread = this.buildGeneralChatThread(existingGeneralThread, 0);
    parsedThreads = [
      normalizedGeneralThread,
      ...parsedThreads.filter((thread) => thread.id !== "general"),
    ];
    this.chatThreads = parsedThreads.slice(0, 30);
    this.chatById = new Map(this.chatThreads.map((thread) => [thread.id, thread]));
    const activeThreadId = String(snapshot.activeThreadId || "");
    this.activeChatThreadId = this.chatById.has(activeThreadId)
      ? activeThreadId
      : (this.chatThreads[0]?.id || null);
    this.persistChatSnapshot();
  }

  attachGlobalListeners() {
    document.addEventListener("selectionchange", this.boundSelectionChange, true);
    document.addEventListener("focusin", this.boundFocusIn, true);
    document.addEventListener("pointerdown", this.boundPointerDown, true);
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
    document.removeEventListener("pointerdown", this.boundPointerDown, true);
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
      console.info(`${zetaLogPrefix("content")} ui_surface_received`, {
        surface,
      });
      if (surface === "popup" && this.settings.panelOpen) {
        this.settings.panelOpen = false;
        this.panel.setOpen(false);
      }
      sendResponse?.({ ok: true, surface });
      return true;
    }

    if (message && message.type === "zeta-chat-open-thread") {
      const threadId = String(message.threadId || "");
      const ok = this.setActiveChatThread(threadId);
      sendResponse?.({
        ok,
        threadId,
      });
      return true;
    }

    if (message && message.type === "zeta-chat-delete-thread") {
      const threadId = String(message.threadId || "");
      this.deleteChatThread(threadId)
        .then((ok) => sendResponse?.({ ok, threadId }))
        .catch(() => sendResponse?.({ ok: false, threadId }));
      return true;
    }

    if (message && message.type === "zeta-chat-send") {
      const threadId = String(message.threadId || "");
      const userMessage = String(message.message || "");
      console.info(`${zetaLogPrefix("content")} assistant zeta-chat-send received`, {
        threadId,
        messageLength: userMessage.length,
        hasThread: this.chatById.has(threadId),
      });
      this.sendChatForThread(threadId, userMessage)
        .then((result) => {
          console.info(`${zetaLogPrefix("content")} assistant sendChatForThread resolved`, {
            ok: true,
            source: result?.source,
            threadId: result?.threadId,
          });
          sendResponse?.({ ok: true, ...result });
        })
        .catch((error) => {
          console.warn(`${zetaLogPrefix("content")} assistant sendChatForThread rejected`, {
            error: String(error?.message || error),
            threadId,
          });
          sendResponse?.({
            ok: false,
            error: String(error?.message || error || "Assistant request failed."),
          });
        });
      return true;
    }

    if (!message || message.type !== "zeta-popup-action") {
      return false;
    }

    const action = String(message.action || "");
    console.info(`${zetaLogPrefix("content")} popup_action_received`, {
      action,
    });

    const run = async () => {
      if (action === "refresh-checker") {
        this.requestAnalysis("popup-macro", true);
        this.addActivity("Macro: refresh checker.", "info");
        return;
      }
      if (action === "clear-chat-history") {
        this.clearActiveChatHistory();
        this.addActivity("Macro: cleared all chat history.", "info");
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
      if (action === "apply-issue") {
        if (this.focusedIssueIndex >= 0) {
          this.applyIssueByIndex(this.focusedIssueIndex);
          this.addActivity("Macro: applied current fix.", "info");
        }
        return;
      }
      if (action === "analyze-graph-chunk") {
        const startRaw = Number(message.start);
        const endRaw = Number(message.end);
        if (!Number.isInteger(startRaw) || !Number.isInteger(endRaw)) {
          this.addActivity("Graph analyze failed: invalid chunk bounds.", "error");
          return;
        }
        const start = Math.max(0, Math.min(startRaw, endRaw));
        const end = Math.max(0, Math.max(startRaw, endRaw));
        const chunkId = String(message.chunkId || "").trim();
        const label = String(message.label || "").trim();
        this.graphAnalysisTarget = {
          chunkId,
          start,
          end,
          label,
        };
        if (chunkId) {
          this.graphActiveChunkId = chunkId;
          if (this.graphChunkTree && typeof this.graphChunkTree === "object") {
            this.graphChunkTree.activeChunkId = chunkId;
          }
        }
        this.persistPanelSnapshot();
        this.requestAnalysis("graph-node", true);
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
      nextSettings.autocompleteEnabled = nextSettings.autocompleteEnabled !== false;
      nextSettings.autoAnalyzeDocument = nextSettings.autoAnalyzeDocument !== false;
      nextSettings.autocompleteShowTopK = nextSettings.autocompleteShowTopK === true;
      nextSettings.autocompleteManualTrigger = nextSettings.autocompleteManualTrigger === true;
      nextSettings.backendUrl = HARDCODED_ANALYZE_URL;
      nextSettings.panelOpen = this.settings.panelOpen;
      this.settings = nextSettings;
      if (!this.settings.autocompleteEnabled) {
        this.cancelAutocompleteNow();
      } else if (this.settings.autocompleteManualTrigger) {
        this.clearAutocompleteSuggestion();
      }
      changed = true;
    }

    if (changed) {
      this.panel.setSettings(this.settings);
      this.panel.setOpen(!!this.settings.panelOpen);
      this.scheduleAnalysis("storage-change", true);
      this.scheduleAutocomplete("storage-change", true);
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
            if (this.activeAutocomplete) {
              this.clearAutocompleteSuggestion();
            }
            this.scheduleChunkSnapshotSync("typing");
            if (this.settings.checkOnType) {
              this.scheduleAnalysis("typing");
            }
            this.scheduleAutocomplete("typing");
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
        this.clearAutocompleteSuggestion();
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
      return new DomLineAdapter(root, content, ".cm-line", scroller, "cm");
    }

    if (root.matches(".ace_editor")) {
      const content = root.querySelector(".ace_text-layer");
      const scroller = root.querySelector(".ace_scroller") || root;
      if (!content) {
        return null;
      }
      return new DomLineAdapter(root, content, ".ace_line", scroller, "ace");
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
    this.autocompleteAwaitingUserInput = false;
    this.clearAutocompleteSuggestion();
    this.panel.setStatus("idle", `Ready on ${adapter.constructor.name}`);
    this.panel.setGlobalState("ready", "global · editor connected");
    this.scheduleChunkSnapshotSync("adapter-switch");
    this.scheduleAnalysis("adapter-switch", true);
    this.scheduleAutocomplete("adapter-switch", true);
  }

  handleFocusIn(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const adapter = this.adapters.find((item) => item.containsNode(target));
    if (adapter) {
      this.setActiveAdapter(adapter);
      this.scheduleAutocomplete("focus", true);
    }
  }

  handleSelectionChange() {
    if (!this.activeAdapter) {
      this.clearAutocompleteSuggestion();
      return;
    }
    if (this.autocompleteInFlight) {
      this.cancelAutocompleteNow();
      this.renderTabGhost();
    }
    if (this.lastRun) {
      this.syncPopoverWithCaret();
    }
    this.scheduleAutocomplete("selection");
  }

  handlePointerDown(event) {
    if (!event || event.button !== 0) {
      return;
    }
    const target = event.target;
    if (target instanceof Element) {
      if (target.closest(".zeta-shell, .zeta-popup-mirror, .zeta-suggestion-popover")) {
        return;
      }
    }
    if (!this.lastRun || !this.activeAdapter || !this.overlay) {
      this.pinnedPopoverIssueKey = "";
      return;
    }
    if (!Array.isArray(this.overlay.rectIssueMap) || this.overlay.rectIssueMap.length === 0) {
      this.pinnedPopoverIssueKey = "";
      return;
    }

    const row = this.overlay.findIssueAtPoint(event.clientX, event.clientY);
    if (!row || !row.issue) {
      this.pinnedPopoverIssueKey = "";
      return;
    }

    const issue = row.issue;
    this.pinnedPopoverIssueKey = String(issue.key || "");
    event.__zetaKeepPopover = true; // consumed by popover outside-click handler
    const issueIndex = ensureArray(this.lastRun.issues).findIndex((item) => item?.key === issue.key);
    if (issueIndex >= 0) {
      this.focusedIssueIndex = issueIndex;
      this.panel.setIssues(this.lastRun.issues, this.focusedIssueIndex);
      this.panel.scrollIssueIntoView(this.focusedIssueIndex);
    }
    this.popover.open(issue, row.rect);
  }

  shouldClearAutocompleteOnKeydown(event) {
    if (!event) {
      return false;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }
    const key = String(event.key || "");
    if (!key) {
      return false;
    }
    if (key === "Backspace" || key === "Delete" || key === "Enter" || key === " ") {
      return true;
    }
    return key.length === 1;
  }

  shouldResumeAutocompleteOnUserInput(event) {
    if (!event) {
      return false;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }
    const key = String(event.key || "");
    if (!key) {
      return false;
    }
    if (key === "Tab" || key === "Shift" || key === "Meta" || key === "Control" || key === "Alt") {
      return false;
    }
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
      return false;
    }
    return this.shouldClearAutocompleteOnKeydown(event);
  }

  handleKeyDown(event) {
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "");
    const metaHeld = event.metaKey || event.getModifierState?.("Meta");
    const ctrlHeld = event.ctrlKey || event.getModifierState?.("Control");
    const altHeld = event.altKey || event.getModifierState?.("Alt");
    const shiftHeld = event.shiftKey || event.getModifierState?.("Shift");
    const ts = new Date().toISOString();

    if (this.tryAcceptTabCompletion(event)) {
      return;
    }

    if (this.autocompleteAwaitingUserInput && this.shouldResumeAutocompleteOnUserInput(event)) {
      this.autocompleteAwaitingUserInput = false;
    }

    if (this.activeAutocomplete && this.shouldClearAutocompleteOnKeydown(event)) {
      this.clearAutocompleteSuggestion();
    }

    console.info(`${zetaLogPrefix("content")} keydown`, {
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
      console.info(`${zetaLogPrefix("content")} shortcut_match`, {
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
      console.info(`${zetaLogPrefix("content")} shortcut_match`, {
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
      console.info(`${zetaLogPrefix("content")} shortcut_match`, {
        ts,
        shortcut: "Alt+Shift+U",
        action: "undo-last",
      });
      this.markShortcutTriggered("Alt+Shift+U");
      this.undoLastAction();
      return;
    }

    if (altHeld && shiftHeld && (key === "c" || code === "KeyC")) {
      event.preventDefault();
      console.info(`${zetaLogPrefix("content")} shortcut_match`, {
        ts,
        shortcut: "Alt+Shift+C",
        action: "clear-chat-history",
      });
      this.markShortcutTriggered("Alt+Shift+C");
      this.clearActiveChatHistory();
      return;
    }

    if ((metaHeld || ctrlHeld) && shiftHeld && (key === "m" || code === "KeyM")) {
      event.preventDefault();
      console.info(`${zetaLogPrefix("content")} shortcut_match`, {
        ts,
        shortcut: metaHeld ? "Cmd+Shift+M" : "Ctrl+Shift+M",
        action: "manual-autocomplete",
      });
      this.markShortcutTriggered(metaHeld ? "Cmd+Shift+M" : "Ctrl+Shift+M");
      this.triggerManualAutocomplete("shortcut");
      return;
    }

    if (altHeld && shiftHeld && (key === "r" || code === "KeyR")) {
      event.preventDefault();
      console.info(`${zetaLogPrefix("content")} shortcut_match`, {
        ts,
        shortcut: "Alt+Shift+R",
        action: "refresh-checker",
      });
      this.markShortcutTriggered("Alt+Shift+R");
      this.requestAnalysis("shortcut-refresh", true);
      return;
    }

    if (altHeld && shiftHeld && (key === "h" || code === "KeyH")) {
      event.preventDefault();
      console.info(`${zetaLogPrefix("content")} shortcut_match`, {
        ts,
        shortcut: "Alt+Shift+H",
        action: "clear-history",
      });
      this.markShortcutTriggered("Alt+Shift+H");
      this.clearActivityHistory();
      return;
    }

    if (ctrlHeld && shiftHeld && (key === "Enter" || key === "enter" || code === "Enter")) {
      event.preventDefault();
      console.info(`${zetaLogPrefix("content")} shortcut_match`, {
        ts,
        shortcut: "Ctrl+Shift+Enter",
        action: "refresh-checker",
      });
      this.markShortcutTriggered("Ctrl+Shift+Enter");
      this.requestAnalysis("shortcut", true);
      return;
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

  triggerManualAutocomplete(source = "manual") {
    if (this.settings.autocompleteEnabled === false) {
      this.addActivity("Manual autocomplete ignored because autocomplete is disabled.", "info");
      return;
    }
    this.autocompleteAwaitingUserInput = false;
    this.scheduleAutocomplete("manual", true);
    this.addActivity(`Manual autocomplete requested (${source}).`, "info");
  }

  ensureTabGhostElement() {
    if (this.tabGhostElement && this.tabGhostElement.isConnected) {
      return;
    }
    const element = document.createElement("div");
    element.className = "zeta-tab-ghost is-hidden";
    element.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    element.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const item = target.closest(".zeta-tab-ghost-item");
      if (!item) {
        return;
      }
      const index = Number(item.getAttribute("data-autocomplete-index"));
      if (!Number.isFinite(index) || !this.activeAutocomplete) {
        return;
      }
      const maxIndex = Math.max(0, ensureArray(this.activeAutocomplete.candidates).length - 1);
      this.activeAutocomplete.selectedIndex = clamp(Math.round(index), 0, maxIndex);
      this.renderTabGhost();
    });
    document.documentElement.appendChild(element);
    this.tabGhostElement = element;
  }

  clearAutocompleteSuggestion() {
    this.activeAutocomplete = null;
    this.renderTabGhost();
  }

  cancelAutocompleteNow() {
    if (this.autocompleteTimer) {
      clearTimeout(this.autocompleteTimer);
      this.autocompleteTimer = null;
    }
    this.autocompleteRequestSeq += 1;
    this.autocompleteInFlight = false;
    this.autocompletePendingSince = 0;
    this.autocompleteQueuedReason = "";
    this.autocompleteAwaitingUserInput = false;
    this.clearAutocompleteSuggestion();
  }

  reportAutocompleteErrorOnce(key, message) {
    const dedupeKey = String(key || "").trim();
    if (!dedupeKey || !message) {
      return;
    }
    const now = Date.now();
    if (this.autocompleteLastErrorKey === dedupeKey && now - this.autocompleteLastErrorAt < 45_000) {
      return;
    }
    this.autocompleteLastErrorKey = dedupeKey;
    this.autocompleteLastErrorAt = now;
    this.addActivity(String(message), "error");
  }

  normalizeAutocompleteSuffix(prefixText, candidateText) {
    const prefix = String(prefixText || "");
    const candidateRaw = String(candidateText || "")
      .replace(/\r/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!candidateRaw) {
      return "";
    }

    const normalizeForOverlap = (text) => {
      const value = String(text || "");
      const chars = [];
      const cuts = [0];
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (/[\s$]/.test(char)) {
          continue;
        }
        chars.push(char.toLowerCase());
        cuts.push(index + 1);
      }
      return {
        normalized: chars.join(""),
        cuts,
      };
    };

    const prefixNorm = normalizeForOverlap(prefix).normalized;
    const withLeadingSpace = candidateRaw.startsWith(" ") ? candidateRaw : ` ${candidateRaw}`;
    const variants = [withLeadingSpace, candidateRaw];

    for (const variant of variants) {
      const candidateNorm = normalizeForOverlap(variant);
      if (!candidateNorm.normalized) {
        continue;
      }

      let overlapLen = 0;
      const maxOverlap = Math.min(prefixNorm.length, candidateNorm.normalized.length);
      for (let size = maxOverlap; size >= 1; size -= 1) {
        if (prefixNorm.slice(-size) === candidateNorm.normalized.slice(0, size)) {
          overlapLen = size;
          break;
        }
      }

      const cutIndex = candidateNorm.cuts[overlapLen] ?? 0;
      const suffix = variant.slice(cutIndex).replace(/^\s+/, " ").trimEnd();
      if (suffix.trim()) {
        return suffix;
      }
    }

    return "";
  }

  normalizeAutocompleteInsertion(prefixText, completionText, suffixText = "") {
    const prefix = String(prefixText || "");
    const suffix = String(suffixText || "");
    let value = String(completionText || "").replace(/\r/g, "");
    if (!value) {
      return "";
    }

    const prefixTrimRight = prefix.replace(/\s+$/, "");
    let overlapLen = 0;
    for (let n = 1; n <= Math.min(prefixTrimRight.length, value.length); n++) {
      if (prefixTrimRight.slice(-n) === value.slice(0, n)) {
        overlapLen = n;
      }
    }
    if (overlapLen > 0) {
      value = value.slice(overlapLen);
    }
    const suffixTrimLeft = suffix.replace(/^\s+/, "");
    const prefixEndsWhitespace = /\s$/.test(prefix);
    const suffixStartsWhitespace = /^\s/.test(suffix);

    const removeLeadingToken = (token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      value = value.replace(new RegExp(`^\\s*${escaped}`), "");
    };
    const removeTrailingToken = (token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      value = value.replace(new RegExp(`${escaped}\\s*$`), "");
    };
    const normalizedLeading = () => value.trimStart();
    const normalizedTrailing = () => value.trimEnd();

    for (const token of ["$$", "$", "\\(", "\\["]) {
      if (prefixTrimRight.endsWith(token) && normalizedLeading().startsWith(token)) {
        removeLeadingToken(token);
      }
    }
    for (const token of ["$$", "$", "\\)", "\\]"]) {
      if (suffixTrimLeft.startsWith(token) && normalizedTrailing().endsWith(token)) {
        removeTrailingToken(token);
      }
    }

    if (prefixEndsWhitespace) {
      value = value.replace(/^\s+/, "");
    } else {
      const startsWhitespace = /^\s/.test(value);
      const startsClosingPunctuation = /^[,.;:!?)}\]]/.test(value);
      if (startsWhitespace) {
        value = value.replace(/^\s+/, " ");
      } else if (prefixTrimRight && /[A-Za-z0-9)\]}]$/.test(prefixTrimRight) && !startsClosingPunctuation) {
        value = ` ${value}`;
      }
    }

    if (/[\\$]$/.test(prefixTrimRight) || /\\\($|\\\[$/.test(prefixTrimRight)) {
      value = value.replace(/^\s+/, "");
    }

    if (suffixTrimLeft && /^[,.;:!?)}\]]/.test(suffixTrimLeft)) {
      value = value.replace(/\s+$/, "");
    }
    if (suffixStartsWhitespace) {
      value = value.replace(/\s+$/, "");
    }

    value = value.replace(/\s+\n/g, "\n");
    value = value.replace(/\n\s+/g, "\n");
    return value.trim() ? value : "";
  }

  normalizeAutocompleteBoundarySpacing(prefixText, insertionText, suffixText = "") {
    const prefix = String(prefixText || "");
    const suffix = String(suffixText || "");
    let value = String(insertionText || "").replace(/\r/g, "");
    if (!value) {
      return "";
    }

    const prefixEndsWhitespace = /\s$/.test(prefix);
    const suffixStartsWhitespace = /^\s/.test(suffix);

    if (prefixEndsWhitespace) {
      value = value.trimStart();
    } else {
      const startsWhitespace = /^\s/.test(value);
      const startsClosingPunctuation = /^[,.;:!?)}\]]/.test(value);
      if (startsWhitespace) {
        value = value.replace(/^\s+/, " ");
      } else if (prefix && /[A-Za-z0-9)\]}]$/.test(prefix) && !startsClosingPunctuation) {
        value = ` ${value}`;
      }
    }

    if (suffixStartsWhitespace || /^[,.;:!?)}\]]/.test(suffix)) {
      value = value.replace(/\s+$/, "");
    }

    value = value.replace(/\s+\n/g, "\n");
    value = value.replace(/\n\s+/g, "\n");
    return value.trim() ? value : "";
  }

  isSentenceCompleteForAutocomplete(prefixText) {
    let probe = String(prefixText || "");
    if (!probe) {
      return false;
    }
    probe = probe.replace(/\s+$/, "");
    if (!probe) {
      return false;
    }

    while (true) {
      const next = probe
        .replace(/(?:\\\)|\\\]|\)|\]|\}|["'`]|”|’)+$/gu, "")
        .replace(/\$+$/g, "")
        .replace(/\s+$/g, "");
      if (next === probe) {
        break;
      }
      probe = next;
    }

    return /[.?!;:]$/.test(probe);
  }

  getLiveAutocompleteBoundaryContext() {
    if (!this.activeAdapter || !this.activeAdapter.isConnected()) {
      return null;
    }
    try {
      const snapshot = this.activeAdapter.getScopeSnapshot("document");
      const text = String(snapshot?.sourceText || snapshot?.context || snapshot?.text || "");
      const caretRaw = this.resolveCaretOffsetInScope(snapshot, this.activeAdapter);
      if (!Number.isInteger(caretRaw)) {
        return null;
      }
      const caret = clamp(caretRaw, 0, text.length);
      return {
        prefixText: text.slice(0, caret),
        suffixText: text.slice(caret),
      };
    } catch (_error) {
      return null;
    }
  }

  isSelectionInActiveAdapter() {
    if (!this.activeAdapter || !this.activeAdapter.isConnected()) {
      return false;
    }
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0) {
      return false;
    }
    const anchorNode = selection.anchorNode;
    return !!(anchorNode && this.activeAdapter.containsNode(anchorNode));
  }

  isOverleafSourceAdapter(adapter) {
    if (!adapter?.root || !(adapter.root instanceof Element)) {
      return false;
    }
    if (!location.hostname.endsWith("overleaf.com")) {
      return false;
    }
    if (!adapter.root.matches(".cm-editor, .ace_editor")) {
      return false;
    }
    if (adapter.root.closest(".pdfjs, .pdf-viewer, .pdf-preview, .preview, .ol-preview")) {
      return false;
    }
    return true;
  }

  /** Used for autocomplete only: allow any host with a valid editor (so localhost / dev works). */
  isAutocompleteAllowedAdapter(adapter) {
    if (!adapter?.root || !(adapter.root instanceof Element)) {
      return false;
    }
    if (!adapter.root.matches(".cm-editor, .ace_editor")) {
      return false;
    }
    if (adapter.root.closest(".pdfjs, .pdf-viewer, .pdf-preview, .preview, .ol-preview")) {
      return false;
    }
    return true;
  }

  resolveAutocompleteEndpoint() {
    const base = HARDCODED_ANALYZE_URL;
    if (base && /\/v1\/lean\/solve\/?$/.test(base)) {
      return base.replace(/\/v1\/lean\/solve\/?$/, "/v1/lean/complete");
    }
    return HARDCODED_COMPLETE_URL;
  }

  collectAutocompleteContext() {
    const adapter = this.activeAdapter;
    if (!adapter || !adapter.isConnected() || !this.isAutocompleteAllowedAdapter(adapter)) {
      return null;
    }

    const snapshot = adapter.getScopeSnapshot("document");
    const sourceText = String(snapshot.sourceText || snapshot.context || snapshot.text || "");
    if (!sourceText.trim()) {
      return null;
    }

    const caretOffsetRaw = this.resolveCaretOffsetInScope(snapshot, adapter);
    if (!Number.isInteger(caretOffsetRaw)) {
      return null;
    }
    const caretOffset = clamp(caretOffsetRaw, 0, sourceText.length);
    const prefixText = sourceText.slice(0, caretOffset);
    const suffixFromCursor = sourceText.slice(caretOffset);
    if (this.isSentenceCompleteForAutocomplete(prefixText)) {
      return null;
    }
    const sentenceBoundary = Math.max(
      prefixText.lastIndexOf("\n"),
      prefixText.lastIndexOf("."),
      prefixText.lastIndexOf("!"),
      prefixText.lastIndexOf("?"),
      prefixText.lastIndexOf(";"),
      prefixText.lastIndexOf(":")
    );
    const fragment = prefixText.slice(sentenceBoundary + 1).replace(/^\s+/, "");
    if (fragment.length < AUTOCOMPLETE_MIN_FRAGMENT_CHARS) {
      return null;
    }
    const words = fragment.split(/\s+/).filter(Boolean);
    if (words.length < AUTOCOMPLETE_MIN_FRAGMENT_WORDS) {
      return null;
    }
    if (/\\[A-Za-z]*$/.test(fragment)) {
      return null;
    }

    const textStart = caretOffset > AUTOCOMPLETE_MAX_TEXT_WINDOW
      ? caretOffset - AUTOCOMPLETE_MAX_TEXT_WINDOW
      : 0;
    const textEnd = Math.min(sourceText.length, caretOffset + 120);
    const textWindow = sourceText.slice(textStart, textEnd);
    const localCursorOffset = caretOffset - textStart;

    const contextStart = Math.max(0, caretOffset - AUTOCOMPLETE_MAX_CONTEXT_WINDOW);
    const contextEnd = Math.min(sourceText.length, caretOffset + 320);
    const contextWindow = sourceText.slice(contextStart, contextEnd);

    const signature = shortHash(
      JSON.stringify({
        endpoint: this.resolveAutocompleteEndpoint(),
        mode: this.settings.mode,
        caretOffset,
        fragmentTail: fragment.slice(-240),
      })
    );

    return {
      snapshot,
      sourceText,
      caretOffset,
      prefixText,
      suffixText: sourceText.slice(caretOffset),
      fragment,
      sentenceBoundary,
      textWindow,
      localCursorOffset,
      contextWindow,
      signature,
    };
  }

  async requestAutocomplete(endpointUrl, context, reason, options = {}) {
    const requestBody = {
      text: context.textWindow,
      cursor_offset: context.localCursorOffset,
      context: context.contextWindow,
      imports: ["Std"],
      max_candidates: 3,
      max_new_tokens: this.settings.mode === "accurate" ? 24 : 16,
      temperature: this.settings.mode === "accurate" ? 0.2 : 0.35,
      include_debug: false,
      zeta_meta: {
        reason,
        scope: "document",
      },
    };
    const cacheKey = shortHash(`${endpointUrl}:${JSON.stringify(requestBody)}`);
    const now = Date.now();
    const cached = this.autocompleteCache.get(cacheKey);
    if (cached && now - cached.timestamp <= AUTOCOMPLETE_CACHE_TTL_MS) {
      return {
        payload: cached.payload,
        cacheHit: true,
      };
    }

    const baseTimeoutMs = Math.min(18000, Math.max(4000, Number(this.settings.requestTimeoutMs) || 6000));
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(18000, options.timeoutMs)
      : baseTimeoutMs;
    const prefixLen = String(context.prefixText || "").length;
    const prefixTail = String(context.prefixText || "").slice(-80);
    const autocompleteStartedAt = performance.now();
    console.info(`${zetaLogPrefix("autocomplete")} request start`, {
      endpoint: endpointUrl,
      timeoutMs,
      prefixLen,
      prefixTail: prefixTail || "(empty)",
      textLen: String(context.textWindow || "").length,
      contextLen: String(context.contextWindow || "").length,
    });

    const response = await this.sendHttpMessage({
      url: endpointUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
      timeoutMs,
    });

    const autocompleteDurationMs = Math.round(performance.now() - autocompleteStartedAt);
    const timings = response?.json?.timings_ms;
    const serverLatencyMs = Number(response?.json?.latency_ms);
    console.info(`${zetaLogPrefix("autocomplete")} request done`, {
      durationMs: autocompleteDurationMs,
      ok: response?.ok,
      status: response?.status,
      cacheHit: !!response?.json?.cache_hit,
      serverLatencyMs: Number.isFinite(serverLatencyMs) ? serverLatencyMs : null,
      retrievalMs: timings && Number.isFinite(timings.retrieval) ? timings.retrieval : null,
      generationMs: timings && Number.isFinite(timings.generation) ? timings.generation : null,
      rankingMs: timings && Number.isFinite(timings.ranking) ? timings.ranking : null,
    });

    if (!response.ok) {
      const serverMessage = response.json?.detail != null
        ? String(response.json.detail)
        : String(response.text || response.error || response.statusText || "request failed");
      const error = new Error(`HTTP error ${response.status || "unknown"}${serverMessage ? `: ${serverMessage}` : ""}`);
      error.status = Number(response.status) || 0; // eslint-disable-line no-param-reassign
      error.endpointUrl = endpointUrl; // eslint-disable-line no-param-reassign
      throw error;
    }
    if (!response.json || typeof response.json !== "object") {
      throw new Error("Autocomplete endpoint returned non-JSON response.");
    }

    this.autocompleteCache.set(cacheKey, {
      timestamp: now,
      payload: response.json,
    });
    for (const [key, value] of this.autocompleteCache.entries()) {
      if (!value || now - Number(value.timestamp || 0) > AUTOCOMPLETE_CACHE_TTL_MS) {
        this.autocompleteCache.delete(key);
      }
    }

    return {
      payload: response.json,
      cacheHit: false,
    };
  }

  buildAutocompleteSentDetail(context, endpointUrl, reasonLabel) {
    const textWindow = String(context.textWindow || "");
    const contextWindow = String(context.contextWindow || "");
    const cursorOffset = Number(context.localCursorOffset) || 0;
    const maxNewTokens = this.settings.mode === "accurate" ? 24 : 16;
    const temperature = this.settings.mode === "accurate" ? 0.2 : 0.35;
    const textSnippet = textWindow.slice(Math.max(0, cursorOffset - 50), cursorOffset + 70).replace(/\n/g, "↵").slice(0, 160);
    const contextTail = contextWindow.slice(-160).replace(/\n/g, "↵").slice(0, 180);
    const lines = [
      "Sent to model:",
      `endpoint: ${endpointUrl}`,
      `text: ${textWindow.length} chars, cursor_offset: ${cursorOffset}`,
      `text (around cursor): ${textSnippet || "(empty)"}`,
      `context: ${contextWindow.length} chars`,
      `context (tail): ${contextTail || "(empty)"}`,
      `params: max_new_tokens=${maxNewTokens}, temperature=${temperature}, max_candidates=3, imports=Std`,
      "",
      `reason: ${reasonLabel} · prefix (${String(context.prefixText || "").length} chars): ${String(context.prefixText || "").slice(-80)}`,
    ];
    return lines.join("\n");
  }

  extractAutocompleteCandidates(payload, context) {
    if (!payload || typeof payload !== "object") {
      return [];
    }
    const rawCandidates = [];
    const selected = typeof payload.selected_completion === "string"
      ? payload.selected_completion
      : "";
    if (selected.trim()) {
      rawCandidates.push(selected);
    }
    const candidates = ensureArray(payload.candidates);
    for (const item of candidates) {
      if (typeof item === "string" && item.trim()) {
        rawCandidates.push(item);
        continue;
      }
      if (item && typeof item.completion === "string" && item.completion.trim()) {
        rawCandidates.push(item.completion);
      }
    }

    const normalized = [];
    const seen = new Set();
    for (const rawCandidate of rawCandidates) {
      const suffix = this.normalizeAutocompleteSuffix(context.prefixText, rawCandidate);
      if (!suffix.trim()) {
        continue;
      }
      const insertion = this.normalizeAutocompleteInsertion(
        context.prefixText,
        suffix,
        context.suffixText
      );
      const boundarySafeInsertion = this.normalizeAutocompleteBoundarySpacing(
        context.prefixText,
        insertion,
        context.suffixText
      );
      if (!boundarySafeInsertion.trim()) {
        continue;
      }
      const key = boundarySafeInsertion.trim().toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push(boundarySafeInsertion);
      if (normalized.length >= 3) {
        break;
      }
    }
    return normalized;
  }

  scheduleAutocomplete(reason, immediate = false) {
    if (this.autocompleteTimer) {
      clearTimeout(this.autocompleteTimer);
      this.autocompleteTimer = null;
    }
    if (this.settings.autocompleteEnabled === false) {
      this.cancelAutocompleteNow();
      return;
    }
    if (!this.activeAdapter || !this.activeAdapter.isConnected()) {
      this.clearAutocompleteSuggestion();
      return;
    }
    const reasonLabel = String(reason || "typing");
    if (this.settings.autocompleteManualTrigger && reasonLabel !== "manual") {
      if (reasonLabel === "typing" || reasonLabel === "selection" || reasonLabel === "focus") {
        this.clearAutocompleteSuggestion();
      }
      return;
    }
    if (this.autocompleteAwaitingUserInput && reasonLabel === "typing") {
      return;
    }
    if (reasonLabel !== "manual") {
      const liveContext = this.getLiveAutocompleteBoundaryContext();
      const livePrefix = String(liveContext?.prefixText || "");
      if (this.isSentenceCompleteForAutocomplete(livePrefix)) {
        this.clearAutocompleteSuggestion();
        return;
      }
    }
    const allowImmediate = immediate && reasonLabel === "manual";
    const delay = allowImmediate ? 0 : AUTOCOMPLETE_DEBOUNCE_MS;
    this.autocompleteTimer = window.setTimeout(() => {
      this.autocompleteTimer = null;
      this.runAutocomplete(reasonLabel);
    }, delay);
  }

  async runAutocomplete(reason = "typing") {
    const reasonLabel = String(reason || "typing");
    if (this.settings.autocompleteEnabled === false) {
      this.cancelAutocompleteNow();
      return;
    }
    if (this.settings.autocompleteManualTrigger && reasonLabel !== "manual") {
      return;
    }
    if (this.autocompleteInFlight) {
      this.autocompleteQueuedReason = reasonLabel;
      return;
    }
    if (Date.now() < this.autocompleteBackoffUntil) {
      return;
    }
    const endpointUrl = this.resolveAutocompleteEndpoint();
    if (!endpointUrl) {
      this.clearAutocompleteSuggestion();
      return;
    }

    const context = this.collectAutocompleteContext();
    if (!context) {
      this.clearAutocompleteSuggestion();
      return;
    }
    if (this.autocompleteGeneratedSentenceBoundaries.includes(context.sentenceBoundary)) {
      return;
    }

    const requestId = ++this.autocompleteRequestSeq;
    this.autocompleteInFlight = true;
    this.autocompletePendingSince = Date.now();
    this.autocompleteQueuedReason = "";
    this.activeAutocomplete = null;
    this.renderTabGhost();

    const autocompleteDetail = this.buildAutocompleteSentDetail(context, endpointUrl, reasonLabel);
    const liveActivityId = this.addActivity(
      "Autocomplete: fetching…",
      "info",
      null,
      autocompleteDetail
    );

    let result;
    let requestError = null;
    try {
      try {
        result = await this.requestAutocomplete(endpointUrl, context, reasonLabel);
      } catch (firstErr) {
        const isTimeout = /timeout|abort|timed out/i.test(String(firstErr?.message || ""));
        if (isTimeout) {
          const baseMs = Math.min(18000, Math.max(4000, Number(this.settings.requestTimeoutMs) || 6000));
          try {
            result = await this.requestAutocomplete(endpointUrl, context, reasonLabel, {
              timeoutMs: Math.min(18000, baseMs * 2),
            });
          } catch (retryErr) {
            requestError = retryErr;
          }
        } else {
          requestError = firstErr;
        }
      }
      if (requestError) {
      const error = requestError;
      if (requestId !== this.autocompleteRequestSeq) {
        this.updateActivityById(liveActivityId, { message: "Autocomplete: canceled (new request)" }, { refreshTime: true });
        return;
      }
      this.clearAutocompleteSuggestion();
      const rawMessage = String(error?.message || error);
      let status = Number(error?.status) || 0;
      if (!status) {
        const messageMatch = rawMessage.match(/HTTP error\s+(\d{3})/i);
        if (messageMatch) {
          status = Number(messageMatch[1]) || 0;
        }
      }
      const endpointForLog = String(error?.endpointUrl || endpointUrl || "");
      const failedMessage = `Autocomplete: failed${status ? ` (${status})` : ""}`;
      const detailText = `${autocompleteDetail}\n${rawMessage.slice(0, 300)}`;
      const updated = this.updateActivityById(
        liveActivityId,
        { message: failedMessage, detailText },
        { refreshTime: true }
      );
      if (!updated) {
        this.addActivity(failedMessage, "error", null, detailText);
      }
      if (status === 404) {
        this.autocompleteBackoffUntil = Date.now() + 60_000;
        this.reportAutocompleteErrorOnce(
          `autocomplete_404:${endpointForLog}`,
          "Autocomplete endpoint returned 404. Confirm the deployed Modal app exposes `/v1/complete`."
        );
      } else {
        this.autocompleteBackoffUntil = Date.now() + 5000;
      }
      logTrace("autocomplete_error", {
        reason: reasonLabel,
        status,
        endpointUrl: endpointForLog,
        message: rawMessage,
      });
    } else {
      this.autocompleteGeneratedSentenceBoundaries.push(context.sentenceBoundary);
      if (this.autocompleteGeneratedSentenceBoundaries.length > 100) {
        this.autocompleteGeneratedSentenceBoundaries.shift();
      }
      if (requestId !== this.autocompleteRequestSeq) {
        this.updateActivityById(liveActivityId, { message: "Autocomplete: canceled (new request)" }, { refreshTime: true });
        return;
      }
      if (this.settings.autocompleteEnabled === false) {
        this.clearAutocompleteSuggestion();
        this.updateActivityById(liveActivityId, { message: "Autocomplete: disabled" }, { refreshTime: true });
        return;
      }
      const suggestions = this.extractAutocompleteCandidates(result.payload, context);
      if (suggestions.length === 0) {
        this.autocompleteBackoffUntil = 0;
        this.clearAutocompleteSuggestion();
        const timings = result?.payload?.timings_ms;
        const reasons = result?.payload?.no_suggestion_reasons;
        const lines = [autocompleteDetail];
        if (timings) {
          lines.push(`retrieval: ${timings.retrieval ?? "?"}ms · generation: ${timings.generation ?? "?"}ms · ranking: ${timings.ranking ?? "?"}ms`);
        }
        lines.push(`sent: text=${String(context.textWindow || "").length} chars, context=${String(context.contextWindow || "").length} chars`);
        if (Array.isArray(reasons) && reasons.length > 0) {
          lines.push(`why no suggestion: ${reasons.join(", ")}`);
        }
        const debug = result?.payload?.no_suggestion_debug;
        if (debug && typeof debug === "object") {
          const upstreamKeys = Array.isArray(debug.upstream_keys)
            ? debug.upstream_keys.join(", ")
            : "";
          if (upstreamKeys) {
            lines.push(`upstream keys: ${upstreamKeys}`);
          }
          if (typeof debug.raw_preview === "string" && debug.raw_preview.trim()) {
            lines.push(`upstream preview: ${debug.raw_preview.slice(0, 500)}`);
          }
        }
        const whyMessage = Array.isArray(reasons) && reasons.length > 0
          ? `Autocomplete: no suggestion — ${reasons[0]}`
          : `Autocomplete: no suggestion — ${reasonLabel} (backend gave no reason)`;
        const updated = this.updateActivityById(liveActivityId, { message: whyMessage, detailText: lines.join("\n") }, { refreshTime: true });
        if (!updated) {
          this.addActivity(whyMessage, "info", null, lines.join("\n"));
        }
        return;
      }
      const timings = result?.payload?.timings_ms;
      const latency = result?.payload?.latency_ms;
      const detail = [autocompleteDetail];
      if (Number.isFinite(latency)) detail.push(`latency: ${latency}ms`);
      if (timings) detail.push(`retrieval: ${timings.retrieval ?? "?"}ms · generation: ${timings.generation ?? "?"}ms · ranking: ${timings.ranking ?? "?"}ms`);
      this.updateActivityById(
        liveActivityId,
        {
          message: result.cacheHit ? "Autocomplete: suggestion ready (cached)" : "Autocomplete: suggestion ready",
          detailText: detail.join("\n"),
        },
        { refreshTime: true }
      );
      this.activeAutocomplete = {
        candidates: suggestions,
        selectedIndex: 0,
        signature: context.signature,
        payload: result.payload,
        cacheHit: !!result.cacheHit,
        requestContext: {
          endpointUrl,
          reason: reasonLabel,
          signature: context.signature,
          fragment: String(context.fragment || ""),
          caretOffset: Number(context.caretOffset) || 0,
          localCursorOffset: Number(context.localCursorOffset) || 0,
          prefixTail: String(context.prefixText || "").slice(-360),
          suffixHead: String(context.suffixText || "").slice(0, 180),
          textWindow: String(context.textWindow || ""),
          contextWindow: String(context.contextWindow || ""),
        },
        updatedAt: Date.now(),
      };
      this.autocompleteBackoffUntil = 0;
      this.renderTabGhost();
    }
    } finally {
      this.autocompleteInFlight = false;
      this.autocompletePendingSince = 0;
      const queuedReason = String(this.autocompleteQueuedReason || "");
      this.autocompleteQueuedReason = "";
      if (queuedReason && Date.now() >= this.autocompleteBackoffUntil) {
        this.scheduleAutocomplete(queuedReason);
      }
    }
  }

  renderTabGhost() {
    this.ensureTabGhostElement();
    const element = this.tabGhostElement;
    if (!element) {
      return;
    }
    if (this.settings.autocompleteEnabled === false) {
      element.classList.add("is-hidden");
      element.textContent = "";
      return;
    }
    const hasSuggestion = !!this.activeAutocomplete;
    const showThinking = !hasSuggestion && this.autocompleteInFlight && this.autocompletePendingSince > 0;
    if ((!hasSuggestion && !showThinking) || !this.activeAdapter || !this.isAutocompleteAllowedAdapter(this.activeAdapter)) {
      element.classList.add("is-hidden");
      element.textContent = "";
      return;
    }

    const snapshot = this.activeAdapter.getVisibleTextSnapshot();
    const rect = this.activeAdapter.getCaretClientRect(snapshot);
    if (!rect) {
      element.classList.add("is-hidden");
      return;
    }

    if (showThinking) {
      element.classList.remove("is-inline-mode", "is-topk-mode");
      element.classList.add("is-thinking-mode");
      element.style.pointerEvents = "none";
      element.replaceChildren();

      const thinking = document.createElement("div");
      thinking.className = "zeta-tab-thinking";
      const label = document.createElement("span");
      label.className = "zeta-tab-thinking-label";
      label.textContent = "Zeta is thinking...";
      const dots = document.createElement("span");
      dots.className = "zeta-tab-thinking-dots";
      for (let i = 0; i < 3; i += 1) {
        const dot = document.createElement("span");
        dot.className = "zeta-tab-thinking-dot";
        dots.appendChild(dot);
      }
      thinking.append(label, dots);
      element.appendChild(thinking);

      const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
      const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
      let left = Math.round(rect.right + 8);
      let top = Math.round(rect.top - 18);
      if (top < 8) {
        top = Math.round(rect.bottom + 4);
      }
      if (left > viewportWidth - 132) {
        left = Math.max(8, viewportWidth - 132);
      }
      if (top > viewportHeight - 30) {
        top = Math.max(8, viewportHeight - 30);
      }
      element.style.left = `${left}px`;
      element.style.top = `${top}px`;
      element.classList.remove("is-hidden");
      return;
    }

    const candidates = ensureArray(this.activeAutocomplete.candidates).filter((item) => String(item || "").trim());
    if (candidates.length === 0) {
      element.classList.add("is-hidden");
      return;
    }

    const selectedIndex = clamp(
      Number(this.activeAutocomplete.selectedIndex) || 0,
      0,
      Math.max(0, candidates.length - 1)
    );
    this.activeAutocomplete.selectedIndex = selectedIndex;
    const showTopK = !!this.settings.autocompleteShowTopK;
    element.classList.remove("is-thinking-mode");
    element.classList.toggle("is-inline-mode", !showTopK);
    element.classList.toggle("is-topk-mode", showTopK);
    element.style.pointerEvents = showTopK ? "auto" : "none";

    element.replaceChildren();

    const viewportWidth = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
    const viewportHeight = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);
    let left = 0;
    let top = 0;

    if (showTopK) {
      const header = document.createElement("div");
      header.className = "zeta-tab-ghost-header";
      header.textContent = "Suggested by zeta";
      element.appendChild(header);

      const preview = document.createElement("div");
      preview.className = "zeta-tab-ghost-preview";
      preview.textContent = String(candidates[selectedIndex] || "").trimStart();
      element.appendChild(preview);

      const list = document.createElement("div");
      list.className = "zeta-tab-ghost-list";
      for (let index = 0; index < candidates.length; index += 1) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "zeta-tab-ghost-item";
        item.setAttribute("data-autocomplete-index", String(index));
        if (index === selectedIndex) {
          item.classList.add("is-active");
        }
        const text = document.createElement("span");
        text.className = "zeta-tab-ghost-text";
        text.textContent = String(candidates[index] || "").trimStart();
        const hint = document.createElement("span");
        hint.className = "zeta-tab-ghost-hint";
        hint.textContent = index === 0 ? "Tab" : "Click to select";
        item.append(text, hint);
        list.appendChild(item);
      }
      element.appendChild(list);

      left = Math.round(rect.left + 8);
      top = Math.round(rect.top - 92);
      if (top < 8) {
        top = Math.round(rect.bottom + 6);
      }
      if (left > viewportWidth - 320) {
        left = Math.max(8, viewportWidth - 320);
      }
      if (top > viewportHeight - 120) {
        top = Math.max(8, viewportHeight - 120);
      }
    } else {
      const inline = document.createElement("span");
      inline.className = "zeta-tab-ghost-inline";
      inline.textContent = String(candidates[selectedIndex] || "").replace(/^\s+/, "");
      element.appendChild(inline);

      left = Math.round(rect.right + 1);
      top = Math.round(rect.top + Math.max(0, rect.height * 0.05));
      if (left > viewportWidth - 48) {
        left = Math.max(8, viewportWidth - 48);
      }
      if (top > viewportHeight - 28) {
        top = Math.max(8, viewportHeight - 28);
      }
    }
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.classList.remove("is-hidden");
  }

  getActiveAutocompleteCandidate() {
    if (!this.activeAutocomplete) {
      return "";
    }
    const candidates = ensureArray(this.activeAutocomplete.candidates).filter((item) => String(item || "").trim());
    if (candidates.length === 0) {
      return "";
    }
    const selectedIndex = clamp(
      Number(this.activeAutocomplete.selectedIndex) || 0,
      0,
      Math.max(0, candidates.length - 1)
    );
    this.activeAutocomplete.selectedIndex = selectedIndex;
    return String(candidates[selectedIndex] || "");
  }

  buildAutocompleteAcceptanceDetail(
    trigger,
    insertion,
    completion,
    contextPrefix,
    contextSuffix,
    requestContext = null
  ) {
    const selectedIndex = this.activeAutocomplete
      ? clamp(
        Number(this.activeAutocomplete.selectedIndex) || 0,
        0,
        Math.max(0, ensureArray(this.activeAutocomplete.candidates).length - 1)
      )
      : 0;
    const cached = this.activeAutocomplete?.cacheHit ? "true" : "false";
    const context = requestContext && typeof requestContext === "object"
      ? requestContext
      : null;
    const lines = [
      "Acceptance",
      `trigger: ${String(trigger || "tab")}`,
      `selected_index: ${selectedIndex}`,
      `cache_hit: ${cached}`,
      `candidate: ${this.truncateActivityText(String(completion || "").trim(), 220)}`,
      `inserted: ${this.truncateActivityText(String(insertion || ""), 220)}`,
      "",
      "Live boundary",
      `prefix_tail: ${this.truncateActivityText(String(contextPrefix || "").slice(-240), 300)}`,
      `suffix_head: ${this.truncateActivityText(String(contextSuffix || "").slice(0, 140), 220)}`,
    ];

    if (!context) {
      return lines.join("\n");
    }

    lines.push(
      "",
      "Request context",
      `endpoint: ${String(context.endpointUrl || this.resolveAutocompleteEndpoint() || "--")}`,
      `reason: ${String(context.reason || "--")}`,
      `signature: ${String(context.signature || "--")}`,
      `fragment: ${this.truncateActivityText(String(context.fragment || ""), 260)}`,
      `caret_offset: ${Number.isFinite(Number(context.caretOffset)) ? Number(context.caretOffset) : "--"}`,
      `local_cursor_offset: ${Number.isFinite(Number(context.localCursorOffset)) ? Number(context.localCursorOffset) : "--"}`,
      `prefix_tail: ${this.truncateActivityText(String(context.prefixTail || ""), 360)}`,
      `suffix_head: ${this.truncateActivityText(String(context.suffixHead || ""), 220)}`,
      "",
      "text_window",
      this.truncateActivityText(String(context.textWindow || ""), 1800),
      "",
      "context_window",
      this.truncateActivityText(String(context.contextWindow || ""), 2200)
    );
    return lines.join("\n");
  }

  acceptActiveAutocomplete(trigger = "tab") {
    if (!this.activeAutocomplete || !this.activeAdapter || !this.activeAdapter.isConnected()) {
      return false;
    }
    if (!this.isAutocompleteAllowedAdapter(this.activeAdapter)) {
      return false;
    }

    const requestContext = this.collectAutocompleteContext();
    const liveContext = this.getLiveAutocompleteBoundaryContext();
    const contextPrefix = String(liveContext?.prefixText ?? requestContext?.prefixText ?? "");
    const contextSuffix = String(liveContext?.suffixText ?? requestContext?.suffixText ?? "");
    if (this.isSentenceCompleteForAutocomplete(contextPrefix)) {
      this.clearAutocompleteSuggestion();
      return false;
    }
    if (
      requestContext &&
      requestContext.signature &&
      this.activeAutocomplete.signature &&
      requestContext.signature !== this.activeAutocomplete.signature
    ) {
      logTrace("autocomplete_accept_context_mismatch", {
        expected: this.activeAutocomplete.signature,
        got: requestContext.signature,
      });
    }

    const completion = this.getActiveAutocompleteCandidate();
    if (!completion) {
      this.clearAutocompleteSuggestion();
      return false;
    }

    let insertion = this.normalizeAutocompleteInsertion(
      contextPrefix,
      completion,
      contextSuffix
    );
    insertion = this.normalizeAutocompleteBoundarySpacing(
      contextPrefix,
      insertion,
      contextSuffix
    );
    const leftBoundaryChar = contextPrefix.slice(-1);
    const rightBoundaryChar = contextSuffix.slice(0, 1);
    if (/\s$/.test(contextPrefix) || /\s/.test(leftBoundaryChar)) {
      insertion = insertion.replace(/^\s+/, "");
    }
    if (/^\s/.test(contextSuffix) || /\s/.test(rightBoundaryChar) || /^[,.;:!?)}\]]/.test(contextSuffix)) {
      insertion = insertion.replace(/\s+$/, "");
    }
    if (!insertion) {
      this.clearAutocompleteSuggestion();
      return false;
    }

    const inserted = this.activeAdapter.insertAtCaret(insertion);
    if (!inserted) {
      return false;
    }

    const acceptanceDetail = this.buildAutocompleteAcceptanceDetail(
      trigger,
      insertion,
      completion,
      contextPrefix,
      contextSuffix,
      this.activeAutocomplete?.requestContext || requestContext
    );
    this.addActivity(
      `${trigger === "click" ? "Applied" : "Accepted"} autocomplete: ${insertion.trim().slice(0, 120)}`,
      "success",
      null,
      acceptanceDetail
    );
    this.autocompleteAwaitingUserInput = true;
    this.clearAutocompleteSuggestion();
    this.scheduleChunkSnapshotSync("typing");
    if (this.settings.checkOnType) {
      this.scheduleAnalysis("typing");
    }
    return true;
  }

  tryAcceptTabCompletion(event) {
    if (!event || String(event.key || "").toLowerCase() !== "tab") {
      return false;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return false;
    }
    if (!this.activeAutocomplete || !this.activeAdapter || !this.activeAdapter.isConnected()) {
      return false;
    }
    if (!this.isAutocompleteAllowedAdapter(this.activeAdapter)) {
      return false;
    }

    const target = event.target;
    if (target instanceof Element) {
      if (target.closest(".zeta-shell, .zeta-popup-mirror, .zeta-suggestion-popover")) {
        return false;
      }
    }
    const targetInAdapter = target instanceof Element && this.activeAdapter.containsNode(target);
    const focused = document.activeElement;
    const focusedInAdapter = focused instanceof Element && this.activeAdapter.containsNode(focused);
    const selectionInAdapter = this.isSelectionInActiveAdapter();
    if (!targetInAdapter && !focusedInAdapter && !selectionInAdapter) {
      return false;
    }
    const accepted = this.acceptActiveAutocomplete("tab");
    if (!accepted) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  async updateSettings(nextPartial, rerun) {
    const next = {
      ...this.settings,
      ...nextPartial,
    };
    next.mode = normalizeMode(next.mode);
    next.scope = normalizeScope(next.scope);
    next.theme = "light";
    next.autocompleteEnabled = next.autocompleteEnabled !== false;
    next.autoAnalyzeDocument = next.autoAnalyzeDocument !== false;
    next.autocompleteManualTrigger = next.autocompleteManualTrigger === true;
    next.backendUrl = HARDCODED_ANALYZE_URL;

    await storageSyncSet({
      [SETTINGS_KEY]: next,
      [MODE_KEY]: next.mode,
    });

    this.settings = next;
    this.panel.setSettings(this.settings);
    if (!this.settings.autocompleteEnabled) {
      this.cancelAutocompleteNow();
    } else if (this.settings.autocompleteManualTrigger) {
      this.clearAutocompleteSuggestion();
    }

    if (rerun) {
      this.scheduleAnalysis("settings", true);
      this.scheduleAutocomplete("settings", true);
    }
  }

  async saveSettingsFromPanel(nextValues) {
    const merged = {
      ...this.settings,
      requestTimeoutMs: clamp(Number(nextValues.requestTimeoutMs) || this.settings.requestTimeoutMs, 2000, 120000),
      retries: clamp(Number(nextValues.retries) || 0, 0, 4),
      autocompleteEnabled: nextValues.autocompleteEnabled !== false,
      autoAnalyzeDocument: nextValues.autoAnalyzeDocument !== false,
      checkOnType: !!nextValues.checkOnType,
      autocompleteShowTopK: !!nextValues.autocompleteShowTopK,
      autocompleteManualTrigger: !!nextValues.autocompleteManualTrigger,
      notationStrictness: ["relaxed", "balanced", "strict"].includes(nextValues.notationStrictness)
        ? nextValues.notationStrictness
        : "balanced",
    };

    await this.updateSettings(merged, false);
    this.panel.setStatus("idle", "Settings saved.");
    this.addActivity("Saved panel settings.", "info");
    this.scheduleAnalysis("settings-save", true);
    this.scheduleAutocomplete("settings-save", true);
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
    this.sortActivityEntriesLatestToEarliest();
    const serializedGraphChunkTree = this.serializeChunkTree(this.graphChunkTree);
    const serializedAnalysisChunkTree = this.serializeChunkTree(this.chunkTree);
    const serializedChunkTree = serializedGraphChunkTree || serializedAnalysisChunkTree;
    const persistedActiveChunkId = this.graphActiveChunkId || this.activeChunkId || null;
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
      activeChunkId: persistedActiveChunkId,
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

  serializeChatThread(thread) {
    const diagnostics = ensureArray(thread.diagnostics).slice(0, 8).map((diag) => ({
      severity: String(diag?.severity || "unknown"),
      message: String(diag?.message || ""),
      line: Number.isInteger(diag?.line) ? diag.line : null,
      column: Number.isInteger(diag?.column) ? diag.column : null,
      file: String(diag?.file || ""),
      raw: String(diag?.raw || ""),
    }));
    const semanticReasons = ensureArray(thread.semanticReasons)
      .map((reason) => String(reason || "").trim())
      .filter(Boolean)
      .slice(0, 8);
    const messages = ensureArray(thread.messages)
      .slice(-20)
      .map((message) => ({
        id: String(message.id || ""),
        role: message.role === "assistant" ? "assistant" : "user",
        text: String(message.text || ""),
        createdAt: Number(message.createdAt) || Date.now(),
        error: !!message.error,
      }));
    return {
      id: String(thread.id || ""),
      title: String(thread.title || "Issue thread"),
      issueKey: String(thread.issueKey || ""),
      category: String(thread.category || "issue"),
      severity: String(thread.severity || "unknown"),
      issueMessage: String(thread.issueMessage || ""),
      targetText: String(thread.targetText || ""),
      replacement: String(thread.replacement || ""),
      line: Number.isInteger(thread.line) ? thread.line : null,
      column: Number.isInteger(thread.column) ? thread.column : null,
      source: String(thread.source || ""),
      sentenceText: String(thread.sentenceText || ""),
      chunkId: String(thread.chunkId || ""),
      compileSuccess: typeof thread.compileSuccess === "boolean" ? thread.compileSuccess : null,
      diagnostics,
      semanticReasons,
      leanCode: this.truncateActivityText(thread.leanCode, 3000),
      requestUrl: String(thread.requestUrl || ""),
      issueSignature: String(thread.issueSignature || ""),
      status: String(thread.status || "idle"),
      lastSource: String(thread.lastSource || ""),
      lastLatencyMs: Number(thread.lastLatencyMs) || 0,
      lastError: String(thread.lastError || ""),
      isActiveIssue: thread.isActiveIssue !== false,
      updatedAt: Number(thread.updatedAt) || Date.now(),
      createdAt: Number(thread.createdAt) || Date.now(),
      messages,
    };
  }

  persistChatSnapshot() {
    const normalizedThreads = this.chatThreads
      .map((thread) => this.serializeChatThread(thread))
      .filter((thread) => thread.id)
      .slice(0, 30);
    this.chatThreads = normalizedThreads;
    this.chatById = new Map(this.chatThreads.map((thread) => [thread.id, thread]));
    if (!this.activeChatThreadId || !this.chatById.has(this.activeChatThreadId)) {
      this.activeChatThreadId = this.chatThreads[0]?.id || null;
    }

    const payload = {
      threads: this.chatThreads,
      activeThreadId: this.activeChatThreadId,
      updatedAt: Date.now(),
    };
    const signature = shortHash(
      JSON.stringify({
        active: payload.activeThreadId,
        threads: payload.threads.map((thread) => (
          `${thread.id}|${thread.status}|${thread.updatedAt}|${thread.lastSource}|` +
          `${thread.lastError}|${thread.messages.map((msg) => `${msg.role}:${shortHash(msg.text || "")}`).join(",")}`
        )),
      })
    );
    if (signature === this.lastChatSnapshotSignature) {
      return Promise.resolve();
    }
    this.lastChatSnapshotSignature = signature;
    return storageLocalSet({
      [CHAT_SNAPSHOT_KEY]: payload,
    });
  }

  buildChatThreadTitle(issue) {
    const base = String(issue?.message || issue?.category || "Issue").replace(/\s+/g, " ").trim();
    if (!base) {
      return "Issue";
    }
    if (base.length <= 78) {
      return base;
    }
    return `${base.slice(0, 75)}...`;
  }

  buildChatPrimerMessage(issue) {
    const target = String(issue?.targetText || "").trim();
    const subject = target ? `for "${target}"` : "for this issue";
    return `I can explain why Lean flagged this ${subject}. Ask for a simpler rewrite if needed.`;
  }

  buildGeneralChatPrimerMessage(issueCount = 0) {
    if (issueCount > 0) {
      return `Ask me anything about your ${issueCount} active checker issue${issueCount === 1 ? "" : "s"}, or about the current paragraph.`;
    }
    return "Ask me anything about the current math paragraph. I can still explain expected Lean issues once they appear.";
  }

  buildGeneralChatThread(existingThread, issueCount = 0) {
    const now = Date.now();
    const messages = existingThread && Array.isArray(existingThread.messages) && existingThread.messages.length > 0
      ? existingThread.messages
      : [{
        id: "msg-general-intro",
        role: "assistant",
        text: this.buildGeneralChatPrimerMessage(issueCount),
        createdAt: now,
        error: false,
      }];
    const signature = `general:${issueCount > 0 ? "issues" : "empty"}`;
    const metadataChanged = String(existingThread?.issueSignature || "") !== signature;
    return {
      id: "general",
      title: "General Assistant",
      issueKey: "",
      category: "general",
      severity: "info",
      issueMessage: issueCount > 0
        ? `There are ${issueCount} active issue thread${issueCount === 1 ? "" : "s"} in this document.`
        : "No active issues yet. Ask a general question.",
      targetText: "",
      replacement: "",
      line: null,
      column: null,
      source: "assistant",
      sentenceText: "",
      chunkId: "",
      compileSuccess: null,
      diagnostics: [],
      semanticReasons: [],
      leanCode: "",
      requestUrl: "",
      issueSignature: signature,
      status: existingThread?.status === "thinking"
        ? "thinking"
        : (existingThread?.status === "error" && !metadataChanged ? "error" : "ready"),
      lastSource: String(existingThread?.lastSource || ""),
      lastLatencyMs: Number(existingThread?.lastLatencyMs) || 0,
      lastError: metadataChanged ? "" : String(existingThread?.lastError || ""),
      isActiveIssue: true,
      updatedAt: metadataChanged ? now : (Number(existingThread?.updatedAt) || now),
      createdAt: Number(existingThread?.createdAt) || now,
      messages,
    };
  }

  syncChatThreadsFromIssues(issues) {
    const issueList = ensureArray(issues);
    const existingById = new Map(this.chatThreads.map((thread) => [thread.id, thread]));
    const nextThreads = [];
    const now = Date.now();
    const existingGeneralThread = existingById.get("general") || null;
    nextThreads.push(this.buildGeneralChatThread(existingGeneralThread, issueList.length));
    existingById.delete("general");

    // One thread per sentence: group issues by sentence key so we don't create multiple windows per sentence.
    const sentenceToIssues = new Map();
    for (const issue of issueList) {
      const issueKey = String(issue?.key || "").trim();
      if (!issueKey) {
        continue;
      }
      const sentenceKey = String(issue?.sentenceKey || "").trim()
        || shortHash(String(issue?.sentenceText || "").trim())
        || shortHash(issueKey);
      if (!sentenceToIssues.has(sentenceKey)) {
        sentenceToIssues.set(sentenceKey, []);
      }
      sentenceToIssues.get(sentenceKey).push(issue);
    }

    for (const [sentenceKey, groupIssues] of sentenceToIssues) {
      const primary = groupIssues[0];
      const threadId = `sentence-${sentenceKey}`;
      const existing = existingById.get(threadId);
      const sentencePreview = String(primary?.sentenceText || "").trim().slice(0, 60);
      const title = sentencePreview ? `${sentencePreview}${sentencePreview.length >= 60 ? "…" : ""}` : this.buildChatThreadTitle(primary);
      const issueSignature = shortHash(
        JSON.stringify({
          sentenceKey,
          issues: groupIssues.map((i) => i?.key || ""),
          category: primary?.category || "",
          severity: primary?.severity || "",
          message: primary?.message || "",
        })
      );
      const metadataChanged = String(existing?.issueSignature || "") !== issueSignature;
      const diagnostics = [];
      const seenDiag = new Set();
      for (const issue of groupIssues) {
        for (const diag of ensureArray(issue?.diagnostics).slice(0, 8)) {
          const key = `${diag?.message || ""}|${diag?.line || ""}|${diag?.column || ""}`;
          if (seenDiag.has(key)) continue;
          seenDiag.add(key);
          diagnostics.push({
            severity: String(diag?.severity || "unknown"),
            message: String(diag?.message || ""),
            line: Number.isInteger(diag?.line) ? diag.line : null,
            column: Number.isInteger(diag?.column) ? diag.column : null,
            file: String(diag?.file || ""),
            raw: String(diag?.raw || ""),
          });
        }
      }
      const semanticReasons = ensureArray(primary?.pipeline?.semantic?.reasons)
        .map((reason) => String(reason || "").trim())
        .filter(Boolean)
        .slice(0, 8);
      const messages = existing && Array.isArray(existing.messages) && existing.messages.length > 0
        ? existing.messages
        : [{
          id: `msg-${threadId}-intro`,
          role: "assistant",
          text: this.buildChatPrimerMessage(primary),
          createdAt: now,
          error: false,
        }];
      const status = existing?.status === "thinking"
        ? "thinking"
        : (existing?.status === "error" && !metadataChanged ? "error" : "ready");
      nextThreads.push({
        id: threadId,
        title,
        issueKey: String(primary?.key || ""),
        category: String(primary?.category || "issue"),
        severity: String(primary?.severity || "unknown"),
        issueMessage: String(primary?.message || ""),
        targetText: String(primary?.targetText || ""),
        replacement: String(primary?.replacement || ""),
        line: Number.isInteger(primary?.line) ? primary.line : null,
        column: Number.isInteger(primary?.column) ? primary.column : null,
        source: String(primary?.source || ""),
        sentenceText: String(primary?.sentenceText || ""),
        chunkId: String(primary?.chunkId || ""),
        compileSuccess: typeof primary?.compile?.success === "boolean" ? primary.compile.success : null,
        diagnostics,
        semanticReasons,
        leanCode: String(primary?.leanCode || ""),
        requestUrl: String(primary?.backendRequestUrl || ""),
        issueSignature,
        status,
        lastSource: String(existing?.lastSource || ""),
        lastLatencyMs: Number(existing?.lastLatencyMs) || 0,
        lastError: metadataChanged ? "" : String(existing?.lastError || ""),
        isActiveIssue: true,
        updatedAt: metadataChanged ? now : (Number(existing?.updatedAt) || now),
        createdAt: Number(existing?.createdAt) || now,
        messages,
      });
      existingById.delete(threadId);
    }

    const staleThreads = Array.from(existingById.values())
      .map((thread) => ({
        ...thread,
        isActiveIssue: false,
      }))
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      .slice(0, 10);

    this.chatThreads = [...nextThreads, ...staleThreads];
    if (!this.activeChatThreadId || !this.chatThreads.some((thread) => thread.id === this.activeChatThreadId)) {
      this.activeChatThreadId = this.chatThreads[0]?.id || null;
    }
    this.persistChatSnapshot();
  }

  setActiveChatThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) {
      return false;
    }
    if (!this.chatById.has(id)) {
      return false;
    }
    this.activeChatThreadId = id;
    this.persistChatSnapshot();
    return true;
  }

  async deleteChatThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) {
      return false;
    }
    const index = this.chatThreads.findIndex((t) => t.id === id);
    if (index === -1) {
      return false;
    }
    this.chatThreads.splice(index, 1);
    this.chatById = new Map(this.chatThreads.map((thread) => [thread.id, thread]));
    if (this.activeChatThreadId === id) {
      this.activeChatThreadId = this.chatThreads[0]?.id || null;
    }
    await this.persistChatSnapshot();
    return true;
  }

  clearActiveChatHistory() {
    const now = Date.now();
    const general = this.chatThreads.find((t) => t.id === "general");
    this.chatThreads = general
      ? [general]
      : [this.buildGeneralChatThread(null, 0)];
    this.chatThreads[0].messages = [];
    this.chatThreads[0].status = "ready";
    this.chatThreads[0].lastError = "";
    this.chatThreads[0].lastSource = "";
    this.chatThreads[0].lastLatencyMs = 0;
    this.chatThreads[0].updatedAt = now;
    this.chatById = new Map(this.chatThreads.map((t) => [t.id, t]));
    this.activeChatThreadId = "general";
    this.persistChatSnapshot();
  }

  resolveChatEndpoint() {
    const fallback = "http://13.57.35.202:8000/v1/chat/explain";
    const raw = HARDCODED_ANALYZE_URL;
    if (!raw) {
      return fallback;
    }

    try {
      const parsed = new URL(raw);
      if (/\/v1\/lean\/solve\/?$/.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/v1\/lean\/solve\/?$/, "/v1/chat/explain");
      } else if (/\/v1\/analyze\/?$/.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/v1\/analyze\/?$/, "/v1/chat/explain");
      } else if (/\/v1\/query\/?$/.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/\/v1\/query\/?$/, "/v1/chat/explain");
      } else {
        parsed.pathname = "/v1/chat/explain";
      }
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch (_error) {
      return fallback;
    }
  }

  buildChatRequestPayload(thread, question) {
    const history = ensureArray(thread.messages)
      .slice(-8)
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: this.truncateActivityText(message.text, 1600),
      }));
    return {
      question: this.truncateActivityText(question, 3000),
      mode: this.settings.mode,
      issue: {
        key: thread.issueKey || null,
        category: thread.category || null,
        severity: normalizeSeverity(thread.severity),
        message: thread.issueMessage || null,
        target_text: thread.targetText || null,
        replacement: thread.replacement || null,
        line: Number.isInteger(thread.line) ? thread.line : null,
        column: Number.isInteger(thread.column) ? thread.column : null,
        source: thread.source || null,
        sentence: thread.sentenceText || null,
        chunk_id: thread.chunkId || null,
        compile_success: typeof thread.compileSuccess === "boolean" ? thread.compileSuccess : null,
        diagnostics: ensureArray(thread.diagnostics).slice(0, 8),
        semantic_reasons: ensureArray(thread.semanticReasons).slice(0, 8),
        lean_code: this.truncateActivityText(thread.leanCode, 3000),
        request_url: thread.requestUrl || null,
      },
      history,
    };
  }

  resolveChatEndpoints() {
    const primary = this.resolveChatEndpoint();
    const candidates = [
      primary,
      "http://13.57.35.202:8000/v1/chat/explain",
    ];
    const unique = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const value = String(candidate || "").trim();
      if (!value || seen.has(value)) {
        continue;
      }
      seen.add(value);
      unique.push(value);
    }
    return unique;
  }

  buildLocalChatFallback(thread, question, failureReason = "") {
    const sentence = String(thread?.sentenceText || "").trim();
    const issueMessage = String(thread?.issueMessage || "Lean reported an issue.").trim();
    const target = String(thread?.targetText || "").trim();
    const replacement = String(thread?.replacement || "").trim();
    const firstDiagnostic = ensureArray(thread?.diagnostics)
      .map((diag) => String(diag?.message || "").trim())
      .find(Boolean);
    const location = Number.isInteger(thread?.line) && Number.isInteger(thread?.column)
      ? ` (L${thread.line}:C${thread.column})`
      : "";
    const parts = [];
    parts.push(`${issueMessage}${location}`);
    if (sentence) parts.push(`Sentence: ${sentence}`);
    if (target) parts.push(`Relevant text: ${target}`);
    if (firstDiagnostic) parts.push(`Compiler: ${firstDiagnostic}`);
    if (replacement) {
      parts.push(`Try next: ${replacement}`);
    } else {
      parts.push("Try rewriting with explicit quantifiers and a direct proof goal.");
    }
    parts.push(`Your question: ${question}`);
    if (failureReason) parts.push(`(Fallback: ${failureReason})`);
    return parts.join(" ");
  }

  async sendChatForThread(threadId, message) {
    const id = String(threadId || "").trim();
    const question = String(message || "").trim();
    if (!id) {
      throw new Error("Missing chat thread id.");
    }
    if (!question) {
      throw new Error("Message cannot be empty.");
    }
    const thread = this.chatById.get(id);
    if (!thread) {
      console.warn(`${zetaLogPrefix("assistant")} sendChatForThread thread not found`, {
        threadId: id,
        chatByIdSize: this.chatById.size,
        chatByIdKeys: Array.from(this.chatById.keys()).slice(0, 5),
      });
      throw new Error("Chat thread not found.");
    }

    const userMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      text: question,
      createdAt: Date.now(),
      error: false,
    };
    thread.messages.push(userMessage);
    thread.status = "thinking";
    thread.lastError = "";
    thread.updatedAt = Date.now();
    this.activeChatThreadId = thread.id;
    await this.persistChatSnapshot();

    const requestUrls = this.resolveChatEndpoints();
    const requestBody = this.buildChatRequestPayload(thread, question);
    console.info(`${zetaLogPrefix("assistant")} sendChatForThread request`, {
      threadId: thread.id,
      questionLength: question.length,
      endpointCount: requestUrls.length,
      firstUrl: requestUrls[0] || "(none)",
      payloadKeys: Object.keys(requestBody || {}),
      issueKey: requestBody?.issue?.category,
    });
    logTrace("chat_request_send", {
      threadId: thread.id,
      url: requestUrls[0] || "",
      chars: question.length,
    });
    const startedAt = performance.now();
    let response = null;
    let sourceRequestUrl = "";
    let lastError = null;
    for (let i = 0; i < requestUrls.length; i += 1) {
      const requestUrl = requestUrls[i];
      try {
        console.info(`${zetaLogPrefix("assistant")} trying chat endpoint`, {
          attempt: i + 1,
          url: requestUrl,
        });
        response = await this.sendBackendRequest({
          requestUrl,
          requestBody,
        });
        sourceRequestUrl = requestUrl;
        console.info(`${zetaLogPrefix("assistant")} chat endpoint success`, {
          url: requestUrl,
          source: response?.source,
          answerLength: String(response?.answer || "").length,
          status: response?.fallback_reason ? "fallback" : "ok",
        });
        break;
      } catch (error) {
        lastError = error;
        console.warn(`${zetaLogPrefix("assistant")} chat endpoint failed`, {
          url: requestUrl,
          error: String(error?.message || error),
          status: error?.status,
        });
        logTrace("chat_request_failed", {
          threadId: thread.id,
          url: requestUrl,
          message: String(error?.message || error),
        });
      }
    }

    if (response) {
      const answer = String(response?.answer || "").trim() || "No explanation returned.";
      const source = String(response?.source || "deterministic");
      const latencyMs = Number(response?.latency_ms);
      const currentThread = this.chatById.get(thread.id) || thread;
      if (!Array.isArray(currentThread.messages)) {
        currentThread.messages = [];
      }
      currentThread.messages.push({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: "assistant",
        text: answer,
        createdAt: Date.now(),
        error: false,
      });
      currentThread.status = "ready";
      currentThread.lastSource = source;
      currentThread.lastLatencyMs = Number.isFinite(latencyMs)
        ? latencyMs
        : performance.now() - startedAt;
      currentThread.lastError = "";
      currentThread.requestUrl = sourceRequestUrl || currentThread.requestUrl;
      currentThread.updatedAt = Date.now();
      await this.persistChatSnapshot();
      this.addActivity(
        `Replied in thread: ${currentThread.title}`,
        "info",
        null,
        null
      );
      return {
        ok: true,
        threadId: currentThread.id,
        source,
        answer,
      };
    }

    const errorText = String(lastError?.message || lastError || "Assistant request failed.");
    console.warn(`${zetaLogPrefix("assistant")} all chat endpoints failed, using local fallback`, {
      threadId: thread.id,
      lastError: errorText,
      triedUrls: requestUrls,
    });
    const fallbackAnswer = this.buildLocalChatFallback(thread, question, errorText);
    const currentThreadFallback = this.chatById.get(thread.id) || thread;
    if (!Array.isArray(currentThreadFallback.messages)) {
      currentThreadFallback.messages = [];
    }
    currentThreadFallback.messages.push({
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role: "assistant",
      text: fallbackAnswer,
      createdAt: Date.now(),
      error: false,
    });
    currentThreadFallback.status = "ready";
    currentThreadFallback.lastError = errorText;
    currentThreadFallback.lastSource = "local-fallback";
    currentThreadFallback.lastLatencyMs = performance.now() - startedAt;
    currentThreadFallback.updatedAt = Date.now();
    await this.persistChatSnapshot();
    this.addActivity(
      `Replied in thread (fallback): ${currentThreadFallback.title}`,
      "info",
      null,
      null
    );
    return {
      ok: true,
      threadId: thread.id,
      source: "local-fallback",
      answer: fallbackAnswer,
    };
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

  requestAnalysis(reason, force = false) {
    const nextReason = String(reason || "scheduled");
    const nextForce = !!force;

    if (this.analysisRunInProgress) {
      this.pendingAnalysisReason = nextReason;
      this.pendingAnalysisForce = this.pendingAnalysisForce || nextForce;
      return;
    }

    this.analysisRunInProgress = true;
    Promise.resolve()
      .then(() => this.runAnalysis(nextReason, nextForce))
      .catch((error) => {
        const message = String(error?.message || error || "Analysis failed.");
        logTrace("analysis_run_failed", {
          reason: nextReason,
          message,
        });
        this.panel.setStatus("error", `Analysis failed: ${message}`);
        this.addActivity(`Analysis failed: ${message}`, "error");
      })
      .finally(() => {
        this.analysisRunInProgress = false;
        if (!this.pendingAnalysisReason) {
          this.pendingAnalysisForce = false;
          return;
        }
        const queuedReason = this.pendingAnalysisReason;
        const queuedForce = this.pendingAnalysisForce;
        this.pendingAnalysisReason = "";
        this.pendingAnalysisForce = false;
        this.requestAnalysis(queuedReason, queuedForce);
      });
  }

  scheduleAnalysis(reason, immediate = false) {
    if (!this.activeAdapter) {
      return;
    }
    if (this.settings.autoAnalyzeDocument === false) {
      return;
    }

    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }

    const delay = immediate ? 0 : modeToDebounce(this.settings.mode);
    this.scheduledTimer = window.setTimeout(() => {
      this.scheduledTimer = null;
      this.requestAnalysis(reason, immediate);
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

  resolveGraphDocumentSnapshot(adapter, fallbackSnapshot = null) {
    if (adapter && typeof adapter.getDocumentSnapshot === "function") {
      const direct = adapter.getDocumentSnapshot();
      if (direct && typeof direct.text === "string") {
        const sourceText = String(direct.sourceText ?? direct.context ?? direct.text ?? "");
        const scopeStart = Number.isInteger(direct.scopeStart) ? direct.scopeStart : 0;
        const scopeEnd = Number.isInteger(direct.scopeEnd) ? direct.scopeEnd : sourceText.length;
        return {
          scope: "document",
          text: sourceText,
          context: sourceText,
          sourceText,
          scopeStart,
          scopeEnd: Math.max(scopeStart, scopeEnd),
          caretOffset: Number.isInteger(direct.caretOffset) ? clamp(direct.caretOffset, 0, sourceText.length) : null,
        };
      }
    }

    if (!fallbackSnapshot) {
      return null;
    }

    const sourceText = String(
      fallbackSnapshot.sourceText
      || fallbackSnapshot.context
      || fallbackSnapshot.text
      || ""
    );
    return {
      scope: "document",
      text: sourceText,
      context: sourceText,
      sourceText,
      scopeStart: 0,
      scopeEnd: sourceText.length,
      caretOffset: null,
    };
  }

  refreshGraphChunkTree(adapter, fallbackSnapshot = null) {
    const docSnapshot = this.resolveGraphDocumentSnapshot(adapter, fallbackSnapshot);
    const sourceText = String(docSnapshot?.text || "");
    if (!sourceText.trim()) {
      this.graphChunkTree = null;
      this.graphActiveChunkId = null;
      return;
    }

    const graphCaret = Number.isInteger(docSnapshot?.caretOffset)
      ? docSnapshot.caretOffset
      : this.resolveCaretOffsetInScope(docSnapshot, adapter);
    const chunkWindow = this.resolveChunkWindow(docSnapshot, graphCaret);
    this.graphChunkTree = this.buildChunkTree(
      chunkWindow.text,
      chunkWindow.caretOffset,
      chunkWindow.baseOffset
    );
    this.graphActiveChunkId = this.graphChunkTree?.activeChunkId || null;
  }

  syncChunkSnapshotFromEditor(reason = "typing") {
    const adapter = this.activeAdapter;
    if (!adapter || !adapter.isConnected()) {
      return;
    }
    const effectiveScope = this.resolveScopeForReason(reason);
    const snapshot = adapter.getScopeSnapshot(effectiveScope);
    const scopeText = String(snapshot.text || "");

    this.refreshGraphChunkTree(adapter, snapshot);

    if (!scopeText.trim()) {
      this.chunkTree = null;
      this.activeChunkId = null;
      this.graphChunkTree = null;
      this.graphActiveChunkId = null;
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
      chunkTree: this.serializeChunkTree(this.graphChunkTree || this.chunkTree),
      activeChunkId: this.graphActiveChunkId || this.activeChunkId,
    });
  }

  resolveScopeForReason(reason) {
    // Always analyze the full editor while typing to keep backend context complete.
    if (reason === "typing" || reason === "init" || reason === "adapter-switch" || reason === "graph-node") {
      return "document";
    }
    return normalizeScope(this.settings.scope);
  }

  async runAnalysis(reason, force = false) {
    const adapter = this.activeAdapter;
    if (!adapter || !adapter.isConnected()) {
      this.clearAutocompleteSuggestion();
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
    const graphTarget = reason === "graph-node" && this.graphAnalysisTarget
      ? { ...this.graphAnalysisTarget }
      : null;
    const graphTargetLabel = graphTarget?.label ? String(graphTarget.label).trim() : "";
    if (reason === "graph-node") {
      this.graphAnalysisTarget = null;
    }
    this.refreshGraphChunkTree(adapter, snapshot);
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
      this.clearAutocompleteSuggestion();
      this.lastRun = {
        snapshot,
        diagnostics: [],
        issues: [],
      };
      this.chunkTree = null;
      this.activeChunkId = null;
      this.graphChunkTree = null;
      this.graphActiveChunkId = null;
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
      this.syncChatThreadsFromIssues([]);
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
    if (graphTarget) {
      const selectedLeaf = this.selectLeafChunkForTarget(
        ensureArray(this.chunkTree?.leafChunks),
        graphTarget.start,
        graphTarget.end
      );
      if (selectedLeaf?.chunkId) {
        this.activeChunkId = selectedLeaf.chunkId;
        if (this.chunkTree && typeof this.chunkTree === "object") {
          this.chunkTree.activeChunkId = selectedLeaf.chunkId;
        }
      }
      if (graphTarget.chunkId) {
        this.graphActiveChunkId = graphTarget.chunkId;
        if (this.graphChunkTree && typeof this.graphChunkTree === "object") {
          this.graphChunkTree.activeChunkId = graphTarget.chunkId;
        }
      }
    }
    const sentencePlan = this.buildSentencePlan(snapshot, force, proseSpans);
    logTrace("analysis_plan", {
      cachedSentences: sentencePlan.cachedCount,
      pendingSentences: sentencePlan.pending.length,
    });
    const signature = shortHash(
      JSON.stringify({
        scope: snapshot.scope,
        mode: this.settings.mode,
        notationStrictness: this.settings.notationStrictness,
        backendUrl: HARDCODED_ANALYZE_URL,
        signatures: sentencePlan.activeSignatures,
      })
    );

    this.lastAnalyzedSignature = signature;
    const requestId = this.activeRequestId + 1;
    this.activeRequestId = requestId;

    const rerenderFromCache = () => {
      const cachedSentenceIssues = this.collectSentenceIssues(sentencePlan.activeKeys);
      const mergedIssues = this.mergeIssues(cachedSentenceIssues)
        .filter((issue) => !this.isIssueIgnored(issue));

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
      graphTargetLabel
        ? `Analyzing... ${graphTargetLabel}`
        : `global · analyzing ${sentencePlan.pending.length} sentence${sentencePlan.pending.length === 1 ? "" : "s"}`
    );

    for (let i = 0; i < sentencePlan.pending.length; i += 1) {
      if (requestId !== this.activeRequestId) {
        return;
      }

      const sentenceEntry = sentencePlan.pending[i];
      const sentenceLabel = this.formatSentenceLabel(sentenceEntry.text);
      const liveActivityId = this.addActivity(
        `analyzing · ${sentenceLabel} · queued`,
        "info",
        null,
        this.buildLiveSentenceActivityDetail(sentenceEntry, "queued", {
          index: i + 1,
          total: sentencePlan.pending.length,
          requestUrl: HARDCODED_ANALYZE_URL,
          elapsedMs: 0,
        })
      );
      const remaining = sentencePlan.pending.length - i;
      logTrace("sentence_check_start", {
        index: i + 1,
        total: sentencePlan.pending.length,
        sentenceKey: sentenceEntry.key,
        chars: sentenceEntry.text.length,
      });
      this.panel.setStatus(
        "analyzing",
        graphTargetLabel
          ? `Analyzing... ${graphTargetLabel}`
          : `Analyzing sentence ${i + 1}/${sentencePlan.pending.length} (${modeToLabel(this.settings.mode)})...`
      );
      this.panel.setInferenceTime(this.lastInferenceMs, remaining);

      await this.analyzeSentenceEntry(
        sentenceEntry,
        snapshot,
        reason,
        (step, meta = {}) => {
          if (requestId !== this.activeRequestId) {
            return;
          }
          this.syncLiveSentenceActivity(liveActivityId, sentenceEntry, step, {
            index: i + 1,
            total: sentencePlan.pending.length,
            requestUrl: meta.requestUrl || HARDCODED_ANALYZE_URL,
            ...meta,
          });
        }
      );
      logTrace("sentence_check_done", {
        sentenceKey: sentenceEntry.key,
        status: sentenceEntry.status,
        inferenceMs: sentenceEntry.inferenceMs,
        issueCount: ensureArray(sentenceEntry.issues).length,
      });

      if (requestId !== this.activeRequestId) {
        this.updateActivityById(
          liveActivityId,
          {
            message: `canceled · ${sentenceLabel}`,
            level: "info",
            detailText: this.buildLiveSentenceActivityDetail(sentenceEntry, "canceled", {
              index: i + 1,
              total: sentencePlan.pending.length,
              requestUrl: HARDCODED_ANALYZE_URL,
              elapsedMs: sentenceEntry.inferenceMs,
            }),
          },
          {
            refreshTime: true,
          }
        );
        return;
      }

      if (sentenceEntry.activityLog && sentenceEntry.shouldAnalyze) {
        const updatedLiveEntry = this.updateActivityById(
          liveActivityId,
          {
            message: sentenceEntry.activityLog.message,
            level: sentenceEntry.activityLog.level,
            detailText: sentenceEntry.activityLog.detailText,
          },
          {
            refreshTime: true,
          }
        );
        if (!updatedLiveEntry) {
          this.addActivity(
            sentenceEntry.activityLog.message,
            sentenceEntry.activityLog.level,
            null,
            sentenceEntry.activityLog.detailText
          );
        }
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
          backendUrl: HARDCODED_ANALYZE_URL,
          shouldAnalyze,
        })
      );

      let entry = this.sentenceCache.get(key);
      if (!entry || entry.signature !== signature) {
        // Reuse a ready result for the same logical sentence (same chunk+text) so we don't re-analyze
        let readyFrom = null;
        for (const [, e] of this.sentenceCache.entries()) {
          if (e.signature === signature && e.status === "ready") {
            readyFrom = e;
            break;
          }
        }
        entry = {
          key,
          signature,
          text: sentenceText,
          start: segment.start,
          end: segment.end,
          chunkId: segment.chunkId || null,
          shouldAnalyze,
          status: readyFrom ? "ready" : "pending",
          issues: readyFrom ? [...(readyFrom.issues || [])] : [],
          persistentIssues: readyFrom ? [...(readyFrom.persistentIssues || [])] : [],
          diagnostics: readyFrom ? [...(readyFrom.diagnostics || [])] : [],
          hasError: readyFrom ? !!readyFrom.hasError : false,
          inferenceMs: readyFrom ? readyFrom.inferenceMs : null,
          lastRequest: readyFrom ? readyFrom.lastRequest : null,
          lastResponse: readyFrom ? readyFrom.lastResponse : null,
          lastCacheHit: readyFrom ? !!readyFrom.lastCacheHit : false,
          updatedAt: readyFrom ? (readyFrom.updatedAt || now) : 0,
          lastSeenAt: now,
        };
        if (readyFrom?.activityLog) {
          entry.activityLog = readyFrom.activityLog;
        }
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

      // Don't re-analyze successfully compiled sentences (no TTL expiry for "ready")
      const stale = now - (entry.updatedAt || 0) > CACHE_TTL_MS;
      const needsFetch =
        force ||
        entry.status === "pending" ||
        (stale && entry.status !== "ready");
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

    // Assign section parents by level stack so every \section, \subsection, etc. gets the correct parent.
    const sectionParentStack = [];
    for (const sectionChunk of sectionChunks) {
      const level = Number.isInteger(sectionChunk.sectionLevel) ? sectionChunk.sectionLevel : 99;
      while (sectionParentStack.length > 0) {
        const top = sectionParentStack[sectionParentStack.length - 1];
        const topLevel = Number.isInteger(top.sectionLevel) ? top.sectionLevel : 99;
        if (topLevel < level) {
          break;
        }
        sectionParentStack.pop();
      }
      const parentId = sectionParentStack.length > 0
        ? sectionParentStack[sectionParentStack.length - 1].chunkId
        : this.pickContainingEnvironmentId(sectionChunk, envChunks) || documentChunk.chunkId;
      sectionChunk.parentId = parentId;
      sectionParentStack.push(sectionChunk);
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

  selectLeafChunkForTarget(leafChunks, rawStart, rawEnd) {
    const leaves = ensureArray(leafChunks);
    if (leaves.length === 0) {
      return null;
    }

    let start = Number.isInteger(rawStart) ? rawStart : null;
    let end = Number.isInteger(rawEnd) ? rawEnd : null;
    if (!Number.isInteger(start) && Number.isInteger(end)) {
      start = end;
    }
    if (!Number.isInteger(end) && Number.isInteger(start)) {
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return leaves[0];
    }
    if (end < start) {
      const swap = start;
      start = end;
      end = swap;
    }

    const midpoint = Math.floor((start + end) / 2);
    for (const chunk of leaves) {
      if (midpoint >= chunk.start && midpoint <= chunk.end) {
        return chunk;
      }
    }

    let bestOverlapChunk = null;
    let bestOverlap = 0;
    for (const chunk of leaves) {
      const overlap = Math.min(chunk.end, end) - Math.max(chunk.start, start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestOverlapChunk = chunk;
      }
    }
    if (bestOverlapChunk) {
      return bestOverlapChunk;
    }

    let bestChunk = leaves[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const chunk of leaves) {
      const distance = midpoint < chunk.start
        ? chunk.start - midpoint
        : midpoint > chunk.end
          ? midpoint - chunk.end
          : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestChunk = chunk;
      }
    }
    return bestChunk;
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

      const persistentIssues = ensureArray(sentenceEntry.persistentIssues);
      const sentenceIssues = persistentIssues.length > 0
        ? persistentIssues
        : ensureArray(sentenceEntry.issues);
      for (let i = 0; i < sentenceIssues.length; i += 1) {
        const issue = sentenceIssues[i];
        const startOffset = Number.isInteger(issue.start)
          ? sentenceEntry.start + issue.start
          : null;
        const endOffset = Number.isInteger(issue.end)
          ? sentenceEntry.start + issue.end
          : null;
        const backendResponse = sentenceEntry.lastResponse || {};
        const compile = backendResponse.compile && typeof backendResponse.compile === "object"
          ? backendResponse.compile
          : null;
        const diagnostics = ensureArray(sentenceEntry.diagnostics || compile?.diagnostics).map((diag) => ({
          severity: String(diag?.severity || "unknown"),
          message: String(diag?.message || ""),
          line: Number.isInteger(diag?.line) ? diag.line : null,
          column: Number.isInteger(diag?.column) ? diag.column : null,
          file: String(diag?.file || ""),
          raw: String(diag?.raw || ""),
        }));

        issues.push({
          ...issue,
          start: startOffset,
          end: endOffset,
          key: `${sentenceEntry.key}:${issue.key || i}:${startOffset ?? "na"}`,
          originIssueKey: String(issue.key || ""),
          sentenceKey: sentenceEntry.key,
          sentenceInferenceMs: sentenceEntry.inferenceMs,
          sentenceText: sentenceEntry.text,
          chunkId: sentenceEntry.chunkId || null,
          compile,
          diagnostics,
          leanCode: String(backendResponse.lean_code || ""),
          pipeline: backendResponse.pipeline || null,
          backendRequestUrl: String(sentenceEntry.lastRequest?.requestUrl || HARDCODED_ANALYZE_URL),
        });
      }
    }
    return issues;
  }

  async analyzeSentenceEntry(sentenceEntry, snapshot, reason, onProgress = null) {
    const emitProgress = (step, meta = {}) => {
      if (typeof onProgress !== "function") {
        return;
      }
      try {
        onProgress(step, meta);
      } catch (_error) {
        // ignore progress callback failures
      }
    };

    const sentenceSnapshot = {
      ...snapshot,
      text: sentenceEntry.text,
      context: snapshot.context,
    };

    const startedAt = performance.now();
    let waitingTickerId = null;
    const stopWaitingTicker = () => {
      if (waitingTickerId) {
        clearInterval(waitingTickerId);
        waitingTickerId = null;
      }
    };
    const startWaitingTicker = (requestUrl) => {
      stopWaitingTicker();
      waitingTickerId = window.setInterval(() => {
        emitProgress("await_backend_pipeline", {
          requestUrl,
          elapsedMs: performance.now() - startedAt,
        });
      }, 1000);
    };
    sentenceEntry.activityLog = null;
    sentenceEntry.livePipelineTrace = [];
    emitProgress("cache_lookup", {
      requestUrl: HARDCODED_ANALYZE_URL,
      elapsedMs: 0,
    });
    try {
      const requestResult = await this.fetchWithCache(
        sentenceEntry.signature,
        sentenceSnapshot,
        `${reason}:sentence`,
        sentenceEntry,
        (step, meta = {}) => {
          const requestUrl = String(meta.requestUrl || HARDCODED_ANALYZE_URL);
          if (step === "request_sent") {
            startWaitingTicker(requestUrl);
          }
          if (step === "response_received" || step === "cache_hit" || step === "request_failed") {
            stopWaitingTicker();
          }
          emitProgress(step, {
            ...meta,
            requestUrl,
            elapsedMs: Number(meta.elapsedMs) || (performance.now() - startedAt),
          });
        }
      );
      stopWaitingTicker();
      emitProgress("parse_response", {
        requestUrl: String(requestResult.request?.requestUrl || HARDCODED_ANALYZE_URL),
        elapsedMs: performance.now() - startedAt,
      });
      const responsePayload = requestResult.payload;
      const normalized = this.normalizeBackendResponse(
        responsePayload,
        sentenceEntry.text,
        String(requestResult.request?.requestUrl || HARDCODED_ANALYZE_URL)
      );
      emitProgress("normalize_response", {
        requestUrl: String(requestResult.request?.requestUrl || HARDCODED_ANALYZE_URL),
        elapsedMs: performance.now() - startedAt,
      });
      const latestIssues = ensureArray(normalized.issues);
      sentenceEntry.issues = latestIssues;
      if (latestIssues.length > 0) {
        sentenceEntry.persistentIssues = this.mergeIssues(latestIssues);
      } else {
        sentenceEntry.persistentIssues = this.mergeIssues(
          ensureArray(sentenceEntry.persistentIssues)
        );
      }
      sentenceEntry.diagnostics = ensureArray(normalized.diagnostics);
      sentenceEntry.hasError = !!normalized.hasError;
      sentenceEntry.status = "ready";
      sentenceEntry.inferenceMs = performance.now() - startedAt;
      sentenceEntry.lastRequest = requestResult.request || null;
      sentenceEntry.lastResponse = responsePayload || null;
      sentenceEntry.lastCacheHit = !!requestResult.cacheHit;
      sentenceEntry.activityLog = this.buildSentenceActivityLog(
        sentenceEntry,
        responsePayload,
        normalized,
        requestResult.request,
        requestResult.cacheHit
      );
      emitProgress("complete", {
        requestUrl: String(requestResult.request?.requestUrl || HARDCODED_ANALYZE_URL),
        cacheHit: !!requestResult.cacheHit,
        issueCount: sentenceEntry.issues.length,
        elapsedMs: sentenceEntry.inferenceMs,
      });
    } catch (error) {
      stopWaitingTicker();
      const message = String(error?.message || error || "Request failed.");
      const failedRequestUrl = String(error?.requestUrl || HARDCODED_ANALYZE_URL);
      const failedRequest = { requestUrl: failedRequestUrl };
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
      sentenceEntry.persistentIssues = this.mergeIssues(sentenceEntry.issues);
      sentenceEntry.lastRequest = failedRequest;
      sentenceEntry.lastResponse = null;
      sentenceEntry.lastCacheHit = false;
      sentenceEntry.activityLog = this.buildSentenceActivityLog(
        sentenceEntry,
        null,
        { diagnostics: [], hasError: true },
        failedRequest,
        false,
        message
      );
      emitProgress("error", {
        requestUrl: failedRequestUrl,
        message,
        elapsedMs: sentenceEntry.inferenceMs,
      });
    } finally {
      stopWaitingTicker();
      sentenceEntry.updatedAt = Date.now();
      sentenceEntry.lastSeenAt = sentenceEntry.updatedAt;
      sentenceEntry.inferenceMs = performance.now() - startedAt;
      this.lastInferenceMs = sentenceEntry.inferenceMs;
    }
  }

  async fetchWithCache(signature, snapshot, reason, sentenceEntry = null, onProgress = null) {
    const emitProgress = (step, meta = {}) => {
      if (typeof onProgress !== "function") {
        return;
      }
      try {
        onProgress(step, meta);
      } catch (_error) {
        // ignore progress callback failures
      }
    };

    const cached = this.responseCache.get(signature);
    const now = Date.now();
    emitProgress("cache_lookup", {
      requestUrl: HARDCODED_ANALYZE_URL,
      elapsedMs: 0,
    });
    if (cached && now - cached.timestamp <= CACHE_TTL_MS) {
      emitProgress("cache_hit", {
        requestUrl: String(cached.request?.requestUrl || HARDCODED_ANALYZE_URL),
        cacheAgeMs: now - cached.timestamp,
        elapsedMs: 0,
      });
      return {
        payload: cached.payload,
        cacheHit: true,
        request: cached.request || null,
      };
    }

    const request = this.buildBackendPayload(snapshot, reason, sentenceEntry);
    const inFlight = this.inFlightSentenceRequests.get(signature);
    if (inFlight?.promise) {
      emitProgress("inflight_join", {
        requestUrl: String(inFlight.requestUrl || request.requestUrl || HARDCODED_ANALYZE_URL),
        elapsedMs: 0,
      });
      return inFlight.promise;
    }

    const requestPromise = (async () => {
      emitProgress("prepare_request", {
        requestUrl: request.requestUrl,
        elapsedMs: 0,
      });
      const response = await this.sendBackendRequest(request, onProgress);
      emitProgress("response_ready", {
        requestUrl: request.requestUrl,
        elapsedMs: 0,
      });

      const cacheTimestamp = Date.now();
      this.responseCache.set(signature, {
        timestamp: cacheTimestamp,
        payload: response,
        request,
      });

      for (const [key, value] of this.responseCache.entries()) {
        if (cacheTimestamp - value.timestamp > CACHE_TTL_MS) {
          this.responseCache.delete(key);
        }
      }

      return {
        payload: response,
        cacheHit: false,
        request,
      };
    })();

    this.inFlightSentenceRequests.set(signature, {
      requestUrl: String(request.requestUrl || HARDCODED_ANALYZE_URL),
      promise: requestPromise,
    });

    try {
      return await requestPromise;
    } finally {
      const current = this.inFlightSentenceRequests.get(signature);
      if (current?.promise === requestPromise) {
        this.inFlightSentenceRequests.delete(signature);
      }
    }
  }

  normalizeLeanInputMathSets(text) {
    let normalized = String(text || "");
    const replacements = [
      [/\\mathbb\s*\{\s*N\s*\}/gi, "Nat"],
      [/\\mathbb\s*\{\s*Z\s*\}/gi, "Int"],
      [/\\mathbb\s*\{\s*Q\s*\}/gi, "Rat"],
      [/\\mathbb\s*\{\s*R\s*\}/gi, "Real"],
      [/ℕ/g, "Nat"],
      [/ℤ/g, "Int"],
      [/ℚ/g, "Rat"],
      [/ℝ/g, "Real"],
    ];
    for (const [pattern, replacement] of replacements) {
      normalized = normalized.replace(pattern, replacement);
    }
    return normalized.trim();
  }

  buildBackendPayload(snapshot, reason, sentenceEntry = null) {
    const requestUrl = HARDCODED_ANALYZE_URL;
    const mode = this.settings.mode === "accurate" ? "thinking" : "fast";
    const maxIters = mode === "thinking" ? 2 : 1;
    const sentenceText = String(sentenceEntry?.text || snapshot?.text || "").trim();
    const normalizedSentenceText = this.normalizeLeanInputMathSets(sentenceText);
    const chunkId = String(sentenceEntry?.chunkId || this.activeChunkId || "input");
    const legacyRequest = {
      requestUrl: DEFAULT_MODAL_ANALYZE_URL,
      requestBody: {
        text: normalizedSentenceText,
        context: String(snapshot?.context || "").slice(0, 6000),
        theorem_name: "zeta_candidate",
        imports: ["Std"],
        temperature: this.settings.mode === "accurate" ? 0.1 : 0.0,
        max_new_tokens: this.settings.mode === "accurate" ? 220 : 140,
        lean_timeout_seconds: 60,
        skip_lean_check: false,
        include_raw_model_output: false,
        mode,
        max_iters: maxIters,
        include_iteration_history: mode === "thinking",
        zeta_meta: {
          reason,
          scope: snapshot?.scope || this.settings.scope,
          notation: this.settings.notationStrictness,
          chunk_id: chunkId,
        },
      },
    };

    if (/\/v1\/lean\/solve(?:\/)?$/.test(requestUrl)) {
      const chunkPayload = {
        chunk_id: chunkId,
        text: normalizedSentenceText,
        start: 0,
        end: normalizedSentenceText.length,
        sentences: [
          {
            sentence_id: `sentence-${chunkId}`,
            start: 0,
            end: normalizedSentenceText.length,
            text: normalizedSentenceText,
          },
        ],
      };
      return {
        requestUrl,
        requestBody: {
          nl_input: normalizedSentenceText,
          max_iters: maxIters,
          context: {
            theorem_name: "zeta_candidate",
            imports: ["Std"],
            temperature: this.settings.mode === "accurate" ? 0.1 : 0.0,
            mode,
            include_iteration_history: mode === "thinking",
            include_raw_model_output: false,
            lean_timeout_seconds: 60,
            source_context: String(snapshot?.context || "").slice(0, 9000),
            scope: snapshot?.scope || this.settings.scope,
            notation: this.settings.notationStrictness,
            reason,
            chunk_id: chunkId,
            chunk_start: 0,
            active_chunk_id: chunkId,
            chunks: [chunkPayload],
          },
        },
      };
    }

    return legacyRequest;
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

  async sendBackendRequest(request, onProgress = null) {
    const emitProgress = (step, meta = {}) => {
      if (typeof onProgress !== "function") {
        return;
      }
      try {
        onProgress(step, meta);
      } catch (_error) {
        // ignore progress callback failures
      }
    };

    const attempts = Math.max(0, Number(this.settings.retries) || 0) + 1;
    const effectiveTimeoutMs = this.resolveEffectiveTimeoutMs(request.requestUrl, request.requestBody);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      emitProgress("request_sent", {
        attempt,
        attempts,
        requestUrl: request.requestUrl,
        timeoutMs: effectiveTimeoutMs,
      });
      const isChatExplain = /\/v1\/chat\/explain(?:\/)?$/.test(String(request.requestUrl || ""));
      if (isChatExplain) {
        console.info(`${zetaLogPrefix("assistant")} sendBackendRequest chat/explain`, {
          attempt,
          url: request.requestUrl,
          timeoutMs: effectiveTimeoutMs,
          bodySize: typeof request.requestBody === "object"
            ? JSON.stringify(request.requestBody).length
            : 0,
        });
      }
      logTrace("backend_request_send", {
        attempt,
        attempts,
        url: request.requestUrl,
        timeoutMs: effectiveTimeoutMs,
        requestKeys: Object.keys(request.requestBody || {}),
      });
      try {
        const startedAt = performance.now();
        const response = await this.sendHttpMessage({
          url: request.requestUrl,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request.requestBody),
          timeoutMs: effectiveTimeoutMs,
        });
        if (isChatExplain) {
          console.info(`${zetaLogPrefix("assistant")} sendBackendRequest chat/explain response`, {
            attempt,
            status: response.status,
            ok: response.ok,
            durationMs: Math.round(performance.now() - startedAt),
            source: response.json?.source,
            fallbackReason: response.json?.fallback_reason,
            answerLength: String(response.json?.answer || "").length,
          });
        }
        logTrace("backend_response_received", {
          attempt,
          status: response.status,
          ok: response.ok,
          durationMs: performance.now() - startedAt,
        });
        emitProgress("response_received", {
          attempt,
          attempts,
          requestUrl: request.requestUrl,
          timeoutMs: effectiveTimeoutMs,
          status: response.status,
          ok: response.ok,
          durationMs: performance.now() - startedAt,
        });

        if (!response.ok) {
          const detail = response.json?.detail || response.text || response.statusText || "Request failed";
          if (isChatExplain) {
            console.warn(`${zetaLogPrefix("assistant")} chat/explain backend returned error`, {
              status: response.status,
              detail: typeof detail === "string" ? detail.slice(0, 500) : detail,
            });
          }
          logTrace("backend_response_error", {
            attempt,
            status: response.status,
            detail,
          });
          const error = new Error(`Backend ${response.status || "error"}: ${detail}`);
          error.status = Number(response.status) || 0; // eslint-disable-line no-param-reassign
          error.requestUrl = String(request.requestUrl || ""); // eslint-disable-line no-param-reassign
          throw error;
        }

        if (!response.json) {
          const error = new Error("Backend returned non-JSON response.");
          error.requestUrl = String(request.requestUrl || ""); // eslint-disable-line no-param-reassign
          throw error;
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
        emitProgress("request_failed", {
          attempt,
          attempts,
          requestUrl: request.requestUrl,
          timeoutMs: effectiveTimeoutMs,
          retryable,
          status: Number(error?.status) || 0,
          message: String(error?.message || error),
        });
        if (!retryable) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 260 * attempt));
      }
    }

    throw lastError || new Error("Unknown backend error");
  }

  resolveEffectiveTimeoutMs(requestUrl, requestBody = null) {
    const configured = clamp(
      Number(this.settings.requestTimeoutMs) || DEFAULT_SETTINGS.requestTimeoutMs,
      2000,
      180000
    );
    const url = String(requestUrl || "");
    const leanTimeoutSeconds = Number(
      requestBody?.lean_timeout_seconds
      || requestBody?.context?.lean_timeout_seconds
    );
    const isChatExplain = /\/v1\/chat\/explain(?:\/)?$/.test(url);
    if (isChatExplain) {
      const minChatMs = 45000;
      return Math.max(configured, minChatMs);
    }
    const isLeanSolve = /\/v1\/lean\/solve(?:\/)?$/.test(url);
    const isAnalyze = /\/v1\/(?:analyze|query)(?:\/)?$/.test(url);
    if (isLeanSolve || isAnalyze) {
      const baseMinTimeoutMs = this.settings.mode === "accurate" ? 90000 : 70000;
      const leanAlignedMinTimeoutMs = Number.isFinite(leanTimeoutSeconds) && leanTimeoutSeconds > 0
        ? Math.round(leanTimeoutSeconds * 1000) + 30000
        : 0;
      const minTimeoutMs = Math.max(baseMinTimeoutMs, leanAlignedMinTimeoutMs);
      if (configured < minTimeoutMs) {
        return minTimeoutMs;
      }
    }
    return configured;
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
          console.warn(
            "[zeta:content] Backend returned error (see what server actually returned):",
            {
              url: payload?.url,
              status: response.status,
              statusText: response.statusText,
              bodyPreview: typeof response.text === "string" ? response.text.slice(0, 600) : response.text,
              json: response.json,
            }
          );
          const error = new Error(response.error || `HTTP error ${response.status || "unknown"}`);
          error.status = Number(response.status) || 0; // eslint-disable-line no-param-reassign
          error.endpointUrl = String(payload?.url || ""); // eslint-disable-line no-param-reassign
          reject(error);
        }
      );
    });
  }

  resolveChunkIssueSeverity(diagnostics) {
    const hasError = diagnostics.some((diag) => normalizeSeverity(diag?.severity) === "error");
    if (hasError) {
      return "error";
    }
    const hasWarning = diagnostics.some((diag) => normalizeSeverity(diag?.severity) === "warning");
    if (hasWarning) {
      return "warning";
    }
    const hasInfo = diagnostics.some((diag) => normalizeSeverity(diag?.severity) === "info");
    if (hasInfo) {
      return "info";
    }
    return "unknown";
  }

  isInfrastructureDiagnosticMessage(message) {
    const text = String(message || "").toLowerCase();
    if (!text) {
      return false;
    }
    const markers = [
      "no default toolchain configured",
      "elan default stable",
      "lean compiler command not found",
      "install lean 4 (elan)",
      "set lean_command/lake_command",
      "lake_project_dir",
      "missing lakefile",
      "compile failed: no compile attempts were executed",
    ];
    return markers.some((marker) => text.includes(marker));
  }

  resolveCompileSuccess(response, diagnostics = []) {
    if (typeof response?.compile?.success === "boolean") {
      return response.compile.success;
    }
    if (typeof response?.is_valid_lean === "boolean") {
      return response.is_valid_lean;
    }
    return !ensureArray(diagnostics).some((diag) => normalizeSeverity(diag?.severity) === "error");
  }

  resolveChunkFixSuggestion(response, diagnostics, topSuggestions, feedbackItems, semanticReasons) {
    const picked = [];
    const seen = new Set();
    const push = (value) => {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (!text) {
        return;
      }
      const key = text.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      picked.push(text);
    };

    for (const suggestion of [
      ...ensureArray(topSuggestions),
      ...ensureArray(feedbackItems),
      ...ensureArray(response?.dashboard?.next_actions),
      ...ensureArray(response?.dashboard?.messages),
      ...ensureArray(semanticReasons),
    ]) {
      push(suggestion);
    }

    const compileFailed = !this.resolveCompileSuccess(response, diagnostics);
    if (compileFailed && picked.length === 0) {
      const firstError = ensureArray(diagnostics).find(
        (diag) => normalizeSeverity(diag?.severity) === "error"
      );
      if (firstError?.message) {
        push(firstError.message);
      }
    }

    return picked[0] || "";
  }

  deriveReplacementFromSuggestion(suggestionText, targetText) {
    const suggestion = String(suggestionText || "").trim();
    const target = String(targetText || "").trim();
    if (!suggestion || !target) {
      return "";
    }

    const cleaned = suggestion
      .replace(/^suggested fix:\s*/i, "")
      .replace(/^try this rewrite(?: next)?:\s*/i, "")
      .trim();
    const patterns = [
      /^did you mean\s+(.+?)\?\s*$/i,
      /^replace with\s+(.+?)\.?\s*$/i,
      /^use\s+(.+?)\s+instead\.?\s*$/i,
      /^rewrite as\s+(.+?)\.?\s*$/i,
    ];
    let candidate = "";
    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match && match[1]) {
        candidate = String(match[1]).trim();
        break;
      }
    }
    if (!candidate) {
      return "";
    }

    candidate = candidate
      .replace(/^["'`]+/, "")
      .replace(/["'`]+$/, "")
      .trim();
    if (!candidate || candidate === target || candidate.length > 260) {
      return "";
    }
    return candidate;
  }

  detectMonotonicInequalityIssues(scopeText) {
    const source = String(scopeText || "");
    if (!source.trim()) {
      return [];
    }

    const issues = [];
    const patterns = [
      {
        regex: /([A-Za-z])\s*\+\s*(\d+)\s*(\\geq|>=|≥)\s*\1\s*\+\s*(\d+)/g,
        invalidWhen: (left, right) => left < right,
        correctedComparator: "≤",
      },
      {
        regex: /([A-Za-z])\s*\+\s*(\d+)\s*(\\leq|<=|≤)\s*\1\s*\+\s*(\d+)/g,
        invalidWhen: (left, right) => left > right,
        correctedComparator: "≥",
      },
    ];

    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(source)) !== null) {
        const variable = String(match[1] || "n");
        const leftConst = Number(match[2]);
        const rightConst = Number(match[4]);
        if (!Number.isFinite(leftConst) || !Number.isFinite(rightConst)) {
          continue;
        }
        if (!pattern.invalidWhen(leftConst, rightConst)) {
          continue;
        }

        const targetText = String(match[0] || "").trim();
        const humanTargetText = this.toActivityMathText(targetText) || targetText;
        const suggestion = `${variable} + ${leftConst} ${pattern.correctedComparator} ${variable} + ${rightConst}`;
        issues.push({
          id: `sanity-${issues.length + 1}`,
          key: this.buildIssueKey({
            category: "semantic-sanity",
            message: `This inequality direction looks inconsistent: ${humanTargetText}.`,
            targetText,
            replacement: suggestion,
          }),
          category: "semantic-sanity",
          severity: "warning",
          message: `This inequality direction looks inconsistent: ${humanTargetText}.`,
          start: match.index,
          end: match.index + targetText.length,
          targetText,
          replacement: suggestion,
          suggestion: `Did you mean ${suggestion}?`,
          source: "heuristic",
        });
      }
    }

    return issues;
  }

  normalizeBackendResponse(response, scopeText, requestUrl = "") {
    const diagnostics =
      ensureArray(response.compile?.diagnostics).length > 0
        ? ensureArray(response.compile?.diagnostics)
        : ensureArray(response.diagnostics);
    const inlineDiagnostics = diagnostics.filter(
      (diag) => !this.isInfrastructureDiagnosticMessage(diag?.message)
    );
    const compileSuccess = this.resolveCompileSuccess(response, diagnostics);

    const interpretationItems = ensureArray(response.interpretation?.items);
    const finalFeedbackItems = ensureArray(response.final_feedback);
    const topSuggestions = [
      ...ensureArray(response.interpretation?.suggestions),
      ...finalFeedbackItems,
    ];
    const feedbackItems = finalFeedbackItems.length > 0
      ? finalFeedbackItems
      : ensureArray(response.feedback);
    const semanticReasons = ensureArray(response.pipeline?.semantic?.reasons);
    const semanticChecked = !!(response.pipeline && response.pipeline.semantic && typeof response.pipeline.semantic === "object");
    const normalizedRequestUrl = String(requestUrl || "");
    const isLegacyTranslatorAnalyze = /\/v1\/(?:analyze|query)(?:\/)?$/.test(normalizedRequestUrl);
    const chunkScopeText = String(scopeText || "");
    const chunkFixSuggestion = this.resolveChunkFixSuggestion(
      response,
      inlineDiagnostics,
      topSuggestions,
      feedbackItems,
      semanticReasons
    );

    const issues = [];
    const highlightRanges = ensureArray(response.highlights?.highlights);
    const coveredInterpretationIndices = new Set();

    if (highlightRanges.length > 0) {
      for (const range of highlightRanges) {
        const itemIndex = Number.isInteger(range?.item_index) ? range.item_index : null;
        if (itemIndex !== null) {
          coveredInterpretationIndices.add(itemIndex);
        }
        const linkedItem = itemIndex !== null ? interpretationItems[itemIndex] : null;
        const localStartRaw = Number.isInteger(range?.start_in_chunk)
          ? range.start_in_chunk
          : (Number.isInteger(range?.start) ? range.start : null);
        const localEndRaw = Number.isInteger(range?.end_in_chunk)
          ? range.end_in_chunk
          : (Number.isInteger(range?.end) ? range.end : null);
        const localStart = Number.isInteger(localStartRaw)
          ? clamp(localStartRaw, 0, scopeText.length)
          : null;
        const localEnd = Number.isInteger(localEndRaw)
          ? clamp(localEndRaw, 0, scopeText.length)
          : null;
        const targetText = (
          Number.isInteger(localStart) &&
          Number.isInteger(localEnd) &&
          localEnd > localStart
        )
          ? scopeText.slice(localStart, localEnd)
          : (String(range?.text || "").trim() || linkedItem?.latex_excerpt || null);
        const resolvedReplacement = String(
          linkedItem?.replacement
          || this.deriveReplacementFromSuggestion(linkedItem?.suggested_fix, targetText)
          || ""
        ).trim() || null;
        const message = linkedItem?.error
          || linkedItem?.suggested_fix
          || String(range?.text || "").trim()
          || "Interpretation issue";

        issues.push({
          id: `hl-${issues.length + 1}`,
          key: this.buildIssueKey({
            category: "math-typo",
            message,
            targetText,
            replacement: resolvedReplacement,
          }),
          category: "math-typo",
          severity: "error",
          message,
          start: localStart,
          end: localEnd,
          targetText,
          replacement: resolvedReplacement,
          suggestion: linkedItem?.suggested_fix || null,
          suggestedFix: linkedItem?.suggested_fix || null,
          source: "backend",
          line: Number.isInteger(linkedItem?.lean_line) ? linkedItem.lean_line : null,
          column: Number.isInteger(linkedItem?.lean_column) ? linkedItem.lean_column : null,
        });
      }
    }

    for (let itemIndex = 0; itemIndex < interpretationItems.length; itemIndex += 1) {
      if (coveredInterpretationIndices.has(itemIndex)) {
        continue;
      }
      const item = interpretationItems[itemIndex];
      const start = Number.isInteger(item.latex_start) ? item.latex_start : null;
      const end = Number.isInteger(item.latex_end) ? item.latex_end : null;
      const excerpt = item.latex_excerpt || null;
      const targetText =
        start !== null && end !== null && end > start
          ? scopeText.slice(start, end)
          : excerpt;
      const resolvedReplacement = String(
        item.replacement
        || this.deriveReplacementFromSuggestion(item.suggested_fix, targetText)
        || ""
      ).trim() || null;

      const message =
        item.error || item.suggested_fix || item.probable_cause || "Interpretation issue";

      issues.push({
        id: `interp-${issues.length + 1}`,
        key: this.buildIssueKey({
          category: "math-typo",
          message,
          targetText,
          replacement: resolvedReplacement,
        }),
        category: "math-typo",
        severity: "error",
        message,
        start,
        end,
        targetText,
        replacement: resolvedReplacement,
        suggestion: item.suggested_fix || null,
        suggestedFix: item.suggested_fix || null,
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

    const seenHintSuggestions = new Set();
    for (const suggestion of [...topSuggestions, ...feedbackItems]) {
      const text = String(suggestion || "").trim();
      if (!text) {
        continue;
      }
      const key = text.toLowerCase();
      if (seenHintSuggestions.has(key)) {
        continue;
      }
      seenHintSuggestions.add(key);

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

    const semanticHeuristics = this.detectMonotonicInequalityIssues(scopeText);
    for (const heuristicIssue of semanticHeuristics) {
      issues.push(heuristicIssue);
    }

    if (
      compileSuccess &&
      !semanticChecked &&
      isLegacyTranslatorAnalyze &&
      chunkScopeText.trim()
    ) {
      const semanticUncheckedMessage =
        "Semantic validation did not run for this sentence, so mathematical truth was not verified.";
      issues.push({
        id: `semantic-unchecked-${issues.length + 1}`,
        key: this.buildIssueKey({
          category: "semantic-validation",
          message: semanticUncheckedMessage,
          targetText: chunkScopeText,
          replacement: null,
        }),
        category: "semantic-validation",
        severity: "warning",
        message: semanticUncheckedMessage,
        start: 0,
        end: chunkScopeText.length,
        targetText: chunkScopeText,
        replacement: null,
        suggestion: "Run the Lean semantic pipeline (`/v1/lean/solve`) to verify this claim.",
        source: "backend",
      });
    }

    const hasRangeBoundIssue = issues.some((issue) => (
      Number.isInteger(issue?.start) &&
      Number.isInteger(issue?.end) &&
      issue.end > issue.start
    ));
    if (chunkScopeText.trim() && inlineDiagnostics.length > 0 && !hasRangeBoundIssue) {
      const fallbackMessage = String(inlineDiagnostics[0]?.message || "Chunk requires review.");
      issues.push({
        id: `chunk-${issues.length + 1}`,
        key: this.buildIssueKey({
          category: "chunk-review",
          message: fallbackMessage,
          targetText: chunkScopeText,
          replacement: null,
        }),
        category: "chunk-review",
        severity: this.resolveChunkIssueSeverity(inlineDiagnostics),
        message: fallbackMessage,
        start: 0,
        end: chunkScopeText.length,
        targetText: chunkScopeText,
        replacement: null,
        suggestion: chunkFixSuggestion || null,
        source: "backend",
      });
    }

    for (const issue of issues) {
      if (issue?.replacement) {
        continue;
      }
      const targetText = String(issue?.targetText || "").trim();
      const suggestionText = String(issue?.suggestion || issue?.suggestedFix || "").trim();
      if (!targetText || !suggestionText) {
        continue;
      }
      const derived = this.deriveReplacementFromSuggestion(suggestionText, targetText);
      if (derived) {
        issue.replacement = derived;
      }
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
      !compileSuccess ||
      response.pipeline?.semantic?.success === false ||
      interpretationItems.length > 0 ||
      diagnostics.some((diag) => normalizeSeverity(diag.severity) === "error");

    return {
      diagnostics,
      issues,
      hasError: hasCompileErrors,
    };
  }

  mergeIssues(issues) {
    const merged = [];
    const seen = new Set();
    for (const issue of issues) {
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

  toActivityMathText(rawText) {
    let text = String(rawText || "");
    if (!text.trim()) {
      return "";
    }

    const blackboardMap = {
      N: "ℕ",
      Z: "ℤ",
      Q: "ℚ",
      R: "ℝ",
      C: "ℂ",
    };
    text = text
      .replace(/\\\(|\\\)|\\\[|\\\]/g, " ")
      .replace(/\$\$/g, " ")
      .replace(/\$/g, " ")
      .replace(/\\mathbb\s*\{\s*([A-Za-z])\s*\}/g, (_, letter) => {
        const key = String(letter || "").toUpperCase();
        return blackboardMap[key] || key;
      })
      .replace(/\\geq\b/g, "≥")
      .replace(/\\leq\b/g, "≤")
      .replace(/\\neq\b/g, "≠")
      .replace(/\\in\b/g, "∈")
      .replace(/\\notin\b/g, "∉")
      .replace(/\\to\b/g, "→")
      .replace(/\\rightarrow\b/g, "→")
      .replace(/\\leftarrow\b/g, "←")
      .replace(/\\iff\b/g, "↔")
      .replace(/\\implies\b/g, "⇒")
      .replace(/\\forall\b/g, "∀")
      .replace(/\\exists\b/g, "∃")
      .replace(/\\cdot\b/g, "·")
      .replace(/\\times\b/g, "×")
      .replace(/\\pm\b/g, "±")
      .replace(/\\mp\b/g, "∓")
      .replace(/\\[a-zA-Z@]+\*?/g, " ")
      .replace(/[{}]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
    return text;
  }

  formatSentenceLabel(sentenceText) {
    const compact = this.toActivityMathText(sentenceText);
    if (!compact) {
      return "sentence";
    }
    if (compact.length <= 92) {
      return compact;
    }
    return `${compact.slice(0, 89)}...`;
  }

  resolveActivitySentenceText(sentenceEntry, responsePayload = null) {
    const backendInput = String(responsePayload?.input_text || "").trim();
    if (backendInput) {
      return backendInput;
    }
    return String(sentenceEntry?.text || "").trim();
  }

  formatInferenceDuration(valueMs) {
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

  estimateLivePipelinePhase(elapsedMs) {
    const elapsed = Number(elapsedMs);
    if (!Number.isFinite(elapsed) || elapsed <= 1200) {
      return "queueing";
    }
    if (elapsed <= 6500) {
      return "model inference";
    }
    return "lean compile";
  }

  describeLivePipelineStep(step, meta = {}) {
    const value = String(step || "").trim();
    if (!value) {
      return "working";
    }
    if (value === "queued") {
      return "queued";
    }
    if (value === "cache_lookup") {
      return "cache lookup";
    }
    if (value === "cache_hit") {
      return "cache hit";
    }
    if (value === "inflight_join") {
      return "joining in-flight request";
    }
    if (value === "prepare_request") {
      return "building request";
    }
    if (value === "request_sent") {
      const attempt = Number(meta.attempt) || 1;
      const attempts = Number(meta.attempts) || attempt;
      return `request sent (${attempt}/${attempts})`;
    }
    if (value === "await_backend_pipeline") {
      const phase = this.estimateLivePipelinePhase(meta.elapsedMs);
      return `backend pipeline · ${phase}`;
    }
    if (value === "response_received") {
      return "response received";
    }
    if (value === "response_ready") {
      return "response ready";
    }
    if (value === "fallback_to_legacy") {
      return "fallback to /v1/analyze";
    }
    if (value === "parse_response") {
      return "parsing response";
    }
    if (value === "normalize_response") {
      return "normalizing issues";
    }
    if (value === "complete") {
      return "completed";
    }
    if (value === "error" || value === "request_failed") {
      return "failed";
    }
    return value.replace(/[_-]+/g, " ");
  }

  resolveLivePipelineOutcome(step) {
    const value = String(step || "").trim().toLowerCase();
    if (value === "error" || value === "request_failed") {
      return "failed";
    }
    if (
      value === "complete"
      || value === "cache_hit"
      || value === "response_ready"
      || value === "normalize_response"
    ) {
      return "ok";
    }
    if (value === "canceled") {
      return "skipped";
    }
    return "unknown";
  }

  recordLivePipelineStep(sentenceEntry, step, meta = {}) {
    if (!sentenceEntry || typeof sentenceEntry !== "object") {
      return [];
    }
    const trace = Array.isArray(sentenceEntry.livePipelineTrace)
      ? sentenceEntry.livePipelineTrace.slice()
      : [];
    const label = this.describeLivePipelineStep(step, meta);
    const stepKey = `${String(step || "")}|${label}`;
    const elapsedMs = Number(meta.elapsedMs);
    const durationMs = Number.isFinite(elapsedMs) && elapsedMs >= 0
      ? Math.round(elapsedMs)
      : null;
    const outcome = this.resolveLivePipelineOutcome(step);
    const lastStage = trace.length > 0 ? trace[trace.length - 1] : null;
    if (lastStage && lastStage.key === stepKey) {
      lastStage.outcome = outcome;
      if (durationMs !== null) {
        lastStage.durationMs = durationMs;
      }
    } else {
      trace.push({
        key: stepKey,
        label,
        outcome,
        durationMs,
      });
    }
    if (trace.length > 10) {
      trace.splice(0, trace.length - 10);
    }
    sentenceEntry.livePipelineTrace = trace;
    return trace;
  }

  buildLiveSentenceActivityDetail(sentenceEntry, step, meta = {}) {
    const text = String(sentenceEntry?.text || "");
    const displayText = this.toActivityMathText(text) || text;
    const chunkId = String(sentenceEntry?.chunkId || this.activeChunkId || "innermost");
    const requestUrl = String(meta.requestUrl || HARDCODED_ANALYZE_URL);
    const stepLabel = this.describeLivePipelineStep(step, meta);

    const detailLines = [
      "Sentence",
      this.truncateActivityText(displayText, 500),
      "",
      "Chunk",
      chunkId,
      "",
      "Pipeline",
      `url: ${requestUrl}`,
      `request_key: ${String(sentenceEntry?.key || "--")}`,
      `step: ${stepLabel}`,
    ];

    if (Number.isFinite(Number(meta.index)) && Number.isFinite(Number(meta.total)) && Number(meta.total) > 0) {
      detailLines.push(`progress: ${Number(meta.index)}/${Number(meta.total)}`);
    }
    if (Number.isFinite(Number(meta.attempt)) && Number.isFinite(Number(meta.attempts))) {
      detailLines.push(`attempt: ${Number(meta.attempt)}/${Number(meta.attempts)}`);
    }
    if (Number.isFinite(Number(meta.status)) && Number(meta.status) > 0) {
      detailLines.push(`status: ${Number(meta.status)}`);
    }
    if (Number.isFinite(Number(meta.timeoutMs)) && Number(meta.timeoutMs) > 0) {
      detailLines.push(`timeout: ${this.formatInferenceDuration(Number(meta.timeoutMs))}`);
    }
    if (Number.isFinite(Number(meta.durationMs)) && Number(meta.durationMs) >= 0) {
      detailLines.push(`network: ${this.formatInferenceDuration(Number(meta.durationMs))}`);
    }
    if (Number.isFinite(Number(meta.cacheAgeMs)) && Number(meta.cacheAgeMs) >= 0) {
      detailLines.push(`cache_age: ${this.formatInferenceDuration(Number(meta.cacheAgeMs))}`);
    }
    if (Number.isFinite(Number(meta.elapsedMs)) && Number(meta.elapsedMs) >= 0) {
      detailLines.push(`elapsed: ${this.formatInferenceDuration(Number(meta.elapsedMs))}`);
    }
    if (step === "await_backend_pipeline") {
      detailLines.push(`pipeline_phase: ${this.estimateLivePipelinePhase(meta.elapsedMs)}`);
    }
    const liveTrace = ensureArray(sentenceEntry?.livePipelineTrace);
    if (liveTrace.length > 0) {
      detailLines.push("", "Pipeline trace");
      for (let index = 0; index < liveTrace.length; index += 1) {
        const stage = liveTrace[index];
        const durationLabel = Number.isFinite(Number(stage?.durationMs))
          ? String(Math.max(0, Math.round(Number(stage.durationMs))))
          : "--";
        detailLines.push(
          `${index + 1}. ${String(stage?.label || "step")} · ${String(stage?.outcome || "unknown")} · attempted=true · duration_ms=${durationLabel}`
        );
      }
    }
    if ((step === "error" || step === "request_failed") && meta.message) {
      detailLines.push("", "Error", this.truncateActivityText(String(meta.message || ""), 1200));
    }

    return detailLines.join("\n");
  }

  syncLiveSentenceActivity(activityId, sentenceEntry, step, meta = {}) {
    const id = String(activityId || "");
    if (!id) {
      return;
    }
    const stepLabel = this.describeLivePipelineStep(step, meta);
    const sentenceLabel = this.formatSentenceLabel(sentenceEntry?.text || "");
    const level = step === "error" || step === "request_failed"
      ? "error"
      : (step === "complete" ? "success" : "info");
    this.recordLivePipelineStep(sentenceEntry, step, meta);
    this.updateActivityById(id, {
      message: `analyzing · ${sentenceLabel} · ${stepLabel}`,
      level,
      detailText: this.buildLiveSentenceActivityDetail(sentenceEntry, step, meta),
    });
  }

  summarizePipelineDetails(details, maxLength = 520) {
    if (!details || typeof details !== "object") {
      return "";
    }
    const parts = [];
    const keys = Object.keys(details).sort();
    for (const key of keys) {
      const value = details[key];
      if (value === null || typeof value === "undefined" || value === "") {
        continue;
      }
      if (typeof value === "object") {
        parts.push(`${key}=${JSON.stringify(value)}`);
      } else {
        parts.push(`${key}=${String(value)}`);
      }
    }
    return this.truncateActivityText(parts.join(", "), maxLength).replace(/\n/g, " ");
  }

  summarizePipelineOutcome(stage) {
    const attempted = stage?.attempted !== false;
    const success = stage?.success;
    if (!attempted) {
      return "skipped";
    }
    if (success === true) {
      return "ok";
    }
    if (success === false) {
      return "failed";
    }
    return "unknown";
  }

  buildSentenceActivityLog(sentenceEntry, responsePayload, normalized, request, cacheHit, errorMessage = null) {
    const pipeline = responsePayload?.pipeline && typeof responsePayload.pipeline === "object"
      ? responsePayload.pipeline
      : null;
    const stages = ensureArray(pipeline?.stages);
    const requestUrl = String(request?.requestUrl || HARDCODED_ANALYZE_URL);
    const translatorTypecheckOnly = (
      stages.length === 0
      && /\/v1\/(?:analyze|query)(?:\/)?$/.test(requestUrl)
    );
    const semantic = pipeline?.semantic && typeof pipeline.semantic === "object"
      ? pipeline.semantic
      : null;
    const diagnostics = ensureArray(normalized?.diagnostics);
    const compileSuccess = this.resolveCompileSuccess(responsePayload || {}, diagnostics);
    const level = errorMessage || normalized?.hasError ? "error" : "success";
    const sentenceSourceText = this.resolveActivitySentenceText(sentenceEntry, responsePayload);
    const sentenceDisplayText = this.toActivityMathText(sentenceSourceText) || sentenceSourceText;
    const sentenceLabel = this.formatSentenceLabel(sentenceSourceText);
    const statusLabel = compileSuccess
      ? (translatorTypecheckOnly ? "typechecked" : "compiled")
      : "needs attention";
    const message = `${statusLabel} · ${sentenceLabel}`;

    const detailLines = [
      "Sentence",
      this.truncateActivityText(sentenceDisplayText, 500),
    ];
    const generatedLeanCode = String(responsePayload?.lean_code || "").trim();
    if (generatedLeanCode) {
      detailLines.push("", "Lean", this.truncateActivityText(generatedLeanCode, 5000));
    }
    if (errorMessage) {
      detailLines.push("", "Error", this.truncateActivityText(errorMessage, 1200));
    }
    if (!compileSuccess) {
      detailLines.push("", "Compile", "success: false", `diagnostics: ${diagnostics.length}`);
    }
    if (diagnostics.length > 0) {
      const diagnosticText = diagnostics
        .slice(0, 10)
        .map((diag, index) => `${index + 1}. ${diag?.severity || "info"} · ${diag?.message || "diagnostic"}`)
        .join("\n");
      detailLines.push("", "diagnostics", this.truncateActivityText(diagnosticText, 1400));
    }
    if (semantic?.success === false) {
      const reasons = ensureArray(semantic?.reasons)
        .map((reason) => String(reason || "").trim())
        .filter(Boolean)
        .slice(0, 4);
      if (reasons.length > 0) {
        detailLines.push("", "semantic");
        for (const reason of reasons) {
          detailLines.push(`- ${this.truncateActivityText(reason, 260)}`);
        }
      }
    }
    if (translatorTypecheckOnly && compileSuccess) {
      detailLines.push(
        "",
        "Note",
        "Lean typecheck ran, but theorem-proving semantic validation did not run."
      );
    }

    if (stages.length > 0) {
      detailLines.push("", "Pipeline trace");
      for (let index = 0; index < stages.length; index += 1) {
        const stage = stages[index];
        const outcome = this.summarizePipelineOutcome(stage);
        const attempted = stage?.success !== undefined && stage?.success !== null;
        const durationLabel = Number.isFinite(Number(stage?.duration_ms))
          ? String(Math.max(0, Math.round(Number(stage.duration_ms))))
          : "--";
        detailLines.push(
          `${index + 1}. ${String(stage?.stage || "stage")} · ${outcome} · attempted=${attempted} · duration_ms=${durationLabel}`
        );
        const stageDetails = stage?.details && typeof stage.details === "object" ? stage.details : {};
        for (const [key, value] of Object.entries(stageDetails)) {
          if (value === null || value === undefined) continue;
          if (typeof value === "string" && value.includes("\n")) {
            detailLines.push(`  ${key}:`);
            const maxLines = 120;
            const lines = value.split(/\r?\n/).slice(0, maxLines);
            for (const line of lines) {
              detailLines.push("    " + line);
            }
            if (value.split(/\r?\n/).length > maxLines) {
              detailLines.push("    ...");
            }
          } else if (Array.isArray(value)) {
            detailLines.push("  " + key + ": " + JSON.stringify(value));
          } else if (typeof value === "object") {
            detailLines.push("  " + key + ": " + JSON.stringify(value));
          } else {
            detailLines.push("  " + key + ": " + String(value));
          }
        }
      }
    } else {
      const liveTrace = ensureArray(sentenceEntry?.livePipelineTrace);
      if (liveTrace.length > 0) {
        detailLines.push("", "Pipeline trace");
        for (let index = 0; index < liveTrace.length; index += 1) {
          const stage = liveTrace[index];
          const durationLabel = Number.isFinite(Number(stage?.durationMs))
            ? String(Math.max(0, Math.round(Number(stage.durationMs))))
            : "--";
          detailLines.push(
            `${index + 1}. ${String(stage?.label || "step")} · ${String(stage?.outcome || "unknown")} · attempted=true · duration_ms=${durationLabel}`
          );
        }
      }
    }

    const shouldIncludeDetail = level === "error";
    if (shouldIncludeDetail) {
      detailLines.push(
        "",
        "Request",
        `url: ${requestUrl}`,
        `cache_hit: ${cacheHit ? "true" : "false"}`,
        `inference: ${this.formatInferenceDuration(sentenceEntry.inferenceMs)}`
      );
    }

    const hasPipelineStages = stages.length > 0;
    const hasLivePipelineTrace = ensureArray(sentenceEntry?.livePipelineTrace).length > 0;
    const includeDetailForViewPipeline = hasPipelineStages || hasLivePipelineTrace || shouldIncludeDetail || detailLines.length >= 2;
    return {
      message,
      level,
      detailText: includeDetailForViewPipeline ? detailLines.join("\n") : "",
    };
  }

  buildActivityTimeLabel(ts = Date.now()) {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  /** Normalized key for activity dedup: same sentence/title => one entry (keep latest). */
  getActivityTitleKey(message) {
    const s = String(message || "").trim().replace(/\s+/g, " ");
    const sep = " · ";
    const i = s.lastIndexOf(sep);
    const title = i >= 0 ? s.slice(i + sep.length).trim() : s;
    return title || s;
  }

  activityCreatedAt(entry) {
    const created = Number(entry?.createdAt);
    if (Number.isFinite(created)) return created;
    const id = String(entry?.id || "");
    const match = id.match(/^act-(\d+)-/);
    return match ? Number(match[1]) : 0;
  }

  sortActivityEntriesLatestToEarliest() {
    this.activityEntries.sort(
      (a, b) => this.activityCreatedAt(b) - this.activityCreatedAt(a)
    );
  }

  addActivity(message, level = "info", undoAction = null, detailText = "") {
    const now = Date.now();
    const entry = {
      id: `act-${now}-${Math.random().toString(36).slice(2, 6)}`,
      message,
      level,
      detailText: this.truncateActivityText(detailText, 7000),
      timeLabel: this.buildActivityTimeLabel(now),
      createdAt: now,
    };

    const newKey = this.getActivityTitleKey(message);
    const isAutocompleteFetching = typeof message === "string" && message.startsWith("Autocomplete: fetching");
    if (!isAutocompleteFetching) {
      this.activityEntries = this.activityEntries.filter(
        (e) => this.getActivityTitleKey(e?.message) !== newKey
      );
    }
    this.activityEntries.push(entry);
    this.sortActivityEntriesLatestToEarliest();
    if (this.activityEntries.length > 60) {
      this.activityEntries = this.activityEntries.slice(0, 60);
    }

    if (undoAction) {
      this.undoStack.push(undoAction);
      if (this.undoStack.length > 30) {
        this.undoStack.shift();
      }
    }

    this.panel.setActivity(this.activityEntries, this.undoStack.length > 0);
    this.persistPanelSnapshot();
    return entry.id;
  }

  updateActivityById(activityId, updates = {}, options = {}) {
    const targetId = String(activityId || "").trim();
    if (!targetId) {
      return false;
    }
    const index = this.activityEntries.findIndex((entry) => entry?.id === targetId);
    if (index === -1) {
      return false;
    }

    const current = this.activityEntries[index] || {};
    const next = { ...current };
    if (typeof updates.message === "string" && updates.message.trim()) {
      next.message = updates.message;
    }
    if (typeof updates.level === "string" && updates.level.trim()) {
      next.level = updates.level;
    }
    if (typeof updates.detailText === "string") {
      next.detailText = this.truncateActivityText(updates.detailText, 7000);
    }
    if (options.refreshTime) {
      next.timeLabel = this.buildActivityTimeLabel();
    } else if (typeof updates.timeLabel === "string" && updates.timeLabel.trim()) {
      next.timeLabel = updates.timeLabel;
    }

    this.activityEntries[index] = next;
    this.sortActivityEntriesLatestToEarliest();
    this.panel.setActivity(this.activityEntries, this.undoStack.length > 0);
    this.persistPanelSnapshot();
    return true;
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
      const keysToRemove = [];
      const explicitKeys = ensureArray(action.issueKeys)
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      keysToRemove.push(...explicitKeys);
      if (String(action.issueKey || "").trim()) {
        keysToRemove.push(String(action.issueKey).trim());
      }
      for (const key of keysToRemove) {
        this.ignoredKeys.delete(key);
      }
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
    this.syncChatThreadsFromIssues(issues);
    this.currentMacroList = this.extractMacroNames(
      state?.snapshot?.context || state?.snapshot?.text || ""
    );
    this.panel.setHealth(score);
    this.panel.setIssues(issues, this.focusedIssueIndex);
    this.persistPanelSnapshot({
      healthScore: score,
      healthBreakdown: breakdown,
      issueCount: issues.length,
      chunkTree: this.serializeChunkTree(this.graphChunkTree || this.chunkTree),
      activeChunkId: this.graphActiveChunkId || this.activeChunkId,
    });

    if (this.activeAdapter && state.snapshot) {
      this.overlay.render(this.activeAdapter, issues, state.snapshot);
    } else {
      this.overlay.clear();
    }
    this.renderTabGhost();
  }

  isIssueIgnored(issue) {
    if (!issue || typeof issue !== "object") {
      return false;
    }
    const key = String(issue.key || "").trim();
    if (key && this.ignoredKeys.has(key)) {
      return true;
    }
    const originIssueKey = String(issue.originIssueKey || "").trim();
    if (originIssueKey && this.ignoredKeys.has(originIssueKey)) {
      return true;
    }
    return false;
  }

  computeHealthBreakdown(issues) {
    const issueList = ensureArray(issues);
    const severityCounts = {
      error: 0,
      warning: 0,
      info: 0,
      unknown: 0,
    };
    const issueEntries = [];
    let rawSeverityPenalty = 0;
    for (const issue of issueList) {
      const severity = normalizeSeverity(issue?.severity);
      if (Object.prototype.hasOwnProperty.call(severityCounts, severity)) {
        severityCounts[severity] += 1;
      } else {
        severityCounts.unknown += 1;
      }
      const points = SEVERITY_WEIGHT[severity] || SEVERITY_WEIGHT.unknown;
      rawSeverityPenalty += points;
      const message = String(issue?.message || issue?.category || "issue").trim().slice(0, 80);
      issueEntries.push({ message: message || severity, severity, points });
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
      issueEntries,
    };
  }

  computeHealthScore(issues) {
    return this.computeHealthBreakdown(issues).score;
  }

  scheduleRender() {
    if (!this.lastRun && !this.activeAutocomplete && !this.autocompleteInFlight) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (!this.activeAdapter) {
        return;
      }
      if (this.lastRun) {
        this.overlay.render(this.activeAdapter, this.lastRun.issues, this.lastRun.snapshot);
        this.syncPopoverWithCaret();
      }
      this.renderTabGhost();
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
    this.pinnedPopoverIssueKey = String(issue.key || "");

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
    const removedKey = String(issue?.key || "");
    const removedOriginKey = String(issue?.originIssueKey || "");
    if (removedKey && this.pinnedPopoverIssueKey === removedKey) {
      this.pinnedPopoverIssueKey = "";
    }
    if (removedKey) {
      this.ignoredKeys.add(removedKey);
    }
    if (removedOriginKey) {
      this.ignoredKeys.add(removedOriginKey);
    }
    await storageLocalSet({
      [IGNORED_KEY]: Array.from(this.ignoredKeys).slice(-1500),
    });

    const sentenceKey = String(issue?.sentenceKey || "");
    const dropFromEntry = (entry) => {
      if (!entry || typeof entry !== "object") {
        return;
      }
      const shouldDrop = (candidate) => {
        const candidateKey = String(candidate?.key || "").trim();
        if (removedOriginKey && candidateKey === removedOriginKey) {
          return true;
        }
        if (candidateKey && candidateKey === removedKey) {
          return true;
        }
        return (
          String(candidate?.message || "") === String(issue?.message || "") &&
          String(candidate?.targetText || "") === String(issue?.targetText || "")
        );
      };
      entry.issues = ensureArray(entry.issues).filter((candidate) => !shouldDrop(candidate));
      entry.persistentIssues = ensureArray(entry.persistentIssues).filter((candidate) => !shouldDrop(candidate));
    };
    if (sentenceKey) {
      dropFromEntry(this.sentenceCache.get(sentenceKey));
    } else {
      for (const entry of this.sentenceCache.values()) {
        dropFromEntry(entry);
      }
    }

    if (!this.lastRun) {
      return;
    }

    this.lastRun.issues = this.lastRun.issues.filter((item) => {
      if (!item) {
        return false;
      }
      if (String(item.key || "") === removedKey) {
        return false;
      }
      if (removedOriginKey && String(item.originIssueKey || "") === removedOriginKey) {
        return false;
      }
      return true;
    });
    this.focusedIssueIndex = clamp(this.focusedIssueIndex, -1, this.lastRun.issues.length - 1);
    this.renderState(this.lastRun);
    this.popover.close();
    this.panel.setStatus("idle", "Issue ignored.");
    const undoKeys = [removedKey, removedOriginKey].filter(Boolean);
    this.addActivity(
      `Ignored suggestion: ${issue.message}`,
      "info",
      { type: "unignore", issueKey: removedKey, issueKeys: undoKeys }
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

    this.popover.close();
    if (String(issue?.key || "") === this.pinnedPopoverIssueKey) {
      this.pinnedPopoverIssueKey = "";
    }
    const appliedKey = String(issue?.key || "");
    if (appliedKey && this.lastRun.issues) {
      this.lastRun.issues = this.lastRun.issues.filter(
        (item) => item && String(item.key || "") !== appliedKey
      );
      this.focusedIssueIndex = clamp(this.focusedIssueIndex, -1, this.lastRun.issues.length - 1);
      this.renderState(this.lastRun);
    }
    this.panel.setStatus("idle", "Replacement applied.");
    this.addActivity(
      `Applied suggestion${issue.targetText ? ` for '${issue.targetText}'` : ""}.`,
      "success",
      { type: "editor-undo" }
    );
    this.scheduleAnalysis("apply", true);
  }

  syncPopoverWithCaret() {
    if (!this.lastRun || !this.activeAdapter) {
      this.pinnedPopoverIssueKey = "";
      this.popover.close();
      return;
    }

    if (this.pinnedPopoverIssueKey) {
      const pinnedIssue = ensureArray(this.lastRun.issues).find(
        (item) => String(item?.key || "") === this.pinnedPopoverIssueKey
      );
      if (pinnedIssue) {
        const pinnedRow = ensureArray(this.overlay.rectIssueMap).find(
          (entry) => String(entry?.issue?.key || "") === this.pinnedPopoverIssueKey
        );
        if (pinnedRow) {
          if (this.popover.currentIssue?.key === pinnedIssue.key) {
            this.popover.position(pinnedRow.rect);
          } else {
            this.popover.open(pinnedIssue, pinnedRow.rect);
          }
        }
        return;
      } else {
        this.pinnedPopoverIssueKey = "";
      }
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
    if (this.autocompleteTimer) {
      clearTimeout(this.autocompleteTimer);
    }
    storageLocalSet({
      [UI_SURFACE_KEY]: {
        surface: "none",
        updatedAt: Date.now(),
      },
    });

    this.detachGlobalListeners();
    this.popover.close();
    this.pinnedPopoverIssueKey = "";
    this.overlay.remove();
    this.panel.remove();
    if (this.tabGhostElement && this.tabGhostElement.isConnected) {
      this.tabGhostElement.remove();
    }
    this.tabGhostElement = null;

    for (const adapter of this.adapters) {
      adapter.destroy();
    }
    this.adapters = [];
  }
}

  zeta.ZetaApp = ZetaApp;
})();
