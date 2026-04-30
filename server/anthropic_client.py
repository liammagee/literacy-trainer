"""Thin async client for Anthropic's /v1/messages endpoint.

The whole point of this server is that the API key lives here, not in the
browser. Treat the key as sensitive: never log it, never echo it back to the
client.
"""
from __future__ import annotations

import os

import httpx

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"


class AnthropicError(RuntimeError):
    pass


def _api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise AnthropicError(
            "ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in."
        )
    return key


async def call_claude(
    *,
    system: str,
    user_message: str,
    model: str,
    max_tokens: int = 1200,
    temperature: float = 0.4,
) -> str:
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "system": system,
        "messages": [{"role": "user", "content": user_message}],
    }
    headers = {
        "content-type": "application/json",
        "x-api-key": _api_key(),
        "anthropic-version": API_VERSION,
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        resp = await client.post(API_URL, json=body, headers=headers)
    if resp.status_code >= 400:
        raise AnthropicError(f"Anthropic {resp.status_code}: {resp.text[:400]}")
    data = resp.json()
    parts = [c.get("text", "") for c in data.get("content", []) if c.get("type") == "text"]
    return "\n".join(parts).strip()
