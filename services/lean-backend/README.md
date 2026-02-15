# Lean Backend Service

Minimal, production-leaning FastAPI backend for NL theorem/proof -> Lean generation + compile + error interpretation.

## Features

- `POST /v1/lean/solve`
  - Calls Modal endpoint to generate Lean code.
  - Payload mapping depends on Modal endpoint form:
    - Root endpoint (e.g. `https://...modal.run`): forwards backend schema unchanged:
      - `nl_input`, `context`, `max_iters`
      - preserves all custom fields inside `context`
    - Explicit translator API endpoints (`/v1/analyze`, `/v1/generate`, `/v1/query`): sends:
    - `text` <- `nl_input`
    - `theorem_name` <- `context.theorem_name` (or fallback `generated_theorem`)
    - `imports` <- `context.imports` (default `["Std"]`)
    - `temperature` <- `context.temperature` (default `0.0`)
    - `mode` <- `context.mode` (`fast` or `thinking`), with auto-`thinking` when `max_iters > 1`
    - `max_iters` <- top-level request `max_iters` when mode is `thinking`
    - optional pass-through: `include_iteration_history`, `include_raw_model_output` from `context`
  - Compiles Lean code locally (`lean` or `lake env lean`).
  - Parses compiler diagnostics into structured objects.
  - Optionally calls an LLM to interpret Lean compiler errors into frontend-friendly guidance.
  - Interpretation items include location-aware edit hints (`latex_start`/`latex_end` and `lean_line`/`lean_column` when available).
  - If compilation fails, resolves text highlights in the same pipeline and returns:
    - `highlights`: structured spans for frontend highlighting
    - `dashboard`: summary/messages/next actions for dashboard UI
- `POST /v1/lean/highlights`
  - Standalone highlight resolver that accepts `{chunks, interpretation, activeChunkId}`.
  - Uses LLM-first matching (when configured), then deterministic fallback.
- `GET /healthz`
- Async I/O (`httpx`, async subprocess), retries, and timeouts.
- Request-scoped logging with `request_id`.

## Project Structure

```text
services/lean-backend/
  app/
    main.py
    models.py
    modal_client.py
    lean_compile.py
    llm_client.py
    settings.py
    utils.py
  tests/
    test_api.py
    test_lean_compile.py
  Dockerfile
  docker-compose.yml
  scripts/bootstrap_mathlib_project.sh
  requirements.txt
```

## Required Environment Variables

- `MODAL_ENDPOINT_URL` (required): Modal HTTP endpoint for Lean generation (root URL or explicit API path).

## Optional Environment Variables

- Modal:
  - `MODAL_API_KEY`
  - `MODAL_USE_GENERATE_ENDPOINT` (default `true`; rewrites `/v1/analyze` or `/v1/query` to `/v1/generate`, but leaves root endpoints unchanged)
  - `MODAL_TIMEOUT_SECONDS` (default `20`)
  - `MODAL_MAX_RETRIES` (default `2`)
- Lean compile:
  - `LEAN_COMMAND` (default `lean`)
  - `LAKE_COMMAND` (default `lake`)
  - `ELAN_COMMAND` (default `elan`)
  - `LAKE_PROJECT_DIR` (if set, compile via `lake env lean`)
  - `LEAN_TEMP_DIR` (optional parent dir for temp compile files)
  - `ELAN_HOME` (optional custom elan toolchain location)
  - `REQUIRE_LAKE_FOR_MATHLIB` (default `true`; reject Mathlib imports when no `LAKE_PROJECT_DIR`)
  - `AUTO_CONFIGURE_ELAN_TOOLCHAIN` (default `true`; when Lean reports "no default toolchain configured", run `elan default ...` once and retry)
  - `ELAN_DEFAULT_TOOLCHAIN` (default `stable`; toolchain passed to `elan default`)
  - `ELAN_TOOLCHAIN_INSTALL_TIMEOUT_SECONDS` (default `180`)
  - `LEAN_TIMEOUT_SECONDS` (default `15`)
  - `COMPILER_OUTPUT_MAX_CHARS` (default `20000`)

