from __future__ import annotations

import os
from functools import lru_cache

from pydantic import BaseModel


class Settings(BaseModel):
    app_name: str = "lean-backend"
    log_level: str = "INFO"

    modal_endpoint_url: str | None = None
    modal_api_key: str | None = None
    modal_use_generate_endpoint: bool = True
    modal_timeout_seconds: float = 20.0
    modal_max_retries: int = 2

    lean_command: str = "lean"
    lake_command: str = "lake"
    elan_command: str = "elan"
    lake_project_dir: str | None = None
    lean_temp_dir: str | None = None
    elan_home: str | None = None
    require_lake_for_mathlib: bool = True
    auto_configure_elan_toolchain: bool = True
    elan_default_toolchain: str = "stable"
    elan_toolchain_install_timeout_seconds: float = 180.0
    lean_timeout_seconds: float = 15.0
    compiler_output_max_chars: int = 20_000

    enable_llm_interpretation: bool = True
    llm_endpoint_url: str | None = None
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str | None = None
    llm_model: str = "gpt-5-nano"
    llm_max_completion_tokens: int = 220
    llm_timeout_seconds: float = 60.0
    llm_max_retries: int = 1
    enable_llm_highlights: bool = True
    llm_highlight_timeout_seconds: float = 12.0
    llm_highlight_max_retries: int = 0


def _env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings(
        app_name=_env("APP_NAME", "lean-backend"),
        log_level=_env("LOG_LEVEL", "INFO"),
        modal_endpoint_url=_env("MODAL_ENDPOINT_URL"),
        modal_api_key=_env("MODAL_API_KEY"),
        modal_use_generate_endpoint=_env("MODAL_USE_GENERATE_ENDPOINT", "true"),
        modal_timeout_seconds=_env("MODAL_TIMEOUT_SECONDS", "20"),
        modal_max_retries=_env("MODAL_MAX_RETRIES", "2"),
        lean_command=_env("LEAN_COMMAND", "lean"),
        lake_command=_env("LAKE_COMMAND", "lake"),
        elan_command=_env("ELAN_COMMAND", "elan"),
        lake_project_dir=_env("LAKE_PROJECT_DIR"),
        lean_temp_dir=_env("LEAN_TEMP_DIR"),
        elan_home=_env("ELAN_HOME"),
        require_lake_for_mathlib=_env("REQUIRE_LAKE_FOR_MATHLIB", "true"),
        auto_configure_elan_toolchain=_env("AUTO_CONFIGURE_ELAN_TOOLCHAIN", "true"),
        elan_default_toolchain=_env("ELAN_DEFAULT_TOOLCHAIN", "stable"),
        elan_toolchain_install_timeout_seconds=_env(
            "ELAN_TOOLCHAIN_INSTALL_TIMEOUT_SECONDS", "180"
        ),
        lean_timeout_seconds=_env("LEAN_TIMEOUT_SECONDS", "15"),
        compiler_output_max_chars=_env("COMPILER_OUTPUT_MAX_CHARS", "20000"),
        enable_llm_interpretation=_env("ENABLE_LLM_INTERPRETATION", "true"),
        llm_endpoint_url=_env("LLM_ENDPOINT_URL"),
        llm_base_url=_env("LLM_BASE_URL", "https://api.openai.com/v1"),
        llm_api_key=_env("LLM_API_KEY"),
        llm_model=_env("LLM_MODEL", "gpt-5-nano"),
        llm_max_completion_tokens=_env("LLM_MAX_COMPLETION_TOKENS", "220"),
        llm_timeout_seconds=_env("LLM_TIMEOUT_SECONDS", "60"),
        llm_max_retries=_env("LLM_MAX_RETRIES", "1"),
        enable_llm_highlights=_env("ENABLE_LLM_HIGHLIGHTS", "true"),
        llm_highlight_timeout_seconds=_env("LLM_HIGHLIGHT_TIMEOUT_SECONDS", "12"),
        llm_highlight_max_retries=_env("LLM_HIGHLIGHT_MAX_RETRIES", "0"),
    )
