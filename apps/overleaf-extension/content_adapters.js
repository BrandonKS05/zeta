(() => {
  "use strict";

  const zeta = window.__zetaContent || (window.__zetaContent = {});
  const { clamp, normalizeScope, extractText } = zeta;

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

  getDocumentSnapshot() {
    return null;
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

  insertAtCaret(_text) {
    return false;
  }

  getCaretClientRect(_snapshot) {
    return null;
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

  getDocumentSnapshot() {
    const sourceText = String(this.element?.value || "");
    const caret = Number.isInteger(this.element?.selectionStart) ? this.element.selectionStart : 0;
    return {
      scope: "document",
      text: sourceText,
      context: sourceText,
      sourceText,
      scopeStart: 0,
      scopeEnd: sourceText.length,
      caretOffset: clamp(caret, 0, sourceText.length),
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

  insertAtCaret(text) {
    const value = String(text || "");
    if (!value) {
      return false;
    }
    const start = this.element.selectionStart || 0;
    const end = this.element.selectionEnd || start;
    this.element.focus();
    this.element.setSelectionRange(start, end);
    this.element.setRangeText(value, start, end, "end");
    this.element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return true;
  }
}

class DomLineAdapter extends AdapterBase {
  constructor(root, content, lineSelector, scroller, editorKind = "dom") {
    super(root);
    this.content = content;
    this.lineSelector = lineSelector;
    this.scroller = scroller || root;
    this.editorKind = String(editorKind || "dom").toLowerCase();
    this.supportsInlineHighlights = true;
    this.supportsDirectRangeReplace = true;
  }

  getDocumentSnapshot() {
    const sourceText = this.getDocumentSourceText();
    if (typeof sourceText !== "string") {
      return null;
    }
    const caretOffset = this.getDocumentCaretOffset(sourceText);
    return {
      scope: "document",
      text: sourceText,
      context: sourceText,
      sourceText,
      scopeStart: 0,
      scopeEnd: sourceText.length,
      caretOffset: Number.isInteger(caretOffset) ? clamp(caretOffset, 0, sourceText.length) : null,
    };
  }

  getDocumentSourceText() {
    if (this.editorKind === "cm") {
      const view = this.resolveCodeMirrorView();
      const doc = view?.state?.doc;
      if (doc && typeof doc.toString === "function") {
        try {
          return String(doc.toString() || "");
        } catch (_error) {
          // fall through to DOM snapshot
        }
      }
    }

    if (this.editorKind === "ace") {
      const editor = this.resolveAceEditor();
      if (editor && typeof editor.getValue === "function") {
        try {
          return String(editor.getValue() || "");
        } catch (_error) {
          // fall through to DOM snapshot
        }
      }
    }

    return String(this.getVisibleTextSnapshot().text || "");
  }

  getDocumentCaretOffset(sourceText = "") {
    if (this.editorKind === "cm") {
      const view = this.resolveCodeMirrorView();
      const selection = view?.state?.selection;
      const main = selection?.main;
      if (main && Number.isInteger(main.head)) {
        return clamp(main.head, 0, String(sourceText || "").length);
      }
    }

    if (this.editorKind === "ace") {
      const editor = this.resolveAceEditor();
      const selection = editor?.selection;
      if (selection && typeof selection.getCursor === "function") {
        const cursor = selection.getCursor();
        const index = this.acePositionToIndex(editor, cursor, sourceText);
        if (Number.isInteger(index)) {
          return clamp(index, 0, String(sourceText || "").length);
        }
      }
    }

    const visible = this.getVisibleTextSnapshot();
    return this.getCaretOffset(visible);
  }

  resolveCodeMirrorView() {
    const readViewFromHost = (host) => {
      if (!host) {
        return null;
      }
      const direct = host.view || host.editorView;
      if (direct?.state?.doc && typeof direct.state.doc.toString === "function") {
        return direct;
      }
      const cmView = host.cmView;
      if (cmView?.view?.state?.doc && typeof cmView.view.state.doc.toString === "function") {
        return cmView.view;
      }
      if (cmView?.state?.doc && typeof cmView.state.doc.toString === "function") {
        return cmView;
      }
      const legacy = host.CodeMirror || host.cm || host.cmEditor;
      if (legacy?.state?.doc && typeof legacy.state.doc.toString === "function") {
        return legacy;
      }
      return null;
    };

    const candidates = [this.root, this.content, this.scroller];
    for (const host of candidates) {
      const view = readViewFromHost(host);
      if (view) {
        return view;
      }
    }

    // Some CM6 embeds keep the editor view on descendant nodes (often cm-content / cm-line)
    // via internal cmView pointers rather than directly on the root wrapper.
    const rootsToScan = [this.content, this.root, this.scroller].filter(Boolean);
    for (const scanRoot of rootsToScan) {
      const descendants = scanRoot.querySelectorAll?.(".cm-content, .cm-scroller, .cm-line");
      if (!descendants || descendants.length === 0) {
        continue;
      }
      for (const node of descendants) {
        const view = readViewFromHost(node);
        if (view) {
          return view;
        }
      }
    }
    return null;
  }

  resolveAceEditor() {
    const candidates = [this.root, this.content, this.scroller];
    for (const host of candidates) {
      if (!host) {
        continue;
      }
      const envEditor = host.env && host.env.editor;
      if (envEditor && typeof envEditor.getValue === "function") {
        return envEditor;
      }
      if (host.editor && typeof host.editor.getValue === "function") {
        return host.editor;
      }
    }
    return null;
  }

  acePositionToIndex(editor, position, sourceText = "") {
    if (!editor || !position || !Number.isInteger(position.row) || !Number.isInteger(position.column)) {
      return null;
    }
    const session = editor.session || (typeof editor.getSession === "function" ? editor.getSession() : null);
    const doc = session?.doc;
    if (doc && typeof doc.positionToIndex === "function") {
      try {
        return doc.positionToIndex(position, 0);
      } catch (_error) {
        // fall back to manual line walk
      }
    }

    const text = String(sourceText || "");
    if (!text) {
      return 0;
    }
    const lines = text.split("\n");
    const row = clamp(position.row, 0, Math.max(0, lines.length - 1));
    const col = clamp(position.column, 0, (lines[row] || "").length);
    let index = 0;
    for (let i = 0; i < row; i += 1) {
      index += (lines[i] || "").length + 1;
    }
    index += col;
    return clamp(index, 0, text.length);
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
    const scopeName = normalizeScope(scope);
    if (scopeName === "document") {
      const fullDoc = this.getDocumentSnapshot();
      if (fullDoc && typeof fullDoc.text === "string") {
        return fullDoc;
      }
    }

    const snap = this.getVisibleTextSnapshot();
    const selected = this.getSelectionText().trim();
    const selection = window.getSelection();

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
      const fullDoc = this.getDocumentSnapshot();
      if (fullDoc && typeof fullDoc.text === "string") {
        return fullDoc;
      }
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

    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
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

  insertAtCaret(text) {
    const value = String(text || "");
    if (!value) {
      return false;
    }

    this.focus();
    const selection = window.getSelection();
    if (!selection) {
      return false;
    }

    if (
      selection.rangeCount === 0 ||
      !selection.anchorNode ||
      !this.content.contains(selection.anchorNode)
    ) {
      const current = this.getVisibleTextSnapshot();
      const boundary = this.locateBoundary(current, current.text.length);
      if (!boundary) {
        return false;
      }
      const fallbackRange = document.createRange();
      fallbackRange.setStart(boundary.node, boundary.offset);
      fallbackRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(fallbackRange);
    }

    let inserted = false;
    if (typeof document.execCommand === "function") {
      inserted = document.execCommand("insertText", false, value);
    }

    if (!inserted) {
      if (!selection.rangeCount) {
        return false;
      }
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(value);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    this.content.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return true;
  }

  getCaretClientRect(snapshot) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return null;
    }
    const anchor = selection.anchorNode;
    if (!anchor || !this.content.contains(anchor)) {
      return null;
    }

    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    const rects = range.getClientRects();
    if (rects.length > 0) {
      return rects[0];
    }

    const fallback = this.getClientRectsForRange(
      this.getCaretOffset(snapshot) ?? 0,
      (this.getCaretOffset(snapshot) ?? 0) + 1,
      snapshot
    );
    return fallback[0] || null;
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

  Object.assign(zeta, {
    AdapterBase,
    TextareaAdapter,
    DomLineAdapter,
    ContentEditableAdapter,
  });
})();
