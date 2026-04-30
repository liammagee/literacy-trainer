"""PDF -> plain text. Server-side replacement for the old PDF.js + vendor dance."""
from __future__ import annotations

from io import BytesIO

from pypdf import PdfReader


def extract_text(pdf_bytes: bytes) -> tuple[str, int]:
    """Return (text, num_pages). Raises ValueError if the file is unreadable."""
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
    except Exception as e:
        raise ValueError(f"Could not parse PDF: {e}") from e
    pages: list[str] = []
    for page in reader.pages:
        try:
            pages.append(page.extract_text() or "")
        except Exception:
            # A single bad page shouldn't sink the whole document.
            pages.append("")
    return ("\n\n".join(p.strip() for p in pages if p.strip()), len(reader.pages))
