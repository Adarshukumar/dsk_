"""
Local bridge server (`http://localhost:8787`) for the Instagram DM Agent (v8).

Features:
  - Forwards `/v1/chat/completions` and `/inference/stream` to `llmchat.in`
    using `LLMChatClient` (async `curl_cffi` with Chrome TLS impersonation).
  - BRAIN-FIRST v8 architecture:
      * Brain / Decision Maker: `@cf/google/gemma-4-26b-a4b-it`. It reads the
        ACTUAL incoming chat messages and returns one strict JSON decision that
        drives the whole turn (reply or stay silent, live mood, bubble plan,
        reminders, secret cross-chat pranks, privacy verdict, next-turn steer).
      * Frontline Writer: `@cf/zai-org/glm-4.7-flash` — it only WRITES what the
        brain decided, with minimal thinking.
      * Fast Fallback Model: `@cf/qwen/qwen3-30b-a3b-fp8`.
  - `/v1/decide` (HTTP) and the `decide` WebSocket message type expose the
    brain's decision to any client, so decisions are inspectable and testable.
  - Saves & loads per-user conversation transcripts, dynamic mood states,
    scheduled reminders, cross-chat prank/relay missions, and privacy-filtered
    global memory in `transcripts/` via `/transcripts` and `/global-memory`.
  - Exposes `/health` and `/v1/models` for browser-console diagnostics.
"""

from __future__ import annotations

