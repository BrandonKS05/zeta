(() => {
  "use strict";

  const zeta = window.__zetaContent || (window.__zetaContent = {});
  const { MAX_HIGHLIGHT_RECTS, ensureArray, normalizeSeverity, clamp } = zeta;

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

  function deriveReplacementFromSuggestion(suggestionText, targetText) {
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

    const suggestionText = String(issue?.suggestion || issue?.suggestedFix || "").trim();
    let resolvedReplacement = String(issue?.replacement || "").trim();
    if (!resolvedReplacement && suggestionText && issue?.targetText) {
      resolvedReplacement = deriveReplacementFromSuggestion(suggestionText, issue.targetText);
    }
    const applyPayload = () => {
      this.onApply({
        ...issue,
        replacement: resolvedReplacement,
      });
      this.close();
    };
    const isSameFix = resolvedReplacement && suggestionText && (
      suggestionText === resolvedReplacement ||
      suggestionText.replace(/^suggested fix:\s*/i, "").trim() === resolvedReplacement
    );
    if (resolvedReplacement) {
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "zeta-suggestion-option zeta-suggestion-option--clickable";
      const strong = document.createElement("strong");
      strong.textContent = isSameFix && suggestionText ? "Apply" : "Apply replacement";
      const span = document.createElement("span");
      span.className = "zeta-suggestion-fix-text";
      span.textContent = (isSameFix && suggestionText ? suggestionText : resolvedReplacement);
      applyBtn.append(strong, span);
      applyBtn.addEventListener("click", (event) => {
        event.preventDefault();
        applyPayload();
      });
      list.appendChild(applyBtn);
    }
    if (suggestionText && !isSameFix) {
      const note = document.createElement("div");
      note.className = "zeta-suggestion-note";
      const label = document.createElement("strong");
      label.textContent = "Suggested fix";
      const body = document.createElement("span");
      body.textContent = suggestionText;
      note.append(label, body);
      list.appendChild(note);
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
    if (event?.__zetaKeepPopover) {
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

    this.root.innerHTML = `
      <header class="zeta-header">
        <div class="zeta-header-top">
          <div class="zeta-brand">
            <img class="zeta-brand-logo" src="${chrome.runtime.getURL("assets/zeta-black-white-2048.png")}" alt="zeta" />
            <div>
              <h2>zeta</h2>
              <p>Grammarly for Math</p>
            </div>
          </div>
          <div class="zeta-top-right">
            <div id="zeta-global-pill" class="zeta-global-pill">
              <span id="zeta-global-dot" class="zeta-global-dot"></span>
              <span id="zeta-global-text">global · idle</span>
            </div>
            <button type="button" id="zeta-collapse-btn" class="zeta-icon-btn">Hide</button>
          </div>
        </div>
        <div class="zeta-status-row">
          <div class="zeta-status">
            <span id="zeta-status-dot" class="zeta-status-dot"></span>
            <span id="zeta-status-text">Idle</span>
          </div>
          <div id="zeta-inference-text" class="zeta-inference">inference --</div>
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
        <div class="zeta-toolbar-actions">
          <button type="button" id="zeta-run-btn" class="zeta-icon-btn">Check</button>
          <button type="button" id="zeta-settings-btn" class="zeta-icon-btn">Settings</button>
        </div>
      </section>
      <div class="zeta-content">
        <section class="zeta-card">
          <div class="zeta-card-header">
            <h3>Document Health</h3>
            <span id="zeta-sentence-stats" class="zeta-card-meta">0 cached · 0 pending</span>
          </div>
          <div class="zeta-health">
            <div class="zeta-health-meter"><span id="zeta-health-fill"></span></div>
            <span id="zeta-health-label">100</span>
          </div>
          <div class="zeta-item-actions zeta-item-actions--top">
            <button type="button" id="zeta-regenerate-btn" class="zeta-btn">Refresh</button>
            <button type="button" id="zeta-next-btn" class="zeta-btn">Next</button>
            <button type="button" id="zeta-prev-btn" class="zeta-btn">Prev</button>
          </div>
        </section>
        <section class="zeta-card">
          <div class="zeta-card-header">
            <h3>Activity & History</h3>
            <div class="zeta-item-actions zeta-item-actions--inline">
              <button type="button" id="zeta-undo-btn" class="zeta-btn">Undo Last</button>
              <button type="button" id="zeta-clear-history-btn" class="zeta-btn">Clear</button>
            </div>
          </div>
          <ul id="zeta-activity" class="zeta-list"></ul>
          <p id="zeta-activity-empty" class="zeta-empty">No activity yet.</p>
        </section>
        <section class="zeta-card">
          <div class="zeta-card-header">
            <h3>Live Feedback</h3>
            <span id="zeta-feedback-count" class="zeta-card-meta">0</span>
          </div>
          <ul id="zeta-issues" class="zeta-list"></ul>
          <p id="zeta-issues-empty" class="zeta-empty">No issues found.</p>
        </section>
        <section id="zeta-settings-card" class="zeta-card" style="display:none">
          <div class="zeta-card-header">
            <h3>Autocomplete Settings</h3>
          </div>
          <div class="zeta-settings">
            <div class="zeta-field">
              <label for="zeta-timeout">Timeout (ms)</label>
              <input id="zeta-timeout" type="number" min="2000" step="500" />
            </div>
            <div class="zeta-field">
              <label for="zeta-retries">Retries</label>
              <input id="zeta-retries" type="number" min="0" max="4" step="1" />
            </div>
            <div class="zeta-settings-row">
              <span>Enable autocomplete</span>
              <input id="zeta-autocomplete-enabled" type="checkbox" />
            </div>
            <div class="zeta-settings-row">
              <span>Check on typing</span>
              <input id="zeta-check-on-type" type="checkbox" />
            </div>
            <div class="zeta-settings-row">
              <span>Show Top-K autocomplete list</span>
              <input id="zeta-autocomplete-topk" type="checkbox" />
            </div>
            <div class="zeta-settings-row">
              <span>Manual trigger only (Alt+Shift+M)</span>
              <input id="zeta-autocomplete-manual" type="checkbox" />
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
            <li><code>⌥⇧N</code> ➡️ next issue</li>
            <li><code>⌥⇧P</code> ⬅️ previous issue</li>
            <li><code>⌘↩</code> ⚡ run check now</li>
            <li><code>⌥⇧R</code> 🔄 refresh checker</li>
            <li><code>⌥⇧H</code> 🧹 clear activity history</li>
            <li><code>⌥⇧M</code> ✨ request autocomplete</li>
            <li><code>⌥⇧A</code> ✅ apply focused replacement</li>
            <li><code>⌥⇧U</code> ↩️ undo last action</li>
          </ul>
        </section>
      </div>
    `;

    document.body.append(this.root);
    this.fab = document.createElement("button");
    this.fab.type = "button";
    this.fab.className = "zeta-fab";
    this.fab.setAttribute("aria-label", "Open zeta panel");
    this.fab.innerHTML = `
      <img src="${chrome.runtime.getURL("assets/zeta-black-white-2048.png")}" alt="" />
    `;
    document.body.append(this.fab);
    this.popupMirror = document.createElement("aside");
    this.popupMirror.className = "zeta-popup-mirror";
    this.popupMirror.setAttribute("aria-hidden", "true");
    this.popupMirror.innerHTML = `
      <iframe
        class="zeta-popup-mirror-frame"
        src="${chrome.runtime.getURL("popup.html?embedded=1")}"
        title="zeta popup mirror"
      ></iframe>
    `;
    document.body.append(this.popupMirror);
    this.isPopupOpen = false;

    this.refs = {
      statusDot: this.root.querySelector("#zeta-status-dot"),
      statusText: this.root.querySelector("#zeta-status-text"),
      globalDot: this.root.querySelector("#zeta-global-dot"),
      globalText: this.root.querySelector("#zeta-global-text"),
      globalPill: this.root.querySelector("#zeta-global-pill"),
      inferenceText: this.root.querySelector("#zeta-inference-text"),
      sentenceStats: this.root.querySelector("#zeta-sentence-stats"),
      feedbackCount: this.root.querySelector("#zeta-feedback-count"),
      scopeSelect: this.root.querySelector("#zeta-scope-select"),
      modeToggle: this.root.querySelector(".zeta-mode-toggle"),
      modeButtons: Array.from(this.root.querySelectorAll(".zeta-mode-btn")),
      healthFill: this.root.querySelector("#zeta-health-fill"),
      healthLabel: this.root.querySelector("#zeta-health-label"),
      activity: this.root.querySelector("#zeta-activity"),
      activityEmpty: this.root.querySelector("#zeta-activity-empty"),
      issues: this.root.querySelector("#zeta-issues"),
      issuesEmpty: this.root.querySelector("#zeta-issues-empty"),
      runBtn: this.root.querySelector("#zeta-run-btn"),
      regenerateBtn: this.root.querySelector("#zeta-regenerate-btn"),
      nextBtn: this.root.querySelector("#zeta-next-btn"),
      prevBtn: this.root.querySelector("#zeta-prev-btn"),
      undoBtn: this.root.querySelector("#zeta-undo-btn"),
      clearHistoryBtn: this.root.querySelector("#zeta-clear-history-btn"),
      settingsBtn: this.root.querySelector("#zeta-settings-btn"),
      collapseBtn: this.root.querySelector("#zeta-collapse-btn"),
      settingsCard: this.root.querySelector("#zeta-settings-card"),
      timeout: this.root.querySelector("#zeta-timeout"),
      retries: this.root.querySelector("#zeta-retries"),
      autocompleteEnabled: this.root.querySelector("#zeta-autocomplete-enabled"),
      checkOnType: this.root.querySelector("#zeta-check-on-type"),
      autocompleteTopK: this.root.querySelector("#zeta-autocomplete-topk"),
      autocompleteManual: this.root.querySelector("#zeta-autocomplete-manual"),
      notation: this.root.querySelector("#zeta-notation"),
      saveSettings: this.root.querySelector("#zeta-save-settings"),
    };

    this.isSettingsOpen = false;
    this.bindEvents();
    this.setOpen(false);
  }

  bindEvents() {
    this.refs.collapseBtn.addEventListener("click", () => this.handlers.onTogglePanel?.(false));
    this.fab.addEventListener("click", () => this.handlers.onTogglePanel?.(!this.isPopupOpen));
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
        requestTimeoutMs: Number(this.refs.timeout.value),
        retries: Number(this.refs.retries.value),
        autocompleteEnabled: this.refs.autocompleteEnabled.checked,
        checkOnType: this.refs.checkOnType.checked,
        autocompleteShowTopK: this.refs.autocompleteTopK.checked,
        autocompleteManualTrigger: this.refs.autocompleteManual.checked,
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
    this.isPopupOpen = !!open;
    // Keep the legacy shell hidden; the mirror iframe shows the same UI as the toolbar popup.
    this.root.classList.add("is-collapsed");
    this.popupMirror.classList.toggle("is-open", this.isPopupOpen);
    this.popupMirror.setAttribute("aria-hidden", this.isPopupOpen ? "false" : "true");
    this.fab.setAttribute("aria-expanded", this.isPopupOpen ? "true" : "false");
  }

  setTheme(_theme) {
    this.root.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("data-zeta-theme", "light");
  }

  setGlobalState(state, text) {
    this.refs.globalPill.classList.remove("is-analyzing", "is-ready", "is-error", "is-offline");
    if (state === "analyzing") {
      this.refs.globalPill.classList.add("is-analyzing");
    } else if (state === "error") {
      this.refs.globalPill.classList.add("is-error");
    } else if (state === "offline") {
      this.refs.globalPill.classList.add("is-offline");
    } else {
      this.refs.globalPill.classList.add("is-ready");
    }
    this.refs.globalText.textContent = text;
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

  setInferenceTime(lastMs, pendingCount = 0) {
    const msLabel = formatInferenceDuration(lastMs);
    const queueLabel = pendingCount > 0 ? ` · ${pendingCount} queued` : "";
    this.refs.inferenceText.textContent = `inference ${msLabel}${queueLabel}`;
  }

  setMode(mode) {
    const indexByMode = { fast: 0, accurate: 1, auto: 2 };
    const index = indexByMode[mode] ?? 2;
    this.refs.modeToggle.style.setProperty("--zeta-mode-index", String(index));
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

  setSentenceStats(cachedCount, pendingCount) {
    this.refs.sentenceStats.textContent = `${cachedCount} cached · ${pendingCount} pending`;
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

  setIssues(issues, focusedIndex) {
    const list = this.refs.issues;
    list.replaceChildren();
    const items = ensureArray(issues);
    this.refs.feedbackCount.textContent = String(items.length);

    for (let i = 0; i < items.length; i += 1) {
      const issue = items[i];
      const li = document.createElement("li");
      li.className = "zeta-item";
      li.setAttribute("data-severity", normalizeSeverity(issue.severity));
      li.setAttribute("data-issue-index", String(i));
      if (i === focusedIndex) {
        li.style.outline = "1px solid currentColor";
      }

      const targetLabel = issue.targetText ? ` · ${issue.targetText}` : "";
      li.innerHTML = `<strong>${issue.category || "issue"}${targetLabel}</strong><p>${issue.message || "Review this issue."}</p>`;

      const actionRow = document.createElement("div");
      actionRow.className = "zeta-item-actions";

      if (issue.replacement) {
        const fixBtn = document.createElement("button");
        fixBtn.type = "button";
        fixBtn.className = "zeta-btn zeta-btn-fix-text";
        fixBtn.setAttribute("data-action", "apply");
        fixBtn.textContent = issue.replacement;
        fixBtn.title = "Click to apply this fix";
        actionRow.appendChild(fixBtn);
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
    this.refs.timeout.value = String(settings.requestTimeoutMs);
    this.refs.retries.value = String(settings.retries);
    this.refs.autocompleteEnabled.checked = settings.autocompleteEnabled !== false;
    this.refs.checkOnType.checked = !!settings.checkOnType;
    this.refs.autocompleteTopK.checked = !!settings.autocompleteShowTopK;
    this.refs.autocompleteManual.checked = !!settings.autocompleteManualTrigger;
    this.refs.notation.value = settings.notationStrictness;
    this.setMode(settings.mode);
    this.setScope(settings.scope);
    this.setTheme(settings.theme);
  }

  scrollIssueIntoView(index) {
    const target = this.refs.issues.querySelector(`[data-issue-index='${index}']`);
    if (target) {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  remove() {
    this.fab.remove();
    this.popupMirror.remove();
    this.root.remove();
  }
}

  Object.assign(zeta, {
    ZetaOverlay,
    ZetaPopover,
    ZetaPanel,
  });
})();
