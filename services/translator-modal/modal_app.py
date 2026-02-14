"""Modal deployment for FrenzyMath/Herald_translator."""

from __future__ import annotations

import os
from dataclasses import dataclass

import modal
from pydantic import BaseModel, Field

APP_NAME = "herald-translator"
MODEL_ID = "FrenzyMath/Herald_translator"
HF_CACHE_DIR = "/cache/hf"

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch>=2.3.0")
    .pip_install("transformers>=4.48.0", "accelerate>=1.0.0", "safetensors>=0.4.5")
)

hf_cache = modal.Volume.from_name("hf-model-cache", create_if_missing=True)

_runtime = None

gpu_function_kwargs = {
    "image": image,
    "gpu": "L4",
    "timeout": 900,
    "scaledown_window": 600,
    "volumes": {"/cache": hf_cache},
}
if os.environ.get("HF_TOKEN"):
    gpu_function_kwargs["secrets"] = [modal.Secret.from_dict({"HF_TOKEN": os.environ["HF_TOKEN"]})]


@dataclass
class Runtime:
    tokenizer: object
    model: object


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1)
    source_lang: str = "English"
    target_lang: str = "Spanish"
    max_new_tokens: int = Field(default=128, ge=1, le=512)
    temperature: float = Field(default=0.2, ge=0.0, le=1.5)


def _build_prompt(text: str, source_lang: str, target_lang: str) -> str:
    return (
        f"Translate from {source_lang} to {target_lang}. "
        "Return only the translated text.\n\n"
        f"Text:\n{text}"
    )


def _load_runtime() -> Runtime:
    global _runtime
    if _runtime is not None:
        return _runtime

    os.environ["HF_HOME"] = HF_CACHE_DIR
    os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    token = os.environ.get("HF_TOKEN")

    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        token=token,
    )
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID,
        token=token,
        torch_dtype=torch.float16,
        device_map="auto",
    )
    model.eval()

    _runtime = Runtime(tokenizer=tokenizer, model=model)
    return _runtime


def _generate_translation(
    text: str,
    source_lang: str,
    target_lang: str,
    max_new_tokens: int,
    temperature: float,
) -> str:
    import torch

    runtime = _load_runtime()
    tokenizer = runtime.tokenizer
    model = runtime.model

    if getattr(tokenizer, "chat_template", None):
        messages = [
            {"role": "system", "content": "You are a translation assistant."},
            {
                "role": "user",
                "content": _build_prompt(
                    text=text, source_lang=source_lang, target_lang=target_lang
                ),
            },
        ]
        prompt = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
    else:
        prompt = _build_prompt(text=text, source_lang=source_lang, target_lang=target_lang)

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    do_sample = temperature > 0
    generate_kwargs = {
        **inputs,
        "max_new_tokens": max_new_tokens,
        "do_sample": do_sample,
        "pad_token_id": tokenizer.eos_token_id,
    }
    if do_sample:
        generate_kwargs["temperature"] = temperature
        generate_kwargs["top_p"] = 0.95

    with torch.inference_mode():
        outputs = model.generate(**generate_kwargs)

    input_tokens = inputs["input_ids"].shape[1]
    generated = outputs[0][input_tokens:]
    return tokenizer.decode(generated, skip_special_tokens=True).strip()


@app.function(**gpu_function_kwargs)
def translate_rpc(
    text: str,
    source_lang: str = "English",
    target_lang: str = "Spanish",
    max_new_tokens: int = 128,
    temperature: float = 0.2,
) -> dict:
    translation = _generate_translation(
        text=text,
        source_lang=source_lang,
        target_lang=target_lang,
        max_new_tokens=max_new_tokens,
        temperature=temperature,
    )
    return {
        "model": MODEL_ID,
        "source_lang": source_lang,
        "target_lang": target_lang,
        "input": text,
        "translation": translation,
    }


@app.function(image=image, timeout=120)
@modal.fastapi_endpoint(method="POST")
def translate_http(request: TranslateRequest) -> dict:
    return translate_rpc.remote(
        text=request.text,
        source_lang=request.source_lang,
        target_lang=request.target_lang,
        max_new_tokens=request.max_new_tokens,
        temperature=request.temperature,
    )
