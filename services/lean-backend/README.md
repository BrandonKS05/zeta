# Lean Backend Service

Minimal, production-leaning FastAPI backend for NL theorem/proof -> Lean generation + compile + error interpretation.

## Features

- `POST /v1/lean/solve`
  - Calls Modal endpoint to generate Lean code.
  - For Modal endpoints ending with `/v1/analyze`, request payload is sent as:
    - `text` <- `nl_input`
    - `theorem_name` <- `context.theorem_name` (or fallback `generated_theorem`)
    - `imports` <- `context.imports` (default `["Std"]`)
    - `temperature` <- `context.temperature` (default `0.0`)
  - Compiles Lean code locally (`lean` or `lake env lean`).
  - Parses compiler diagnostics into structured objects.
  - Optionally calls an LLM to interpret Lean compiler errors into frontend-friendly guidance.
  - Interpretation items include location-aware edit hints (`latex_start`/`latex_end` and `lean_line`/`lean_column` when available).
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
  requirements.txt
```

## Required Environment Variables

- `MODAL_ENDPOINT_URL` (required): Modal HTTP endpoint for Lean generation.

## Optional Environment Variables

- Modal:
  - `MODAL_API_KEY`
  - `MODAL_TIMEOUT_SECONDS` (default `20`)
  - `MODAL_MAX_RETRIES` (default `2`)
- Lean compile:
  - `LEAN_COMMAND` (default `lean`)
  - `LAKE_COMMAND` (default `lake`)
  - `LAKE_PROJECT_DIR` (if set, compile via `lake env lean`)
  - `LEAN_TIMEOUT_SECONDS` (default `15`)
  - `COMPILER_OUTPUT_MAX_CHARS` (default `20000`)
- LLM interpretation:
  - `ENABLE_LLM_INTERPRETATION` (default `true`)
  - `LLM_ENDPOINT_URL` (full endpoint override)
  - `LLM_BASE_URL` (default `https://api.openai.com/v1`)
  - `LLM_API_KEY`
  - `LLM_MODEL` (default `gpt-4o-mini`)
  - `LLM_TIMEOUT_SECONDS` (default `30`)
  - `LLM_MAX_RETRIES` (default `1`)

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
  "interpretation_error": null
}
```

## Tests

```bash
cd /Users/williamfeng/Documents/treehacks-2026/services/lean-backend
source .venv/bin/activate
pytest -q
```
