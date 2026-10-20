"""
Local bridge server (`http://localhost:8765`) for the Instagram DM Agent (v7).

Features:
  - Forwards `/v1/chat/completions` and `/inference/stream` to `llmchat.in`
    using `LLMChatClient` (async `curl_cffi` with Chrome TLS impersonation).
  - Dual-Model Parallel Architecture (v7):
      * Primary Answering & Creative Agent Model: `@cf/zai-org/glm-4.7-flash`
        (`zai-org/glm-4.7-flash`) with minimal-thinking prompt enforcement.
      * Background Brain & Strategy Model: `@cf/google/gemma-4-26b-a4b-it`
        (`google/gemma-4-26b-a4b-it`).
      * Fast Fallback Model: `@cf/qwen/qwen3-30b-a3b-fp8`.
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

# Token floor for thinking models (GLM-4.7-Flash, Gemma-4, Qwen3) so internal
# reasoning_content never starves the visible reply content.
THINK_MIN_BUDGET = int(os.environ.get("IG_THINK_MIN_BUDGET", "2500"))

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
            "IG Bridge Server v7 listening on http://%s:%d (answering=%s, brain=%s -> %s)",
            self.host,
            self.port,
            DEFAULT_MODEL,
            DEFAULT_BRAIN_MODEL,
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
                        "version": "7.0",
                        "provider": "llmchat.in",
                        "default_model": DEFAULT_MODEL,
                        "default_endpoint": resolve_wire_model(DEFAULT_MODEL),
                        "default_wire_model": resolve_wire_model(DEFAULT_MODEL),
                        "brain_model": DEFAULT_BRAIN_MODEL,
                        "brain_endpoint": resolve_wire_model(DEFAULT_BRAIN_MODEL),
                        "brain_wire_model": resolve_wire_model(DEFAULT_BRAIN_MODEL),
                        "fallback_chain": FALLBACK_CHAIN,
                        "chain": FALLBACK_CHAIN,
                        "models": list(MODEL_REGISTRY.keys()),
                        "transcripts_dir": str(TRANSCRIPTS_DIR),
                        "uptime_s": round(time.time() - START),
                        "unconditional_idle_starter": False,
                        "privacy_wall": True,
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
                        if f.name == "_global_memory.json":
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
                    )
                    await self._send_json(writer, 200, saved)
                    return

            if path in ("/v1/chat/completions", "/inference/stream") and method == "POST":
                await self._handle_completions(writer, path, body_bytes)
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
                if rtype in ("reply", "brain", "llm"):
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
                    "chain": FALLBACK_CHAIN,
                    "models": list(MODEL_REGISTRY.keys()),
                    "uptime_s": round(time.time() - START),
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

            await conn.send_json({"id": rid, "ok": False, "error": f"unknown type {rtype}"})
        except Exception as e:
            await conn.send_json({"id": rid, "ok": False, "error": str(e)[:300]})

    async def _ws_llm_worker(self, conn: _WSConn, req: dict, rtype: str) -> None:
        """Frontline `reply` (GLM-4.7-Flash) and background `brain` (Gemma-4) calls."""
        rid = req.get("id")
        try:
            messages = req.get("messages")
            if not isinstance(messages, list) or not messages:
                raise ValueError("'messages' must be a non-empty list")

            default_m = DEFAULT_BRAIN_MODEL if rtype == "brain" else DEFAULT_MODEL
            model_q = req.get("model") or default_m
            req_max = int(req.get("max_tokens") or (320 if rtype == "brain" else 500))
            if is_thinking_model(model_q):
                max_tokens = max(req_max, THINK_MIN_BUDGET)
            else:
                max_tokens = max(req_max, 256)

            log.info(
                "WS %s model=%s (wire=%s) msgs=%d max_tokens=%d",
                rtype, resolve_short_model(model_q), resolve_wire_model(model_q),
                len(messages), max_tokens,
            )

            result = await self.client.chat_completion(
                messages=messages,
                model=model_q,
                max_tokens=max_tokens,
                temperature=float(req.get("temperature", 0.85 if rtype != "brain" else 0.35)),
                low_think=bool(req.get("fast_think", True)),
            )

            await conn.send_json({
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
            })
        except Exception as e:
            log.warning("WS %s failed: %s", rtype, e)
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
