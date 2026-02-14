# Modal backend for math Grammarly (`FrenzyMath/Herald_translator`)

This service deploys a full NL -> Lean backend on Modal:

- GPU inference with `FrenzyMath/Herald_translator`
- Lean syntax/type checking with `lean`
- HTTP API for extension/frontend integration
- Modal RPC function for direct Python calls

## Endpoints and functions

- Modal function: `analyze_rpc` (GPU)
- Modal ASGI app: `api` (HTTP)

HTTP routes under the `api` endpoint:

- `GET /healthz`
- `POST /v1/analyze`
- `POST /v1/query` (alias of analyze)
- `POST /v1/generate` (fast path: skips Lean check)
- `POST /v1/analyze/jobs` (async submit)
- `GET /v1/analyze/jobs/{call_id}` (async poll)
- `POST /v1/warmup`

## 1. Prerequisites

- Python 3.11+
- Modal account with credits

## 2. Local setup

```bash
cd /Users/aryan/Desktop/treehacks-2026/services/translator-modal
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-local.txt
modal setup
```

## 3. Optional secrets and env

You can pass values directly via env vars, or reference existing Modal secrets by name.

```bash
# Hugging Face access
export HF_TOKEN=hf_xxx
# or: export HF_SECRET_NAME=your-hf-secret-name

# Optional API key protection for HTTP endpoints
export API_KEY=replace-with-random-string
# or: export GRAMMAR_API_SECRET_NAME=your-api-secret-name

# Optional CORS config for extension/frontend
export CORS_ALLOW_ORIGINS="*"
```

## 4. Deploy

```bash
cd /Users/aryan/Desktop/treehacks-2026
modal deploy services/translator-modal/modal_app.py
```

After deploy, Modal prints a URL for `api`. Use that as your backend base URL.

## 5. Warm up model (recommended once after deploy)

```bash
cd /Users/aryan/Desktop/treehacks-2026/services/translator-modal
source .venv/bin/activate
python query_http.py \
  --base-url "https://<your-api-endpoint>.modal.run" \
  --text "For all natural numbers n, n + 0 = n." \
  --context "Assume n is a natural number." \
  --theorem-name add_zero_right
```

Or hit:

```bash
curl -X POST "https://<your-api-endpoint>.modal.run/v1/warmup"
```

## 6. Query via Modal SDK (Python)

```bash
cd /Users/aryan/Desktop/treehacks-2026/services/translator-modal
source .venv/bin/activate
python query_modal.py \
  --text "If a and b are real numbers and a = b, then b = a." \
  --context "This is a symmetry property of equality over real numbers." \
  --theorem-name eq_symm_real \
  --imports Std
```

## 7. Query via HTTP (Python)

```bash
python query_http.py \
  --base-url "https://<your-api-endpoint>.modal.run" \
  --text "The sum of two even natural numbers is even." \
  --context "Use Nat and the Even predicate." \
  --theorem-name even_add \
  --imports Std
```

### Fast vs thinking mode

`/v1/analyze` supports two modes:

- `fast` (default): single-pass translation + Lean check (lowest latency)
- `thinking`: iterative Lean rewrite loop (re-checks and patches generated Lean statement type)

Thinking-mode example:

```bash
python query_http.py \
  --base-url "https://<your-api-endpoint>.modal.run" \
  --text "For all x, x plus zero equals x." \
  --theorem-name add_zero \
  --mode thinking \
  --max-iters 3 \
  --include-iteration-history
```

You can also use the Modal SDK helper with the same flags:

```bash
python query_modal.py \
  --text "For all x, x plus zero equals x." \
  --theorem-name add_zero \
  --mode thinking \
  --max-iters 3
```

## 8. Async query flow (recommended for Chrome extension)

Submit:

```bash
curl -X POST "https://<your-api-endpoint>.modal.run/v1/analyze/jobs" \
  -H "content-type: application/json" \
  -d '{
    "text": "For all natural numbers n, n + 0 = n.",
    "context": "Simple arithmetic identity.",
    "theorem_name": "add_zero_right",
    "imports": ["Std"]
  }'
```

Poll:

```bash
curl "https://<your-api-endpoint>.modal.run/v1/analyze/jobs/<call_id>"
```