Note on toolchain persistence:
- Set `ELAN_HOME` to a persistent mounted path (default in docker-compose: `/lean-state/elan`) so required Lean toolchains (for example `v4.28.0-rc1`) are downloaded once and reused across container restarts/redeploys.
- LLM interpretation:
  - `ENABLE_LLM_INTERPRETATION` (default `true`)
  - `ENABLE_LLM_HIGHLIGHTS` (default `true`)
  - `LLM_ENDPOINT_URL` (full endpoint override)
  - `LLM_BASE_URL` (default `https://api.openai.com/v1`)
  - `LLM_API_KEY`
  - `LLM_MODEL` (default `gpt-5-nano`)
  - `LLM_MAX_COMPLETION_TOKENS` (default `220`; caps interpretation output size/latency)
  - `LLM_TIMEOUT_SECONDS` (default `30`)
  - `LLM_MAX_RETRIES` (default `1`)
  - `LLM_HIGHLIGHT_TIMEOUT_SECONDS` (default `12`)
  - `LLM_HIGHLIGHT_MAX_RETRIES` (default `0`)

See `.env.example` for a complete template.

## Lean 4 Installation (Local)

Install Lean via `elan`:

```bash
curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh
source "$HOME/.elan/env"
elan default stable
lean --version
lake --version
```

If you need project context (imports, dependencies), set `LAKE_PROJECT_DIR` to an existing Lean/Lake project directory.

## Local Run

```bash
cd /Users/williamfeng/Documents/treehacks-2026/services/lean-backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

## Docker Run

```bash
cd /Users/williamfeng/Documents/treehacks-2026/services/lean-backend
cp .env.example .env
# edit .env
docker compose up --build
```

`INSTALL_LEAN` defaults to `true` in Docker, so Lean/Lake are installed unless you explicitly set `INSTALL_LEAN=false`.

To initialize a persistent Mathlib Lake project for compilation, run:

```bash
./scripts/bootstrap_mathlib_project.sh /opt/lean-state/mathlib-project
```

Then set:

```bash
LAKE_PROJECT_DIR=/opt/lean-state/mathlib-project
```

## EC2 Deployment (Modal model + EC2 Lean compile)

This backend already supports the architecture:
- NL -> Lean generation is called over HTTP at `MODAL_ENDPOINT_URL`
- Lean compilation runs locally on the EC2 host/container

Recommended AWS setup:

1. Use a persistent disk path (EBS) for Lean/Lake state:
   - Example path: `/opt/lean-state`
2. Bootstrap Mathlib project once:
   - `./scripts/bootstrap_mathlib_project.sh /opt/lean-state/mathlib-project`
3. Configure env:
   - `MODAL_ENDPOINT_URL=https://...modal.run`
   - `LAKE_PROJECT_DIR=/opt/lean-state/mathlib-project`
   - `LEAN_TEMP_DIR=/opt/lean-state/tmp`
   - `LEAN_TIMEOUT_SECONDS=30` (optional for heavier imports)
4. Start server (`docker compose up -d --build` or `uvicorn ...`)

If your generated Lean never imports Mathlib, `LAKE_PROJECT_DIR` is optional.

`docker-compose.yml` now mounts a persistent state directory by default:
- host `${LEAN_STATE_DIR:-./.lean-state}` -> container `/lean-state`

## Example Request

```bash
curl -X POST "http://localhost:8000/v1/lean/solve" \
  -H "Content-Type: application/json" \
  -H "X-Request-ID: demo-123" \
  -d '{
    "nl_input": "Prove that for any natural number n, n = n",
    "context": {"domain": "Nat"},
    "max_iters": 1
  }'
```

Example response shape:

```json
{
  "lean_code": "theorem refl_nat (n : Nat) : n = n := by rfl",
  "compile": {
    "success": true,
    "stdout": "",
    "stderr": "",
    "diagnostics": []
  },
  "interpretation": null,
  "interpretation_error": null,
  "highlights": {
    "highlights": [],
    "items": [],
    "unresolved_items": [],
    "resolver": "deterministic",
    "resolver_error": null
  },
  "dashboard": {
    "status": "ok",
    "headline": "Lean compiled successfully.",
    "messages": [],
    "next_actions": []
  }
}
```

## Tests

```bash
cd /Users/williamfeng/Documents/treehacks-2026/services/lean-backend
source .venv/bin/activate
pytest -q
```
