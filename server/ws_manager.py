"""Per-session WebSocket connection registry.

Every browser viewing a session opens a WebSocket. New messages from any source
(learner POSTs, agent responses) are persisted then broadcast to every socket
in the session.
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def connect(self, session_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self._rooms.setdefault(session_id, set()).add(ws)

    def disconnect(self, session_id: str, ws: WebSocket) -> None:
        room = self._rooms.get(session_id)
        if room and ws in room:
            room.discard(ws)
        if room is not None and not room:
            self._rooms.pop(session_id, None)

    async def broadcast(self, session_id: str, payload: dict[str, Any]) -> None:
        room = list(self._rooms.get(session_id, ()))
        for ws in room:
            try:
                await ws.send_json(payload)
            except Exception:
                self.disconnect(session_id, ws)

    def lock_for(self, session_id: str) -> asyncio.Lock:
        """Per-session asyncio.Lock — used to serialize agent calls so that
        two parallel learner messages don't trigger two parallel Professor calls
        racing on the transcript state."""
        lock = self._locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[session_id] = lock
        return lock


manager = ConnectionManager()
