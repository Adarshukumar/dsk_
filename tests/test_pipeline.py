#!/usr/bin/env python3
"""
End-to-end offline tests for the gemma-4 pipeline.

    python tests/test_pipeline.py

Runs with the system/test environment's Python; needs curl_cffi (same
dependency as the bridge itself).  No network access required.
"""
from __future__ import annotations

import base64
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import llmchat_provider                      # noqa: E402
import server                                # noqa: E402
from mock_llmchat import MockLLM, MODEL_WIRE, CONTENT   # noqa: E402

PASS, FAIL = [], []


def check(name):
    def deco(fn):
        try:
            detail = fn()
            PASS.append((name, detail))
            print(f"  ✅ {name} — {detail}")
        except Exception as e:
            FAIL.append((name, e))
            print(f"  ❌ {name} — {e}")
        return fn
    return deco


def collect_stream(messages):
    async def run():
        prov = llmchat_provider.LLMChatProvider(
            model="google/gemma-4-26b-a4b-it",
            system=None, temperature=0.9, max_tokens=600,
            timeout=30, retries=0,
        )
        out = []
        async for tok in prov.chat(messages=messages):
            out.append(tok)
        return "".join(out), prov
    import asyncio
    return asyncio.run(run())


def http_json(url, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read())


def ws_session(port):
    """Tiny raw RFC6455 client: connect, return (send_json, recv_json, close)."""
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((
        f"GET /ws HTTP/1.1\r\nHost: localhost:{port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    ).encode())
    head = b""
    while b"\r\n\r\n" not in head:
        head += s.recv(1)
    if b" 101 " not in head.split(b"\r\n")[0]:
        raise AssertionError("WS upgrade failed: " + head.split(b"\r\n")[0].decode())

    def send_json(obj):
        payload = json.dumps(obj).encode()
        mask = os.urandom(4)
        if len(payload) < 126:
            header = bytes([0x81, 0x80 | len(payload)])
        elif len(payload) < (1 << 16):
            header = bytes([0x81, 0x80 | 126]) + struct.pack(">H", len(payload))
        else:
            header = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", len(payload))
        s.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def recv_exact(n):
        buf = b""
        while len(buf) < n:
            chunk = s.recv(n - len(buf))
            if not chunk:
                raise AssertionError("socket closed")
            buf += chunk
        return buf

    def recv_json():
        h = recv_exact(2)
        length = h[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", recv_exact(8))[0]
        return json.loads(recv_exact(length).decode())

    return send_json, recv_json, s.close


def wait_http(url, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            status, body = http_json(url, timeout=3)
            if status == 200:
                return body
        except Exception:
            time.sleep(0.3)
    raise AssertionError("server did not come up: " + url)


def test_provider(mock):
    llmchat_provider._API = mock.url
    msgs = [{"role": "user", "content": "bro hi"}]
    raw, prov = collect_stream(msgs)

    assert "<think>" in raw, "provider did not wrap reasoning in <think>"
    assert "The user said" in raw, "reasoning text missing"
    assert CONTENT.strip() in raw, "answer text missing"
    assert prov.reasoning_chars > 100, f"reasoning_chars={prov.reasoning_chars}"
    assert prov.last_usage.get("completion_tokens") == 250, prov.last_usage
    assert mock.requests, "mock received no request"
    sent = mock.requests[-1]
    assert sent["model"] == MODEL_WIRE, f"wire model was {sent['model']!r}"
    assert sent["body"].get("stream") is True
    assert sent["body"].get("max_tokens") == 600
    assert sent["body"]["messages"][-1]["role"] == "assistant"
    return f"{prov.reasoning_chars} reasoning chars · model {MODEL_WIRE} used"


def test_strip():
    assert server.strip_think("a<think>x</think>b") == "ab"
    assert server.strip_think("a<thinking>x</thinking>b") == "ab"
    assert server.strip_think("a<think>unclosed") == "a"
    assert server.strip_think("plain") == "plain"
    return "closed, <thinking>, truncated"


def test_config():
    assert server.DEFAULT_MODEL == "google/gemma-4-26b-a4b-it"
    assert server.FALLBACK_CHAIN[0] == server.DEFAULT_MODEL
    assert server.model_endpoint(server.DEFAULT_MODEL) == MODEL_WIRE
    assert server.resolve_model("@cf/google/gemma-4-26b-a4b-it") == server.DEFAULT_MODEL
    assert server.resolve_model("GEMMA-4-26B") == server.DEFAULT_MODEL
    assert server.resolve_model(None) == server.DEFAULT_MODEL
    return "primary + fallbacks + name resolution"


def test_fallback(mock):
    llmchat_provider._API = mock.url
    msgs = [{"role": "user", "content": "bro hi"}]
    res = server.generate_with_fallback(msgs, "@cf/google/gemma-4-26b-a4b-it", 600, 0.9)
    assert res["text"] == CONTENT.strip(), res["text"]
    assert res["model"] == server.DEFAULT_MODEL
    assert res["fallback_index"] == 0
    assert "<think" not in res["text"]
    assert res["reasoning_chars"] > 100
    assert res["usage"].get("completion_tokens") == 250

    with MockLLM(fail_models=("gemma",)) as broken:
        llmchat_provider._API = broken.url
        res2 = server.generate_with_fallback(msgs, "@cf/google/gemma-4-26b-a4b-it", 600, 0.9)
        assert res2["model"] == "meta/llama-3.3-70b-instruct-fp8-fast", res2["model"]
        assert res2["fallback_index"] == 1, res2["fallback_index"]
        assert res2["text"] == CONTENT.strip()
    return "gemma-4 primary · auto-fallback when gemma fails"


def test_bridge_http_ws(mock):
    env = dict(os.environ, LLMCHAT_API=mock.url)
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py"), "--port", "8791"],
        cwd=str(ROOT), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        health = wait_http("http://127.0.0.1:8791/health")
        assert health["default_endpoint"] == MODEL_WIRE, health
        assert health["chain"][0] == server.DEFAULT_MODEL

        status, reply = http_json("http://127.0.0.1:8791/reply", {
            "messages": [{"role": "user", "content": "bro hi"}],
            "max_tokens": 600,
        })
        assert status == 200
        assert reply["text"] == CONTENT.strip(), reply["text"]
        assert reply["reasoning_chars"] > 100
        assert "elapsed_ms" in reply and "fallback_index" in reply

        status, oai = http_json("http://127.0.0.1:8791/v1/chat/completions", {
            "messages": [{"role": "user", "content": "bro hi"}]})
        assert oai["choices"][0]["message"]["content"] == CONTENT.strip()

        send, recv, close = ws_session(8791)
        try:
            send({"id": "h1", "type": "health"})
            h = recv()
            assert h["id"] == "h1" and h["default_endpoint"] == MODEL_WIRE, h

            send({"id": "r1", "type": "reply", "messages": [
                {"role": "user", "content": "bro hi"}]})
            r = recv()
            assert r["ok"] and r["text"] == CONTENT.strip(), r

            send({"id": "s1", "type": "save", "transcript": {
                "user": "_pipeline_test",
                "messages": [{"id": "test:1", "ts": 1, "mine": False,
                              "kind": "text", "label": "text", "text": "hi"}]}})
            saved = recv()
            assert saved["ok"] and saved["total_messages"] == 1, saved
        finally:
            close()

        for p in (ROOT / "transcripts").glob("_pipeline_test.json"):
            p.unlink()
        return "health · /reply · OpenAI alias · WS reply · WS save"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    print("\nIG-Agent pipeline tests (offline, mock llmchat.in)\n")
    with MockLLM() as mock:
        check("provider · gemma-4 SSE reasoning + content")(lambda: test_provider(mock))
        check("server · strip_think variants")(test_strip)
        check("server · gemma-4 config + resolution")(test_config)
        check("server · fallback chain")(lambda: test_fallback(mock))
        check("bridge · HTTP + WebSocket end-to-end")(lambda: test_bridge_http_ws(mock))

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed\n")
    if FAIL:
        for name, err in FAIL:
            print(f"FAILED: {name}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
