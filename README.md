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

A live deployment is at **https://literacy-trainer.fly.dev/** (single shared
machine, classroom-grade); the rest of this README walks through running it
locally from scratch.

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

## Prerequisites

You need three things: **Python 3.11 or newer**, **git**, and an **Anthropic API
key**. The first two cover the local server; the third is what powers the
Professor and Study Partner.

### 1. Install Python

You can check what's already on your machine with:

```bash
python3 --version
```

If it prints `3.11.x` or higher, skip ahead. Otherwise:

**macOS** — the easiest path is Homebrew:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # if you don't have brew
brew install python@3.13
```
Apple's bundled `/usr/bin/python3` is fine if it's already 3.11+, but Homebrew
keeps you up to date and avoids surprises when macOS upgrades.

**Linux (Debian / Ubuntu)** — most distros ship a usable Python; only reach for
the deadsnakes PPA if you need a newer one than `apt` offers:
```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git
```

**Windows** — download the official installer from
<https://www.python.org/downloads/windows/>, run it, and **tick "Add python.exe
to PATH"** on the first screen. Then in PowerShell:
```powershell
python --version
```

### 2. Install git

If `git --version` doesn't work:
- macOS: `brew install git` (or `xcode-select --install`)
- Linux: covered by the apt line above
- Windows: <https://git-scm.com/download/win>

### 3. Get an Anthropic API key

The server makes one HTTPS call per agent turn. You'll need a key with billing
enabled.

1. Sign in / sign up at <https://console.anthropic.com/>.
2. Add a payment method under **Settings → Billing** and put a small starting
   balance on the account (the app uses Sonnet by default — a 30-minute classroom
   session typically costs cents, not dollars).
3. Go to **Settings → API Keys → Create Key**, give it a name like
   `literacy-trainer-local`, and **copy the `sk-ant-…` value immediately** — the
   console only shows it once.

Keep that key handy for the next section.

---

## Quick start

```bash
git clone https://github.com/liammagee/literacy-trainer.git
cd literacy-trainer

# Create an isolated Python environment so this project's deps don't pollute
# your system Python (or vice versa).
python3 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate

pip install -r requirements.txt

# Wire up your API key
cp .env.example .env
# edit .env in your editor of choice and replace sk-ant-... with the real key

python run.py
```

`run.py` finds an open port (default 8765, falls back if taken), starts uvicorn,
and opens the app in your default browser. You should see the setup screen at
`http://localhost:8765/`.

To stop the server, press `Ctrl+C` in the terminal. To resume next time:
```bash
cd literacy-trainer
source .venv/bin/activate
python run.py
```

### Run for a classroom (LAN)

```bash
HOST=0.0.0.0 PORT=8765 python run.py
```

Find your machine's LAN IP (`ipconfig getifaddr en0` on macOS,
`hostname -I` on Linux, `ipconfig` on Windows) and share
`http://<your-LAN-IP>:8765/` with learners on the same network. They open the
URL, choose **Join an existing group session by code**, paste the 8-character
code shown in your browser, and they're in.

---

## Using the app

### Starting a group session (host)

1. **Mode** → leave on *Group session*.
2. **Display name** → what other learners and the Professor will see (e.g.
   `Alex (instructor)`).
3. **Article & level** → pick a learner level (this calibrates the Professor's
   tone and depth), choose a model, and provide the article in one of three ways:
   - **Paste text** — fastest, works for anything you can get into a textarea.
   - **PDF upload** — the file is parsed on the server with `pypdf`; works on
     most journal PDFs but struggles with heavy two-column layouts and image-only
     scans.
   - **From web URL** — best-effort browser fetch; many publishers block this
     with CORS, in which case fall back to Paste.
4. Click **Begin session**. The server returns an 8-character code (e.g.
   `ABCD2345`), which appears in the header. Share that code with anyone you
   want to invite.

The Professor's first question streams into the left pane within a few seconds.

### Joining an existing session

A learner who got the code from a host:

1. Open the same site (or `http://<host-LAN-IP>:8765/`).
2. **Mode** → *Join an existing group session by code*.
3. Enter the code and a display name, click **Begin session**.
4. They land in the same room and immediately see the full transcript so far,
   plus any new messages live.

