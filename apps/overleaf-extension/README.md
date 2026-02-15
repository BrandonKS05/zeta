# zeta (Overleaf + browser editor extension)

**Grammarly for Math**

zeta now ships a real frontend shell for math statement checking:

- injected right-side panel on pages with editable text
- scope-aware checking (`selection`, `paragraph`, `document`)
- real-time pipeline with debounce, retry, timeout, and stale-result protection
- natural-language suggestion rendering + compiler diagnostics
- inline issue underlines and caret-persistent suggestion popup
- Tab autocomplete on Overleaf source editors (LHS) using `/v1/complete`
- issue actions (`apply`, `ignore`, `regenerate`) plus activity/history with undo
- persisted settings (`backend URL`, mode, scope, timeout, retries, notation strictness)
- keyboard shortcuts for issue navigation

## LaTeX delimiter coverage

Chunk/graph delimiters now include mainstream structural LaTeX commands, not only sectioning.

- Sectioning: `\part`, `\chapter`, `\section`, `\subsection`, `\subsubsection`, `\paragraph`, `\subparagraph`
- Front matter: `\title`, `\author`, `\date`, `\subtitle`, `\institute`, `\thanks`, `\maketitle`
- Document structure: `\tableofcontents`, `\listoffigures`, `\listoftables`, `\appendix`, `\frontmatter`, `\mainmatter`, `\backmatter`
- Bibliography: `\bibliography`, `\bibliographystyle`, `\addbibresource`, `\printbibliography`
- Cross-ref/citations: `\label`, `\ref`, `\eqref`, `\pageref`, `\autoref`, `\cref`, `\Cref`, `\cite`, `\citet`, `\citep`
- Layout/page controls: `\newpage`, `\clearpage`, `\cleardoublepage`, `\pagebreak`, `\linebreak`, `\vspace`, `\hspace`, `\smallskip`, `\medskip`, `\bigskip`

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

Autocomplete requires a backend that implements:

- `POST /v1/complete`

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
- `Tab` accept active inline autocomplete suggestion
