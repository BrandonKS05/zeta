# zeta (Overleaf + browser editor extension)

**Grammarly for Math**

zeta now ships a real frontend shell for math statement checking:

- injected right-side panel on pages with editable text
- scope-aware checking (`selection`, `paragraph`, `document`)
- real-time pipeline with debounce, retry, timeout, and stale-result protection
- natural-language suggestion rendering + compiler diagnostics
- inline issue underlines and caret-persistent suggestion popup
- issue actions (`apply`, `ignore`, `regenerate`) plus activity/history with undo
- persisted settings (`backend URL`, mode, scope, timeout, retries, notation strictness)
- keyboard shortcuts for issue navigation

## Content Script Organization

The injected frontend is split into multiple files for maintainability:

- `content_shared.js` - constants, helpers, storage utilities
- `content_adapters.js` - editor adapters (CodeMirror, Ace, textarea, contenteditable)
- `content_ui.js` - overlay, popover, panel UI classes
- `content_app.js` - main app/controller logic
- `content_bootstrap.js` - guard + app startup/shutdown wiring

`content.js` is deprecated and no longer loaded by `manifest.json`.

## Backend compatibility

Works with both response styles:

- `POST /v1/lean/solve` (lean-backend)
- `POST /v1/analyze` / `query` style (translator-modal)

Configure the endpoint in the panel Settings section.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select: `/Users/aryan/Desktop/treehacks-2026/apps/overleaf-extension`

## Keyboard shortcuts

- `Alt+Shift+N` next issue
- `Alt+Shift+P` previous issue
- `Ctrl/Cmd+Enter` run check now
- `Alt+Shift+A` apply focused replacement
- `Alt+Shift+U` undo last action
