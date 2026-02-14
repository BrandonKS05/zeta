(() => {
  "use strict";

  const zeta = window.__zetaContent || (window.__zetaContent = {});
  const {
    SETTINGS_KEY,
    MODE_KEY,
    IGNORED_KEY,
    CACHE_TTL_MS,
    DEFAULT_SETTINGS,
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
    normalizeSeverity,
    logTrace,
    DomLineAdapter,
    TextareaAdapter,
    ContentEditableAdapter,
    ZetaOverlay,
    ZetaPopover,
    ZetaPanel,
  } = zeta;

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
      onTogglePanel: (explicit) => this.togglePanel(explicit),
      onToggleTheme: () => this.toggleTheme(),
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
    this.activeRequestId = 0;
    this.lastAnalyzedSignature = "";
    this.lastRun = null;
    this.focusedIssueIndex = -1;
    this.responseCache = new Map();
    this.chunkCache = new Map();
    this.chunkTree = null;
    this.activeChunkId = null;
    this.lastInferenceMs = null;
    this.activityEntries = [];
    this.undoStack = [];

    this.boundSelectionChange = this.handleSelectionChange.bind(this);
    this.boundFocusIn = this.handleFocusIn.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundScheduleByScroll = this.scheduleRender.bind(this);
    this.boundStorageChange = this.handleStorageChange.bind(this);
  }

  async init() {
    await this.loadSettings();
    this.panel.setSettings(this.settings);
    this.panel.setOpen(this.settings.panelOpen);
    this.panel.setStatus("idle", "Idle");
    this.panel.setGlobalState("ready", "global · waiting");
    this.panel.setInferenceTime(null, 0);
    this.panel.setSentenceStats(0, 0);
    this.panel.setHealth(100);
    this.panel.setActivity(this.activityEntries, false);
    this.panel.setChunkTree(null, null);

    this.refreshAdapters();
    this.activateInitialAdapter();
    this.attachGlobalListeners();

    if (this.activeAdapter) {
      this.scheduleAnalysis("init", true);
    } else {
      this.panel.setStatus("idle", "Focus a text editor to start.");
      this.panel.setGlobalState("offline", "global · no editor");
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
    merged.theme = normalizeTheme(merged.theme);
    merged.requestTimeoutMs = clamp(Number(merged.requestTimeoutMs) || DEFAULT_SETTINGS.requestTimeoutMs, 2000, 120000);
    merged.retries = clamp(Number(merged.retries) || 0, 0, 4);
    merged.backendUrl = merged.backendUrl || DEFAULT_SETTINGS.backendUrl;
    merged.notationStrictness = ["relaxed", "balanced", "strict"].includes(merged.notationStrictness)
      ? merged.notationStrictness
      : "balanced";

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
  }

  handleStorageChange(changes, areaName) {
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
      nextSettings.theme = normalizeTheme(nextSettings.theme);
      this.settings = nextSettings;
      changed = true;
    }

    if (changed) {
      this.panel.setSettings(this.settings);
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
          if (adapter === this.activeAdapter && this.settings.checkOnType) {
            this.scheduleAnalysis("typing");
          }
          if (adapter === this.activeAdapter) {
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
    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      this.togglePanel();
      return;
    }

    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      this.focusNextIssue();
      return;
    }

    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      this.focusPrevIssue();
      return;
    }

    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (this.focusedIssueIndex >= 0) {
        this.applyIssueByIndex(this.focusedIssueIndex);
      }
      return;
    }

    if (event.altKey && event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault();
      this.undoLastAction();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      this.runAnalysis("shortcut", true);
    }
  }

  async updateSettings(nextPartial, rerun) {
    const next = {
      ...this.settings,
      ...nextPartial,
    };
    next.mode = normalizeMode(next.mode);
    next.scope = normalizeScope(next.scope);
    next.theme = normalizeTheme(next.theme);

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

  async toggleTheme() {
    const nextTheme = this.settings.theme === "dark" ? "light" : "dark";
    await this.updateSettings({ theme: nextTheme }, false);
    this.panel.setStatus("idle", `Theme switched to ${nextTheme}.`);
    this.panel.setGlobalState("ready", "global · theme updated");
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

  togglePanel(explicit) {
    const nextOpen = typeof explicit === "boolean" ? explicit : !this.settings.panelOpen;
    this.settings.panelOpen = nextOpen;
    this.panel.setOpen(nextOpen);
    storageSyncSet({
      [SETTINGS_KEY]: this.settings,
      [MODE_KEY]: this.settings.mode,
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
      return;
    }

    const effectiveScope = this.resolveScopeForReason(reason);
    const snapshot = adapter.getScopeSnapshot(effectiveScope);
    const scopeText = String(snapshot.text || "");
    logTrace("analysis_begin", {
      reason,
      force,
      requestedScope: this.settings.scope,
      effectiveScope,
      chars: scopeText.length,
    });
    if (!scopeText.trim()) {
      this.chunkTree = null;
      this.activeChunkId = null;
      this.lastRun = {
        snapshot,
        diagnostics: [],
        issues: [],
      };
      this.focusedIssueIndex = -1;
      this.panel.setStatus("idle", "Nothing to analyze in this scope.");
      this.panel.setIssues([], -1);
      this.panel.setHealth(100);
      this.panel.setGlobalState("ready", "global · waiting");
      this.panel.setInferenceTime(this.lastInferenceMs, 0);
      this.panel.setSentenceStats(0, 0);
      this.panel.setChunkTree(null, null);
      this.overlay.clear();
      this.popover.close();
      return;
    }

    const localIssues = this.detectLocalMathTypos(scopeText);
    const chunkPlan = this.buildChunkPlan(snapshot, force, adapter);
    this.chunkTree = chunkPlan.chunkTree;
    this.activeChunkId = chunkPlan.activeChunkId;
    this.panel.setChunkTree(chunkPlan.chunkTree, chunkPlan.activeChunkId);
    logTrace("analysis_plan", {
      cachedChunks: chunkPlan.cachedCount,
      pendingChunks: chunkPlan.pending.length,
      activeChunkId: chunkPlan.activeChunkId,
      totalChunkSentences: chunkPlan.totalSentenceCount,
      localIssues: localIssues.length,
    });
    const signature = shortHash(
      JSON.stringify({
        scope: snapshot.scope,
        mode: this.settings.mode,
        notationStrictness: this.settings.notationStrictness,
        backendUrl: this.settings.backendUrl,
        signatures: chunkPlan.activeSignatures,
      })
    );

    if (!force && signature === this.lastAnalyzedSignature && chunkPlan.pending.length === 0) {
      return;
    }

    this.lastAnalyzedSignature = signature;
    const requestId = this.activeRequestId + 1;
    this.activeRequestId = requestId;

    const rerenderFromCache = () => {
      const cachedChunkIssues = this.collectChunkIssues(chunkPlan.activeKeys);
      const mergedIssues = this.mergeIssues(localIssues, cachedChunkIssues)
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

    this.panel.setSentenceStats(chunkPlan.cachedCount, chunkPlan.pending.length);
    this.panel.setInferenceTime(this.lastInferenceMs, chunkPlan.pending.length);
    rerenderFromCache();

    if (chunkPlan.pending.length === 0) {
      this.panel.setStatus("success", "All cached chunks are up to date.");
      this.panel.setGlobalState("ready", "global · synced");
      this.syncPopoverWithCaret();
      return;
    }

    this.panel.setGlobalState(
      "analyzing",
      `global · analyzing ${chunkPlan.pending.length} chunk${chunkPlan.pending.length === 1 ? "" : "s"}`
    );

    for (let i = 0; i < chunkPlan.pending.length; i += 1) {
      if (requestId !== this.activeRequestId) {
        return;
      }

      const chunkEntry = chunkPlan.pending[i];
      const remaining = chunkPlan.pending.length - i;
      logTrace("chunk_check_start", {
        index: i + 1,
        total: chunkPlan.pending.length,
        chunkKey: chunkEntry.key,
        chunkId: chunkEntry.chunkId,
        sentenceCount: ensureArray(chunkEntry.sentences).length,
        chars: chunkEntry.text.length,
      });
      this.panel.setStatus(
        "analyzing",
        `Analyzing chunk ${i + 1}/${chunkPlan.pending.length} (${modeToLabel(this.settings.mode)})...`
      );
      this.panel.setInferenceTime(this.lastInferenceMs, remaining);

      await this.analyzeChunkEntry(chunkEntry, snapshot, reason);
      logTrace("chunk_check_done", {
        chunkKey: chunkEntry.key,
        chunkId: chunkEntry.chunkId,
        status: chunkEntry.status,
        inferenceMs: chunkEntry.inferenceMs,
        issueCount: ensureArray(chunkEntry.issues).length,
      });

      if (requestId !== this.activeRequestId) {
        return;
      }

      const pendingLeft = chunkPlan.pending.length - i - 1;
      this.panel.setSentenceStats(chunkPlan.cachedCount, pendingLeft);
      this.panel.setInferenceTime(this.lastInferenceMs, pendingLeft);
      rerenderFromCache();
    }

    const finalIssues = ensureArray(this.lastRun?.issues);
    const hasError = finalIssues.some((issue) => normalizeSeverity(issue.severity) === "error");

    this.panel.setStatus(
      hasError ? "error" : "success",
      hasError ? "Completed with actionable feedback." : "Check complete."
    );
    this.panel.setGlobalState(hasError ? "error" : "ready", hasError ? "global · review needed" : "global · synced");

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

  buildChunkPlan(snapshot, force, adapter) {
    const scopeText = String(snapshot.text || "");
    const now = Date.now();
    const caretOffset = this.resolveCaretOffsetInScope(snapshot, adapter);
    const chunkWindow = this.resolveChunkWindow(snapshot, caretOffset);
    const chunkTree = this.buildChunkTree(
      chunkWindow.text,
      chunkWindow.caretOffset,
      chunkWindow.baseOffset
    );
    const activeKeys = [];
    const activeSignatures = [];
    const pending = [];

    for (const chunk of chunkTree.leafChunks) {
      const contextText = this.buildChunkContext(scopeText, chunk, chunkTree);
      const signature = shortHash(
        JSON.stringify({
          chunkId: chunk.chunkId,
          text: chunk.text,
          context: contextText,
          mode: this.settings.mode,
          notationStrictness: this.settings.notationStrictness,
          backendUrl: this.settings.backendUrl,
        })
      );

      let entry = this.chunkCache.get(chunk.chunkId);
      if (!entry || entry.signature !== signature) {
        entry = {
          key: chunk.chunkId,
          chunkId: chunk.chunkId,
          signature,
          text: chunk.text,
          sentences: ensureArray(chunk.sentences),
          contextText,
          start: chunk.start,
          end: chunk.end,
          status: "pending",
          issues: [],
          diagnostics: [],
          hasError: false,
          inferenceMs: null,
          updatedAt: 0,
          lastSeenAt: now,
        };
        this.chunkCache.set(chunk.chunkId, entry);
      } else {
        entry.text = chunk.text;
        entry.sentences = ensureArray(chunk.sentences);
        entry.contextText = contextText;
        entry.start = chunk.start;
        entry.end = chunk.end;
        entry.lastSeenAt = now;
      }

      const stale = now - (entry.updatedAt || 0) > CACHE_TTL_MS;
      const needsFetch = force || entry.status === "pending" || stale;
      if (needsFetch) {
        entry.status = "pending";
        pending.push(entry);
      }

      activeKeys.push(chunk.chunkId);
      activeSignatures.push(signature);
    }

    if (chunkTree.activeChunkId) {
      pending.sort((a, b) => {
        if (a.chunkId === chunkTree.activeChunkId) {
          return -1;
        }
        if (b.chunkId === chunkTree.activeChunkId) {
          return 1;
        }
        return a.start - b.start;
      });
    }

    const activeSet = new Set(activeKeys);
    for (const [key, entry] of this.chunkCache.entries()) {
      if (activeSet.has(key)) {
        continue;
      }
      if (now - (entry.lastSeenAt || 0) > 5 * 60 * 1000) {
        this.chunkCache.delete(key);
      }
    }

    return {
      chunkTree,
      activeChunkId: chunkTree.activeChunkId,
      activeKeys,
      activeSignatures,
      pending,
      cachedCount: activeKeys.length,
      totalSentenceCount: chunkTree.leafChunks.reduce(
        (sum, chunk) => sum + ensureArray(chunk.sentences).length,
        0
      ),
    };
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
    const proofs = [];

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
        proofs,
        chunkById,
        activeChunkId: null,
      };
    }

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
      const chunk = this.createChunk({
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
      return chunk;
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
      if (parentId) {
        sectionChunk.parentId = parentId;
      }
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
      if (sectionParentId) {
        envChunk.parentId = sectionParentId;
      }
    }

    for (const commandChunk of commandChunks) {
      const envParentId = this.pickContainingEnvironmentId(commandChunk, envChunks);
      if (envParentId) {
        commandChunk.parentId = envParentId;
        continue;
      }
      const sectionParentId = this.pickContainingSectionId(commandChunk, sectionChunks);
      if (sectionParentId) {
        commandChunk.parentId = sectionParentId;
      }
    }

    const structuralChunks = [...sectionChunks, ...envChunks, ...commandChunks];
    for (const chunk of structuralChunks) {
      addChunk(chunk, false);
      if (chunk.type === "environment" && String(chunk.envName || "").toLowerCase() === "proof") {
        proofs.push(chunk);
      }
    }

    const childrenByParent = new Map();
    const pushChild = (parentId, child) => {
      const key = parentId || rootId;
      const bucket = childrenByParent.get(key) || [];
      bucket.push(child);
      childrenByParent.set(key, bucket);
    };

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
    walkContainer(rootId, rootStart, rootEnd);

    if (leafChunks.length === 0) {
      addTextLeaf(rootId, rootStart, rootEnd);
    }

    chunks.sort((a, b) => (a.start || 0) - (b.start || 0));
    leafChunks.sort((a, b) => (a.start || 0) - (b.start || 0));

    const absoluteCaret = Number.isInteger(caretOffset) ? baseOffset + caretOffset : null;
    const activeChunkId = this.selectActiveChunkId(leafChunks, absoluteCaret);
    return {
      chunks,
      leafChunks,
      proofs,
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
    const regex = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*])?\s*\{[^}]*\}/g;
    const levelByName = {
      part: 0,
      chapter: 0,
      section: 1,
      subsection: 2,
      subsubsection: 3,
      paragraph: 4,
      subparagraph: 5,
    };

    let match;
    while ((match = regex.exec(source)) !== null) {
      const raw = String(match[0] || "");
      const name = String(match[1] || "").toLowerCase();
      const titleMatch = raw.match(/\{([^}]*)\}\s*$/);
      const title = titleMatch ? String(titleMatch[1] || "").trim() : "";
      const startLocal = match.index;
      const commandEndLocal = match.index + match[0].length;
      const level = levelByName[name] ?? 6;
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

      if (!envName) {
        continue;
      }
      if (normalizedEnvName === "document") {
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
    const commandSpecs = [
      { regex: /\\maketitle\b/g, commandName: "title" },
    ];
    let commandIndex = 0;

    for (const spec of commandSpecs) {
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

  splitLatexAwareSentences(text) {
    const source = String(text || "");
    const segments = [];
    if (!source.trim()) {
      return segments;
    }

    let rawStart = 0;
    let i = 0;
    let inInlineDollar = false;
    let inDoubleDollar = false;
    let inParenMath = false;
    let inBracketMath = false;
    let mathEnvDepth = 0;
    const mathEnvPattern = /^(equation|align|gather|multline|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|split|math|displaymath|eqnarray|array)\*?$/;

    const pushSegment = (rawEnd) => {
      let start = clamp(rawStart, 0, source.length);
      let end = clamp(rawEnd, 0, source.length);

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
      rawStart = rawEnd;
    };

    while (i < source.length) {
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

    pushSegment(source.length);
    if (segments.length === 0 && source.trim()) {
      const [start, end] = this.trimSpan(source, 0, source.length);
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

  buildChunkContext(scopeText, chunk, chunkTree) {
    const source = String(scopeText || "");
    let proofStart = chunk.start;

    if (chunk.parentId) {
      const proofChunk = chunkTree.chunkById.get(chunk.parentId);
      if (proofChunk) {
        proofStart = proofChunk.start;
      }
    }

    const contextStart = Math.max(0, proofStart - 2000);
    let context = source.slice(contextStart, proofStart);

    if (chunk.parentId) {
      const priorSteps = chunkTree.leafChunks
        .filter((candidate) => candidate.parentId === chunk.parentId && candidate.end <= chunk.start)
        .slice(-2)
        .map((candidate) => candidate.text.trim())
        .filter(Boolean);
      if (priorSteps.length > 0) {
        context = `${context}\n\nPrevious steps:\n${priorSteps.join("\n\n")}`;
      }
    }

    return context.slice(-7000);
  }

  collectChunkIssues(activeKeys) {
    const issues = [];
    for (const key of activeKeys) {
      const chunkEntry = this.chunkCache.get(key);
      if (!chunkEntry) {
        continue;
      }

      const chunkIssues = ensureArray(chunkEntry.issues);
      for (let i = 0; i < chunkIssues.length; i += 1) {
        const issue = chunkIssues[i];
        const startOffset = Number.isInteger(issue.start)
          ? chunkEntry.start + issue.start
          : null;
        const endOffset = Number.isInteger(issue.end)
          ? chunkEntry.start + issue.end
          : null;

        issues.push({
          ...issue,
          start: startOffset,
          end: endOffset,
          key: `${chunkEntry.key}:${issue.key || i}:${startOffset ?? "na"}`,
          chunkKey: chunkEntry.key,
          chunkId: chunkEntry.chunkId,
          chunkInferenceMs: chunkEntry.inferenceMs,
        });
      }
    }
    return issues;
  }

  async analyzeChunkEntry(chunkEntry, snapshot, reason) {
    const chunkSnapshot = {
      ...snapshot,
      text: chunkEntry.text,
      context: chunkEntry.contextText || snapshot.context,
    };

    const startedAt = performance.now();
    try {
      const responsePayload = await this.fetchWithCache(
        chunkEntry.signature,
        chunkSnapshot,
        `${reason}:chunk`
      );
      const normalized = this.normalizeBackendResponse(responsePayload, chunkEntry.text);
      chunkEntry.issues = ensureArray(normalized.issues);
      chunkEntry.diagnostics = ensureArray(normalized.diagnostics);
      chunkEntry.hasError = !!normalized.hasError;
      chunkEntry.status = "ready";
    } catch (error) {
      const message = String(error?.message || error || "Request failed.");
      chunkEntry.hasError = true;
      chunkEntry.status = "error";
      const priorIssues = ensureArray(chunkEntry.issues).filter(
        (item) => item?.id !== `chunk-error-${chunkEntry.key}`
      );
      chunkEntry.issues = [
        ...priorIssues,
        {
          id: `chunk-error-${chunkEntry.key}`,
          key: `chunk-error-${chunkEntry.key}`,
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
    } finally {
      chunkEntry.updatedAt = Date.now();
      chunkEntry.lastSeenAt = chunkEntry.updatedAt;
      chunkEntry.inferenceMs = performance.now() - startedAt;
      this.lastInferenceMs = chunkEntry.inferenceMs;
    }
  }

  async fetchWithCache(signature, snapshot, reason) {
    const cached = this.responseCache.get(signature);
    const now = Date.now();
    if (cached && now - cached.timestamp <= CACHE_TTL_MS) {
      return cached.payload;
    }

    const payload = this.buildBackendPayload(snapshot, reason);
    const response = await this.sendBackendRequest(payload);
    this.responseCache.set(signature, {
      timestamp: now,
      payload: response,
    });

    for (const [key, value] of this.responseCache.entries()) {
      if (now - value.timestamp > CACHE_TTL_MS) {
        this.responseCache.delete(key);
      }
    }

    return response;
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

  detectLocalMathTypos(scopeText) {
    const issues = [];

    const pushIssue = (start, end, message, replacement, category = "math-typo", severity = "warning") => {
      const targetText = scopeText.slice(start, end);
      const issue = {
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
        start,
        end,
        targetText,
        replacement: replacement || null,
        source: "local",
      };
      issues.push(issue);
    };

    const patternRules = [
      { regex: /==/g, replacement: "=", message: "Use '=' for Lean equality." },
      { regex: /\+\+/g, replacement: "+", message: "Duplicate '+' looks like a typo." },
      { regex: /--+/g, replacement: "-", message: "Repeated '-' may be a math typo." },
      { regex: /<=</g, replacement: "<=", message: "Malformed relation '<=<'." },
      { regex: />=>/g, replacement: ">=", message: "Malformed relation '>=>'." },
      { regex: /\^\^/g, replacement: "^", message: "Duplicate exponent marker '^' detected." },
    ];

    for (const rule of patternRules) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(scopeText)) !== null) {
        pushIssue(match.index, match.index + match[0].length, rule.message, rule.replacement);
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

    for (let i = 0; i < scopeText.length; i += 1) {
      const ch = scopeText[i];
      if (openers[ch]) {
        stack.push({ ch, index: i });
      } else if (closers[ch]) {
        const top = stack[stack.length - 1];
        if (!top || top.ch !== closers[ch]) {
          pushIssue(i, i + 1, `Unbalanced '${ch}' bracket.`, null, "math-typo", "error");
        } else {
          stack.pop();
        }
      }
    }

    for (const unclosed of stack) {
      pushIssue(
        unclosed.index,
        unclosed.index + 1,
        `Unclosed '${unclosed.ch}' bracket.`,
        null,
        "math-typo",
        "error"
      );
    }

    const dollarCount = (scopeText.match(/\$/g) || []).length;
    if (dollarCount % 2 !== 0) {
      const idx = scopeText.lastIndexOf("$");
      pushIssue(
        idx === -1 ? 0 : idx,
        idx === -1 ? 1 : idx + 1,
        "Unpaired '$' math delimiter.",
        null,
        "math-typo",
        "error"
      );
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

  addActivity(message, level = "info", undoAction = null) {
    const now = new Date();
    const entry = {
      id: `act-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
      message,
      level,
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
  }

  clearActivityHistory() {
    this.activityEntries = [];
    this.undoStack = [];
    this.panel.setActivity(this.activityEntries, false);
    this.panel.setStatus("idle", "Activity history cleared.");
  }

  async undoLastAction() {
    const action = this.undoStack.pop();
    if (!action) {
      this.panel.setActivity(this.activityEntries, false);
      this.panel.setStatus("idle", "Nothing to undo.");
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

    const score = this.computeHealthScore(issues);
    this.panel.setHealth(score);
    this.panel.setIssues(issues, this.focusedIssueIndex);

    if (this.activeAdapter && state.snapshot) {
      this.overlay.render(this.activeAdapter, issues, state.snapshot);
    } else {
      this.overlay.clear();
    }
  }

  computeHealthScore(issues) {
    let penalty = 0;
    for (const issue of ensureArray(issues)) {
      penalty += SEVERITY_WEIGHT[normalizeSeverity(issue.severity)] || SEVERITY_WEIGHT.unknown;
    }
    return clamp(100 - penalty, 0, 100);
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
