#!/usr/bin/env python3
"""
══════════════════════════════════════════════════════════════════════
  🌉  IG-Agent LLM Bridge  ·  server.py

  Turns llmchat_provider.py (llmchat.in — 23 free models, no API key)
  into a tiny local HTTP API the Instagram console bot can call.

  Run:      python server.py            (default http://127.0.0.1:8787)

  Endpoints:
    GET  /health                → {ok, default_model, chain, uptime_s}
    GET  /models                → {models: [...], default}
    POST /reply                 → {messages, model?, max_tokens?, temperature?}
                                  ← {text, model, elapsed_ms, fallback_index}
    POST /v1/chat/completions   → OpenAI-style alias of /reply

  Self-healing:
    · model fallback chain — if a model errors/times out, next one is tried
    · unknown model names silently fall back to the default (never a 400)
    · <think>…</think> blocks from thinking models are stripped from output
    · CORS + Private-Network headers so https://instagram.com can call it
══════════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import re
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

try:
    from llmchat_provider import LLMChatProvider, MODELS
except ImportError:
    sys.exit("llmchat_provider.py not found — keep it next to server.py")

try:  # emoji-safe Windows console
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ═══════════════════════════ CONFIG ═══════════════════════════

DEFAULT_MODEL = "meta/llama-3.3-70b-instruct-fp8-fast"

# Tried in order until one answers. Fast pair first (sub-2s replies),
# then slower smarter models; kimi last (currently dead upstream —
# streams nothing, but fails in ~1s so it costs nothing to keep).
FALLBACK_CHAIN = [
    "meta/llama-3.3-70b-instruct-fp8-fast",
    "meta/llama-4-scout-17b-16e-instruct",
    "zai-org/glm-4.7-flash",
    "meta/llama-3.1-70b-instruct",
    "qwen/qwen3-30b-a3b-fp8",
    "meta/llama-3.1-8b-instruct",
    "moonshotai/kimi-k2.5",
]

NAME_MAP = {m.name: m for m in MODELS}
_THINK_RE = re.compile(r"<think>.*?</think>", re.S)

# models that burn token budget on reasoning before answering
_THINKING = {
    "moonshotai/kimi-k2.5",
    "qwen/qwq-32b",
    "deepseek-ai/deepseek-r1-distill-qwen-32b",
    "qwen/qwen3-30b-a3b-fp8",
    "zai-org/glm-4.7-flash",
}

TIMEOUT = 90          # per-model HTTP timeout (s), set by --timeout
START = time.time()

# ═══════════════════════════ HELPERS ═══════════════════════════


def strip_think(text: str) -> str:
    """Remove reasoning blocks; also salvage a truncated (unclosed) one."""
    text = _THINK_RE.sub("", text)
    cut = text.find("<think>")
    if cut != -1:
        text = text[:cut]
    return text.strip()


def resolve_model(query) -> str | None:
    """Exact or substring match; None = unknown → caller uses fallback chain."""
    if not query:
        return DEFAULT_MODEL
    q = str(query)
    if q in NAME_MAP:
        return q
    q = q.lower()
    for name in NAME_MAP:
        if q in name.lower():
            return name
    return None


def _generate(messages: list, model: str, max_tokens: int, temperature: float) -> str:
    """Blocking: stream one model to completion, return raw text."""
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

    return asyncio.run(run())


# ═══════════════════════════ WEBSOCKET (CSP bypass) ═══════════════════════════
# Instagram's CSP blocks fetch() to http://127.0.0.1 but ALLOWS ws://localhost:*.
# So the page-side bot talks to the bridge over a tiny hand-rolled WebSocket.
# Protocol (JSON text frames): {"id","type":"reply"|"health","messages",...}
# → {"id","ok":true,"text","model"} / {"id","ok":false,"error"}

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
    """Generate one reply in its own worker so independent chats run in parallel."""
    rid = req.get("id")
    try:
        messages = req.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("'messages' must be a non-empty list")
        text, model = generate_with_fallback(
            messages, req.get("model"), req.get("max_tokens"), req.get("temperature"))
        resp = {"id": rid, "ok": True, "text": text, "model": model}
    except Exception as e:
        resp = {"id": rid, "ok": False, "error": str(e)[:300]}
    try:
        conn.send_text(json.dumps(resp))
    except (BrokenPipeError, ConnectionError, OSError, ValueError):
        # The browser can close/reload while an LLM is still generating.
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
                resp = {"id": req.get("id"), "ok": True, "default_model": DEFAULT_MODEL,
                        "chain": FALLBACK_CHAIN, "uptime_s": round(time.time() - START)}
                conn.send_text(json.dumps(resp))
                continue
            # Do not block this connection while an LLM streams. The browser's
            # request ids let responses safely arrive in whichever order finishes first.
            threading.Thread(target=_serve_ws_reply, args=(conn, req), daemon=True).start()
    except (ConnectionError, OSError, ValueError) as e:
        print(f"[ws] client left ({e})", flush=True)


def generate_with_fallback(messages, model_query, max_tokens=512, temperature=0.9):
    """Shared by POST /reply and the WebSocket channel."""
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
        budget = max(max_tokens, 2500) if name in _THINKING else max_tokens
        try:
            raw = _generate(messages, name, budget, temperature)
            text = strip_think(raw)
            if not text:
                raise RuntimeError("empty output")
            dt = time.time() - t0
            print(f"[reply] {name}  {dt:.1f}s  {len(text)} chars"
                  + (f"  (fallback #{i})" if i else ""), flush=True)
            return text, name
        except Exception as e:
            errors.append(f"{name}: {str(e)[:160]}")
            print(f"[fall]  {errors[-1]}", flush=True)
    raise RuntimeError("all models failed: " + " | ".join(errors[:2]))


# ═══════════════════════════ HTTP ═══════════════════════════


class Handler(BaseHTTPRequestHandler):
    server_version = "IGAgentBridge/1.0"

    # -- CORS incl. Private Network Access (https page → http://127.0.0.1)
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
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
                "chain": FALLBACK_CHAIN,
                "uptime_s": round(time.time() - START),
            })
        elif path == "/models":
            self._json(200, {"models": [m.name for m in MODELS], "default": DEFAULT_MODEL})
        else:
            self._json(200, {
                "ok": True,
                "service": "ig-agent-llm-bridge",
                "endpoints": ["GET /health", "GET /models", "POST /reply", "POST /v1/chat/completions"],
            })

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/reply", "/v1/chat/completions"):
            return self._json(404, {"error": "unknown endpoint " + path})

        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            return self._json(400, {"error": f"bad JSON body: {e}"})

        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return self._json(400, {"error": "'messages' must be a non-empty list"})

        try:
            text, model = generate_with_fallback(
                messages, body.get("model"), body.get("max_tokens"),
                body.get("temperature", 0.9))
        except Exception as e:
            return self._json(502, {"error": str(e)[:300]})

        if path == "/v1/chat/completions":
            return self._json(200, {
                "choices": [{"message": {"role": "assistant", "content": text}}],
                "model": model,
            })
        return self._json(200, {"text": text, "model": model})


# ═══════════════════════════ MAIN ═══════════════════════════


def main():
    global TIMEOUT
    ap = argparse.ArgumentParser(description="IG-Agent LLM bridge (llmchat.in)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--timeout", type=int, default=90, help="per-model LLM timeout in seconds")
    args = ap.parse_args()
    TIMEOUT = args.timeout

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"IG-Agent LLM bridge  ->  http://{args.host}:{args.port}")
    print(f"default model : {DEFAULT_MODEL}")
    print(f"fallback chain: {len(FALLBACK_CHAIN)} models, auto-rotate on failure")
    print("waiting for calls from ig-agent-chat.js ...  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbridge stopped")


if __name__ == "__main__":
    main()
