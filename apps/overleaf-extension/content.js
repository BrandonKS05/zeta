(() => {
  "use strict";

  const WORD_REGEX = /\b(apple|banana)\b/gi;
  const WORD_CLASS = {
    apple: "herald-highlight-apple",
    banana: "herald-highlight-banana",
  };

  const instances = new Map();
  let scanScheduled = false;

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

  function isEditorEligible(editor) {
    if (!editor.isConnected) {
      return false;
    }

    const content = editor.querySelector(".cm-content");
    if (!content) {
      return false;
    }

    if (content.closest('[aria-hidden="true"]')) {
      return false;
    }

    const rect = editor.getBoundingClientRect();
    return rect.width > 300 && rect.height > 100;
  }

  class EditorHighlighter {
    constructor(editor) {
      this.editor = editor;
      this.content = editor.querySelector(".cm-content");
      this.scroller = editor.querySelector(".cm-scroller") || editor;
      this.layer = document.createElement("div");
      this.layer.className = "herald-highlight-layer";

      this.boundScheduleRender = this.scheduleRender.bind(this);
      this.pendingRender = false;
      this.disconnected = false;

      this.mutationObserver = new MutationObserver(this.boundScheduleRender);
    }

    attach() {
      if (this.disconnected) {
        return;
      }

      if (window.getComputedStyle(this.content).position === "static") {
        this.content.style.position = "relative";
      }

      this.content.appendChild(this.layer);

      this.mutationObserver.observe(this.content, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      this.scroller.addEventListener("scroll", this.boundScheduleRender, {
        passive: true,
      });
      window.addEventListener("resize", this.boundScheduleRender);

      this.scheduleRender();
    }

    scheduleRender() {
      if (this.pendingRender || this.disconnected) {
        return;
      }
      this.pendingRender = true;
      window.requestAnimationFrame(() => {
        this.pendingRender = false;
        this.render();
      });
    }

    render() {
      if (this.disconnected || !this.editor.isConnected || !this.content.isConnected) {
        return;
      }

      this.layer.replaceChildren();

      const contentRect = this.content.getBoundingClientRect();
      const scrollerRect = this.scroller.getBoundingClientRect();
      const textNodes = this.collectTextNodes();

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
          const end = start + matchedWord.length;
          const range = document.createRange();
          try {
            range.setStart(node, start);
            range.setEnd(node, end);
          } catch (_error) {
            continue;
          }

          const rects = range.getClientRects();
          for (const rect of rects) {
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

            const highlight = document.createElement("div");
            highlight.className = `herald-highlight ${className}`;
            highlight.style.left = `${rect.left - contentRect.left}px`;
            highlight.style.top = `${rect.top - contentRect.top}px`;
            highlight.style.width = `${rect.width}px`;
            highlight.style.height = `${rect.height}px`;
            this.layer.appendChild(highlight);
          }
        }
      }
    }

    collectTextNodes() {
      const nodes = [];
      const walker = document.createTreeWalker(
        this.content,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.trim().length === 0) {
              return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (!parent) {
              return NodeFilter.FILTER_REJECT;
            }
            if (parent.closest(".herald-highlight-layer")) {
              return NodeFilter.FILTER_REJECT;
            }
            if (!parent.closest(".cm-line")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

      let nextNode = walker.nextNode();
      while (nextNode) {
        nodes.push(nextNode);
        nextNode = walker.nextNode();
      }

      return nodes;
    }

    destroy() {
      if (this.disconnected) {
        return;
      }
      this.disconnected = true;
      this.mutationObserver.disconnect();
      this.scroller.removeEventListener("scroll", this.boundScheduleRender);
      window.removeEventListener("resize", this.boundScheduleRender);
      this.layer.remove();
    }
  }

  function attachToEditors() {
    const editors = new Set(document.querySelectorAll(".cm-editor"));

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
    attachToEditors();
    pageObserver.observe(document.body, { childList: true, subtree: true });
    window.setInterval(scheduleScan, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

