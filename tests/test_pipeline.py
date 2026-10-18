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


def collect_stream(messages, model=None):
    async def run():
        prov = llmchat_provider.LLMChatProvider(
            model=model,
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

    assert "<think>" in raw, "provider did not capture <think>"
    assert "user said" in raw, f"reasoning text missing in {raw!r}"
    assert CONTENT.strip() in raw, f"answer text missing in {raw!r}"
    # Ensure top-level "response" field in Qwen3 SSE chunks did NOT double tokens
    assert "Yo! Yo!" not in raw, f"tokens were doubled: {raw!r}"
    assert prov.reasoning_chars > 50, f"reasoning_chars={prov.reasoning_chars}"
    assert prov.last_usage.get("completion_tokens") == 250, prov.last_usage
    assert mock.requests, "mock received no request"
    sent = mock.requests[-1]
    assert sent["model"] == MODEL_WIRE, f"wire model was {sent['model']!r}"
    assert sent["body"].get("stream") is True
    assert sent["body"].get("max_tokens") == 600
    assert sent["body"]["messages"][-1]["role"] == "assistant"
    return f"{prov.reasoning_chars} reasoning chars · model {MODEL_WIRE} used (no token duplication)"


def test_strip():
    assert server.strip_think("a<think>x</think>b") == "ab"
    assert server.strip_think("a<thinking>x</thinking>b") == "ab"
    assert server.strip_think("a<think>unclosed") == "a"
    assert server.strip_think("plain") == "plain"
    clean, trace = server.extract_think("<think>\nQuick thought.\n</think>\n\nHey bro!")
    assert clean == "Hey bro!" and trace == "Quick thought."
    return "closed, <thinking>, truncated, extract_think"


def test_config():
    assert server.DEFAULT_MODEL == "qwen/qwen3-30b-a3b-fp8"
    assert server.BRAIN_MODEL == "google/gemma-4-26b-a4b-it"
    assert server.FALLBACK_CHAIN[0] == server.DEFAULT_MODEL
    assert server.FALLBACK_CHAIN[1] == server.BRAIN_MODEL
    assert server.model_endpoint(server.DEFAULT_MODEL) == MODEL_WIRE
    assert server.resolve_model("@cf/qwen/qwen3-30b-a3b-fp8") == server.DEFAULT_MODEL
    assert server.resolve_model("@cf/google/gemma-4-26b-a4b-it") == server.BRAIN_MODEL
    assert server.resolve_model(None) == server.DEFAULT_MODEL
    return "Qwen3-30B primary + Gemma-4 brain + fallbacks"


def test_fallback(mock):
    llmchat_provider._API = mock.url
    msgs = [{"role": "user", "content": "bro hi"}]
    res = server.generate_with_fallback(msgs, "@cf/qwen/qwen3-30b-a3b-fp8", 600, 0.9)
    assert res["text"] == CONTENT.strip(), res["text"]
    assert res["model"] == server.DEFAULT_MODEL
    assert res["fallback_index"] == 0
    assert "<think" not in res["text"]
    assert res["reasoning_chars"] > 50
    assert "user said" in res["thinking_trace"]
    assert res["usage"].get("completion_tokens") == 250

    with MockLLM(fail_models=("qwen",)) as broken:
        llmchat_provider._API = broken.url
        res2 = server.generate_with_fallback(msgs, "@cf/qwen/qwen3-30b-a3b-fp8", 600, 0.9)
        assert res2["model"] == "google/gemma-4-26b-a4b-it", res2["model"]
        assert res2["fallback_index"] == 1, res2["fallback_index"]
        assert res2["text"] == CONTENT.strip()
    return "Qwen3-30B primary (/no_think) · auto-fallback to Gemma-4 when Qwen fails"


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
        assert reply["model"] == "qwen/qwen3-30b-a3b-fp8", reply
        assert reply["reasoning_chars"] > 50
        assert "elapsed_ms" in reply and "fallback_index" in reply

        status, brain_resp = http_json("http://127.0.0.1:8791/brain", {
            "messages": [{"role": "user", "content": "analyze profile"}],
            "max_tokens": 300,
        })
        assert status == 200
        assert brain_resp["model"] == "google/gemma-4-26b-a4b-it", brain_resp

        status, oai = http_json("http://127.0.0.1:8791/v1/chat/completions", {
            "messages": [{"role": "user", "content": "bro hi"}]})
        assert oai["choices"][0]["message"]["content"] == CONTENT.strip()

        send, recv, close = ws_session(8791)
        try:
            send({"id": "h1", "type": "health"})
            h = recv()
            assert h["id"] == "h1" and h["default_endpoint"] == MODEL_WIRE, h

            send({"id": "b1", "type": "bot"})
            b = recv()
            assert b["id"] == "b1" and b["ok"] is True and "window.IGAgent" in b["code"]

            send({"id": "r1", "type": "reply", "messages": [
                {"role": "user", "content": "bro hi"}]})
            r = recv()
            assert r["ok"] and r["text"] == CONTENT.strip(), r

            send({"id": "br1", "type": "brain", "messages": [
                {"role": "user", "content": "analyze profile"}]})
            br = recv()
            assert br["ok"] and br["model"] == "google/gemma-4-26b-a4b-it", br

            send({"id": "s1", "type": "save", "transcript": {
                "user": "_pipeline_test",
                "agent_state": {"relationship_stage": "flirty-banter", "proactive_streak": 0},
                "brain_profile": {"personality": "witty Gen-Z"},
                "process_log": [{"turn_id": "t1", "at": 1, "trigger": "incoming_burst"}],
                "messages": [{"id": "test:1", "ts": 1, "mine": False,
                              "kind": "text", "label": "text", "text": "hi"}]}})
            saved = recv()
            assert saved["ok"] and saved["total_messages"] == 1 and saved["process_turn_count"] == 1, saved

            send({"id": "g1", "type": "save_global", "global": {
                "connections": [{"a": "adarshu.io", "b": "deeps20_", "relation": "close friends"}],
                "people": {"deeps20_": {"handle": "deeps20_", "lastTexts": ["Hyy babyy🌚🌚"]}},
                "gossip": ["@deeps20_: Hyy babyy🌚🌚"],
            }})
            gsaved = recv()
            assert gsaved["ok"] and gsaved["people"] == 1, gsaved

            send({"id": "g2", "type": "get_global"})
            gloaded = recv()
            assert gloaded["ok"] and "deeps20_" in gloaded["global"].get("people", {}), gloaded
        finally:
            close()

        for p in (ROOT / "transcripts").glob("_pipeline_test.json"):
            p.unlink()
        for p in (ROOT / "transcripts").glob("_global_memory.json"):
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
