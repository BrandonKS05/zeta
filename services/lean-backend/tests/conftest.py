from __future__ import annotations

import os

# Blank the LLM/Modal keys so no real external API calls are made during tests.
# Tests that exercise the LLM path do so via monkeypatch of the call sites.
# ENABLE_LLM_INTERPRETATION stays True (default) — the compile-failure tests need it.
os.environ["LLM_API_KEY"] = ""
os.environ["MODAL_ENDPOINT_URL"] = ""
os.environ["MODAL_API_KEY"] = ""

# Clear the lru_cache so get_settings() re-reads the blanked env vars above.
from app.settings import get_settings  # noqa: E402
get_settings.cache_clear()