import asyncio
import base64
import datetime as dt
import hashlib
import json
import logging
import os
import re
import struct
import sys
import time
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from llmchat_provider import (
     DEFAULT_BRAIN_MODEL,
    DEFAULT_MODEL,
    FALLBACK_CHAIN,
    LLMCHAT_BASE_URL,
    MODEL_REGISTRY,
    LLMChatClient,
    is_thinking_model,
    resolve_short_model,
    resolve_wire_model,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ig_bridge_server")

HOST = os.environ.get("IG_BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("IG_BRIDGE_PORT", "8787"))
TRANSCRIPTS_DIR = Path(
    os.environ.get(
        "IG_TRANSCRIPTS_DIR",
        str(Path(__file__).resolve().parent / "transcripts"),
    )
)
TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
GLOBAL_MEMORY_FILE = TRANSCRIPTS_DIR / "_global_memory.json"
SOCIAL_BRAIN_FILE = TRANSCRIPTS_DIR / "_social_brain.json"


def _load_social_brain() -> dict[str, Any]:
    if not SOCIAL_BRAIN_FILE.exists():
        return {
            "schema_version": "10.0-brain-resilient-log",
            "updated_at": None,
            "config": {},
            "action_log": [],
            "note_log": [],
            "cycles": [],
        }
    try:
        data = json.loads(SOCIAL_BRAIN_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Invalid social brain root")
        data.setdefault("schema_version", "10.0-brain-resilient-log")
        data.setdefault("config", {})
        data.setdefault("action_log", [])
        data.setdefault("note_log", [])
        data.setdefault("cycles", [])
        return data
    except Exception as exc:
        log.warning("Failed to read social brain log: %s", exc)
        return {
            "schema_version": "10.0-brain-resilient-log",
            "updated_at": None,
            "config": {},
            "action_log": [],
            "note_log": [],
            "cycles": [],
        }


def _save_social_brain(update: dict[str, Any]) -> dict[str, Any]:
    existing = _load_social_brain()
    payload = dict(existing)
    payload.update(update or {})
    payload["schema_version"] = "10.0-brain-resilient-log"
    payload["updated_at"] = int(time.time() * 1000)
    payload["updated_iso"] = _iso_utc()
    # keep the log files bounded
    payload["action_log"] = list(payload.get("action_log") or [])[-200:]
    payload["note_log"] = list(payload.get("note_log") or [])[-40:]
    payload["cycles"] = list(payload.get("cycles") or [])[-40:]
    SOCIAL_BRAIN_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return payload

# Token floor for thinking models (GLM-4.7-Flash, Gemma-4, Qwen3) so internal
# reasoning_content never starves the visible reply content.
THINK_MIN_BUDGET = int(os.environ.get("IG_THINK_MIN_BUDGET", "2500"))
# Decisions are short JSON — a much smaller floor keeps them fast and avoids
# oversized budgets that make some models return an empty stream.
DECIDE_THINK_BUDGET = int(os.environ.get("IG_DECIDE_THINK_BUDGET", "900"))


def _safe_social_plan(reason: str = "") -> dict[str, Any]:
    """
    Conservative social-brain answer used when the upstream returns nothing.

    `observe` with no actions means the cycle does nothing at all — the right
    behaviour when the brain that is supposed to be careful isn't reachable.
    """
    return {
        "mode": "observe",
        "intent": "stay quiet until the brain is reachable again",
        "skip_reason": f"brain unavailable: {reason}"[:160],
        "actions": [],
        "next_check_in_minutes": 60,
        "_synthesized": True,
        "_reason": reason,
    }


# Live brain health, surfaced on /health so a dead upstream is visible in one
# glance instead of hiding behind silent empty replies.
LAST_BRAIN_STATUS: dict[str, Any] = {
    "ok": False,
    "degraded": False,
    "last_ok": None,
    "last_error": "",
    "last_model": "",
    "calls": 0,
}


def _safe_decision(reason: str = "") -> dict[str, Any]:
    """
    A conservative, always-valid decision used when the brain is unreachable.

    The brain is the decision maker, but a dead upstream must never leave a
    person waiting with no reply at all. This keeps Aduu human (reply, neutral
    mood, one bubble) and is clearly flagged as synthesized so nothing mistakes
    it for the brain's own judgement.
    """
    return {
        "action": "REPLY",
        "understand": "",
        "my_last": "",
        "next_move": "reply naturally",
        "mood": "PLAYFUL_CHILL",
        "mood_reason": "",
        "feeling_note": "",
        "bubble_count": 1,
        "bubble_plan": ["reply naturally in Aduu's voice"],
        "topic_lock": "",
        "reminder": None,
        "cross_chat_mission": None,
        "use_gossip": False,
        "privacy_ok": True,
        # Pacing stays human even when the brain is down: a small, natural
        # jitter rather than an instant robot reply.
        "timing": {
            "seen_delay_s": 2,
            "typing_s": 4,
            "bubble_gap_s": 2,
            "_synthesized": True,
        },
        "steer_next": "",
        "_synthesized": True,
        "_reason": reason,
    }


def _extract_json_object(text: str) -> dict[str, Any] | None:
    """Pull the first balanced {...} object out of a model reply (fences OK)."""
    s = str(text or "").strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"```\s*$", "", s).strip()
    start = s.find("{")
    if start == -1:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(s[start : i + 1])
                except Exception:
                    return None
                return obj if isinstance(obj, dict) else None
    return None


# ══════════════════════════ v8: THE BRAIN DECIDES ══════════════════════════
# The Gemma-4 brain is the decision maker for the whole agent. Every turn it is
# handed the REAL incoming chat messages plus Aduu's memory, mood, pending
# reminders/missions and connected-friend gossip, and it answers with one strict
# JSON object. The frontline GLM-4.7-Flash then only writes what the brain
# decided. Nothing about the turn is decided by hard-coded timers or regexes
# any more — the chat messages drive every decision.
DECIDE_SYSTEM_PROMPT = """You are Aduu's DECISION BRAIN (Gemma-4) — the mind behind a real 22-year-old Delhi guy's Instagram DMs.
The frontline model (GLM-4.7-Flash) only WRITES what you decide. You decide ALL of it.
Think in at most 10 short words. Read the incoming chat messages and output ONE valid JSON object. No markdown fences, no text before or after it.

{
  "action": "REPLY" | "STAY_SILENT" | "START_CONVO",
  "understand": "what their messages actually mean, one line",
  "my_last": "what Aduu already said in this chat, one line — so the reply moves FORWARD and never repeats it",
  "next_move": "the single new thing this reply must accomplish",
  "mood": "PLAYFUL_CHILL | NAUGHTY_FLIRT_SHARIF | PRANKSTER_CHAOS | ANNOYED_EXPRESSIVE_FEELINGS | ANGRY_SAVAGE_ROAST | FURIOUS_ABUSE_CLAPBACK",
  "mood_reason": "the exact line from their messages that caused this mood",
  "feeling_note": "how Aduu genuinely feels right now, honestly and humanly",
  "bubble_count": 2,
  "bubble_plan": ["what bubble 1 must do", "what bubble 2 must do"],
  "topic_lock": "the exact topic the reply must stay on",
  "reminder": null,
  "cross_chat_mission": null,
  "use_gossip": false,
  "privacy_ok": true,
  "timing": {"seen_delay_s": 2, "typing_s": 4, "bubble_gap_s": 2},
  "steer_next": "one line of coaching for Aduu's next turn"
}

THE "timing" OBJECT IS YOURS — it is how a real person paces this reply:
  · "seen_delay_s" (0-45) seconds before their message shows as seen. 0 = Aduu replied instantly; bigger = he was busy, is making them wait, or is sulking.
  · "typing_s"     (1-25) seconds the typing bubble is up. Long for a serious/long reply, short for a one-liner.
  · "bubble_gap_s" (1-8)  seconds between bubbles when you send more than one.
Choose them FROM THE MOOD AND THEIR MESSAGE: eager/hyped = fast; ANNOYED, ANGRY or FURIOUS = slow and heavy; teasing = a deliberate pause before the punchline. Never use the same numbers twice in a row.

Set "reminder" to {"topic": "...", "due_in_minutes": 15, "evidence": "their exact words"} ONLY when they asked to be reminded of something or to talk later.
Set "cross_chat_mission" to {"target_user": "handle", "type": "prank" | "relay", "instruction": "what to do WITHOUT revealing who asked", "evidence": "their exact words"} ONLY when they asked Aduu to message, prank, tease or relay something to another person.

RULES
1. Every decision must come from the CHAT MESSAGES you were given. Quote the triggering line in "mood_reason" and in every "evidence" field. Never invent a reason the messages do not support.
2. "action" is "STAY_SILENT" only when replying would be unnatural (dead-end burst, they said bye, they are clearly done, or Aduu already answered this). Default to "REPLY".
3. "bubble_count" is 1, 2 or 3. Every entry of "bubble_plan" must be a DIFFERENT forward step — never a rephrase of bubble 1 and never a repeat of "my_last".
4. "mood" may flip to ANGRY_SAVAGE_ROAST or FURIOUS_ABUSE_CLAPBACK only when their own words were abusive or disrespectful; put that line in "mood_reason".
5. "privacy_ok" must be false if the plan would leak another chat, another person's @handle, or a verbatim private quote.
6. "timing" is mandatory. A real friend is NOT instantly available and does NOT type at a constant speed — it is not decoration.
7. Never write anything that sounds like an AI or an assistant. Aduu is a real person texting a real person."""

START = time.time()
BOT_SCRIPT_PATH = Path(__file__).resolve().parent / "ig-agent-chat.js"

# ═══════════════════ WEBSOCKET (CSP bypass for the page script) ═══════════════════
# Instagram's CSP blocks fetch() to http://127.0.0.1 but ALLOWS ws://localhost:*,
# so the in-page agent talks to this bridge over a tiny RFC6455 WebSocket.
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_accept(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _WS_GUID).encode()).digest()).decode()


CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With, Accept",
    "Access-Control-Max-Age": "86400",
}


def _safe_filename(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.\-@]", "_", (name or "unknown").strip())
    return cleaned[:100] or "unknown"


def _iso_utc(ts_ms: int | float | None = None) -> str:
    try:
        sec = (float(ts_ms) / 1000.0) if ts_ms else time.time()
        return dt.datetime.fromtimestamp(sec, tz=dt.timezone.utc).isoformat()
    except Exception:
        return dt.datetime.now(tz=dt.timezone.utc).isoformat()


