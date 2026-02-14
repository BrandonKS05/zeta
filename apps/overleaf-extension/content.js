(() => {
  "use strict";

  if (window.__zetaFrontendV4) {
    return;
  }
  if (!location.hostname.endsWith("overleaf.com")) {
    return;
  }
  window.__zetaFrontendV4 = true;

  const SETTINGS_KEY = "zetaSettings";
  const MODE_KEY = "zetaMode";
  const IGNORED_KEY = "zetaIgnoredIssueKeys";
  const CACHE_TTL_MS = 90 * 1000;
  const MAX_HIGHLIGHT_RECTS = 120;

  const DEFAULT_SETTINGS = {
    backendUrl: "http://localhost:8000/v1/lean/solve",
    mode: "auto",
    scope: "paragraph",
    checkOnType: true,
    requestTimeoutMs: 18000,
    retries: 1,
    notationStrictness: "balanced",
    panelOpen: true,
  };

  const MODE_SET = new Set(["fast", "accurate", "auto"]);
  const SCOPE_SET = new Set(["selection", "paragraph", "document"]);
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

  class AdapterBase {
    constructor(root) {
      this.root = root;
      this.cleanupFns = [];
      this.supportsInlineHighlights = false;
      this.supportsDirectRangeReplace = false;
      this.id = `${this.constructor.name}-${Math.random().toString(36).slice(2, 8)}`;
    }

    containsNode(node) {
      return !!(node && this.root && this.root.contains(node));
    }

    isConnected() {
      return !!(this.root && this.root.isConnected);
    }

    focus() {
      if (this.root?.focus) {
        this.root.focus();
      }
    }

    addCleanup(fn) {
      this.cleanupFns.push(fn);
    }

    destroy() {
      for (const fn of this.cleanupFns.splice(0)) {
        try {
          fn();
        } catch (_error) {
          // ignore cleanup failures
        }
      }
    }

    getSelectionText() {
      return "";
    }

    getScopeSnapshot(_scope) {
      return {
        scope: "document",
        text: "",
        context: "",
        sourceText: "",
        scopeStart: 0,
        scopeEnd: 0,
      };
    }

    getVisibleTextSnapshot() {
      return { text: "", segments: [], lines: [] };
    }

    getCaretOffset(_snapshot) {
      return null;
    }

    getClientRectsForRange(_start, _end, _snapshot) {
      return [];
    }

    replaceIssue(_issue, _replacement, _snapshot) {
      return false;
    }

    setupObservers(onChange, onScroll) {
      const mutationObserver = new MutationObserver(onChange);
      mutationObserver.observe(this.root, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      this.addCleanup(() => mutationObserver.disconnect());

      this.root.addEventListener("input", onChange, true);
      this.root.addEventListener("keyup", onChange, true);
      this.root.addEventListener("compositionend", onChange, true);
      this.addCleanup(() => {
        this.root.removeEventListener("input", onChange, true);
        this.root.removeEventListener("keyup", onChange, true);
        this.root.removeEventListener("compositionend", onChange, true);
      });

      this.root.addEventListener("scroll", onScroll, true);
      this.addCleanup(() => this.root.removeEventListener("scroll", onScroll, true));
    }
  }

  class TextareaAdapter extends AdapterBase {
    constructor(element) {
      super(element);
      this.element = element;
      this.supportsInlineHighlights = false;
      this.supportsDirectRangeReplace = true;
    }

    setupObservers(onChange, onScroll) {
      this.element.addEventListener("input", onChange, true);
      this.element.addEventListener("keyup", onChange, true);
      this.addCleanup(() => {
        this.element.removeEventListener("input", onChange, true);
        this.element.removeEventListener("keyup", onChange, true);
      });

      this.element.addEventListener("scroll", onScroll, true);
      this.addCleanup(() => this.element.removeEventListener("scroll", onScroll, true));
    }

    getSelectionText() {
      const start = this.element.selectionStart || 0;
      const end = this.element.selectionEnd || 0;
      if (end <= start) {
        return "";
      }
      return this.element.value.slice(start, end);
    }

    getScopeSnapshot(scope) {
      const sourceText = this.element.value || "";
      const cursor = this.element.selectionStart || 0;
      const selStart = this.element.selectionStart || 0;
      const selEnd = this.element.selectionEnd || 0;

      let scopeStart = 0;
      let scopeEnd = sourceText.length;
      let scopeName = normalizeScope(scope);

      if (scopeName === "selection" && selEnd > selStart) {
        scopeStart = selStart;
        scopeEnd = selEnd;
      } else if (scopeName === "paragraph") {
        const left = sourceText.lastIndexOf("\n", Math.max(0, cursor - 1));
        const right = sourceText.indexOf("\n", cursor);
        scopeStart = left === -1 ? 0 : left + 1;
        scopeEnd = right === -1 ? sourceText.length : right;
      } else if (scopeName === "selection") {
        scopeName = "paragraph";
        const left = sourceText.lastIndexOf("\n", Math.max(0, cursor - 1));
        const right = sourceText.indexOf("\n", cursor);
        scopeStart = left === -1 ? 0 : left + 1;
        scopeEnd = right === -1 ? sourceText.length : right;
      }

      return {
        scope: scopeName,
        text: sourceText.slice(scopeStart, scopeEnd),
        context: sourceText,
        sourceText,
        scopeStart,
        scopeEnd,
        selectionStart: selStart,
        selectionEnd: selEnd,
      };
    }

    getCaretOffset() {
      return this.element.selectionStart || 0;
    }

    replaceIssue(issue, replacement, snapshot) {
      if (!replacement) {
        return false;
      }

      if (Number.isInteger(issue.start) && Number.isInteger(issue.end)) {
        const start = snapshot.scopeStart + issue.start;
        const end = snapshot.scopeStart + issue.end;
        this.element.setSelectionRange(start, end);
        this.element.setRangeText(replacement, start, end, "end");
        this.element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return true;
      }

      if (issue.targetText) {
        const idx = this.element.value.indexOf(issue.targetText);
        if (idx !== -1) {
          this.element.setSelectionRange(idx, idx + issue.targetText.length);
          this.element.setRangeText(replacement, idx, idx + issue.targetText.length, "end");
          this.element.dispatchEvent(new InputEvent("input", { bubbles: true }));
          return true;
        }
      }

      return false;
    }
  }

  class DomLineAdapter extends AdapterBase {
    constructor(root, content, lineSelector, scroller) {
      super(root);
      this.content = content;
      this.lineSelector = lineSelector;
      this.scroller = scroller || root;
      this.supportsInlineHighlights = true;
      this.supportsDirectRangeReplace = true;
    }

    setupObservers(onChange, onScroll) {
      const mutationObserver = new MutationObserver(onChange);
      mutationObserver.observe(this.content, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      this.addCleanup(() => mutationObserver.disconnect());

      this.content.addEventListener("input", onChange, true);
      this.content.addEventListener("keyup", onChange, true);
      this.content.addEventListener("compositionend", onChange, true);
      this.addCleanup(() => {
        this.content.removeEventListener("input", onChange, true);
        this.content.removeEventListener("keyup", onChange, true);
        this.content.removeEventListener("compositionend", onChange, true);
      });

      this.scroller.addEventListener("scroll", onScroll, { passive: true });
      this.addCleanup(() => this.scroller.removeEventListener("scroll", onScroll));
    }

    focus() {
      if (this.content?.focus) {
        this.content.focus();
      } else {
        super.focus();
      }
    }

    getSelectionText() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        return "";
      }
      const anchor = selection.anchorNode;
      if (!anchor || !this.content.contains(anchor)) {
        return "";
      }
      return String(selection.toString() || "");
    }

    getVisibleTextSnapshot() {
      const lines = Array.from(this.content.querySelectorAll(this.lineSelector));
      const snapshot = {
        text: "",
        segments: [],
        lines: [],
      };

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const lineStart = snapshot.text.length;

        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            return node.nodeValue && node.nodeValue.length > 0
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          },
        });

        let node = walker.nextNode();
        while (node) {
          const start = snapshot.text.length;
          const value = node.nodeValue || "";
          snapshot.text += value;
          snapshot.segments.push({ node, start, end: snapshot.text.length });
          node = walker.nextNode();
        }

        const lineEnd = snapshot.text.length;
        snapshot.lines.push({
          element: line,
          start: lineStart,
          end: lineEnd,
          text: snapshot.text.slice(lineStart, lineEnd),
        });

        if (i < lines.length - 1) {
          snapshot.text += "\n";
        }
      }

      return snapshot;
    }

    getCaretOffset(snapshot) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
        return null;
      }

      const anchorNode = selection.anchorNode;
      if (!anchorNode || !this.content.contains(anchorNode)) {
        return null;
      }

      const range = document.createRange();
      range.selectNodeContents(this.content);
      try {
        range.setEnd(anchorNode, selection.anchorOffset);
      } catch (_error) {
        return null;
      }

      const textBefore = String(range.toString() || "");
      return clamp(textBefore.length, 0, snapshot.text.length);
    }

    getScopeSnapshot(scope) {
      const snap = this.getVisibleTextSnapshot();
      const selected = this.getSelectionText().trim();
      const selection = window.getSelection();
      const scopeName = normalizeScope(scope);

      const caretOffset = this.getCaretOffset(snap) ?? 0;
      let scopeStart = 0;
      let scopeEnd = snap.text.length;
      let resolvedScope = scopeName;

      if (scopeName === "selection" && selected.length > 0) {
        const guess = snap.text.indexOf(selected);
        if (guess !== -1) {
          scopeStart = guess;
          scopeEnd = guess + selected.length;
        }
      } else if (scopeName === "paragraph" || scopeName === "selection") {
        if (scopeName === "selection") {
          resolvedScope = "paragraph";
        }
        const line = snap.lines.find((candidate) => {
          return caretOffset >= candidate.start && caretOffset <= candidate.end;
        }) || snap.lines[0];
        if (line) {
          scopeStart = line.start;
          scopeEnd = line.end;
        }
      }

      if (!selection || selection.rangeCount === 0) {
        resolvedScope = "document";
      }

      return {
        scope: resolvedScope,
        text: snap.text.slice(scopeStart, scopeEnd),
        context: snap.text,
        sourceText: snap.text,
        scopeStart,
        scopeEnd,
      };
    }

    locateBoundary(snapshot, offset) {
      const clamped = clamp(offset, 0, snapshot.text.length);
      for (const seg of snapshot.segments) {
        if (clamped >= seg.start && clamped <= seg.end) {
          return {
            node: seg.node,
            offset: clamp(clamped - seg.start, 0, (seg.node.nodeValue || "").length),
          };
        }
      }
      const last = snapshot.segments[snapshot.segments.length - 1];
      if (last) {
        return { node: last.node, offset: (last.node.nodeValue || "").length };
      }
      return null;
    }

    getClientRectsForRange(start, end, snapshot) {
      const rects = [];
      const rangeStart = this.locateBoundary(snapshot, start);
      const rangeEnd = this.locateBoundary(snapshot, end);
      if (!rangeStart || !rangeEnd) {
        return rects;
      }

      const range = document.createRange();
      try {
        range.setStart(rangeStart.node, rangeStart.offset);
        range.setEnd(rangeEnd.node, rangeEnd.offset);
      } catch (_error) {
        return rects;
      }

      const scrollerRect = this.scroller.getBoundingClientRect();
      for (const rect of range.getClientRects()) {
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.bottom < scrollerRect.top ||
          rect.top > scrollerRect.bottom
        ) {
          continue;
        }
        rects.push(rect);
      }

      return rects;
    }

    replaceIssue(issue, replacement, snapshot) {
      if (!replacement) {
        return false;
      }

      const current = this.getVisibleTextSnapshot();
      let start = null;
      let end = null;

      if (Number.isInteger(issue.start) && Number.isInteger(issue.end)) {
        start = snapshot.scopeStart + issue.start;
        end = snapshot.scopeStart + issue.end;
      } else if (issue.targetText) {
        const idx = current.text.indexOf(issue.targetText);
        if (idx !== -1) {
          start = idx;
          end = idx + issue.targetText.length;
        }
      }

      if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
        return false;
      }

      const startBoundary = this.locateBoundary(current, start);
      const endBoundary = this.locateBoundary(current, end);
      if (!startBoundary || !endBoundary) {
        return false;
      }

      const range = document.createRange();
      try {
        range.setStart(startBoundary.node, startBoundary.offset);
        range.setEnd(endBoundary.node, endBoundary.offset);
      } catch (_error) {
        return false;
      }

      this.focus();
      const selection = window.getSelection();
      if (!selection) {
        return false;
      }
      selection.removeAllRanges();
      selection.addRange(range);

      let replaced = false;
      if (typeof document.execCommand === "function") {
        replaced = document.execCommand("insertText", false, replacement);
      }

      if (!replaced) {
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
      }

      selection.removeAllRanges();
      this.content.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    }
  }

  class ContentEditableAdapter extends DomLineAdapter {
    constructor(root) {
      super(root, root, "[data-zeta-line], p, div, li, span", root);
      this.supportsInlineHighlights = true;
    }

    getVisibleTextSnapshot() {
      const snapshot = {
        text: "",
        segments: [],
        lines: [],
      };

      const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.nodeValue && node.nodeValue.length > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });

      let node = walker.nextNode();
      while (node) {
        const start = snapshot.text.length;
        const value = node.nodeValue || "";
        snapshot.text += value;
        snapshot.segments.push({ node, start, end: snapshot.text.length });
        node = walker.nextNode();
      }

      snapshot.lines.push({
        element: this.content,
        start: 0,
        end: snapshot.text.length,
        text: snapshot.text,
      });

      return snapshot;
    }
  }

  class ZetaOverlay {
    constructor() {
      this.layer = document.createElement("div");
      this.layer.className = "zeta-highlight-layer";
      document.body.appendChild(this.layer);
      this.rectIssueMap = [];
    }

    clear() {
      this.layer.replaceChildren();
      this.rectIssueMap = [];
    }

    render(adapter, issues, snapshot) {
      this.clear();
      if (!adapter || !adapter.supportsInlineHighlights) {
        return;
      }

      const renderedRects = [];
      const sourceText = snapshot.sourceText;

      for (const issue of issues) {
        if (renderedRects.length >= MAX_HIGHLIGHT_RECTS) {
          break;
        }

        const ranges = this.resolveRanges(issue, snapshot, sourceText);
        for (const [start, end] of ranges) {
          const rects = adapter.getClientRectsForRange(start, end, adapter.getVisibleTextSnapshot());
          for (const rect of rects) {
            if (renderedRects.length >= MAX_HIGHLIGHT_RECTS) {
              break;
            }
            const marker = document.createElement("div");
            marker.className = `zeta-highlight zeta-highlight--${issue.severity}`;
            marker.style.left = `${rect.left}px`;
            marker.style.top = `${rect.top}px`;
            marker.style.width = `${rect.width}px`;
            marker.style.height = `${Math.max(rect.height, 15)}px`;
            this.layer.appendChild(marker);
            renderedRects.push({
              issue,
              rect: {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              },
            });
          }
        }
      }

      this.rectIssueMap = renderedRects;
    }

    resolveRanges(issue, snapshot, sourceText) {
      const ranges = [];
      if (Number.isInteger(issue.start) && Number.isInteger(issue.end)) {
        ranges.push([snapshot.scopeStart + issue.start, snapshot.scopeStart + issue.end]);
        return ranges;
      }

      if (!issue.targetText) {
        return ranges;
      }

      const target = issue.targetText.trim();
      if (!target) {
        return ranges;
      }

      let index = sourceText.indexOf(target, snapshot.scopeStart);
      while (index !== -1) {
        if (index > snapshot.scopeEnd) {
          break;
        }
        ranges.push([index, index + target.length]);
        if (ranges.length >= 3) {
          break;
        }
        index = sourceText.indexOf(target, index + target.length);
      }

      return ranges;
    }

    findIssueAtPoint(clientX, clientY) {
      for (const row of this.rectIssueMap) {
        const rect = row.rect;
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return row;
        }
      }
      return null;
    }

    remove() {
      this.layer.remove();
    }
  }

  class ZetaPopover {
    constructor(onApply, onIgnore) {
      this.onApply = onApply;
      this.onIgnore = onIgnore;
      this.element = null;
      this.currentIssue = null;

      this.boundOutside = this.handleOutside.bind(this);
      this.boundEsc = this.handleEsc.bind(this);
    }

    open(issue, anchorRect) {
      this.close();
      this.currentIssue = issue;

      const element = document.createElement("div");
      element.className = "zeta-suggestion-popover";

      const title = document.createElement("p");
      title.className = "zeta-suggestion-title";
      title.textContent = issue.message;
      element.appendChild(title);

      const list = document.createElement("div");
      list.className = "zeta-suggestion-list";

      if (issue.replacement) {
        const applyBtn = document.createElement("button");
        applyBtn.type = "button";
        applyBtn.className = "zeta-suggestion-option";
        applyBtn.innerHTML = `<strong>Apply replacement</strong><span>${issue.replacement}</span>`;
        applyBtn.addEventListener("click", (event) => {
          event.preventDefault();
          this.onApply(issue);
          this.close();
        });
        list.appendChild(applyBtn);
      }

      const ignoreBtn = document.createElement("button");
      ignoreBtn.type = "button";
      ignoreBtn.className = "zeta-suggestion-option";
      ignoreBtn.innerHTML = "<strong>Ignore this issue</strong><span>Hide this rule hit in this project.</span>";
      ignoreBtn.addEventListener("click", (event) => {
        event.preventDefault();
        this.onIgnore(issue);
        this.close();
      });
      list.appendChild(ignoreBtn);

      element.appendChild(list);
      document.body.appendChild(element);
      this.element = element;
      this.position(anchorRect);

      document.addEventListener("pointerdown", this.boundOutside, true);
      document.addEventListener("keydown", this.boundEsc, true);
      window.addEventListener("resize", this.boundEsc);
      window.addEventListener("scroll", this.boundEsc, true);
    }

    position(anchorRect) {
      if (!this.element || !anchorRect) {
        return;
      }

      const margin = 10;
      const width = this.element.offsetWidth;
      const height = this.element.offsetHeight;

      let left = anchorRect.left;
      let top = anchorRect.bottom + 8;

      if (left + width > window.innerWidth - margin) {
        left = window.innerWidth - width - margin;
      }
      if (left < margin) {
        left = margin;
      }

      if (top + height > window.innerHeight - margin) {
        top = anchorRect.top - height - 8;
      }
      if (top < margin) {
        top = margin;
      }

      this.element.style.left = `${Math.round(left)}px`;
      this.element.style.top = `${Math.round(top)}px`;
    }

    handleOutside(event) {
      if (!this.element) {
        return;
      }
      const target = event.target;
      if (target instanceof Element && target.closest(".zeta-suggestion-popover")) {
        return;
      }
      this.close();
    }

    handleEsc(event) {
      if (event instanceof KeyboardEvent && event.key !== "Escape") {
        return;
      }
      this.close();
    }

    close() {
      if (!this.element) {
        this.currentIssue = null;
        return;
      }

      this.element.remove();
      this.element = null;
      this.currentIssue = null;

      document.removeEventListener("pointerdown", this.boundOutside, true);
      document.removeEventListener("keydown", this.boundEsc, true);
      window.removeEventListener("resize", this.boundEsc);
      window.removeEventListener("scroll", this.boundEsc, true);
    }
  }

  class ZetaPanel {
    constructor(handlers) {
      this.handlers = handlers;
      this.root = document.createElement("aside");
      this.root.className = "zeta-shell";
      this.root.setAttribute("role", "complementary");
      this.root.setAttribute("aria-label", "zeta math checker panel");

      this.fab = document.createElement("button");
      this.fab.type = "button";
      this.fab.className = "zeta-fab";
      this.fab.setAttribute("aria-label", "Toggle zeta panel");
      this.fab.innerHTML = `<img src="${chrome.runtime.getURL("assets/icon-128.png")}" alt="zeta" />`;

      this.root.innerHTML = `
        <header class="zeta-header">
          <div class="zeta-brand">
            <img class="zeta-brand-logo" src="${chrome.runtime.getURL("assets/icon-128.png")}" alt="zeta" />
            <div>
              <h2>zeta</h2>
              <p>Grammarly for Math</p>
            </div>
          </div>
          <div class="zeta-status-row">
            <div class="zeta-status">
              <span id="zeta-status-dot" class="zeta-status-dot"></span>
              <span id="zeta-status-text">Idle</span>
            </div>
            <div class="zeta-header-actions">
              <button type="button" id="zeta-run-btn" class="zeta-icon-btn">Check</button>
              <button type="button" id="zeta-settings-btn" class="zeta-icon-btn">Settings</button>
              <button type="button" id="zeta-collapse-btn" class="zeta-icon-btn">Hide</button>
            </div>
          </div>
        </header>
        <section class="zeta-toolbar">
          <div class="zeta-field">
            <label for="zeta-scope-select">Scope</label>
            <select id="zeta-scope-select">
              <option value="selection">Selection</option>
              <option value="paragraph">Paragraph</option>
              <option value="document">Document</option>
            </select>
          </div>
          <div class="zeta-field">
            <label>Mode</label>
            <div class="zeta-mode-toggle" role="tablist" aria-label="zeta mode">
              <button type="button" class="zeta-mode-btn" data-mode="fast">fast</button>
              <button type="button" class="zeta-mode-btn" data-mode="accurate">accurate</button>
              <button type="button" class="zeta-mode-btn" data-mode="auto">auto</button>
            </div>
          </div>
        </section>
        <div class="zeta-content">
          <section class="zeta-card">
            <h3>Document Health</h3>
            <div class="zeta-health">
              <div class="zeta-health-meter"><span id="zeta-health-fill"></span></div>
              <span id="zeta-health-label">100</span>
            </div>
            <div class="zeta-item-actions" style="margin-top:8px">
              <button type="button" id="zeta-regenerate-btn" class="zeta-btn">Regenerate</button>
              <button type="button" id="zeta-next-btn" class="zeta-btn">Next Issue</button>
              <button type="button" id="zeta-prev-btn" class="zeta-btn">Prev Issue</button>
            </div>
          </section>
          <section class="zeta-card">
            <h3>Activity & History</h3>
            <div class="zeta-item-actions">
              <button type="button" id="zeta-undo-btn" class="zeta-btn">Undo Last</button>
              <button type="button" id="zeta-clear-history-btn" class="zeta-btn">Clear</button>
            </div>
            <ul id="zeta-activity" class="zeta-list"></ul>
            <p id="zeta-activity-empty" class="zeta-empty">No activity yet.</p>
          </section>
          <section class="zeta-card">
            <h3>Compiler Diagnostics</h3>
            <ul id="zeta-diagnostics" class="zeta-list"></ul>
            <p id="zeta-diagnostics-empty" class="zeta-empty">No diagnostics.</p>
          </section>
          <section class="zeta-card">
            <h3>Math Typos & Suggestions</h3>
            <ul id="zeta-issues" class="zeta-list"></ul>
            <p id="zeta-issues-empty" class="zeta-empty">No issues found.</p>
          </section>
          <section id="zeta-settings-card" class="zeta-card" style="display:none">
            <h3>Settings</h3>
            <div class="zeta-settings">
              <div class="zeta-field">
                <label for="zeta-backend-url">Backend URL</label>
                <input id="zeta-backend-url" type="text" />
              </div>
              <div class="zeta-field">
                <label for="zeta-timeout">Timeout (ms)</label>
                <input id="zeta-timeout" type="number" min="2000" step="500" />
              </div>
              <div class="zeta-field">
                <label for="zeta-retries">Retries</label>
                <input id="zeta-retries" type="number" min="0" max="4" step="1" />
              </div>
              <div class="zeta-settings-row">
                <span>Check on typing</span>
                <input id="zeta-check-on-type" type="checkbox" />
              </div>
              <div class="zeta-field">
                <label for="zeta-notation">Notation strictness</label>
                <select id="zeta-notation">
                  <option value="relaxed">Relaxed</option>
                  <option value="balanced">Balanced</option>
                  <option value="strict">Strict</option>
                </select>
              </div>
              <button type="button" id="zeta-save-settings" class="zeta-btn zeta-btn--primary">Save Settings</button>
            </div>
            <ul class="zeta-shortcuts">
              <li><code>Alt+Shift+Z</code> toggle panel</li>
              <li><code>Alt+Shift+N</code> next issue</li>
              <li><code>Alt+Shift+P</code> previous issue</li>
              <li><code>Ctrl/Cmd+Enter</code> run check now</li>
              <li><code>Alt+Shift+A</code> apply focused replacement</li>
              <li><code>Alt+Shift+U</code> undo last action</li>
            </ul>
          </section>
        </div>
      `;

      document.body.append(this.root, this.fab);

      this.refs = {
        statusDot: this.root.querySelector("#zeta-status-dot"),
        statusText: this.root.querySelector("#zeta-status-text"),
        scopeSelect: this.root.querySelector("#zeta-scope-select"),
        modeButtons: Array.from(this.root.querySelectorAll(".zeta-mode-btn")),
        healthFill: this.root.querySelector("#zeta-health-fill"),
        healthLabel: this.root.querySelector("#zeta-health-label"),
        activity: this.root.querySelector("#zeta-activity"),
        activityEmpty: this.root.querySelector("#zeta-activity-empty"),
        diagnostics: this.root.querySelector("#zeta-diagnostics"),
        diagnosticsEmpty: this.root.querySelector("#zeta-diagnostics-empty"),
        issues: this.root.querySelector("#zeta-issues"),
        issuesEmpty: this.root.querySelector("#zeta-issues-empty"),
        runBtn: this.root.querySelector("#zeta-run-btn"),
        regenerateBtn: this.root.querySelector("#zeta-regenerate-btn"),
        nextBtn: this.root.querySelector("#zeta-next-btn"),
        prevBtn: this.root.querySelector("#zeta-prev-btn"),
        undoBtn: this.root.querySelector("#zeta-undo-btn"),
        clearHistoryBtn: this.root.querySelector("#zeta-clear-history-btn"),
        settingsBtn: this.root.querySelector("#zeta-settings-btn"),
        settingsCard: this.root.querySelector("#zeta-settings-card"),
        collapseBtn: this.root.querySelector("#zeta-collapse-btn"),
        backendUrl: this.root.querySelector("#zeta-backend-url"),
        timeout: this.root.querySelector("#zeta-timeout"),
        retries: this.root.querySelector("#zeta-retries"),
        checkOnType: this.root.querySelector("#zeta-check-on-type"),
        notation: this.root.querySelector("#zeta-notation"),
        saveSettings: this.root.querySelector("#zeta-save-settings"),
      };

      this.isSettingsOpen = false;
      this.bindEvents();
    }

    bindEvents() {
      this.fab.addEventListener("click", () => this.handlers.onTogglePanel());
      this.refs.collapseBtn.addEventListener("click", () => this.handlers.onTogglePanel(false));
      this.refs.runBtn.addEventListener("click", () => this.handlers.onRunNow());
      this.refs.regenerateBtn.addEventListener("click", () => this.handlers.onRegenerate());
      this.refs.undoBtn.addEventListener("click", () => this.handlers.onUndoLast());
      this.refs.clearHistoryBtn.addEventListener("click", () => this.handlers.onClearHistory());
      this.refs.nextBtn.addEventListener("click", () => this.handlers.onNextIssue());
      this.refs.prevBtn.addEventListener("click", () => this.handlers.onPrevIssue());

      this.refs.scopeSelect.addEventListener("change", () => {
        this.handlers.onScopeChange(this.refs.scopeSelect.value);
      });

      for (const button of this.refs.modeButtons) {
        button.addEventListener("click", () => {
          this.handlers.onModeChange(button.dataset.mode || "auto");
        });
      }

      this.refs.settingsBtn.addEventListener("click", () => {
        this.isSettingsOpen = !this.isSettingsOpen;
        this.refs.settingsCard.style.display = this.isSettingsOpen ? "block" : "none";
      });

      this.refs.saveSettings.addEventListener("click", () => {
        this.handlers.onSaveSettings({
          backendUrl: this.refs.backendUrl.value.trim(),
          requestTimeoutMs: Number(this.refs.timeout.value),
          retries: Number(this.refs.retries.value),
          checkOnType: this.refs.checkOnType.checked,
          notationStrictness: this.refs.notation.value,
        });
      });

      this.refs.issues.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) {
          return;
        }

        const item = target.closest(".zeta-item");
        if (!item) {
          return;
        }

        const index = Number(item.getAttribute("data-issue-index"));
        if (!Number.isFinite(index)) {
          return;
        }

        if (target.closest("[data-action='apply']")) {
          this.handlers.onApplyIssue(index);
          return;
        }

        if (target.closest("[data-action='ignore']")) {
          this.handlers.onIgnoreIssue(index);
          return;
        }

        this.handlers.onFocusIssue(index);
      });
    }

    setOpen(open) {
      this.root.classList.toggle("is-collapsed", !open);
    }

    setStatus(phase, message) {
      const dot = this.refs.statusDot;
      dot.classList.remove("is-analyzing", "is-success", "is-error");
      if (phase === "analyzing") {
        dot.classList.add("is-analyzing");
      } else if (phase === "success") {
        dot.classList.add("is-success");
      } else if (phase === "error") {
        dot.classList.add("is-error");
      }
      this.refs.statusText.textContent = message;
    }

    setMode(mode) {
      for (const button of this.refs.modeButtons) {
        button.classList.toggle("is-active", button.dataset.mode === mode);
      }
    }

    setScope(scope) {
      this.refs.scopeSelect.value = scope;
    }

    setHealth(score) {
      const clamped = clamp(Math.round(score), 0, 100);
      this.refs.healthFill.style.width = `${clamped}%`;
      this.refs.healthLabel.textContent = `${clamped}`;
    }

    setActivity(entries, canUndo) {
      const list = this.refs.activity;
      list.replaceChildren();
      const items = ensureArray(entries);

      for (const entry of items) {
        const li = document.createElement("li");
        li.className = "zeta-activity-item";
        li.setAttribute("data-level", entry.level || "info");
        li.innerHTML = `<strong>${entry.message}</strong><p>${entry.timeLabel || ""}</p>`;
        list.appendChild(li);
      }

      this.refs.activityEmpty.style.display = items.length > 0 ? "none" : "block";
      this.refs.undoBtn.disabled = !canUndo;
    }

    setDiagnostics(diagnostics) {
      const list = this.refs.diagnostics;
      list.replaceChildren();
      const items = ensureArray(diagnostics);
      for (const diag of items) {
        const li = document.createElement("li");
        li.className = "zeta-item";
        li.setAttribute("data-severity", normalizeSeverity(diag.severity));
        const location =
          Number.isInteger(diag.line) && Number.isInteger(diag.column)
            ? ` (L${diag.line}:C${diag.column})`
            : "";
        li.innerHTML = `<strong>${normalizeSeverity(diag.severity)}${location}</strong><p>${diag.message || "Diagnostic"}</p>`;
        list.appendChild(li);
      }
      this.refs.diagnosticsEmpty.style.display = items.length > 0 ? "none" : "block";
    }

    setIssues(issues, focusedIndex) {
      const list = this.refs.issues;
      list.replaceChildren();
      const items = ensureArray(issues);
      for (let i = 0; i < items.length; i += 1) {
        const issue = items[i];
        const li = document.createElement("li");
        li.className = "zeta-item";
        li.setAttribute("data-severity", normalizeSeverity(issue.severity));
        li.setAttribute("data-issue-index", String(i));
        if (i === focusedIndex) {
          li.style.outline = "2px solid #8c1515";
        }

        const targetLabel = issue.targetText ? ` · ${issue.targetText}` : "";
        li.innerHTML = `<strong>${issue.category || "issue"}${targetLabel}</strong><p>${issue.message || "Review this issue."}</p>`;

        const actionRow = document.createElement("div");
        actionRow.className = "zeta-item-actions";

        if (issue.replacement) {
          const applyBtn = document.createElement("button");
          applyBtn.type = "button";
          applyBtn.className = "zeta-btn";
          applyBtn.setAttribute("data-action", "apply");
          applyBtn.textContent = "Apply";
          actionRow.appendChild(applyBtn);
        }

        const ignoreBtn = document.createElement("button");
        ignoreBtn.type = "button";
        ignoreBtn.className = "zeta-btn";
        ignoreBtn.setAttribute("data-action", "ignore");
        ignoreBtn.textContent = "Ignore";
        actionRow.appendChild(ignoreBtn);

        li.appendChild(actionRow);
        list.appendChild(li);
      }

      this.refs.issuesEmpty.style.display = items.length > 0 ? "none" : "block";
    }

    setSettings(settings) {
      this.refs.backendUrl.value = settings.backendUrl;
      this.refs.timeout.value = String(settings.requestTimeoutMs);
      this.refs.retries.value = String(settings.retries);
      this.refs.checkOnType.checked = !!settings.checkOnType;
      this.refs.notation.value = settings.notationStrictness;
      this.setMode(settings.mode);
      this.setScope(settings.scope);
    }

    scrollIssueIntoView(index) {
      const target = this.refs.issues.querySelector(`[data-issue-index='${index}']`);
      if (target) {
        target.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    remove() {
      this.root.remove();
      this.fab.remove();
    }
  }

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
      this.panel.setHealth(100);
      this.panel.setActivity(this.activityEntries, false);

      this.refreshAdapters();
      this.activateInitialAdapter();
      this.attachGlobalListeners();

      if (this.activeAdapter) {
        this.scheduleAnalysis("init", true);
      } else {
        this.panel.setStatus("idle", "Focus a text editor to start.");
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

    async runAnalysis(reason, force = false) {
      const adapter = this.activeAdapter;
      if (!adapter || !adapter.isConnected()) {
        this.panel.setStatus("error", "No active editor.");
        return;
      }

      const snapshot = adapter.getScopeSnapshot(this.settings.scope);
      const text = String(snapshot.text || "").trim();
      if (!text) {
        this.lastRun = {
          snapshot,
          diagnostics: [],
          issues: [],
        };
        this.panel.setStatus("idle", "Nothing to analyze in this scope.");
        this.panel.setDiagnostics([]);
        this.panel.setIssues([], -1);
        this.panel.setHealth(100);
        this.overlay.clear();
        this.popover.close();
        return;
      }

      const signature = shortHash(JSON.stringify({
        text,
        scope: snapshot.scope,
        mode: this.settings.mode,
        notationStrictness: this.settings.notationStrictness,
        backendUrl: this.settings.backendUrl,
      }));

      if (!force && signature === this.lastAnalyzedSignature) {
        return;
      }

      this.lastAnalyzedSignature = signature;
      const requestId = this.activeRequestId + 1;
      this.activeRequestId = requestId;

      this.panel.setStatus("analyzing", `Analyzing (${modeToLabel(this.settings.mode)})...`);

      const localIssues = this.detectLocalMathTypos(snapshot.text);
      this.renderState({
        snapshot,
        diagnostics: [],
        issues: localIssues,
      });

      let responsePayload = null;
      try {
        responsePayload = await this.fetchWithCache(signature, snapshot, reason);
      } catch (error) {
        if (requestId !== this.activeRequestId) {
          return;
        }
        const message = String(error?.message || error || "Request failed.");
        this.panel.setStatus("error", message);
        if (reason !== "typing") {
          this.addActivity(`Check failed: ${message}`, "error");
        }
        this.renderState({
          snapshot,
          diagnostics: [],
          issues: localIssues,
        });
        return;
      }

      if (requestId !== this.activeRequestId) {
        return;
      }

      const normalized = this.normalizeBackendResponse(responsePayload, snapshot.text);
      const mergedIssues = this.mergeIssues(localIssues, normalized.issues)
        .filter((issue) => !this.ignoredKeys.has(issue.key));

      this.lastRun = {
        snapshot,
        diagnostics: normalized.diagnostics,
        issues: mergedIssues,
      };
      this.focusedIssueIndex = mergedIssues.length === 0 ? -1 : 0;

      this.renderState(this.lastRun);
      this.panel.setStatus(
        normalized.hasError ? "error" : "success",
        normalized.hasError
          ? `Completed with ${normalized.diagnostics.length} diagnostics`
          : "Lean check complete"
      );
      if (reason !== "typing" || normalized.hasError) {
        this.addActivity(
          normalized.hasError
            ? `Completed check with ${normalized.diagnostics.length} diagnostics and ${mergedIssues.length} suggestions.`
            : `Completed check with ${mergedIssues.length} suggestions.`,
          normalized.hasError ? "error" : "success"
        );
      }

      this.syncPopoverWithCaret();
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

    async sendBackendRequest(request) {
      const attempts = Math.max(0, Number(this.settings.retries) || 0) + 1;
      let lastError = null;

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const response = await this.sendHttpMessage({
            url: request.requestUrl,
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.requestBody),
            timeoutMs: this.settings.requestTimeoutMs,
          });

          if (!response.ok) {
            const detail = response.json?.detail || response.text || response.statusText || "Request failed";
            throw new Error(`Backend ${response.status || "error"}: ${detail}`);
          }

          if (!response.json) {
            throw new Error("Backend returned non-JSON response.");
          }

          return response.json;
        } catch (error) {
          lastError = error;
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
      const diagnostics = ensureArray(state.diagnostics);

      const score = this.computeHealthScore(issues);
      this.panel.setHealth(score);
      this.panel.setDiagnostics(diagnostics);
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

  const app = new ZetaApp();
  app.init();

  window.__zetaDestroy = () => {
    app.destroy();
    delete window.__zetaFrontendV4;
  };
})();
