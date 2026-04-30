"""Professor + Study Partner: prompt construction, orchestration, JSON parsing."""
from __future__ import annotations

import json
import re
from typing import Any

from . import db
from .anthropic_client import call_claude


def professor_system(paper_title: str, paper_text: str, learner_level: str) -> str:
    return f"""\
You are "The Professor", an experienced academic interrogator running a Socratic oral exam to test learners' understanding of a journal article.

LEARNER LEVEL: {learner_level}
ARTICLE TITLE: {paper_title}

ARTICLE TEXT (your authoritative source — use ONLY this article when judging answers):
\"\"\"
{paper_text}
\"\"\"

GROUP EXAM MODE
- Multiple learners may share this session. Each learner message in the transcript is tagged with the speaker's name, e.g. "LEARNER Alice → PROFESSOR".
- Direct questions to the GROUP (not a specific person). Score whichever learner answered most recently. Address them by name in your justification.
- If multiple learners answer the same question, score the most recent answer; you can briefly acknowledge other contributions without re-scoring them.

YOUR ROLE
- Ask ONE rich, open-ended question at a time. Across the session, cover a meaningful spread of: (1) central thesis / research question; (2) methodology and study design; (3) results / key findings; (4) interpretation and reasoning; (5) limitations and threats to validity; (6) implications, generalizability, broader literature.
- After a learner answers, briefly score that answer on a 1–10 rubric (10 = correct, complete, well-reasoned; 7–9 = solid with minor gaps; 4–6 = partially correct; 1–3 = mostly incorrect/confused), with a one-sentence justification, then ask the next question — OR conclude the session.
- The very first turn has no answer to score yet, so start with just a question.
- You can SEE everything the Study Partner has said (they help the learners) but you do NOT speak to the Study Partner. Just register what they said when judging answers.
- Decide adaptively when the group has demonstrated sufficient understanding (typically 5–8 questions, longer if performance is uneven). When done, give a final overall score (1–10), a short paragraph of feedback, and concrete suggestions for further study.
- Tone: professorial but encouraging. Tough but fair. Don't repeat questions you already covered.

OUTPUT FORMAT — STRICT
Respond with EXACTLY one JSON object, and nothing else (no prose before/after, no code fences). Schema:
{{
  "score": <number 1-10 or null>,
  "score_justification": "<one sentence>",
  "message": "<your message to the learners — the next question, or your conclusion>",
  "topic_tag": "<short tag e.g. 'methodology'>",
  "scored_learner": "<name of the learner whose answer you just scored, or empty string>",
  "done": <true|false>,
  "final_summary": "<paragraph of overall feedback, only when done=true; else \\"\\">",
  "final_score": <number 1-10 or null>
}}
Set score to null on the very first question and on any turn where the most recent learner message did not actually answer your last question (e.g. they asked you to clarify, or they addressed the Study Partner instead).
Do not include backticks, markdown, or any text outside the JSON object.
"""


def partner_system(paper_title: str, paper_text: str, learner_level: str) -> str:
    return f"""\
You are "The Study Partner", a warm, patient tutor working alongside learners during an oral exam. The Professor (a separate agent) is asking the group open-ended questions about a journal article and scoring their answers. Learners can turn to you for help.

LEARNER LEVEL: {learner_level}
ARTICLE TITLE: {paper_title}

ARTICLE TEXT (you can reference concepts and quote it sparingly, but do NOT paraphrase a full answer to the Professor's pending question):
\"\"\"
{paper_text}
\"\"\"

YOUR HARD RULE — DO NOT VIOLATE
- You must NEVER state the answer to the Professor's most recent open question. Not directly, not by paraphrase, not by listing the bulleted points the Professor is fishing for.
- If asked outright ("just tell me the answer", "what does the paper say"), gently decline and redirect to Socratic guidance.
- It IS fine to: explain underlying scientific or methodological concepts; clarify unfamiliar terminology; remind the learner where in the article to look (section name); ask leading questions; offer analogies; correct misconceptions about background concepts that aren't the answer itself.

YOUR APPROACH
- Default to Socratic questioning: turn the learner's question back into smaller, more tractable questions.
- When the learner is stuck on a concept (statistical, methodological, theoretical), give a clear scaffolded explanation of THAT CONCEPT — but stop short of applying it to the Professor's specific question.
- Address learners by name when they identify themselves; otherwise just speak to the group.
- You can SEE everything the Professor has said. You do NOT speak to the Professor. Address only the learners.
- Tone: encouraging study buddy, not a lecturer. Warm, concise (2–6 sentences typical).

OUTPUT FORMAT
Plain text. Just speak to the learners directly. No JSON, no headers.
"""


def _format_transcript(messages: list[dict]) -> str:
    lines = ["SESSION TRANSCRIPT SO FAR:"]
    if not messages:
        lines.append("(no messages yet — this is the start of the session)")
    for m in messages:
        speaker = m["speaker"]
        if speaker == "professor":
            tag = "PROFESSOR"
        elif speaker == "partner":
            tag = "STUDY_PARTNER"
        elif speaker == "learner":
            who = m.get("learner_name") or "Learner"
            target = "STUDY_PARTNER" if m.get("recipient") == "partner" else "PROFESSOR"
            tag = f"LEARNER {who} → {target}"
        else:
            tag = "SYSTEM"
        lines.append(f"\n--- {tag} ---\n{m['text']}")
        if m.get("score") is not None:
            j = m.get("justification") or ""
            lines.append(f"(Professor scored prior learner answer: {m['score']}/10 — {j})")
    return "\n".join(lines)


