from __future__ import annotations

import os
from pathlib import Path

from fastapi.staticfiles import StaticFiles

from backend.app import app


PUBLIC_DIR = Path(__file__).resolve().parent / 'public'

if not os.getenv('VERCEL') and PUBLIC_DIR.exists():
    app.mount('/', StaticFiles(directory=PUBLIC_DIR, html=True), name='frontend')
