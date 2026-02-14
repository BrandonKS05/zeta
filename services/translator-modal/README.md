# Modal backend (`FrenzyMath/Herald_translator`)

## 1. Prerequisites

- Python 3.11+
- Modal account and credits

## 2. Local setup

```bash
cd /Users/aryan/Desktop/treehacks-2026/services/translator-modal
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-local.txt
modal setup
```

Optional (recommended for model download reliability):

```bash
export HF_TOKEN=hf_xxx
```

## 3. Deploy

```bash
cd /Users/aryan/Desktop/treehacks-2026
modal deploy services/translator-modal/modal_app.py
```

Deployment creates:

- `translate_rpc` (GPU function)
- `translate_http` (HTTP POST endpoint)

## 4. Test with Python (Modal SDK direct call)

```bash
cd /Users/aryan/Desktop/treehacks-2026/services/translator-modal
source .venv/bin/activate
python query_modal.py \
  --text "Hello, how are you?" \
  --source-lang English \
  --target-lang French
```

## 5. Test with Python (HTTP call)

Use the URL printed by `modal deploy` for `translate_http`.

```bash
python query_http.py \
  --url "https://<your-endpoint>.modal.run" \
  --text "This is a test." \
  --source-lang English \
  --target-lang Spanish
```

## 6. Notes on cost + scaling

- The model is large (~27.6GB repo files), so first cold start can take time.
- Keep `scaledown_window` non-trivial to reduce repeated cold starts.
- Start with one GPU container, measure latency and spend, then scale.
