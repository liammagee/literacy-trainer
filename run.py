#!/usr/bin/env python3
"""Boot the FastAPI server and open the app in a browser.

Usage:
    python run.py                  # bind 127.0.0.1:8765
    HOST=0.0.0.0 python run.py     # expose on the LAN (e.g. for a classroom)
    PORT=9000 python run.py        # alternate port
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser

from dotenv import load_dotenv

load_dotenv()


def _find_open_port(start: int, tries: int = 50) -> int:
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError(f"No open port between {start} and {start + tries}")


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        sys.stderr.write(
            "WARNING: ANTHROPIC_API_KEY is not set. The server will start, but any "
            "agent call will fail until you add it to .env (copy .env.example).\n"
        )

    host = os.environ.get("HOST", "127.0.0.1")
    requested_port = int(os.environ.get("PORT", "8765"))
    port = _find_open_port(requested_port) if host in {"127.0.0.1", "localhost"} else requested_port

    url = f"http://localhost:{port}/"
    print("=" * 60)
    print("  Literacy Trainer")
    print(f"  Serving at:  {url}")
    print(f"  Bind:        {host}:{port}")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)

    if host in {"127.0.0.1", "localhost"} and not os.environ.get("NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    import uvicorn
    uvicorn.run("server.main:app", host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
