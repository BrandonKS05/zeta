# Zeta Demo Script: Journal Readiness Pre-Check

## Quick Start

Zeta is an AI-powered scientific publishing and peer-review assistant integrated into Overleaf. It scans documents for notation drift, undefined symbols, and theorem issues, then generates peer-review-style feedback. The extension, CLI, and Proof-CI demo all work without secrets in deterministic mode. The backend, Modal/DeepSeek path, and LLM interpretation are optional for enhanced AI summaries and live model inference.

## Load the Extension Locally

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `apps/overleaf-extension` from this repository.
5. Open any Overleaf project, or click the Zeta extension icon directly to use the popup Demo Mode.

## Deterministic Demo (no secrets required)

### Dashboard Demo Mode

1. Click the Zeta extension icon in Chrome.
2. Select the **Readiness** tab.
3. The dashboard runs **Demo Mode** automatically with a sample paper. Click **Run Demo Mode** to refresh.

### In-Document Review Mode

1. Open any Overleaf project after loading the extension.
2. Look for the floating **Zeta Review Mode** panel in the upper-right corner.
3. Click **Use Demo Paper** for the guaranteed live-demo path.
4. The panel switches to **Demo Mode** and displays:
   - Journal Readiness score (below 100).
   - Certified Demo Mode badge.
   - Problem symbol chips for `\sigma` and `\tau`.
   - **AI Reviewer Summary** (labeled as **Heuristic fallback** without backend).
   - Inline Issue Cards with location, snippet, “Why this matters,” and Author Fix text.
   - Review Ledger events.
5. Click **Next Issue** to cycle through warnings.
6. Click **Copy Suggested Fix** on an issue card.
7. Click **Copy Reviewer Report** to copy the full Markdown report.

### What Demo Mode Shows

The sample paper includes:
- `\sigma` defined as a covariance matrix, then used as a scalar variance (notation drift).
- `\tau` used in a theorem before its detected definition.
- One assumption, one lemma, one theorem.

Expected output:
- Zeta Journal Readiness score.
- Certified Demo Mode stamp.
- Counts for definitions, theorems, lemmas, assumptions, notation warnings.
- Notation drift and use-before-definition warnings.
- Suggested author fixes.
- Counterexample intuition explaining why overloaded notation breaks reasoning.

## CLI / Proof-CI Demo

Run Zeta as a deterministic CLI check without the extension:

```bash
npm run zeta:check -- --dir <path-to-latex-project>
```

### Output

The CLI writes two files:
- **`zeta-report.json`** — structured problem list (notation, undefined symbols, theorem issues).
- **`zeta-report.md`** — human-readable Markdown report.

### Strict Mode

Add the `--strict` flag to fail CI if any issues are found:

```bash
npm run zeta:check -- --dir <path> --strict
```

Useful for Proof-CI gates that block merge until pre-check passes.

## Start the Backend (localhost)

To enable live backend health checks and LLM-powered summaries:

### Install dependencies

```bash
cd services/lean-backend
pip install -r requirements.txt
```

### Start the server

```bash
uvicorn app.main:app --reload --port 8000
```

### Health check

Navigate to `http://localhost:8000/healthz` in a browser. You should see `{“status”: “ok”}`.

### Extension now sees backend

Open the extension popup. The backend health indicator now shows **”Backend: connected”** instead of unavailable. The AI summary can call `/v1/lean/solve` for deterministic problem detection.

## Live Smoke Test

Test the backend in isolation:

```bash
npm run zeta:smoke:live
```

This runs a deterministic test against the backend:
- Submits a sample document to `/v1/lean/solve`.
- Verifies the response structure.
- Does not require Modal, LLM, or Lean installed.

To test a remote backend, set the `ZETA_BACKEND_URL` environment variable:

```bash
ZETA_BACKEND_URL=http://example.com:8000 npm run zeta:smoke:live
```

## Modal / DeepSeek Path (Optional)

To enable live AI model inference (DeepSeek Prover V2), deploy the translator service to Modal:

### Prerequisites

- Modal account and CLI auth: `modal token set`
- HuggingFace token: `HF_TOKEN`
- Modal endpoint and API key: `MODAL_ENDPOINT_URL`, `MODAL_API_KEY`

### Deploy

```bash
modal deploy services/translator-modal/modal_app.py
```

### Configure backend

Set environment variables for the backend:

```bash
export MODAL_ENDPOINT_URL=<your-modal-endpoint>
export MODAL_API_KEY=<your-modal-key>
export HF_TOKEN=<your-hf-token>
```

Then restart the backend:

```bash
cd services/lean-backend && uvicorn app.main:app --reload --port 8000
```

### What gets enabled

- Live DeepSeek-Prover-V2 model inference for mathematical reasoning.
- Backend can request `ENABLE_LLM_INTERPRETATION` for LLM-powered summaries (requires `LLM_API_KEY` and `LLM_MODEL` or `LLM_BASE_URL`).
- Extension popup AI summary no longer shows **”Heuristic fallback”**.

## Export Reports

### Copy Reviewer Report (Extension)