Tip: the join URL `?s=CODE` pre-fills the code, so a host can paste
`http://localhost:8765/?s=ABCD2345` directly into a chat instead of asking
people to type the code.

### Inside the exam

The session screen has two panes side-by-side:

- **The Professor (left, orange)** — asks open-ended questions about the
  paper, scores each learner reply 1–10, and decides when the exam is done. The
  score chip appears under the learner's most recent answer once the Professor
  responds.
- **The Study Partner (right, green)** — Socratic helper. Asks back, hints,
  scaffolds, but is system-prompted to never hand over the answer.

The composer at the bottom has an addressee dropdown so each message goes to
exactly one agent. Multi-learner rooms work because every browser sees every
message — when learner A is talking to the Professor, learner B can ask the
Study Partner a side question without crossing wires. A per-session asyncio
lock on the server serializes the agent calls so two simultaneous answers
don't race.

### Ending the session

Click **End Session** in the header. The Professor produces a final summary
and an overall score, and the result modal appears with:
- A big aggregate score
- The Professor's wrap-up feedback
- A scoreboard of every individual answer with its score and justification

You can export the transcript as Markdown or JSON from the bottom of the
composer, or from the result modal. The export endpoints are also reachable
directly (see [API](#api)) if you want to fetch them programmatically.

### Solo offline mode

*Solo offline* downloads a small model (Llama 3.2 3B by default, ~1.9 GB)
into your browser using WebLLM and runs everything on your GPU. It never talks
to the server, so:
- No transcript is saved.
- No code is generated and no one can join.
- It works without internet after the first download.

Use it if you want to demo the app on a plane, or if you're explicitly avoiding
sending paper content to a third-party API. Smaller models can struggle with
the strict JSON the Professor uses for scoring; the UI falls back to plain
text rendering when that happens.

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

## Capturing and analyzing transcripts

Every server-mode session is captured automatically — there is nothing extra
to enable. The data lives in a single SQLite file:

| Where you ran it           | Path to the DB                      |
|----------------------------|-------------------------------------|
| `python run.py` (local)    | `./data/sessions.db`                |
| `HOST=0.0.0.0 python run.py` (LAN) | `./data/sessions.db` on the host |
| Deployed to fly.io         | `/data/sessions.db` inside the VM (mounted volume `literacy_data`) |

The `data/` directory is `.gitignore`d, so transcripts stay on the host that
ran the server.

### Schema at a glance

Three tables, defined in [`server/db.py`](server/db.py):

- **`sessions`** — one row per exam. Holds `paper_title`, `paper_text`,
  `learner_level`, `model`, `created_at`, `ended_at`, `final_score`,
  `final_summary`. The id (`ABCD2345`) is the join code.
- **`participants`** — one row per `(session_id, learner_name)` pair, with
  `joined_at`. Picks up everyone who entered the room.
- **`messages`** — every utterance, ordered by autoincrement id. Columns:
  `speaker` (`professor` / `partner` / `learner` / `system`), `learner_name`
  (set when speaker = learner), `recipient` (which agent the learner addressed),
  `text`, `score` (1–10, attached to the *learner* message the Professor just
  graded), `justification`, `topic_tag`, `ts` (epoch ms).

There's an index on `(session_id, ts)` so per-session queries stay fast.

### Three ways to pull data out

**1. Direct SQL** — fastest for ad-hoc inspection. The `sqlite3` CLI ships with
macOS and most Linux distros:

```bash
cd literacy-trainer
sqlite3 data/sessions.db
```

Some recipes:

```sql
-- Recent sessions, with title and length
SELECT id, paper_title, learner_level, model,
       datetime(created_at/1000, 'unixepoch', 'localtime') AS started,
       (ended_at IS NOT NULL) AS finished,
       final_score
FROM sessions
ORDER BY created_at DESC
LIMIT 20;

-- Score distribution within one session
SELECT learner_name, COUNT(*) AS answers,
       AVG(score) AS avg, MIN(score) AS lo, MAX(score) AS hi
FROM messages
WHERE session_id = 'ABCD2345' AND speaker = 'learner' AND score IS NOT NULL
GROUP BY learner_name
ORDER BY avg DESC;

-- Topic coverage across all completed sessions
SELECT topic_tag, COUNT(*) AS hits
FROM messages
WHERE topic_tag IS NOT NULL
GROUP BY topic_tag
ORDER BY hits DESC;

-- Full transcript of one session, in order
SELECT speaker,
       COALESCE(learner_name, '') AS who,
       COALESCE(recipient, '') AS to_agent,
       score,
       text
FROM messages
WHERE session_id = 'ABCD2345'
ORDER BY id;
```

**2. JSON export endpoint** — best when you want a stable shape to feed into
another tool:

```bash
curl http://localhost:8765/api/sessions/ABCD2345/transcript.json > ABCD2345.json
```

The blob includes the session row, the full participants list, and every
message in order — the same data as the SQL above, deserialised once.

**3. Markdown export** — best for quick human review or pasting into a
Notion/Obsidian doc:

```bash
curl http://localhost:8765/api/sessions/ABCD2345/transcript.md > ABCD2345.md
```

To list all sessions (so you can find the ids without opening a browser):

```bash
curl http://localhost:8765/api/sessions | jq
```

### Notebook-style analysis with pandas

If you want to do anything beyond one-off queries, pull the messages table
into a DataFrame:

```python
import sqlite3
import pandas as pd

con = sqlite3.connect("data/sessions.db")
sessions = pd.read_sql_query("SELECT * FROM sessions", con)
messages = pd.read_sql_query("SELECT * FROM messages", con)

# Convert epoch ms to datetimes for plotting
for df in (sessions, messages):
    for col in [c for c in df.columns if c.endswith("_at") or c == "ts"]:
        df[col] = pd.to_datetime(df[col], unit="ms")

# Per-session score trajectory (one row per scored learner answer)
scores = messages[(messages.speaker == "learner") & messages.score.notna()]
trajectory = scores.groupby("session_id").apply(
    lambda g: g.sort_values("ts").assign(turn=range(1, len(g) + 1))[["turn", "score", "learner_name"]]
)
```

From there you can plot per-learner score curves, run topic-tag frequency
analysis, or export a CSV for whoever's writing up the assessment.

### Pulling transcripts off the deployed server

The fly.io deployment mounts SQLite at `/data/sessions.db` on the VM. To copy
it down for analysis:

```bash
flyctl ssh sftp shell --app literacy-trainer
# inside the sftp prompt:
get /data/sessions.db ./data/sessions-prod.db
exit
```

Or stream a single transcript over HTTPS:

```bash
curl https://literacy-trainer.fly.dev/api/sessions/ABCD2345/transcript.json > out.json
```

---

## Configuration

Environment variables (read from `.env` via `python-dotenv`):

| Variable             | Required | Default             | Notes |
|----------------------|----------|---------------------|-------|
| `ANTHROPIC_API_KEY`  | yes      | —                   | the only secret. Never sent to clients. |
| `CLAUDE_MODEL`       | no       | `claude-sonnet-4-6` | default model for new sessions |
| `HOST`               | no       | `127.0.0.1`         | use `0.0.0.0` to expose on the LAN |
| `PORT`               | no       | `8765`              | local-mode start; auto-falls-back if busy |
| `DATA_DIR`           | no       | `./data`            | where SQLite lives |

Allowed model ids (validated server-side in `server/main.py`):
`claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`,
`claude-haiku-4-5-20251001`.

---

## Deployment (fly.io)

The repo ships with `Dockerfile` and `fly.toml` ready to deploy:

```bash
# one-time: claim the app and create the volume
flyctl apps create literacy-trainer
flyctl volumes create literacy_data --app literacy-trainer --region lax --size 1
flyctl secrets set ANTHROPIC_API_KEY=sk-ant-... --app literacy-trainer

# every deploy:
flyctl deploy --app literacy-trainer
```

`fly.toml` pins `auto_stop_machines = false` and `min_machines_running = 1`
because the WebSocket rooms live in a process-local dict — letting fly stop or
fan out the only machine would split the room. For classroom-scale traffic that
single shared-cpu-1x / 512mb machine is plenty.

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
