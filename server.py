#!/usr/bin/env python3
"""
══════════════════════════════════════════════════════════════════════
  🌉  IG-Agent LLM Bridge  ·  server.py  (v3)

  Turns llmchat_provider.py (llmchat.in — 25 free models, no API key)
  into a tiny local HTTP+WS API the Instagram console bot can call,
  and keeps a complete JSON transcript per contact on disk.

  Run:      python server.py            (default http://127.0.0.1:8787)

  Endpoints:
    GET  /health                → {ok, default_model, chain, uptime_s}
    GET  /models                → {models: [...], default}
    POST /reply                 → {messages, model?, max_tokens?, temperature?}
                                  ← {text, model, elapsed_ms, fallback_index}
    POST /v1/chat/completions   → OpenAI-style alias of /reply
    POST /save                  → {transcript:{user, messages, persona, …}}
                                  ← {file, total_messages}  (merged on disk)
    GET  /transcripts           → list of saved contact JSONs
    GET  /transcripts/<user>    → one contact's full transcript JSON

  WebSocket protocol (ws://localhost:8787/ws) — JSON text frames:
    {"id","type":"reply","messages":[…]}   → {"id","ok":true,"text","model"}
    {"id","type":"health"}                 → {"id","ok":true,…}
    {"id","type":"save","transcript":{…}}  → {"id","ok":true,"file",…}

  Self-healing:
    · model fallback chain — if a model errors/times out, next one is tried
    · unknown model names silently fall back to the default (never a 400)
    · <think>…</think> blocks from thinking models are stripped from output
    · reply workers run in parallel threads so one slow chat never blocks
      another; socket writes are serialized so frames can't interleave
  Transcripts:
    · ./transcripts/<user>.json — complete merged message history per
      contact + the agent persona + memory profile; the client only sends
      its recent window, the server merges by message id so nothing is
      ever lost (the client's cap only limits its local cache).
══════════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import re
import struct
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

try:
    from llmchat_provider import LLMChatProvider, MODELS
except ImportError:
    sys.exit("llmchat_provider.py not found — keep it next to server.py")

try:  # emoji-safe Windows console
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ═══════════════════════════ CONFIG ═══════════════════════════

# Primary frontline answering model: Qwen3-30B-A3B-FP8 (fast, snappy DM replies)
DEFAULT_MODEL = "qwen/qwen3-30b-a3b-fp8"
# Background agentic brain model: Gemma-4-26B-A4B-IT (deep personality, memory, proactive tasks)
BRAIN_MODEL = "google/gemma-4-26b-a4b-it"

# Tried in order until one answers. Qwen3-30B first (answering primary),
# then Gemma-4-26B, then fast llama/glm fallbacks.
FALLBACK_CHAIN = [
    "qwen/qwen3-30b-a3b-fp8",
    "google/gemma-4-26b-a4b-it",
    "meta/llama-3.3-70b-instruct-fp8-fast",
    "meta/llama-4-scout-17b-16e-instruct",
    "zai-org/glm-4.7-flash",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "moonshotai/kimi-k2.5",
]

NAME_MAP = {m.name: m for m in MODELS}
_THINK_RE = re.compile(r"<think(?:ing)?>(.*?)</think(?:ing)?>", re.S)

_THINKING = {
    "qwen/qwen3-30b-a3b-fp8",
    "google/gemma-4-26b-a4b-it",
    "moonshotai/kimi-k2.5",
    "qwen/qwq-32b",
    "deepseek-ai/deepseek-r1-distill-qwen-32b",
    "zai-org/glm-4.7-flash",
}
THINK_MIN_BUDGET = 1200   # lean token floor for fast low-think responses

TIMEOUT = 120         # per-model HTTP timeout (s), set by --timeout
START = time.time()

# transcripts live next to server.py
TRANSCRIPT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "transcripts")
TRANSCRIPT_MAX_MSGS = 5000          # per file
_SAVE_LOCK = threading.Lock()       # one writer at a time — merges must not race

# ═══════════════════════════ HELPERS ═══════════════════════════


def extract_think(text: str) -> tuple[str, str]:
    """Return (clean_answer, thinking_trace) from raw model output."""
    traces = [m.strip() for m in _THINK_RE.findall(text or "") if m and m.strip()]
    cleaned = _THINK_RE.sub("", text or "")
    cut = cleaned.find("<think")
    if cut != -1:
        unclosed = cleaned[cut:]
        unclosed = re.sub(r"^<think(?:ing)?>", "", unclosed).strip()
        if unclosed:
            traces.append(unclosed)
        cleaned = cleaned[:cut]
    return cleaned.strip(), "\n".join(traces).strip()


def strip_think(text: str) -> str:
    """Remove reasoning blocks; also salvage a truncated (unclosed) one."""
    cleaned, _ = extract_think(text)
    return cleaned


_LOW_THINK_DIRECTIVE = (
    "\n\n[FAST-THINK DIRECTIVE /no_think]: Think SO LESS. "
    "Keep <think> empty or under 10 words max, close </think> immediately, "
    "and output ONLY the final response."
)


def _apply_low_think(messages: list[dict], model_name: str, fast_think: bool = True) -> list[dict]:
    """Fine-tune prompt for Qwen3 / Gemma-4 so internal thinking stays minimal."""
    if not fast_think or not messages:
        return messages
    out = [dict(m) for m in messages]
    if model_name in ("qwen/qwen3-30b-a3b-fp8", "google/gemma-4-26b-a4b-it"):
        if out[0].get("role") == "system":
            if "/no_think" not in str(out[0].get("content", "")):
                out[0]["content"] = str(out[0].get("content", "")) + _LOW_THINK_DIRECTIVE
        else:
            out.insert(0, {"role": "system", "content": _LOW_THINK_DIRECTIVE.strip()})
        # For Qwen3, appending /no_think to the last user turn triggers native 0-token think mode
        if model_name == "qwen/qwen3-30b-a3b-fp8":
            for idx in range(len(out) - 1, -1, -1):
                if out[idx].get("role") == "user":
                    u_txt = str(out[idx].get("content", ""))
                    if "/no_think" not in u_txt:
                        out[idx]["content"] = u_txt + " /no_think"
                    break
    return out


def resolve_model(query) -> str | None:
    """Exact or substring match; None = unknown → caller uses fallback chain.

    Accepts both the registry name ("google/gemma-4-26b-a4b-it") and the wire
    form ("@cf/google/gemma-4-26b-a4b-it"), case-insensitively.
    """
    if not query:
        return DEFAULT_MODEL
    q = str(query).strip()
    if q.startswith("@") and "/" in q:
        q = q.split("/", 1)[1]
    if q in NAME_MAP:
        return q
    ql = q.lower()
    for name in NAME_MAP:
        if name.lower() == ql:
            return name
    for name in NAME_MAP:
        if ql in name.lower():
            return name
    return None


def model_endpoint(name: str) -> str:
    """Registry name → the exact wire model id ("@cf/…") used upstream."""
    m = NAME_MAP.get(name)
    return m.endpoint if m else name


def _generate(messages: list, model: str, max_tokens: int, temperature: float):
    """Blocking: stream one model to completion.

    Returns (raw_text, reasoning_chars, usage).  raw_text still carries the
    <think>…</think> wrapper the provider adds around reasoning_content;
    strip_think() removes it.
    """
    prov = LLMChatProvider(
        model=model,
        system=None,               # system prompt already inside messages
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=TIMEOUT,
        retries=1,                 # fail fast — the fallback chain retries
    )

    async def run() -> str:
        out: list[str] = []
        async for tok in prov.chat(messages=messages):
            out.append(tok)
        return "".join(out)

    raw = asyncio.run(run())
    return raw, prov.reasoning_chars, dict(prov.last_usage)


def generate_with_fallback(messages, model_query=None, max_tokens=512, temperature=0.9, fast_think=True):
    """Shared by POST /reply, POST /brain, and the WebSocket channel."""
    max_tokens = int(max_tokens or 512)
    temperature = float(temperature if temperature is not None else 0.9)
    first = resolve_model(model_query)
    chain: list[str] = []
    for name in ([first] if first else []) + FALLBACK_CHAIN:
        if name not in chain:
            chain.append(name)
    errors = []
    for i, name in enumerate(chain):
        t0 = time.time()
        budget = max(max_tokens, THINK_MIN_BUDGET) if name in _THINKING else max_tokens
        tuned_msgs = _apply_low_think(messages, name, fast_think=fast_think)
        try:
            raw, reasoning_chars, usage = _generate(tuned_msgs, name, budget, temperature)
            text, thinking_trace = extract_think(raw)
            if not reasoning_chars and thinking_trace:
                reasoning_chars = len(thinking_trace)
            if not text:
                raise RuntimeError("empty output")
            dt = time.time() - t0
            tokens = int(usage.get("completion_tokens") or 0)
            print(f"[reply] {name}  {dt:.1f}s  {len(text)} chars"
                  + (f"  · think {reasoning_chars} ch" if reasoning_chars else "")
                  + (f"  · {tokens} tok" if tokens else "")
                  + (f"  (fallback #{i})" if i else ""), flush=True)
            return {
                "text": text,
                "model": name,
                "endpoint": model_endpoint(name),
                "elapsed_ms": round(dt * 1000),
                "fallback_index": i,
                "reasoning_chars": reasoning_chars,
                "thinking_trace": thinking_trace[:500] if thinking_trace else "",
                "usage": usage,
            }
        except Exception as e:
            errors.append(f"{name}: {str(e)[:160]}")
            print(f"[fall]  {errors[-1]}", flush=True)
    raise RuntimeError("all models failed: " + " | ".join(errors[:2]))


# ═══════════════════ TRANSCRIPTS (per-contact JSON files) ═══════════════════


def _safe_user(user: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._-]", "_", str(user or "").lstrip("@").strip())
    return name or "unknown"


def _transcript_path(user: str) -> str:
    return os.path.join(TRANSCRIPT_DIR, _safe_user(user) + ".json")


def save_transcript(tr: dict) -> dict:
    """Merge a client transcript window + complete v6 agentic process log,
    brain profile, and agent state into the on-disk JSON file. Atomic write."""
    user = str(tr.get("user") or "").strip() or "unknown"
    path = _transcript_path(user)
    with _SAVE_LOCK:
        old_msgs: dict[str, dict] = {}
        old_proc: dict[str, dict] = {}
        keep: dict = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    old = json.load(f)
                for m in old.get("messages", []):
                    if isinstance(m, dict) and m.get("id"):
                        old_msgs[str(m["id"])] = m
                for p_entry in old.get("process_log", []):
                    if isinstance(p_entry, dict) and p_entry.get("turn_id"):
                        old_proc[str(p_entry["turn_id"])] = p_entry
                keep = {k: old.get(k) for k in (
                    "persona", "owner_bio", "memory_profile",
                    "brain_profile", "agent_state", "models"
                )}
            except Exception:
                old_msgs, old_proc, keep = {}, {}, {}

        incoming = tr.get("messages") or []
        for m in incoming:
            if isinstance(m, dict) and m.get("id"):
                mid = str(m["id"])
                prev_m = old_msgs.get(mid) or {}
                merged_m = {**prev_m, **m}
                if m.get("ts") and not merged_m.get("iso_time"):
                    try:
                        merged_m["iso_time"] = datetime.fromtimestamp(
                            float(m["ts"]) / 1000.0, tz=timezone.utc
                        ).isoformat(timespec="seconds")
                    except Exception:
                        pass
                old_msgs[mid] = merged_m

        for p_entry in (tr.get("process_log") or []):
            if isinstance(p_entry, dict) and p_entry.get("turn_id"):
                old_proc[str(p_entry["turn_id"])] = p_entry

        msgs = sorted(old_msgs.values(), key=lambda m: m.get("ts") or 0)
        proc_list = sorted(old_proc.values(), key=lambda x: x.get("at") or 0)[-500:]
        brain_prof = tr.get("brain_profile") or keep.get("brain_profile") or {}
        agent_st = tr.get("agent_state") or keep.get("agent_state") or {}
        models_meta = tr.get("models") or keep.get("models") or {
            "answering_model": model_endpoint(DEFAULT_MODEL),
            "brain_model": model_endpoint(BRAIN_MODEL),
        }

        doc = {
            "schema_version": "6.0-agentic",
            "user": user,
            "thread_fbid": tr.get("thread_fbid"),
            "updated_at": tr.get("updated_at")
                          or datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "message_count": len(msgs),
            "process_turn_count": len(proc_list),
            "models": models_meta,
            "agent_state": agent_st,
            "brain_profile": brain_prof,
            "memory_profile": tr.get("memory_profile") or keep.get("memory_profile") or "",
            "persona": tr.get("persona") or keep.get("persona") or "",
            "owner_bio": tr.get("owner_bio") or keep.get("owner_bio") or "",
            "process_log": proc_list,
            "messages": msgs[-TRANSCRIPT_MAX_MSGS:],
        }
        os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    total = len(doc["messages"])
    print(f"[save] @{_safe_user(user)}  {total} msgs ({len(proc_list)} agentic turns)  →  {os.path.basename(path)}", flush=True)
    return {"file": path, "total_messages": total, "process_turn_count": len(proc_list)}


def list_transcripts() -> list[dict]:
    out = []
    if os.path.isdir(TRANSCRIPT_DIR):
        for fn in sorted(os.listdir(TRANSCRIPT_DIR)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(TRANSCRIPT_DIR, fn), encoding="utf-8") as f:
                    d = json.load(f)
                out.append({
                    "user": d.get("user", fn[:-5]),
                    "file": fn,
                    "message_count": d.get("message_count", len(d.get("messages", []))),
                    "updated_at": d.get("updated_at", ""),
                })
            except Exception:
                out.append({"user": fn[:-5], "file": fn, "message_count": None, "updated_at": "unreadable"})
    return out


def load_transcript(user: str) -> dict | None:
    path = _transcript_path(user)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


GLOBAL_MEM_PATH = os.path.join(TRANSCRIPT_DIR, "_global_memory.json")


def save_global_memory(gm: dict) -> dict:
    """Persist the cross-chat global memory + social graph + gossip on disk."""
    with _SAVE_LOCK:
        old: dict = {}
        if os.path.exists(GLOBAL_MEM_PATH):
            try:
                with open(GLOBAL_MEM_PATH, encoding="utf-8") as f:
                    old = json.load(f)
            except Exception:
                old = {}
        people = dict(old.get("people") or {})
        for k, v in (gm.get("people") or {}).items():
            if isinstance(v, dict):
                people[str(k)] = v
        conns = gm.get("connections") or old.get("connections") or []
        gossip = (old.get("gossip") or []) + (gm.get("gossip") or [])
        seen_g = set()
        dedup_gossip = []
        for g in gossip:
            gs = str(g).strip()
            if gs and gs not in seen_g:
                seen_g.add(gs)
                dedup_gossip.append(gs)
        doc = {
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "connections": conns,
            "people": people,
            "gossip": dedup_gossip[-200:],
        }
        os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
        tmp = GLOBAL_MEM_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
        os.replace(tmp, GLOBAL_MEM_PATH)
    return {"file": GLOBAL_MEM_PATH, "people_count": len(doc["people"]), "gossip_count": len(doc["gossip"])}


def load_global_memory() -> dict:
    if os.path.exists(GLOBAL_MEM_PATH):
        try:
            with open(GLOBAL_MEM_PATH, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"connections": [], "people": {}, "gossip": []}


# ═══════════════════════════ WEBSOCKET (CSP bypass) ═══════════════════════════
# Instagram's CSP blocks fetch() to http://127.0.0.1 but ALLOWS ws://localhost:*.
# So the page-side bot talks to the bridge over a tiny hand-rolled WebSocket.
# Protocol (JSON text frames): {"id","type":"reply"|"health"|"save",...}
# → {"id","ok":true,...} / {"id","ok":false,"error"}

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_accept(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + _WS_GUID).encode()).digest()).decode()


class _WSConn:
    """Minimal RFC6455 server-side connection (text frames, ping/pong/close)."""

    def __init__(self, rfile, wfile):
        self.rfile, self.wfile = rfile, wfile
        # Reply workers may complete out of order; serialize physical writes so
        # their WebSocket frames can never interleave on the same socket.
        self._write_lock = threading.Lock()

    def _read_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                raise ConnectionError("client gone")
            buf += chunk
        return buf

    def recv_text(self, timeout_s: float = 600):
        """Return next text payload (handles ping/pong/close). None = closed."""
        while True:
            h = self._read_exact(2)
            fin, opcode = (h[0] >> 7) & 1, h[0] & 0x0F
            masked, length = (h[1] >> 7) & 1, h[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else None
            payload = self._read_exact(length) if length else b""
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x1:                       # text
                return payload.decode("utf-8", "replace")
            if opcode == 0x9:                       # ping → pong
                self.send_frame(payload, 0xA)
                continue
            if opcode == 0x8:                       # close
                try:
                    self.send_frame(payload, 0x8)
                except Exception:
                    pass
                return None
            continue                                # pong/other — ignore

    def send_frame(self, data: bytes, opcode: int = 0x1):
        header = bytes([0x80 | opcode])
        n = len(data)
        if n < 126:
            header += bytes([n])
        elif n < (1 << 16):
            header += bytes([126]) + struct.pack(">H", n)
        else:
            header += bytes([127]) + struct.pack(">Q", n)
        with self._write_lock:
            self.wfile.write(header + data)
            self.wfile.flush()

    def send_text(self, s: str):
        self.send_frame(s.encode("utf-8"))


def _serve_ws_reply(conn: _WSConn, req: dict) -> None:
    """Generate one reply or background brain pass in its own worker thread."""
    rid = req.get("id")
    req_type = req.get("type") or "reply"
    try:
        messages = req.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("'messages' must be a non-empty list")
        default_m = BRAIN_MODEL if req_type == "brain" else DEFAULT_MODEL
        model_q = req.get("model") or default_m
        result = generate_with_fallback(
            messages, model_q, req.get("max_tokens"), req.get("temperature"),
            fast_think=req.get("fast_think", True))
        resp = {"id": rid, "ok": True, "role_type": req_type, **result}
    except Exception as e:
        resp = {"id": rid, "ok": False, "error": str(e)[:300]}
    try:
        conn.send_text(json.dumps(resp))
    except (BrokenPipeError, ConnectionError, OSError, ValueError):
        pass


def handle_ws(handler) -> None:
    """Upgrade + serve one WebSocket client; reply jobs run independently."""
    key = handler.headers.get("Sec-WebSocket-Key", "")
    handler.close_connection = True     # socket is ours now, not the HTTP loop's
    handler.send_response(101, "Switching Protocols")
    handler.send_header("Upgrade", "websocket")
    handler.send_header("Connection", "Upgrade")
    handler.send_header("Sec-WebSocket-Accept", _ws_accept(key))
    handler.end_headers()
    conn = _WSConn(handler.rfile, handler.wfile)
    print("[ws] client connected", flush=True)
    try:
        while True:
            raw = conn.recv_text()
            if raw is None:
                break
            try:
                req = json.loads(raw)
            except Exception:
                conn.send_text(json.dumps({"ok": False, "error": "bad json"}))
                continue
            if req.get("type") == "health":
                resp = {"id": req.get("id"), "ok": True,
                        "default_model": DEFAULT_MODEL,
                        "default_endpoint": model_endpoint(DEFAULT_MODEL),
                        "brain_model": BRAIN_MODEL,
                        "brain_endpoint": model_endpoint(BRAIN_MODEL),
                        "chain": FALLBACK_CHAIN,
                        "uptime_s": round(time.time() - START)}
                conn.send_text(json.dumps(resp))
                continue
            if req.get("type") == "bot":
                bot_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ig-agent-chat.js")
                try:
                    with open(bot_path, encoding="utf-8") as bf:
                        code = bf.read()
                    resp = {"id": req.get("id"), "ok": True, "code": code}
                except Exception as e:
                    resp = {"id": req.get("id"), "ok": False, "error": str(e)[:200]}
                conn.send_text(json.dumps(resp))
                continue
            if req.get("type") == "save":
                rid = req.get("id")
                try:
                    tr = req.get("transcript")
                    if not isinstance(tr, dict) or not tr.get("user"):
                        raise ValueError("'transcript' with 'user' is required")
                    r = save_transcript(tr)
                    resp = {"id": rid, "ok": True, **r}
                except Exception as e:
                    resp = {"id": rid, "ok": False, "error": str(e)[:300]}
                try:
                    conn.send_text(json.dumps(resp))
                except (BrokenPipeError, ConnectionError, OSError, ValueError):
                    pass
                continue
            if req.get("type") == "save_global":
                rid = req.get("id")
                try:
                    gm = req.get("global_memory") or req.get("global")
                    if not isinstance(gm, dict):
                        raise ValueError("'global_memory' dict is required")
                    r = save_global_memory(gm)
                    resp = {"id": rid, "ok": True, "people": r["people_count"], **r}
                except Exception as e:
                    resp = {"id": rid, "ok": False, "error": str(e)[:300]}
                try:
                    conn.send_text(json.dumps(resp))
                except (BrokenPipeError, ConnectionError, OSError, ValueError):
                    pass
                continue
            if req.get("type") == "get_global":
                rid = req.get("id")
                gm_doc = load_global_memory()
                conn.send_text(json.dumps({"id": rid, "ok": True, "global_memory": gm_doc, "global": gm_doc}))
                continue
            # Do not block this connection while an LLM streams. The browser's
            # request ids let responses safely arrive in whichever order finishes first.
            threading.Thread(target=_serve_ws_reply, args=(conn, req), daemon=True).start()
    except (ConnectionError, OSError, ValueError) as e:
        print(f"[ws] client left ({e})", flush=True)


# ═══════════════════════════ HTTP ═══════════════════════════


class Handler(BaseHTTPRequestHandler):
    server_version = "IGAgentBridge/3.0"

    # -- CORS incl. Private Network Access (https page → http://127.0.0.1)
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # silence default stderr noise
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if (self.headers.get("Upgrade", "").lower() == "websocket"
                and path in ("/ws", "/")):
            handle_ws(self)
            return
        if path == "/health":
            self._json(200, {
                "ok": True,
                "default_model": DEFAULT_MODEL,
                "default_endpoint": model_endpoint(DEFAULT_MODEL),
                "brain_model": BRAIN_MODEL,
                "brain_endpoint": model_endpoint(BRAIN_MODEL),
                "chain": FALLBACK_CHAIN,
                "uptime_s": round(time.time() - START),
            })
        elif path == "/models":
            self._json(200, {"models": [m.name for m in MODELS], "default": DEFAULT_MODEL})
        elif path == "/global_memory":
            self._json(200, load_global_memory())
        elif path == "/transcripts":
            self._json(200, {"transcripts": list_transcripts()})
        elif path.startswith("/transcripts/"):
            user = unquote(path[len("/transcripts/"):])
            doc = load_transcript(user)
            if doc is None:
                self._json(404, {"error": "no transcript for " + user})
            else:
                self._json(200, doc)
        else:
            self._json(200, {
                "ok": True,
                "service": "ig-agent-llm-bridge",
                "endpoints": ["GET /health", "GET /models", "POST /reply",
                              "POST /v1/chat/completions", "POST /save",
                              "GET /transcripts", "GET /transcripts/<user>"],
            })

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/reply", "/brain", "/v1/chat/completions", "/save"):
            return self._json(404, {"error": "unknown endpoint " + path})

        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json(400, {"error": f"bad JSON body: {e}"})

        if path == "/save":
            tr = body.get("transcript")
            if not isinstance(tr, dict) or not tr.get("user"):
                return self._json(400, {"error": "'transcript' with 'user' is required"})
            try:
                return self._json(200, save_transcript(tr))
            except Exception as e:
                return self._json(500, {"error": str(e)[:300]})

        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return self._json(400, {"error": "'messages' must be a non-empty list"})

        try:
            default_m = BRAIN_MODEL if path == "/brain" else DEFAULT_MODEL
            result = generate_with_fallback(
                messages, body.get("model") or default_m, body.get("max_tokens"),
                body.get("temperature", 0.9), fast_think=body.get("fast_think", True))
        except Exception as e:
            return self._json(502, {"error": str(e)[:300]})

        if path == "/v1/chat/completions":
            return self._json(200, {
                "choices": [{"message": {"role": "assistant", "content": result["text"]}}],
                "model": result["model"],
                "usage": result.get("usage") or {},
            })
        return self._json(200, result)


# ═══════════════════════════ MAIN ═══════════════════════════


def main():
    global TIMEOUT
    ap = argparse.ArgumentParser(description="IG-Agent LLM bridge (llmchat.in)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--timeout", type=int, default=120, help="per-model LLM timeout in seconds")
    args = ap.parse_args()
    TIMEOUT = args.timeout

    os.makedirs(TRANSCRIPT_DIR, exist_ok=True)
    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"IG-Agent LLM bridge  ->  http://{args.host}:{args.port}")
    print(f"default model : {DEFAULT_MODEL}")
    print(f"fallback chain: {len(FALLBACK_CHAIN)} models, auto-rotate on failure")
    print(f"transcripts   : {TRANSCRIPT_DIR}")
    print("waiting for calls from ig-agent-chat.js ...  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbridge stopped")


if __name__ == "__main__":
    main()
