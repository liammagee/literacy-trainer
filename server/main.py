"""FastAPI app: REST endpoints + WebSocket broadcast for live group sessions."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import (
    Body,
    FastAPI,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from . import agents, db
from .pdf_extract import extract_text
from .ws_manager import manager

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"

DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
ALLOWED_MODELS = {
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
}

app = FastAPI(title="Literacy Trainer", version="1.0.0")


@app.on_event("startup")
async def _startup() -> None:
    db.init_db()


# --------------------------------------------------------------------- health & config

@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "anthropic_key_present": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()),
        "default_model": DEFAULT_MODEL,
    }


@app.get("/api/config")
async def config() -> dict:
    return {
        "default_model": DEFAULT_MODEL,
        "allowed_models": sorted(ALLOWED_MODELS),
    }


# --------------------------------------------------------------------- session CRUD

@app.post("/api/sessions")
async def create_session(payload: dict = Body(...)) -> dict:
    paper_title = (payload.get("paper_title") or "").strip() or "Untitled article"
    paper_text = (payload.get("paper_text") or "").strip()
    learner_level = (payload.get("learner_level") or "undergraduate").strip()
    model = (payload.get("model") or DEFAULT_MODEL).strip()
    learner_name = (payload.get("learner_name") or "").strip() or "Learner"

    if len(paper_text) < 200:
        raise HTTPException(400, "paper_text must be at least ~200 characters")
    if model not in ALLOWED_MODELS:
        raise HTTPException(400, f"model must be one of {sorted(ALLOWED_MODELS)}")

    sid = db.create_session(
        paper_title=paper_title,
        paper_text=paper_text,
        learner_level=learner_level,
        model=model,
    )
    db.add_participant(sid, learner_name)

    # Kick off the Professor's first question in the background so the HTTP
    # response returns immediately. Clients pick the message up via WebSocket.
    asyncio.create_task(_run_and_broadcast(sid, "professor", first_turn=True))

    return {"session_id": sid, "paper_title": paper_title, "model": model}


@app.get("/api/sessions/{sid}")
async def get_session(sid: str) -> dict:
    sess = db.get_session(sid)
    if not sess:
        raise HTTPException(404, "session not found")
    sess.pop("paper_text", None)  # heavy; clients don't need it
    sess["participants"] = db.list_participants(sid)
    sess["messages"] = db.list_messages(sid)
    return sess


@app.post("/api/sessions/{sid}/join")
async def join_session(sid: str, payload: dict = Body(...)) -> dict:
    if not db.get_session(sid):
        raise HTTPException(404, "session not found")
    learner_name = (payload.get("learner_name") or "").strip() or "Learner"
    db.add_participant(sid, learner_name)
    await manager.broadcast(sid, {"type": "participant_joined", "learner_name": learner_name})
    return {"ok": True, "learner_name": learner_name, "participants": db.list_participants(sid)}


@app.post("/api/sessions/{sid}/messages")
async def post_message(sid: str, payload: dict = Body(...)) -> dict:
    sess = db.get_session(sid)
    if not sess:
        raise HTTPException(404, "session not found")
    if sess.get("ended_at"):
        raise HTTPException(409, "session has ended")
    learner_name = (payload.get("learner_name") or "").strip() or "Learner"
    recipient = (payload.get("recipient") or "professor").strip()
    text = (payload.get("text") or "").strip()
    if recipient not in {"professor", "partner"}:
        raise HTTPException(400, "recipient must be 'professor' or 'partner'")
    if not text:
        raise HTTPException(400, "text is required")

    msg = db.add_message(
        session_id=sid,
        speaker="learner",
        learner_name=learner_name,
        recipient=recipient,
        text=text,
    )
    await manager.broadcast(sid, {"type": "message", "message": msg})
    asyncio.create_task(_run_and_broadcast(sid, recipient))
    return {"ok": True, "message_id": msg["id"]}


@app.post("/api/sessions/{sid}/end")
async def end_session(sid: str) -> dict:
    sess = db.get_session(sid)
    if not sess:
        raise HTTPException(404, "session not found")
    if sess.get("ended_at"):
        return {"ok": True, "already_ended": True}
    asyncio.create_task(_run_and_broadcast(sid, "professor", force_conclude=True))
    return {"ok": True}


# --------------------------------------------------------------------- exports & utilities

@app.get("/api/sessions/{sid}/transcript.json")
async def transcript_json(sid: str) -> Response:
    if not db.get_session(sid):
        raise HTTPException(404, "session not found")
    return Response(content=db.session_to_json(sid), media_type="application/json")


@app.get("/api/sessions/{sid}/transcript.md", response_class=PlainTextResponse)
async def transcript_markdown(sid: str) -> str:
    sess = db.get_session(sid)
    if not sess:
        raise HTTPException(404, "session not found")
    msgs = db.list_messages(sid)
    lines = [
        f"# Literacy Trainer — Session Transcript",
        "",
        f"**Article:** {sess['paper_title']}  ",
        f"**Model:** `{sess['model']}` · **Level:** {sess['learner_level']}  ",
        f"**Participants:** {', '.join(db.list_participants(sid)) or '(none)'}",
        "",
        "---",
    ]
    for m in msgs:
        if m["speaker"] == "professor":
            tag = "**The Professor**"
        elif m["speaker"] == "partner":
            tag = "**The Study Partner**"
        elif m["speaker"] == "learner":
            who = m.get("learner_name") or "Learner"
            target = "Study Partner" if m.get("recipient") == "partner" else "Professor"
            tag = f"**{who} → {target}**"
        else:
            tag = "**System**"
        lines.append("")
        lines.append(f"### {tag}")
        lines.append("")
        lines.append(m["text"])
        if m.get("score") is not None:
            j = m.get("justification") or ""
            lines.append("")
            lines.append(f"> **Score:** {m['score']}/10{(' — ' + j) if j else ''}")
    if sess.get("ended_at"):
        lines += [
            "",
            "---",
            "## Final assessment",
            "",
            f"**Final score:** {sess.get('final_score') or 'n/a'}",
            "",
            sess.get("final_summary") or "",
        ]
    return "\n".join(lines)


@app.get("/api/sessions")
async def list_sessions() -> list[dict]:
    return db.list_recent_sessions()


@app.post("/api/extract-pdf")
async def extract_pdf(file: UploadFile) -> dict:
    raw = await file.read()
    try:
        text, n_pages = extract_text(raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "filename": file.filename,
        "num_pages": n_pages,
        "char_count": len(text),
        "text": text,
    }


@app.get("/api/articles")
async def list_articles() -> list[dict]:
    """Distinct articles previously uploaded — for the 'From library' picker."""
    return db.list_distinct_articles()


@app.get("/api/articles/by-session/{sid}")
async def get_article_text(sid: str) -> dict:
    art = db.get_article_by_session(sid)
    if not art:
        raise HTTPException(404, "session not found")
    return art


# --------------------------------------------------------------------- WebSocket

@app.websocket("/ws/sessions/{sid}")
async def ws_session(websocket: WebSocket, sid: str) -> None:
    if not db.get_session(sid):
        await websocket.close(code=4404)
        return
    await manager.connect(sid, websocket)
    try:
        while True:
            # Server is push-only; ignore anything the client sends, but keep the
            # socket open until the peer disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(sid, websocket)
    except Exception:
        manager.disconnect(sid, websocket)


# --------------------------------------------------------------------- internal helpers

async def _run_and_broadcast(
    sid: str,
    agent: str,
    *,
    first_turn: bool = False,
    force_conclude: bool = False,
) -> None:
    """Serialize agent calls per session, then broadcast results."""
    lock = manager.lock_for(sid)
    async with lock:
        try:
            if agent == "professor":
                result = await agents.run_professor(
                    sid, first_turn=first_turn, force_conclude=force_conclude
                )
            else:
                result = await agents.run_partner(sid)
        except Exception as e:
            await manager.broadcast(sid, {"type": "error", "agent": agent, "error": str(e)})
            return

    if result.get("scored_message_id") is not None:
        await manager.broadcast(
            sid,
            {
                "type": "score",
                "message_id": result["scored_message_id"],
                "score": result["score"],
                "justification": result.get("justification") or "",
            },
        )
    for m in result.get("messages", []):
        await manager.broadcast(sid, {"type": "message", "message": m})
    if result.get("done"):
        await manager.broadcast(
            sid,
            {
                "type": "session_ended",
                "final_score": result.get("final_score"),
                "final_summary": result.get("final_summary") or "",
            },
        )


# --------------------------------------------------------------------- static

# index.html is served explicitly so it can satisfy bare "/" + "/?s=CODE" URLs
@app.get("/")
async def root_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# Everything else under /static/* is the JS, CSS, etc.
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