1. In the extension **Readiness** tab, click **Copy Reviewer Report**.
2. Paste into a PR, journal submission note, or peer-review workflow.
3. The report is Markdown titled **Zeta Scientific Pre-Check Report**.

### Export Ledger (Extension)

1. In the extension popup, click **Export Ledger**.
2. A file `zeta-ledger.json` downloads with all review events.

### CLI Reports

After running `npm run zeta:check`, open:
- `zeta-report.md` — human-readable problems and fixes.
- `zeta-report.json` — structured data for tooling.

## Environment Variables

| Variable | Service | Required For | Notes |
|---|---|---|---|
| `MODAL_ENDPOINT_URL` | lean-backend | Backend → Modal inference | Modal deployed endpoint URL |
| `MODAL_API_KEY` | lean-backend | Backend auth to Modal | Modal authentication |
| `LLM_API_KEY` | lean-backend | LLM interpretation | OpenAI or compatible API key |
| `LLM_BASE_URL` | lean-backend | Custom LLM endpoint | Default: OpenAI, set for other providers |
| `LLM_MODEL` | lean-backend | LLM model name | Default: gpt-4.1-mini |
| `HF_TOKEN` | translator-modal | HuggingFace model download | Required to download DeepSeek model |
| `API_KEY` | translator-modal | Translator API auth | Modal deployment authentication |
| `ZETA_BACKEND_URL` | smoke test | Override backend URL | Default: http://localhost:8000 |
| `ENABLE_LLM_INTERPRETATION` | lean-backend | Enable/disable LLM | Default: true |
| `ENABLE_LLM_HIGHLIGHTS` | lean-backend | Enable/disable LLM highlights | Default: true |

## What Works Without Secrets

- Extension Dashboard in Demo Mode.
- In-Document Review Mode with **Use Demo Paper**.
- CLI: `npm run zeta:check -- --dir <path>`.
- Deterministic problem detection (notation, undefined symbols, theorem issues).
- Reviewer report generation (Markdown and JSON).
- Export Ledger button in popup.
- Backend health check endpoint.
- Smoke test (`npm run zeta:smoke:live`) against a running backend.

## What Requires Backend / Modal / LLM

- Backend must be running for health indicator and `/v1/lean/solve` calls.
- Modal/DeepSeek path optional; enables live model inference for enhanced reasoning.
- `LLM_API_KEY` optional; when set, enables AI-powered summary and highlights (not just heuristic fallback).
- `LLM_BASE_URL` and `LLM_MODEL` optional; configure non-OpenAI LLM providers.

## Known Limitations

- **Overleaf extraction fragile**: Real Overleaf DOM parsing may fail on complex documents or page layout changes. Use **Demo Paper** mode for reliable demo.
- **AI summary is heuristic fallback**: Without `LLM_API_KEY`, the extension shows **”Heuristic fallback”** instead of AI-generated text. Backend is not required for demo; it only improves quality.
- **No multiplayer support**: Zeta is a solo author pre-check tool. Concurrent document edits are not synchronized.
- **Style guide not yet implemented**: Notation rules are hard-coded. Custom journal style rules are future work.
- **Limited theorem extraction**: Only simple `\begin{theorem}...\end{theorem}` syntax. Complex macro definitions and custom environments may be missed.

## Demo Script for Judges (5 minutes)

### Setup (1 min)

1. Open Chrome with the Zeta extension loaded.
2. Open the Zeta popup (click extension icon).
3. Ensure the **Readiness** tab is selected.

### Live in-document demo (3 min)

1. Open the extension popup and click the **Readiness** tab. Say: “Zeta is running in Demo Mode because we don't have secrets configured. The dashboard scans LaTeX for notation problems.”
2. Look at the **Certified Demo Mode** stamp and explain: “This prevents anyone from mistaking a prototype for a real certification.”
3. Click **Use Demo Paper** if it's not already active. Point to the problem symbol chips (`\sigma` and `\tau`) and say: “Zeta found two issues: notation drift and use-before-definition.”
4. Click **Next Issue** to show the `\sigma` notation drift card. Read the “Why this matters” text aloud: “Zeta explains why this matters to a reviewer. A human spellchecker wouldn't catch this.”
5. Click **Copy Suggested Fix** and point to the copied author-facing language. Say: “Authors can use this verbatim in revision notes.”
6. Click **Next Issue** to show the `\tau` use-before-definition warning.
7. Click **Copy Reviewer Report** and say: “One click exports the full peer-review report in Markdown. This goes into a PR, journal submission note, or review workflow.”

### Optional: Show CLI (1 min)

1. In a terminal, run: `npm run zeta:check -- --dir apps/overleaf-extension`
2. Open `zeta-report.md` and say: “The CLI produces the same pre-check without the UI. Useful for CI gates.”
3. Mention: `npm run zeta:check -- --dir <path> --strict` fails CI if issues found.

### Closing (1 min)

“Zeta is a scientific publishing pre-check tool. It catches notation and theorem issues a grammar tool would miss. The deterministic path works today without secrets; the backend and Modal path unlock live model inference for stronger reasoning. The prototype is careful: it's labeled Demo Mode, not full certification.”