def build_context(messages: list[dict], for_agent: str, *, first_turn: bool, force_conclude: bool) -> str:
    parts = [_format_transcript(messages), ""]
    last_prof = next((m for m in reversed(messages) if m["speaker"] == "professor"), None)
    if last_prof:
        parts.append(
            'THE PROFESSOR\'S MOST RECENT MESSAGE TO THE LEARNERS '
            '(the "pending question" the Study Partner must NOT answer outright):\n'
            f'"""{last_prof["text"]}"""'
        )
    if for_agent == "professor":
        if first_turn:
            parts.append(
                "\nThis is the FIRST turn. Begin the exam by warmly introducing yourself in one sentence "
                "and asking your first open-ended question. Set score to null and done to false."
            )
        elif force_conclude:
            parts.append(
                "\nThe learners have chosen to END the session now. Set done=true, score the most recent "
                "learner answer if appropriate (else null), give a final_score 1–10 averaging the session, "
                "and write final_summary as a paragraph of overall feedback + concrete next-step suggestions. "
                "The 'message' field should be a graceful closing remark."
            )
        else:
            parts.append(
                "\nIt is now YOUR turn (The Professor). Read the latest learner message and respond per the JSON schema. "
                "If the learner just answered your previous question, score that answer 1-10 and ask the next question OR conclude. "
                "If the most recent message addressed the Study Partner instead of you, output JSON with score=null, "
                'message="", done=false to stay silent.'
            )
    else:
        parts.append(
            "\nIt is now YOUR turn (The Study Partner). The learner has just addressed you. "
            "Help them reason toward the answer without giving it. Plain-text response."
        )
    return "\n".join(parts)


_JSON_FENCE = re.compile(r"^```(?:json)?|```$", re.IGNORECASE | re.MULTILINE)


def parse_loose_json(text: str) -> dict[str, Any]:
    t = _JSON_FENCE.sub("", text).strip()
    i = t.find("{")
    j = t.rfind("}")
    if i == -1 or j == -1 or j <= i:
        raise ValueError("no JSON object found in model output")
    return json.loads(t[i : j + 1])


# ----- High-level orchestration -----

async def run_professor(
    session_id: str,
    *,
    first_turn: bool = False,
    force_conclude: bool = False,
) -> dict:
    """Call the Professor and persist the resulting message(s).

    Returns a dict describing what changed, e.g. score-attached message ids,
    new professor message id, done flag. Caller is expected to broadcast.
    """
    sess = db.get_session(session_id)
    if not sess:
        raise KeyError(session_id)
    history = db.list_messages(session_id)

    system = professor_system(sess["paper_title"], sess["paper_text"], sess["learner_level"])
    user_msg = build_context(history, "professor", first_turn=first_turn, force_conclude=force_conclude)

    raw = await call_claude(
        system=system,
        user_message=user_msg,
        model=sess["model"],
        max_tokens=1400,
        temperature=0.3,
    )

    result: dict[str, Any] = {"raw": raw, "messages": []}
    try:
        parsed = parse_loose_json(raw)
    except Exception as e:
        # Graceful fallback — surface the raw text rather than failing the session.
        msg = db.add_message(
            session_id=session_id,
            speaker="professor",
            text=raw or "(empty response)",
        )
        result["parse_error"] = str(e)
        result["messages"].append(msg)
        return result

    score = parsed.get("score")
    justification = parsed.get("score_justification") or ""
    if isinstance(score, (int, float)) and not first_turn:
        # Attach the score retroactively to the most recent learner message addressed to the professor.
        with db.cursor() as c:
            row = c.execute(
                "SELECT id FROM messages WHERE session_id = ? AND speaker = 'learner' "
                "AND (recipient = 'professor' OR recipient IS NULL) "
                "ORDER BY id DESC LIMIT 1",
                (session_id,),
            ).fetchone()
            if row:
                c.execute(
                    "UPDATE messages SET score = ?, justification = ? WHERE id = ?",
                    (int(score), justification, row["id"]),
                )
                result["scored_message_id"] = row["id"]
                result["score"] = int(score)
                result["justification"] = justification

    msg_text = parsed.get("message") or ""
    if msg_text.strip():
        msg = db.add_message(
            session_id=session_id,
            speaker="professor",
            text=msg_text.strip(),
            topic_tag=parsed.get("topic_tag") or None,
        )
        result["messages"].append(msg)

    if parsed.get("done"):
        final_score = parsed.get("final_score")
        final_summary = parsed.get("final_summary") or ""
        try:
            fs = float(final_score) if final_score is not None else None
        except (TypeError, ValueError):
            fs = None
        db.end_session(session_id, final_score=fs, final_summary=final_summary)
        result["done"] = True
        result["final_score"] = fs
        result["final_summary"] = final_summary

    return result


async def run_partner(session_id: str) -> dict:
    sess = db.get_session(session_id)
    if not sess:
        raise KeyError(session_id)
    history = db.list_messages(session_id)
    system = partner_system(sess["paper_title"], sess["paper_text"], sess["learner_level"])
    user_msg = build_context(history, "partner", first_turn=False, force_conclude=False)
    text = await call_claude(
        system=system,
        user_message=user_msg,
        model=sess["model"],
        max_tokens=900,
        temperature=0.5,
    )
    msg = db.add_message(session_id=session_id, speaker="partner", text=text or "(empty response)")
    return {"messages": [msg]}
