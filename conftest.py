from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
for relative in ("services/lean-backend", "services/translator-modal"):
    path = str(ROOT / relative)
    if path not in sys.path:
        sys.path.insert(0, path)
