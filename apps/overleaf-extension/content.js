(() => {
  "use strict";

  const MODE_KEY = "zetaMode";
  const MODE_VALUES = new Set(["fast", "accurate", "auto"]);
  const EDITOR_QUERY = ".cm-editor, .ace_editor";
  const WORD_REGEX = /\b(apple|banana)\b/gi;
  const WORD_CLASS = {
    apple: "zeta-highlight-apple",
    banana: "zeta-highlight-banana",
  };

  const SUGGESTIONS = {
    apple: [
      {
        replacement: "variable x",
        reason: "Use symbolic names for math quantities.",
      },
      {
        replacement: "set A",
        reason: "Use set notation when referring to collections.",
      },
      {
        replacement: "scalar a",
        reason: "Use a precise numeric label.",
      },
    ],
    banana: [
      {
        replacement: "function f",
        reason: "Use named functions for transformations.",
      },
      {
        replacement: "vector v",
        reason: "Use vector notation for directional values.",
      },
      {
        replacement: "parameter b",
        reason: "Use parameter labels for model terms.",
      },
    ],
  };

  const instances = new Map();
  let scanScheduled = false;
  let activeMode = "auto";

  function normalizeMode(mode) {
    return MODE_VALUES.has(mode) ? mode : "auto";
  }

  function resolveRenderMode(textLength) {
    if (activeMode !== "auto") {
      return activeMode;
    }
    return textLength > 8000 ? "accurate" : "fast";
  }

  function modeToDelay(mode) {
    if (mode === "accurate") {
      return 120;
    }
    return 0;
  }

  function modeLabel(mode) {
    if (mode === "fast") {
      return "Fast";
    }
    if (mode === "accurate") {
      return "Accurate";
    }
    return "Auto";
  }

  function loadModeFromStorage() {
    if (typeof chrome === "undefined" || !chrome.storage?.sync) {
      return;
    }

    chrome.storage.sync.get({ [MODE_KEY]: "auto" }, (result) => {
      const nextMode = normalizeMode(result[MODE_KEY]);
      if (nextMode !== activeMode) {
        activeMode = nextMode;
        for (const highlighter of instances.values()) {
          highlighter.scheduleRender();
        }
      }
    });
  }

  function wireModeListeners() {
    if (typeof chrome === "undefined") {
      return;
    }

    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "sync" || !changes[MODE_KEY]) {
          return;
        }

        const nextMode = normalizeMode(changes[MODE_KEY].newValue);
        if (nextMode === activeMode) {
          return;
        }

        activeMode = nextMode;
        for (const highlighter of instances.values()) {
          highlighter.scheduleRender();
        }
      });
    }

    if (chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type !== "zeta-mode-changed") {
          return;
        }
        const nextMode = normalizeMode(message.mode);
        if (nextMode !== activeMode) {
          activeMode = nextMode;
          for (const highlighter of instances.values()) {
            highlighter.scheduleRender();
          }
        }
      });
    }
  }

  function scheduleScan() {
    if (scanScheduled) {
      return;
    }

    scanScheduled = true;
    window.requestAnimationFrame(() => {
      scanScheduled = false;
      attachToEditors();
    });
  }

  function getEditorKind(editor) {
    if (editor.classList.contains("cm-editor")) {
      return "codemirror";
    }
    if (editor.classList.contains("ace_editor")) {
      return "ace";
    }
    return null;
  }

  function getEditorConfig(kind) {
    if (kind === "codemirror") {
      return {
        contentSelector: ".cm-content",
        scrollerSelector: ".cm-scroller",
        lineSelector: ".cm-line",
      };
    }
    if (kind === "ace") {
      return {
        contentSelector: ".ace_text-layer",
        scrollerSelector: ".ace_scroller",
        lineSelector: ".ace_line",
      };
    }
    return null;
  }

  function isEditorEligible(editor) {
    const kind = getEditorKind(editor);
    const config = getEditorConfig(kind);
    if (!config) {
      return false;
    }

    if (!editor.isConnected) {
      return false;
    }

    const content = editor.querySelector(config.contentSelector);
    if (!content) {
      return false;
    }

    if (kind === "codemirror" && content.getAttribute("contenteditable") === "false") {
      return false;
    }

    if (
      !editor.querySelector(config.lineSelector) ||
      !editor.querySelector(config.scrollerSelector)
    ) {
      return false;
    }

    if (
      editor.closest('[aria-hidden="true"]') ||
      content.closest('[aria-hidden="true"]')
    ) {
      return false;
    }

    const rect = editor.getBoundingClientRect();
    return rect.width > 320 && rect.height > 120;
  }

  function getSuggestions(word, mode) {
    const suggestionList = SUGGESTIONS[word] || [];
    if (mode === "fast") {
      return suggestionList.slice(0, 1);
    }
    if (mode === "accurate") {
      return suggestionList;
    }
    return suggestionList.slice(0, 2);
  }

  class EditorHighlighter {
    constructor(editor) {
      this.editor = editor;
      this.kind = getEditorKind(editor);
      this.config = getEditorConfig(this.kind);
      this.content = this.config
        ? editor.querySelector(this.config.contentSelector)
        : null;
      this.scroller =
        this.config && editor.querySelector(this.config.scrollerSelector)
          ? editor.querySelector(this.config.scrollerSelector)
          : editor;

      this.layer = document.createElement("div");
      this.layer.className = "zeta-highlight-layer";

      this.disconnected = !this.content;
      this.pendingTimer = null;
      this.pendingFrame = false;
      this.highlightTargets = [];
      this.activeTarget = null;
      this.popover = null;

      this.boundScheduleRender = this.scheduleRender.bind(this);
      this.boundContentClick = this.handleContentClick.bind(this);
      this.boundSelectionChange = this.handleSelectionChange.bind(this);
      this.boundDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
      this.boundDocumentKeydown = this.handleDocumentKeydown.bind(this);
      this.boundClosePopover = this.closePopover.bind(this);

      this.mutationObserver = new MutationObserver(this.boundScheduleRender);
    }

    attach() {
      if (this.disconnected) {
        return;
      }

      document.body.appendChild(this.layer);

      this.mutationObserver.observe(this.content, {
        subtree: true,
        childList: true,
        characterData: true,
      });

      this.content.addEventListener("input", this.boundScheduleRender, true);
      this.content.addEventListener("keyup", this.boundScheduleRender, true);
      this.content.addEventListener("compositionend", this.boundScheduleRender, true);
      this.content.addEventListener("click", this.boundContentClick, true);
      document.addEventListener("selectionchange", this.boundSelectionChange, true);

      this.scroller.addEventListener("scroll", this.boundScheduleRender, {
        passive: true,
      });
      window.addEventListener("scroll", this.boundScheduleRender, true);
      window.addEventListener("resize", this.boundScheduleRender);

      this.scheduleRender();
    }

    scheduleRender() {
      if (this.disconnected) {
        return;
      }

      const textLength = this.content?.textContent?.length || 0;
      const mode = resolveRenderMode(textLength);
      const delay = modeToDelay(mode);

      if (delay > 0) {
        if (this.pendingTimer) {
          window.clearTimeout(this.pendingTimer);
        }
        this.pendingTimer = window.setTimeout(() => {
          this.pendingTimer = null;
          this.requestFrame();
        }, delay);
        return;
      }

      if (this.pendingTimer) {
        window.clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }

      this.requestFrame();
    }

    requestFrame() {
      if (this.pendingFrame || this.disconnected) {
        return;
      }

      this.pendingFrame = true;
      window.requestAnimationFrame(() => {
        this.pendingFrame = false;
        this.render();
      });
    }

    render() {
      if (this.disconnected || !this.editor.isConnected || !this.content.isConnected) {
        return;
      }

      this.layer.replaceChildren();
      this.highlightTargets = [];

      const scrollerRect = this.scroller.getBoundingClientRect();
      const textNodes = this.collectVisibleTextNodes(scrollerRect);

      for (const node of textNodes) {
        const text = node.nodeValue;
        if (!text) {
          continue;
        }

        WORD_REGEX.lastIndex = 0;
        let match;
        while ((match = WORD_REGEX.exec(text)) !== null) {
          const matchedWord = match[1].toLowerCase();
          const className = WORD_CLASS[matchedWord];
          if (!className) {
            continue;
          }

          const start = match.index;
          const end = start + match[0].length;
          const range = document.createRange();

          try {
            range.setStart(node, start);
            range.setEnd(node, end);
          } catch (_error) {
            continue;
          }

          const visibleRects = [];
          for (const rect of range.getClientRects()) {
            if (
              rect.width <= 0 ||
              rect.height <= 0 ||
              rect.bottom < scrollerRect.top ||
              rect.top > scrollerRect.bottom ||
              rect.right < scrollerRect.left ||
              rect.left > scrollerRect.right
            ) {
              continue;
            }
            visibleRects.push(rect);
          }

          if (visibleRects.length === 0) {
            continue;
          }

          const target = {
            node,
            start,
            end,
            word: matchedWord,
            matchedText: match[0],
            rects: visibleRects.map((rect) => ({
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            })),
          };
          this.highlightTargets.push(target);

          for (const rect of visibleRects) {
            const highlight = document.createElement("div");
            highlight.className = `zeta-highlight ${className}`;
            highlight.style.left = `${rect.left}px`;
            highlight.style.top = `${rect.top}px`;
            highlight.style.width = `${rect.width}px`;
            highlight.style.height = `${Math.max(rect.height, 16)}px`;
            this.layer.appendChild(highlight);
          }
        }
      }

      this.syncPopoverToCaret();
    }

    collectVisibleTextNodes(scrollerRect) {
      const nodes = [];
      const lines = this.content.querySelectorAll(this.config.lineSelector);
      for (const line of lines) {
        const rect = line.getBoundingClientRect();
        if (
          rect.height <= 0 ||
          rect.bottom < scrollerRect.top ||
          rect.top > scrollerRect.bottom
        ) {
          continue;
        }

        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.trim().length === 0) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        });

        let nextNode = walker.nextNode();
        while (nextNode) {
          nodes.push(nextNode);
          nextNode = walker.nextNode();
        }
      }
      return nodes;
    }

    findTargetAtPoint(clientX, clientY) {
      for (const target of this.highlightTargets) {
        for (const rect of target.rects) {
          if (
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom
          ) {
            return { target, rect };
          }
        }
      }
      return null;
    }

    getTargetAtCaret() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
        return null;
      }

      const anchorNode = selection.anchorNode;
      if (!anchorNode || !this.content.contains(anchorNode)) {
        return null;
      }

      for (const target of this.highlightTargets) {
        if (this.isCaretWithinTarget(target, selection)) {
          return target;
        }
      }

      return null;
    }

    isCaretWithinTarget(target, selection) {
      const anchorNode = selection.anchorNode;
      const anchorOffset = selection.anchorOffset;
      if (!anchorNode) {
        return false;
      }

      if (anchorNode === target.node) {
        return anchorOffset >= target.start && anchorOffset <= target.end;
      }

      const range = document.createRange();
      try {
        range.setStart(target.node, target.start);
        range.setEnd(target.node, target.end);
        return range.isPointInRange(anchorNode, anchorOffset);
      } catch (_error) {
        return false;
      }
    }

    getAnchorRectForTarget(target) {
      const rect = target.rects[0];
      return rect || null;
    }

    isSameSuggestionContext(first, second) {
      if (!first || !second) {
        return false;
      }
      return first.word === second.word && first.matchedText === second.matchedText;
    }

    syncPopoverToCaret() {
      if (!this.popover) {
        return;
      }

      const caretTarget = this.getTargetAtCaret();
      if (!caretTarget) {
        this.closePopover();
        return;
      }

      const anchorRect = this.getAnchorRectForTarget(caretTarget);
      if (!anchorRect) {
        this.closePopover();
        return;
      }

      if (!this.isSameSuggestionContext(caretTarget, this.activeTarget)) {
        this.openPopover(caretTarget, anchorRect);
        return;
      }

      this.activeTarget = caretTarget;
      this.positionPopover(anchorRect);
    }

    handleContentClick(event) {
      if (event.button !== 0) {
        return;
      }

      const clickX = event.clientX;
      const clickY = event.clientY;
      window.requestAnimationFrame(() => {
        if (this.disconnected) {
          return;
        }

        const caretTarget = this.getTargetAtCaret();
        const caretAnchor = caretTarget ? this.getAnchorRectForTarget(caretTarget) : null;
        if (caretTarget && caretAnchor) {
          this.openPopover(caretTarget, caretAnchor);
          return;
        }

        const hit = this.findTargetAtPoint(clickX, clickY);
        if (hit) {
          this.openPopover(hit.target, hit.rect);
          return;
        }

        if (this.popover) {
          this.closePopover();
        }
      });
    }

    handleSelectionChange() {
      if (!this.popover || this.disconnected) {
        return;
      }
      this.syncPopoverToCaret();
    }

    openPopover(target, anchorRect) {
      this.closePopover();

      const mode = resolveRenderMode(this.content?.textContent?.length || 0);
      const suggestions = getSuggestions(target.word, mode);
      if (suggestions.length === 0) {
        return;
      }

      const popover = document.createElement("div");
      popover.className = "zeta-suggestion-popover";

      const header = document.createElement("div");
      header.className = "zeta-suggestion-header";

      const title = document.createElement("div");
      title.className = "zeta-suggestion-title";
      title.textContent = `Suggestions for \"${target.matchedText}\"`;

      const modeChip = document.createElement("span");
      modeChip.className = "zeta-mode-chip";
      modeChip.textContent = modeLabel(mode);

      header.append(title, modeChip);
      popover.appendChild(header);

      const list = document.createElement("div");
      list.className = "zeta-suggestion-list";

      for (const suggestion of suggestions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "zeta-suggestion-option";

        const replacement = document.createElement("span");
        replacement.className = "zeta-suggestion-replacement";
        replacement.textContent = suggestion.replacement;

        const reason = document.createElement("span");
        reason.className = "zeta-suggestion-reason";
        reason.textContent = suggestion.reason;

        button.append(replacement, reason);
        button.addEventListener("click", (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          this.applySuggestion(target, suggestion.replacement);
        });

        list.appendChild(button);
      }

      popover.appendChild(list);
      document.body.appendChild(popover);
      this.popover = popover;
      this.activeTarget = target;

      this.positionPopover(anchorRect);

      document.addEventListener(
        "pointerdown",
        this.boundDocumentPointerDown,
        true
      );
      document.addEventListener("keydown", this.boundDocumentKeydown, true);
      window.addEventListener("scroll", this.boundClosePopover, true);
      window.addEventListener("resize", this.boundClosePopover);
    }

    positionPopover(anchorRect) {
      if (!this.popover) {
        return;
      }

      const margin = 12;
      const width = this.popover.offsetWidth;
      const height = this.popover.offsetHeight;

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

      this.popover.style.left = `${Math.round(left)}px`;
      this.popover.style.top = `${Math.round(top)}px`;
    }

    handleDocumentPointerDown(event) {
      if (!this.popover) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) {
        this.closePopover();
        return;
      }

      if (
        target.closest(".zeta-suggestion-popover")
      ) {
        return;
      }

      this.closePopover();
    }

    handleDocumentKeydown(event) {
      if (event.key === "Escape") {
        this.closePopover();
      }
    }

    applySuggestion(target, replacementText) {
      if (!target.node.isConnected) {
        this.closePopover();
        return;
      }

      const range = document.createRange();
      try {
        range.setStart(target.node, target.start);
        range.setEnd(target.node, target.end);
      } catch (_error) {
        this.closePopover();
        return;
      }

      const selection = window.getSelection();
      if (!selection) {
        this.closePopover();
        return;
      }

      this.content.focus();
      selection.removeAllRanges();
      selection.addRange(range);

      let replaced = false;
      if (typeof document.execCommand === "function") {
        replaced = document.execCommand("insertText", false, replacementText);
      }

      if (!replaced) {
        const text = target.node.nodeValue || "";
        target.node.nodeValue =
          text.slice(0, target.start) + replacementText + text.slice(target.end);

        const inputEvent = new InputEvent("input", {
          bubbles: true,
          data: replacementText,
          inputType: "insertReplacementText",
        });
        target.node.parentElement?.dispatchEvent(inputEvent);
      }

      selection.removeAllRanges();
      this.closePopover();
      this.scheduleRender();
    }

    closePopover() {
      if (!this.popover) {
        this.activeTarget = null;
        return;
      }

      this.popover.remove();
      this.popover = null;

      document.removeEventListener(
        "pointerdown",
        this.boundDocumentPointerDown,
        true
      );
      document.removeEventListener("keydown", this.boundDocumentKeydown, true);
      window.removeEventListener("scroll", this.boundClosePopover, true);
      window.removeEventListener("resize", this.boundClosePopover);
      this.activeTarget = null;
    }

    destroy() {
      if (this.disconnected) {
        return;
      }

      this.disconnected = true;
      this.closePopover();

      if (this.pendingTimer) {
        window.clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }

      this.mutationObserver.disconnect();

      this.content.removeEventListener("input", this.boundScheduleRender, true);
      this.content.removeEventListener("keyup", this.boundScheduleRender, true);
      this.content.removeEventListener(
        "compositionend",
        this.boundScheduleRender,
        true
      );
      this.content.removeEventListener("click", this.boundContentClick, true);
      document.removeEventListener("selectionchange", this.boundSelectionChange, true);

      this.scroller.removeEventListener("scroll", this.boundScheduleRender);
      window.removeEventListener("scroll", this.boundScheduleRender, true);
      window.removeEventListener("resize", this.boundScheduleRender);

      this.layer.remove();
    }
  }

  function attachToEditors() {
    const editors = new Set(document.querySelectorAll(EDITOR_QUERY));

    for (const [editor, highlighter] of instances.entries()) {
      if (!editors.has(editor) || !isEditorEligible(editor)) {
        highlighter.destroy();
        instances.delete(editor);
      }
    }

    for (const editor of editors) {
      if (!isEditorEligible(editor)) {
        continue;
      }

      if (!instances.has(editor)) {
        const highlighter = new EditorHighlighter(editor);
        highlighter.attach();
        instances.set(editor, highlighter);
      } else {
        instances.get(editor).scheduleRender();
      }
    }
  }

  const pageObserver = new MutationObserver(scheduleScan);

  function start() {
    if (!location.hostname.endsWith("overleaf.com")) {
      return;
    }

    loadModeFromStorage();
    wireModeListeners();

    attachToEditors();
    pageObserver.observe(document.body, { childList: true, subtree: true });
    window.setInterval(scheduleScan, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