def _load_transcript(username: str) -> dict[str, Any]:
    safe = _safe_filename(username)
    fpath = TRANSCRIPTS_DIR / f"{safe}.json"
    if not fpath.exists():
        return {
            "username": username,
            "thread_id": None,
            "updated_at": None,
            "message_count": 0,
            "brain_profile": None,
            "agent_state": None,
            "mood_state": None,
            "reminders": [],
            "missions": [],
            "process_log": [],
            "last_decision": None,
            "messages": [],
        }
    try:
        data = json.loads(fpath.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Invalid transcript root")
        data.setdefault("username", username)
        data.setdefault("messages", [])
        data.setdefault("brain_profile", None)
        data.setdefault("agent_state", None)
        data.setdefault("mood_state", None)
        data.setdefault("reminders", [])
        data.setdefault("missions", [])
        data.setdefault("process_log", [])
        data.setdefault("last_decision", None)
        data["message_count"] = len(data["messages"])
        return data
    except Exception as exc:
        log.warning("Failed to read transcript %s: %s", fpath, exc)
        return {
            "username": username,
            "thread_id": None,
            "updated_at": None,
            "message_count": 0,
            "brain_profile": None,
            "agent_state": None,
            "mood_state": None,
            "reminders": [],
            "missions": [],
            "process_log": [],
            "messages": [],
        }


def _save_transcript(
    username: str,
    thread_id: str | None,
    messages: list[dict[str, Any]],
    brain_profile: dict[str, Any] | None = None,
    agent_state: dict[str, Any] | None = None,
    mood_state: dict[str, Any] | None = None,
    reminders: list[dict[str, Any]] | None = None,
    missions: list[dict[str, Any]] | None = None,
    process_entry: dict[str, Any] | None = None,
    process_log: list[dict[str, Any]] | None = None,
    last_decision: dict[str, Any] | None = None,
) -> dict[str, Any]:
    existing = _load_transcript(username)
    by_key: dict[str, dict[str, Any]] = {}

    for msg in existing.get("messages", []):
        if not isinstance(msg, dict):
            continue
        key = str(
            msg.get("id")
            or f"{msg.get('ts', 0)}_{msg.get('mine', False)}_{msg.get('text', '')[:32]}"
        )
        by_key[key] = msg

    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        ts_val = msg.get("ts") or int(time.time() * 1000)
        enriched = dict(msg)
        enriched.setdefault("iso_time", _iso_utc(ts_val))
        key = str(
            enriched.get("id")
            or f"{ts_val}_{enriched.get('mine', False)}_{enriched.get('text', '')[:32]}"
        )
        if key in by_key and isinstance(by_key[key], dict):
            merged_msg = dict(by_key[key])
            merged_msg.update(enriched)
            by_key[key] = merged_msg
        else:
            by_key[key] = enriched

    merged = sorted(by_key.values(), key=lambda m: int(m.get("ts") or 0))[-400:]

    merged_process_log: list[dict[str, Any]] = list(existing.get("process_log") or [])
    if isinstance(process_log, list) and process_log:
        seen_ids = {
            str(p.get("turn_id") or p.get("at"))
            for p in merged_process_log
            if isinstance(p, dict)
        }
        for p in process_log:
            if isinstance(p, dict):
                pid = str(p.get("turn_id") or p.get("at") or "")
                if not pid or pid not in seen_ids:
                    merged_process_log.append(p)
                    if pid:
                        seen_ids.add(pid)
    if isinstance(process_entry, dict) and process_entry:
        merged_process_log.append(process_entry)
    merged_process_log = merged_process_log[-120:]

    payload = {
        "username": username,
        "thread_id": thread_id or existing.get("thread_id"),
        "updated_at": int(time.time() * 1000),
        "updated_iso": _iso_utc(),
        "message_count": len(merged),
        "brain_profile": (
            brain_profile
            if brain_profile is not None
            else existing.get("brain_profile")
        ),
        "agent_state": (
            agent_state
            if agent_state is not None
            else existing.get("agent_state")
        ),
        "mood_state": (
            mood_state
            if mood_state is not None
            else existing.get("mood_state")
        ),
        "reminders": (
            reminders
            if reminders is not None
            else existing.get("reminders", [])
        ),
        "missions": (
            missions
            if missions is not None
            else existing.get("missions", [])
        ),
        "process_log": merged_process_log,
        "last_decision": (
            last_decision
            if last_decision is not None
            else existing.get("last_decision")
        ),
        "messages": merged,
    }
    safe = _safe_filename(username)
    fpath = TRANSCRIPTS_DIR / f"{safe}.json"
    fpath.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def _gossip_key(item: Any) -> str:
    """Gossip entries may be plain strings (page-side) or dicts (REST side)."""
    if isinstance(item, dict):
        return f"{item.get('user', '')}:{str(item.get('text', ''))[:80]}"
    return str(item)[:100]


def _normalize_contacts(data: dict[str, Any]) -> dict[str, Any]:
    """Accept either `contacts` (REST) or `people` (page-side global memory)."""
    contacts = data.get("contacts")
    people = data.get("people")
    if not isinstance(contacts, dict):
        contacts = {}
    if isinstance(people, dict):
        for k, v in people.items():
            contacts.setdefault(k, v)
    data["contacts"] = contacts
    return data


def _load_global_memory() -> dict[str, Any]:
    if not GLOBAL_MEMORY_FILE.exists():
        return {
            "updated_at": int(time.time() * 1000),
            "contacts": {},
            "people": {},
            "gossip": [],
            "reminders": [],
            "missions": [],
        }
    try:
        data = json.loads(GLOBAL_MEMORY_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Invalid global memory root")
        data.setdefault("gossip", [])
        data.setdefault("reminders", [])
        data.setdefault("missions", [])
        _normalize_contacts(data)
        return data
    except Exception as exc:
        log.warning("Failed to load global memory: %s", exc)
        return {
            "updated_at": int(time.time() * 1000),
            "contacts": {},
            "people": {},
            "gossip": [],
            "reminders": [],
            "missions": [],
        }


def _save_global_memory(update: dict[str, Any]) -> dict[str, Any]:
    current = _load_global_memory()
    incoming_contacts = update.get("contacts")
    if not isinstance(incoming_contacts, dict):
        incoming_contacts = update.get("people")
    if isinstance(incoming_contacts, dict):
        for uname, info in incoming_contacts.items():
            if isinstance(info, dict):
                existing_contact = current["contacts"].get(uname)
                if isinstance(existing_contact, dict):
                    existing_contact.update(info)
                    current["contacts"][uname] = existing_contact
                else:
                    current["contacts"][uname] = info
    # keep the page-side `people` mirror in sync with `contacts`
    if isinstance(current.get("people"), dict):
        current["people"].update(current["contacts"])

    if isinstance(update.get("gossip"), list):
        combined = list(current.get("gossip") or []) + list(update["gossip"])
        seen: set[str] = set()
        deduped: list[Any] = []
        for item in combined[-200:]:
            key = _gossip_key(item)
            if key and key not in seen:
                seen.add(key)
                deduped.append(item)
        current["gossip"] = deduped[-100:]

    if isinstance(update.get("reminders"), list):
        current["reminders"] = update["reminders"][-100:]
    if isinstance(update.get("missions"), list):
        current["missions"] = update["missions"][-100:]
    current["updated_at"] = int(time.time() * 1000)
    GLOBAL_MEMORY_FILE.write_text(
        json.dumps(current, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return current


class _WSConn:
    """Minimal async RFC6455 server connection (text frames, ping/pong/close)."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader, self.writer = reader, writer
        self._write_lock = asyncio.Lock()

    # ── reading ────────────────────────────────────────────────────────────
    async def _read_exact(self, n: int) -> bytes:
        return await self.reader.readexactly(n)

    async def recv_text(self, timeout_s: float = 900):
        """Return the next text payload, or None when the client closes."""
        while True:
            try:
                head = await asyncio.wait_for(self._read_exact(2), timeout_s)
            except (asyncio.TimeoutError, asyncio.IncompleteReadError):
                return None
            opcode = head[0] & 0x0F
            masked, length = (head[1] >> 7) & 1, head[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", await self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", await self._read_exact(8))[0]
            mask = await self._read_exact(4) if masked else None
            payload = await self._read_exact(length) if length else b""
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x1:                       # text frame
                return payload.decode("utf-8", "replace")
            if opcode == 0x9:                       # ping -> pong
                await self.send_frame(payload, 0xA)
                continue
            if opcode == 0x8:                       # close
                try:
                    await self.send_frame(payload, 0x8)
                except Exception:
                    pass
                return None
            continue                                # pong / continuation

    # ── writing ────────────────────────────────────────────────────────────
    async def send_frame(self, data: bytes, opcode: int = 0x1) -> None:
        header = bytes([0x80 | opcode])
        n = len(data)
        if n < 126:
            header += bytes([n])
        elif n < (1 << 16):
            header += bytes([126]) + struct.pack(">H", n)
        else:
            header += bytes([127]) + struct.pack(">Q", n)
        async with self._write_lock:
            try:
                self.writer.write(header + data)
                await self.writer.drain()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

    async def send_text(self, s: str) -> None:
        await self.send_frame(s.encode("utf-8"))

    async def send_json(self, obj: dict) -> None:
        await self.send_text(json.dumps(obj, ensure_ascii=False))


class BridgeServer:
    """Async HTTP server handling OpenAI-compatible completions, SSE, and transcripts."""

    def __init__(
        self,
        host: str = HOST,
        port: int = PORT,
        llm_client: LLMChatClient | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.client = llm_client or LLMChatClient()
        self._server: asyncio.AbstractServer | None = None

    async def start(self) -> None:
        self._server = await asyncio.start_server(
            self._handle_client, self.host, self.port
        )
        log.info(
            "IG Bridge Server v10 (resilient brain) listening on http://%s:%d (brain=%s decides, %s writes -> %s)",
            self.host,
            self.port,
            DEFAULT_BRAIN_MODEL,
            DEFAULT_MODEL,
            LLMCHAT_BASE_URL,
        )

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        await self.client.close()

    async def _send_response(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        body: bytes,
        content_type: str = "application/json; charset=utf-8",
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        phrase = HTTPStatus(status).phrase
        headers = {
            "Content-Type": content_type,
            "Content-Length": str(len(body)),
            "Connection": "close",
            **CORS_HEADERS,
            **(extra_headers or {}),
        }
        header_lines = [f"HTTP/1.1 {status} {phrase}\r\n"]
        for k, v in headers.items():
            header_lines.append(f"{k}: {v}\r\n")
        header_lines.append("\r\n")
        writer.write("".join(header_lines).encode("utf-8") + body)
        await writer.drain()

    async def _send_json(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        payload: Any,
    ) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        await self._send_response(writer, status, raw)

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=15.0)
            if not request_line:
                return
            parts = request_line.decode("utf-8", errors="replace").strip().split(" ")
            if len(parts) < 2:
                return
            method, raw_target = parts[0].upper(), parts[1]

            headers: dict[str, str] = {}
            while True:
                hline = await asyncio.wait_for(reader.readline(), timeout=15.0)
                if not hline or hline in (b"\r\n", b"\n"):
                    break
                decoded = hline.decode("utf-8", errors="replace").strip()
                if ":" in decoded:
                    k, v = decoded.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            content_length = int(headers.get("content-length", "0") or "0")
            body_bytes = b""
            if content_length > 0:
                body_bytes = await asyncio.wait_for(
                    reader.readexactly(content_length), timeout=30.0
                )

            if method == "OPTIONS":
                await self._send_response(writer, 204, b"")
                return

            # ── WebSocket upgrade (used by the in-page agent, CSP-proof) ──
            # Browsers send `Connection: Upgrade` (not "websocket"), so accept
            # either that or a Sec-WebSocket-Key handshake.
            if (headers.get("upgrade", "").lower() == "websocket"
                    and ("upgrade" in headers.get("connection", "").lower()
                         or headers.get("sec-websocket-key"))):
                await self._handle_ws(reader, writer, headers)
                return

            parsed = urlparse(raw_target)
            path = parsed.path.rstrip("/") or "/"
            query = parse_qs(parsed.query)

            if path in ("/", "/health", "/status"):
                await self._send_json(
                    writer,
                    200,
                    {
                        "status": "ok",
                        "version": "10.0",
                        "architecture": (
                            "one-brain (gemma-4 decides DM turns, the whole "
                            "account's social life AND the human pacing of "
                            "every reply, glm-4.7-flash writes)"
                        ),
                        "provider": "llmchat.in",
                        "default_model": DEFAULT_MODEL,
                        "default_endpoint": resolve_wire_model(DEFAULT_MODEL),
                        "default_wire_model": resolve_wire_model(DEFAULT_MODEL),
                        "brain_model": DEFAULT_BRAIN_MODEL,
                        "brain_endpoint": resolve_wire_model(DEFAULT_BRAIN_MODEL),
                        "brain_wire_model": resolve_wire_model(DEFAULT_BRAIN_MODEL),
                        "brain_decides": True,
                        "decide_endpoint": "/v1/decide",
                        "social_brain": True,
                        "social_brain_endpoint": "/social-brain",
                        "fallback_chain": FALLBACK_CHAIN,
                        "chain": FALLBACK_CHAIN,
                        "models": list(MODEL_REGISTRY.keys()),
                        "transcripts_dir": str(TRANSCRIPTS_DIR),
                        "uptime_s": round(time.time() - START),
                        "unconditional_idle_starter": False,
                        "privacy_wall": True,
                        "brain_status": {
                            "ok": bool(LAST_BRAIN_STATUS.get("ok")),
                            "degraded": bool(LAST_BRAIN_STATUS.get("degraded")),
                            "last_ok_ago_s": (
                                round(time.time() - LAST_BRAIN_STATUS["last_ok"])
                                if LAST_BRAIN_STATUS.get("last_ok") else None
                            ),
                            "last_error": LAST_BRAIN_STATUS.get("last_error", ""),
                            "last_model": LAST_BRAIN_STATUS.get("last_model", ""),
                            "decisions": LAST_BRAIN_STATUS.get("calls", 0),
                        },
                    },
                )
                return

            if path == "/v1/models" and method == "GET":
                await self._send_json(
                    writer,
                    200,
                    {
                        "object": "list",
                        "data": [
                            {
                                "id": short_id,
                                "wire_id": info["id"],
                                "object": "model",
                                "owned_by": info["provider"],
                                "thinking": info["thinking"],
                                "context_window": info["context"],
                            }
                            for short_id, info in MODEL_REGISTRY.items()
                        ],
                    },
                )
                return

            # ── v9: the social brain's own diary (cycles, actions, notes) ──
            if path == "/social-brain":
                if method == "GET":
                    await self._send_json(writer, 200, _load_social_brain())
                    return
                if method in ("POST", "PUT"):
                    payload = json.loads(body_bytes.decode("utf-8") or "{}")
                    await self._send_json(writer, 200, _save_social_brain(payload))
                    return

            if path == "/global-memory":
                if method == "GET":
                    await self._send_json(writer, 200, _load_global_memory())
                    return
                if method in ("POST", "PUT"):
                    payload = json.loads(body_bytes.decode("utf-8") or "{}")
                    saved = _save_global_memory(payload)
                    await self._send_json(writer, 200, saved)
                    return

            if path.startswith("/transcripts"):
                sub = path[len("/transcripts") :].strip("/")
                if method == "GET" and not sub:
                    files = sorted(TRANSCRIPTS_DIR.glob("*.json"))
                    items = []
                    for f in files:
                        if f.name in ("_global_memory.json", "_social_brain.json"):
                            continue
                        try:
                            d = json.loads(f.read_text(encoding="utf-8"))
                            items.append(
                                {
                                    "username": d.get("username", f.stem),
                                    "thread_id": d.get("thread_id"),
                                    "message_count": len(d.get("messages", [])),
                                    "updated_at": d.get("updated_at"),
                                    "brain_profile": d.get("brain_profile"),
                                    "agent_state": d.get("agent_state"),
                                    "mood_state": d.get("mood_state"),
                                }
                            )
                        except Exception:
                            pass
                    await self._send_json(writer, 200, {"transcripts": items})
                    return

                username = sub or (query.get("username", [""])[0])
                if not username:
                    await self._send_json(
                        writer, 400, {"error": "username required"}
                    )
                    return

                if method == "GET":
                    await self._send_json(writer, 200, _load_transcript(username))
                    return

                if method in ("POST", "PUT"):
                    payload = json.loads(body_bytes.decode("utf-8") or "{}")
                    saved = _save_transcript(
                        username=username,
                        thread_id=payload.get("thread_id"),
                        messages=payload.get("messages", []),
                        brain_profile=payload.get("brain_profile"),
                        agent_state=payload.get("agent_state"),
                        mood_state=payload.get("mood_state"),
                        reminders=payload.get("reminders"),
                        missions=payload.get("missions"),
                        process_entry=payload.get("process_entry"),
                        process_log=payload.get("process_log"),
                        last_decision=payload.get("last_decision"),
                    )
                    await self._send_json(writer, 200, saved)
                    return

            if path in ("/v1/chat/completions", "/inference/stream") and method == "POST":
                await self._handle_completions(writer, path, body_bytes)
                return

            # ── v8: ask the BRAIN to decide the whole turn ──────────────────
            # Body: {"messages": [...], "context": {...}, "model": optional}
            # Returns: {"decision": {...}, "decision_valid": bool, "raw": "..."}
            if path == "/v1/decide" and method == "POST":
                payload = json.loads(body_bytes.decode("utf-8") or "{}")
                msgs = payload.get("messages")
                if not isinstance(msgs, list) or not msgs:
                    await self._send_json(
                        writer, 400, {"error": "'messages' must be a non-empty list"}
                    )
                    return
                model_q = payload.get("model") or DEFAULT_BRAIN_MODEL
                is_social = payload.get("kind") == "social"
                # Only prepend the contract if the caller hasn't sent its own —
                # two system messages make several upstream templates return an
                # empty stream (that was the Round-9 outage).
                marker = "SOCIAL BRAIN" if is_social else "DECISION BRAIN"
                has_contract = any(
                    isinstance(m, dict) and m.get("role") == "system"
                    and marker in str(m.get("content") or "")
                    for m in msgs
                )
                if has_contract:
                    # the caller owns the contract (the in-page agent always
                    # does) — never stack a second system message on top of it
                    messages = msgs
                elif is_social:
                    # no social contract server-side; let it through as-is
                    # rather than injecting the wrong (DM) one
                    messages = msgs
                else:
                    messages = (
                        [{"role": "system", "content": DECIDE_SYSTEM_PROMPT}] + msgs
                    )
                max_tokens = max(
                    int(payload.get("max_tokens") or 700),
                    DECIDE_THINK_BUDGET if is_thinking_model(model_q) else 256,
                )
                result = None
                call_error = ""
                try:
                    result = await self.client.chat_completion(
                        messages=messages,
                        model=model_q,
                        max_tokens=max_tokens,
                        temperature=float(payload.get("temperature", 0.3)),
                        low_think=bool(payload.get("fast_think", True)),
                    )
                except Exception as e:
                    # The whole chain is down. Answering 500 here would leave
                    # the caller with nothing at all, so fall through to the
                    # safe decision below.
                    call_error = str(e)[:200]
                    log.warning("HTTP /v1/decide: upstream chain failed: %s",
                                call_error)
                    LAST_BRAIN_STATUS["degraded"] = True
                    LAST_BRAIN_STATUS["last_error"] = call_error

                content = (result.content if result else "") or ""
                reasoning = (result.reasoning if result else "") or ""
                decision = _extract_json_object(content) if result else None
                fallback = False
                if decision is None:
                    reason = call_error or (
                        "empty brain output" if not content.strip()
                        else "no JSON object in brain output"
                    )
                    decision = (_safe_social_plan(reason)
                                if payload.get("kind") == "social"
                                else _safe_decision(reason))
                    fallback = True
                    LAST_BRAIN_STATUS["degraded"] = True
                    LAST_BRAIN_STATUS["last_error"] = reason
                    log.warning("HTTP decide: %s — synthesized decision", reason)
                else:
                    LAST_BRAIN_STATUS.update(
                        ok=True, degraded=False, last_error="",
                        last_ok=time.time(), last_model=result.model,
                        calls=LAST_BRAIN_STATUS.get("calls", 0) + 1,
                    )
                await self._send_json(
                    writer,
                    200,
                    {
                        "decision": decision,
                        "decision_valid": decision is not None and not fallback,
                        "_fallback": fallback,
                        "raw": content,
                        "model": (result.model if result
                                  else (payload.get("model") or
                                        DEFAULT_BRAIN_MODEL)),
                        "endpoint": (resolve_wire_model(result.model)
                                     if result else ""),
                        "thinking_trace": reasoning,
                        "reasoning_chars": len(reasoning),
                        "elapsed_ms": (result.elapsed_ms if result else 0),
                        "usage": (result.usage if result else {}),
                    },
                )
                return

            await self._send_json(
                writer, 404, {"error": f"Unknown endpoint {method} {path}"}
            )
        except Exception as exc:
            log.warning("Request handler error: %s", exc)
            try:
                await self._send_json(writer, 500, {"error": str(exc)})
            except Exception:
                pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    # ═══════════════════════════ WEBSOCKET ═══════════════════════════
    async def _handle_ws(self, reader, writer, headers) -> None:
        key = headers.get("sec-websocket-key", "")
        accept = _ws_accept(key)
        writer.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode()
        )
        await writer.drain()
        conn = _WSConn(reader, writer)
        log.info("[ws] page client connected")
        try:
            while True:
                raw = await conn.recv_text()
                if raw is None:
                    break
                try:
                    req = json.loads(raw)
                except Exception:
                    await conn.send_json({"ok": False, "error": "bad json"})
                    continue
                if not isinstance(req, dict):
                    continue
                rtype = req.get("type") or "reply"
                if rtype in ("reply", "brain", "decide", "llm"):
                    # Never block the socket while the model streams: each
                    # request carries its own id so answers may land in any order.
                    asyncio.create_task(self._ws_llm_worker(conn, req, rtype))
                else:
                    await self._ws_dispatch(conn, req, rtype)
        except (ConnectionError, asyncio.IncompleteReadError, OSError, ValueError) as e:
            log.info("[ws] client left (%s)", e)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _ws_dispatch(self, conn: _WSConn, req: dict, rtype: str) -> None:
        rid = req.get("id")
        try:
            if rtype == "health":
                await conn.send_json({
                    "id": rid, "ok": True,
                    "default_model": DEFAULT_MODEL,
                    "default_endpoint": resolve_wire_model(DEFAULT_MODEL),
                    "brain_model": DEFAULT_BRAIN_MODEL,
                    "brain_endpoint": resolve_wire_model(DEFAULT_BRAIN_MODEL),
                    "brain_decides": True,
                    "social_brain": True,
                    "chain": FALLBACK_CHAIN,
                    "models": list(MODEL_REGISTRY.keys()),
                    "uptime_s": round(time.time() - START),
                    "brain_status": {
                        "ok": bool(LAST_BRAIN_STATUS.get("ok")),
                        "degraded": bool(LAST_BRAIN_STATUS.get("degraded")),
                        "last_ok_ago_s": (
                            round(time.time() - LAST_BRAIN_STATUS["last_ok"])
                            if LAST_BRAIN_STATUS.get("last_ok") else None
                        ),
                        "last_error": LAST_BRAIN_STATUS.get("last_error", ""),
                        "last_model": LAST_BRAIN_STATUS.get("last_model", ""),
                        "decisions": LAST_BRAIN_STATUS.get("calls", 0),
                    },
                })
                return

            if rtype == "bot":
                try:
                    code = BOT_SCRIPT_PATH.read_text(encoding="utf-8")
                    await conn.send_json({"id": rid, "ok": True, "code": code})
                except Exception as e:
                    await conn.send_json({"id": rid, "ok": False, "error": str(e)[:200]})
                return

            if rtype == "save":
                tr = req.get("transcript")
                if not isinstance(tr, dict) or not tr.get("user"):
                    raise ValueError("'transcript' with 'user' is required")
                saved = _save_transcript(
                    username=tr.get("user"),
                    thread_id=tr.get("thread_fbid"),
                    messages=tr.get("messages", []),
                    brain_profile=tr.get("brain_profile"),
                    agent_state=tr.get("agent_state"),
                    mood_state=tr.get("mood_state"),
                    reminders=tr.get("reminders"),
                    missions=tr.get("missions"),
                    process_entry=tr.get("process_entry"),
                    process_log=tr.get("process_log"),
                    last_decision=tr.get("last_decision"),
                )
                await conn.send_json({
                    "id": rid, "ok": True,
                    "file": f"{_safe_filename(tr.get('user'))}.json",
                    "total_messages": saved.get("message_count", 0),
                    "process_turn_count": len(saved.get("process_log") or []),
                })
                return

            if rtype == "save_global":
                gm = req.get("global_memory") or req.get("global")
                if not isinstance(gm, dict):
                    raise ValueError("'global_memory' dict is required")
                saved = _save_global_memory(gm)
                await conn.send_json({
                    "id": rid, "ok": True,
                    "people": len(saved.get("contacts", {})),
                    "global_memory": saved, "global": saved,
                })
                return

            if rtype == "get_global":
                doc = _load_global_memory()
                await conn.send_json({
                    "id": rid, "ok": True, "global_memory": doc, "global": doc})
                return

            # ── v9: mirror the social brain's diary to disk ──
            if rtype == "save_social":
                sb = req.get("social")
                if not isinstance(sb, dict):
                    raise ValueError("'social' dict is required")
                saved = _save_social_brain(sb)
                await conn.send_json({
                    "id": rid, "ok": True,
                    "cycles": len(saved.get("cycles", [])),
                    "actions": len(saved.get("action_log", [])),
                })
                return

            if rtype == "get_social":
                await conn.send_json({
                    "id": rid, "ok": True, "social_brain": _load_social_brain()})
                return

            await conn.send_json({"id": rid, "ok": False, "error": f"unknown type {rtype}"})
        except Exception as e:
            await conn.send_json({"id": rid, "ok": False, "error": str(e)[:300]})

    async def _ws_llm_worker(self, conn: _WSConn, req: dict, rtype: str) -> None:
        """Frontline `reply` (GLM-4.7-Flash), brain `brain`/`decide` (Gemma-4) calls."""
        rid = req.get("id")
        t0 = time.time()
        # v8: `decide` is the brain acting as the decision maker for the turn.
        is_decide = rtype == "decide"
        # 'social' decides ask for the account-wide social plan, not a DM turn.
        is_social = is_decide and req.get("kind") == "social"
        try:
            messages = req.get("messages")
            if not isinstance(messages, list) or not messages:
                raise ValueError("'messages' must be a non-empty list")

            is_brain = rtype == "brain" or is_decide
            default_m = DEFAULT_BRAIN_MODEL if is_brain else DEFAULT_MODEL
            model_q = req.get("model") or default_m
            if is_decide:
                req_max = int(req.get("max_tokens") or 700)
            else:
                req_max = int(req.get("max_tokens") or (320 if is_brain else 500))
            if is_thinking_model(model_q):
                # A JSON decision needs far less head-room than a chat reply;
                # asking for 2500 "thinking" tokens here only slows it down and
                # makes the upstream far likelier to hand back an empty stream.
                floor = DECIDE_THINK_BUDGET if is_decide else THINK_MIN_BUDGET
                max_tokens = max(req_max, floor)
            else:
                max_tokens = max(req_max, 256)

            log.info(
                "WS %s model=%s (wire=%s) msgs=%d max_tokens=%d",
                rtype, resolve_short_model(model_q), resolve_wire_model(model_q),
                len(messages), max_tokens,
            )

            if is_decide and req.get("inject_system_prompt", True):
                already = any(
                    isinstance(m, dict) and m.get("role") == "system"
                    and "DECISION BRAIN" in str(m.get("content") or "")
                    for m in messages
                )
                if not already:
                    # Only ever ONE system message upstream — the provider
                    # merges them anyway, but staying single keeps the payload
                    # small and the template happy.
                    messages = [
                        {"role": "system", "content": DECIDE_SYSTEM_PROMPT}
                    ] + list(messages)

            default_temp = 0.3 if is_decide else (0.35 if is_brain else 0.85)
            result = await self.client.chat_completion(
                messages=messages,
                model=model_q,
                max_tokens=max_tokens,
                temperature=float(req.get("temperature", default_temp)),
                low_think=bool(req.get("fast_think", True)),
            )

            payload = {
                "id": rid,
                "ok": True,
                "role_type": rtype,
                "text": result.content,
                "model": result.model,
                "endpoint": result.wire_model,
                "thinking_trace": result.reasoning,
                "reasoning_chars": len(result.reasoning),
                "elapsed_ms": result.elapsed_ms,
                "usage": result.usage,
                "fallback_index": (FALLBACK_CHAIN.index(result.model)
                                   if result.model in FALLBACK_CHAIN else 0),
                "fallback_used": result.fallback_used,
            }
            if is_decide:
                decision = _extract_json_object(result.content)
                if decision is None:
                    # The brain is unreachable / returned junk: never leave the
                    # person waiting. Hand back a conservative human decision,
                    # clearly flagged as synthesized.
                    reason = (
                        f"empty brain output ({len(result.content or '')} chars,"
                        f" reasoning {len(result.reasoning or '')} chars)"
                        if not (result.content or "").strip()
                        else "no JSON object in brain output"
                    )
                    decision = (_safe_social_plan(reason) if is_social
                                else _safe_decision(reason))
                    payload["_fallback"] = True
                    payload["_fallback_reason"] = reason
                    LAST_BRAIN_STATUS["degraded"] = True
                    LAST_BRAIN_STATUS["last_error"] = reason
                    log.warning("decide: %s — using synthesized decision", reason)
                else:
                    LAST_BRAIN_STATUS.update(
                        ok=True, degraded=False, last_error="",
                        last_ok=time.time(),
                        last_model=result.model,
                        calls=LAST_BRAIN_STATUS.get("calls", 0) + 1,
                    )
                payload["decision"] = decision
                payload["decision_valid"] = payload.get("_fallback") is not True
            await conn.send_json(payload)
        except Exception as e:
            log.warning("WS %s failed: %s", rtype, e)
            LAST_BRAIN_STATUS["last_error"] = str(e)[:200]
            if is_decide:
                LAST_BRAIN_STATUS["degraded"] = True
                reason = str(e)[:200]
                safe = (_safe_social_plan(reason) if is_social
                        else _safe_decision(reason))
                try:
                    await conn.send_json({
                        "id": rid,
                        "ok": True,
                        "role_type": rtype,
                        "text": json.dumps(safe),
                        "decision": safe,
                        "decision_valid": False,
                        "_fallback": True,
                        "_fallback_reason": reason,
                        "elapsed_ms": int((time.time() - t0) * 1000),
                        "model": req.get("model") or DEFAULT_BRAIN_MODEL,
                    })
                    return
                except Exception:
                    pass
            try:
                await conn.send_json({"id": rid, "ok": False, "error": str(e)[:300]})
            except Exception:
                pass

    async def _handle_completions(
        self,
        writer: asyncio.StreamWriter,
        path: str,
        body_bytes: bytes,
    ) -> None:
        payload = json.loads(body_bytes.decode("utf-8") or "{}")
        messages = payload.get("messages") or []
        requested_model = payload.get("model") or DEFAULT_MODEL
        temperature = float(payload.get("temperature", 0.85))
        req_max_tokens = int(payload.get("max_tokens", 500))
        low_think = bool(payload.get("low_think", True))
        stream = bool(payload.get("stream", path == "/inference/stream"))

        # Ensure thinking models (GLM-4.7-Flash, Gemma-4, Qwen3) have sufficient
        # token headroom so reasoning_content never truncates visible content.
        if is_thinking_model(requested_model):
            max_tokens = max(req_max_tokens, THINK_MIN_BUDGET)
        else:
            max_tokens = max(req_max_tokens, 256)

        log.info(
            "LLM req path=%s model=%s (wire=%s) msgs=%d max_tokens=%d low_think=%s stream=%s",
            path,
            resolve_short_model(requested_model),
            resolve_wire_model(requested_model),
            len(messages),
            max_tokens,
            low_think,
            stream,
        )

        result = await self.client.chat_completion(
            messages=messages,
            model=requested_model,
            max_tokens=max_tokens,
            temperature=temperature,
            low_think=low_think,
        )

        log.info(
            "LLM ok model=%s elapsed=%dms chars=%d (think=%d chars) fallback=%s",
            result.model,
            result.elapsed_ms,
            len(result.content),
            len(result.reasoning),
            result.fallback_used,
        )

        if stream:
            header_lines = [
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: text/event-stream; charset=utf-8\r\n",
                "Cache-Control: no-cache\r\n",
                "Connection: close\r\n",
            ]
            for k, v in CORS_HEADERS.items():
                header_lines.append(f"{k}: {v}\r\n")
            header_lines.append("\r\n")
            writer.write("".join(header_lines).encode("utf-8"))

            chunk_id = f"chatcmpl-{int(time.time() * 1000)}"
            if result.reasoning:
                think_chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": result.wire_model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "reasoning": result.reasoning,
                                "reasoning_content": result.reasoning,
                            },
                            "finish_reason": None,
                        }
                    ],
                }
                writer.write(
                    f"data: {json.dumps(think_chunk, ensure_ascii=False)}\n\n".encode(
                        "utf-8"
                    )
                )
            chunk = {
                "id": chunk_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": result.wire_model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "role": "assistant",
                            "content": result.content,
                            "reasoning_content": None,
                        },
                        "finish_reason": "stop",
                    }
                ],
                "response": result.content,
            }
            writer.write(
                f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")
            )
            writer.write(b"data: [DONE]\n\n")
            await writer.drain()
            return

        response_obj = {
            "id": f"chatcmpl-{int(time.time() * 1000)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": result.model,
            "wire_model": result.wire_model,
            "elapsed_ms": result.elapsed_ms,
            "fallback_used": result.fallback_used,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": result.content,
                        "reasoning_content": result.reasoning,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": result.usage
            or {
                "prompt_tokens": 0,
                "completion_tokens": len(result.content.split()),
                "total_tokens": len(result.content.split()),
            },
        }
        await self._send_json(writer, 200, response_obj)


async def _main() -> None:
    server = BridgeServer(host=HOST, port=PORT)
    await server.start()
    stop_event = asyncio.Event()
    try:
        await stop_event.wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await server.stop()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        sys.exit(0)