If `API_KEY` is enabled:

```bash
python query_http.py \
  --base-url "https://<your-api-endpoint>.modal.run" \
  --text "Every natural number is less than or equal to itself." \
  --context "Reflexivity of <= on natural numbers." \
  --theorem-name le_refl_nat \
  --api-key "replace-with-random-string"
```

## 9. Response shape (high-level)

`/v1/analyze` returns:

- `statement_type` (generated Lean proposition/type)
- `lean_declaration` and full `lean_source`
- `diagnostics` from Lean compiler output
- `is_valid_lean` boolean
- `feedback` list (human-readable correction guidance)
- `mode` (`fast` or `thinking`)
- `iteration_count` (always `1` in fast mode)
- optional `iteration_history` when `include_iteration_history=true` in thinking mode

Input accepts optional `context` to disambiguate nearby math prose.

For low-latency UI suggestions, call `/v1/generate` (or set `skip_lean_check=true`) and run full `/v1/analyze` asynchronously in the background.

## 10. Cost and reliability notes

- First cold start is expensive because model weights are large.
- Keep `scaledown_window` non-trivial to avoid repeated cold starts.
- Start with one `L4`, measure end-to-end latency, then tune throughput.
- Run `/v1/warmup` after deploy to prime container + model cache.
- `/v1/warmup` now runs a real `analyze_rpc` Mathlib probe to warm the exact inference path used by `/v1/analyze`.
- Prefer async jobs for browser clients so cold starts do not block a single long HTTP request.
- Mathlib is auto-enabled when imports or generated symbols require it (`Real`, `Differentiable`, etc.).
- Warmup now pre-initializes Mathlib so first real Mathlib query is faster.
- Mathlib bootstrap runs one-time `lake update` and `lake exe cache get` into `/cache/lean/mathlib_checker`, then reuses cache.
- Added in-memory caches for:
  - full analyze responses (request-level cache)
  - model output (prompt-level cache)
  - Lean check results (statement-level cache, reused across theorem names)
- Default generation length reduced to `max_new_tokens=128` for faster statement generation.
- You can keep warm containers for low p95 latency via env:
  - `GPU_MIN_CONTAINERS`, `GPU_BUFFER_CONTAINERS`, `GPU_MAX_CONTAINERS`
  - `API_MIN_CONTAINERS`, `API_MAX_CONTAINERS`

## 11. Batch evaluation suite

Run all built-in test prompts and save responses:

```bash
cd /Users/aryan/Desktop/treehacks-2026/services/translator-modal
source .venv/bin/activate
python run_eval_suite.py \
  --base-url "https://<your-api-endpoint>.modal.run" \
  --async-jobs
```

Inputs are in:

- `/Users/aryan/Desktop/treehacks-2026/services/translator-modal/evals/cases.json`

Reports are saved under:

- `/Users/aryan/Desktop/treehacks-2026/services/translator-modal/evals/results/`

## 12. Paragraph-level dataset (ProofNet#)

Generate larger paragraph-level cases from Hugging Face dataset `PAug/ProofNetSharp`:

```bash
cd /Users/aryan/Desktop/treehacks-2026/services/translator-modal
source .venv/bin/activate
pip install -r requirements-dev.txt
python evals/build_proofnetsharp_cases.py \
  --split valid \
  --max-cases 100 \
  --output evals/cases_proofnetsharp_paragraph.json
```

Dataset references:

- [`PAug/ProofNetSharp`](https://huggingface.co/datasets/PAug/ProofNetSharp) (statement + natural language proof + Lean 4 formalization)
- [`nvidia/Nemotron-Math-Proofs-v1`](https://huggingface.co/datasets/nvidia/Nemotron-Math-Proofs-v1) (larger-scale option with Lean theorem formalizations)

Then run the eval suite on those cases:

```bash
python run_eval_suite.py \
  --base-url "https://<your-api-endpoint>.modal.run" \
  --cases-file evals/cases_proofnetsharp_paragraph.json \
  --async-jobs
```

## 13. Pytest

```bash
cd /Users/aryan/Desktop/treehacks-2026/services/translator-modal
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest
```
