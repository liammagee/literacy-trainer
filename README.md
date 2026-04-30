# Literacy Trainer

A two-agent Socratic oral-exam tool for journal articles. Learners read a paper,
then face **The Professor** (who asks open-ended questions and scores answers
1–10) alongside **The Study Partner** (a Socratic helper who never gives the
answer outright).

This is a client/server refactor of an earlier single-page prototype. The server
holds the Anthropic API key, persists every session to SQLite, and broadcasts
new messages to all browsers viewing a session in real time — so a group of
learners can take the exam together while an instructor (or analyst) reviews the
transcripts later.

---

## Modes

The setup screen offers three options:

| Mode               | Where the model runs       | Persisted? | Multi-user? | API key needed in browser? |
|--------------------|----------------------------|------------|-------------|----------------------------|
| **Group session**  | Server → Anthropic         | Yes (SQLite) | Yes (share code) | No |
| **Join session**   | Server → Anthropic         | Yes        | Yes         | No |
| **Solo offline**   | Browser (WebLLM, WebGPU)   | No         | No          | No |

Group mode is the default. WebLLM is preserved as a no-internet fallback for
single learners; it never talks to the server.

---

## Quick start

```bash
git clone https://github.com/<you>/literacy-trainer.git
cd literacy-trainer

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# edit .env, set ANTHROPIC_API_KEY=sk-ant-...

python run.py
```

The server starts on `http://localhost:8765/` and opens a browser tab.

### Run for a classroom (LAN)

```bash
HOST=0.0.0.0 PORT=8765 python run.py
```

Then share `http://<your-LAN-IP>:8765/` with learners on the same network.
They open the URL, choose **Join an existing group session by code**, paste
the 8-character code shown in the host's browser, and they're in.

---

## Architecture

```
┌─────────────┐       HTTPS + WebSocket      ┌──────────────────────────┐
│  Browser    │ ◄─────────────────────────► │ FastAPI                  │
│  (UI only)  │                              │  • /api/sessions         │
│             │                              │  • /ws/sessions/{id}     │
│             │                              │  • /api/extract-pdf      │
└─────────────┘                              │  • Anthropic API key     │
                                             │  • Per-session asyncio   │
                                             │    Lock serializes agent │
                                             │    calls                 │
                                             └──────────┬───────────────┘
                                                        │
                                                        ▼
                                                ./data/sessions.db
                                                (SQLite, WAL)
```

**Key flow** (server mode):

1. Creator browser POSTs `/api/sessions` with the article text and learner level. Server returns a session id (e.g. `ABCD2345`).
2. Server kicks off the Professor's first question in the background. Creator browser opens a WebSocket to `/ws/sessions/{id}` and receives the question via push.
3. Joiners GET `/?s=ABCD2345`; the page reads the code from the URL and opens the same WebSocket. They see the full history on connect, then live updates.
4. Each learner POSTs to `/api/sessions/{id}/messages`. Server persists, broadcasts via WS, then triggers the addressed agent (Professor or Study Partner) under a per-session `asyncio.Lock` so two parallel learner messages don't race.
5. Agents persist their replies and broadcast them. Every browser shows the same transcript in the same order.

---

## API

| Method | Path                                  | Purpose |
|--------|---------------------------------------|---------|
| GET    | `/api/health`                         | health + key-present indicator |
| GET    | `/api/config`                         | default + allowed Claude models |
| POST   | `/api/sessions`                       | create a session, returns id |
| GET    | `/api/sessions`                       | list recent sessions (for analysis) |
| GET    | `/api/sessions/{id}`                  | session metadata + full message history |
| POST   | `/api/sessions/{id}/join`             | record a participant joining |
| POST   | `/api/sessions/{id}/messages`         | send a learner message |
| POST   | `/api/sessions/{id}/end`              | trigger the Professor's wrap-up |
| GET    | `/api/sessions/{id}/transcript.md`    | server-rendered Markdown |
| GET    | `/api/sessions/{id}/transcript.json`  | full session export |
| POST   | `/api/extract-pdf`                    | upload a PDF, returns extracted text |
| WS     | `/ws/sessions/{id}`                   | push-only event stream |

WebSocket events: `message`, `score`, `participant_joined`, `session_ended`, `error`.

---

## Storage layout

```
data/
└── sessions.db   # SQLite, three tables: sessions, participants, messages
```

For later analysis you can:
- Query the database directly (`sqlite3 data/sessions.db`)
- Hit `GET /api/sessions/{id}/transcript.json` for a single-blob export
- Hit `GET /api/sessions` to list recent sessions

The `data/` directory is `.gitignore`d — transcripts stay on the host that
ran the server.

---

## Configuration

Environment variables (read from `.env` via `python-dotenv`):

| Variable             | Required | Default             | Notes |
|----------------------|----------|---------------------|-------|
| `ANTHROPIC_API_KEY`  | yes      | —                   | the only secret. Never sent to clients. |
| `CLAUDE_MODEL`       | no       | `claude-sonnet-4-6` | default model for new sessions |
| `HOST`               | no       | `127.0.0.1`         | use `0.0.0.0` to expose on the LAN |
| `PORT`               | no       | `8765`              | |
| `DATA_DIR`           | no       | `./data`            | where SQLite lives |

---

## Security notes

- The Anthropic key lives on the server only. Browsers never see it.
- Session codes are 8 chars from a 32-symbol alphabet (~10¹² combinations,
  ambiguous chars removed). Anyone with the code can join — treat the code
  as the access control. For sensitive use cases, run the server on a
  private network or put a reverse proxy with auth in front of it.
- No identity / login; learners pick a display name when joining. Good
  enough for classroom use, not for production.

---

## Roadmap (not done yet)

- Real authentication (e.g. magic links) for non-classroom contexts
- Resumable sessions for the participant who created them
- Admin dashboard listing all stored sessions
- Per-learner score breakdown in the final report (group mode currently scores per answer; the wrap-up is whole-group)
