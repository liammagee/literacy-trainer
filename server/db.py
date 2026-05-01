"""SQLite-backed persistence for sessions, participants, and messages."""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
import string
import time
from contextlib import contextmanager
from pathlib import Path

# Ambiguous chars (0/O, 1/I/L) removed for human-friendly session codes.
_CODE_ALPHABET = "".join(
    c for c in string.ascii_uppercase + string.digits if c not in "0O1IL"
)
_CODE_LEN = 8

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  paper_title   TEXT NOT NULL,
  paper_text    TEXT NOT NULL,
  learner_level TEXT NOT NULL,
  model         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  final_score   REAL,
  final_summary TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  session_id   TEXT NOT NULL,
  learner_name TEXT NOT NULL,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, learner_name),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  speaker       TEXT NOT NULL,        -- 'professor' | 'partner' | 'learner' | 'system'
  learner_name  TEXT,                  -- only set when speaker='learner'
  recipient     TEXT,                  -- 'professor' | 'partner' | NULL
  text          TEXT NOT NULL,
  score         INTEGER,               -- score the Professor gave the previous learner answer
  justification TEXT,
  topic_tag     TEXT,
  ts            INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts);
"""


def _data_dir() -> Path:
    p = Path(os.environ.get("DATA_DIR", "./data")).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _db_path() -> Path:
    return _data_dir() / "sessions.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(), isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def cursor():
    conn = _connect()
    try:
        yield conn.cursor()
    finally:
        conn.close()


def init_db() -> None:
    with cursor() as c:
        c.executescript(SCHEMA)


def new_session_id() -> str:
    # Try a few times in the (vanishingly unlikely) event of collision.
    for _ in range(10):
        sid = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LEN))
        with cursor() as c:
            row = c.execute("SELECT 1 FROM sessions WHERE id = ?", (sid,)).fetchone()
            if not row:
                return sid
    raise RuntimeError("Could not allocate a unique session id")


def create_session(
    *,
    paper_title: str,
    paper_text: str,
    learner_level: str,
    model: str,
) -> str:
    sid = new_session_id()
    with cursor() as c:
        c.execute(
            "INSERT INTO sessions (id, paper_title, paper_text, learner_level, model, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (sid, paper_title, paper_text, learner_level, model, int(time.time() * 1000)),
        )
    return sid


def get_session(session_id: str) -> dict | None:
    with cursor() as c:
        row = c.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return dict(row) if row else None


def end_session(session_id: str, *, final_score: float | None, final_summary: str) -> None:
    with cursor() as c:
        c.execute(
            "UPDATE sessions SET ended_at = ?, final_score = ?, final_summary = ? WHERE id = ?",
            (int(time.time() * 1000), final_score, final_summary, session_id),
        )


def add_participant(session_id: str, learner_name: str) -> None:
    with cursor() as c:
        c.execute(
            "INSERT OR IGNORE INTO participants (session_id, learner_name, joined_at) VALUES (?, ?, ?)",
            (session_id, learner_name, int(time.time() * 1000)),
        )


def list_participants(session_id: str) -> list[str]:
    with cursor() as c:
        rows = c.execute(
            "SELECT learner_name FROM participants WHERE session_id = ? ORDER BY joined_at",
            (session_id,),
        ).fetchall()
    return [r["learner_name"] for r in rows]


def add_message(
    *,
    session_id: str,
    speaker: str,
    text: str,
    learner_name: str | None = None,
    recipient: str | None = None,
    score: int | None = None,
    justification: str | None = None,
    topic_tag: str | None = None,
) -> dict:
    ts = int(time.time() * 1000)
    with cursor() as c:
        c.execute(
            "INSERT INTO messages (session_id, speaker, learner_name, recipient, text, "
            "score, justification, topic_tag, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, speaker, learner_name, recipient, text, score, justification, topic_tag, ts),
        )
        msg_id = c.lastrowid
    return {
        "id": msg_id,
        "session_id": session_id,
        "speaker": speaker,
        "learner_name": learner_name,
        "recipient": recipient,
        "text": text,
        "score": score,
        "justification": justification,
        "topic_tag": topic_tag,
        "ts": ts,
    }


def list_messages(session_id: str) -> list[dict]:
    with cursor() as c:
        rows = c.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def list_recent_sessions(limit: int = 50) -> list[dict]:
    with cursor() as c:
        rows = c.execute(
            """
            SELECT s.id, s.paper_title, s.learner_level, s.model,
                   s.created_at, s.ended_at, s.final_score,
                   (SELECT COUNT(*) FROM participants p WHERE p.session_id = s.id) AS participant_count,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
            FROM sessions s
            ORDER BY s.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def session_to_json(session_id: str) -> str:
    """Single-blob export for offline analysis."""
    sess = get_session(session_id)
    if not sess:
        raise KeyError(session_id)
    sess["participants"] = list_participants(session_id)
    sess["messages"] = list_messages(session_id)
    return json.dumps(sess, indent=2)
