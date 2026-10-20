#!/usr/bin/env python3
"""
End-to-end offline tests for the v7 parallel-agent bridge.

    python tests/test_pipeline.py

Runs with the system/test environment's Python; needs curl_cffi (the same
dependency the bridge itself uses). No network access required — the whole
llmchat.in side is served by tests/mock_llmchat.py.

Covers:
  1. provider · GLM-4.7-Flash SSE parse (reasoning + content, no duplication)
  2. provider · minimal-think directive injection
  3. provider · glitch ("!!!!!!") + empty-content rejection → model fallback
  4. server  · model registry / resolution / thinking budgets
  5. bridge  · HTTP /health, /v1/models, /v1/chat/completions, /inference/stream
  6. bridge  · WebSocket protocol: health, bot, reply (GLM), brain (Gemma-4),
              save (v7.0-parallel-agentic schema), save_global, get_global
  7. storage · transcripts + global memory round-trip
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import llmchat_provider                                    # noqa: E402
import server                                              # noqa: E402
from mock_llmchat import (                                 # noqa: E402
    MockLLM, MODEL_WIRE, BRAIN_MODEL_WIRE, FALLBACK_MODEL_WIRE, CONTENT, REASONING,
    DECISION_JSON)

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


def make_client(mock, **kw):
    return llmchat_provider.LLMChatClient(inference_url=mock.url, **kw)


def run(coro):
    return asyncio.run(coro)


# ───────────────────────────── tiny WS client ─────────────────────────────

def ws_session(port):
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
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        s.sendall(header + mask + masked)

    buf = bytearray()

    def _read(n):
        while len(buf) < n:
            chunk = s.recv(4096)
            if not chunk:
                raise ConnectionError("closed")
            buf.extend(chunk)
        out = bytes(buf[:n])
        del buf[:n]
        return out

    def recv_json():
        while True:
            h = _read(2)
            opcode = h[0] & 0x0F
            length = h[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", _read(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", _read(8))[0]
            payload = _read(length) if length else b""
            if opcode == 0x1:
                return json.loads(payload.decode("utf-8"))
            if opcode == 0x8:
                raise ConnectionError("closed by server")

    return send_json, recv_json, s.close


def http_json(url, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read())


def wait_http(url, tries=80):
    last = None
    for _ in range(tries):
        try:
            return http_json(url)
        except Exception as e:
            last = e
            time.sleep(0.25)
    raise AssertionError(f"server never came up at {url}: {last}")


# ────────────────────────────────── tests ──────────────────────────────────

def test_provider_glm(mock):
    client = make_client(mock)
    res = run(client.chat_completion(
        messages=[{"role": "user", "content": "bro hi"}],
        model="zai-org/glm-4.7-flash", max_tokens=500))

    assert res.content == CONTENT, f"content={res.content!r}"
    assert res.reasoning.strip() == REASONING, f"reasoning={res.reasoning!r}"
    # GLM sends reasoning+reasoning_content with the SAME token: never doubled
    assert "One One" not in res.reasoning, f"reasoning doubled: {res.reasoning!r}"
    assert res.model == "zai-org/glm-4.7-flash", res.model
    assert res.wire_model == MODEL_WIRE, res.wire_model
    assert res.usage.get("completion_tokens") == 658, res.usage

    body = mock.last_body()
    assert body.get("model") == MODEL_WIRE, body.get("model")
    assert body.get("stream") is None, "payload must not ask for SSE framing"
    return f"{len(res.reasoning)} reasoning chars · {len(res.content)} content chars · {MODEL_WIRE}"


def test_provider_minimal_think(mock):
    client = make_client(mock)
    run(client.chat_completion(
        messages=[{"role": "system", "content": "You are Aduu."},
                  {"role": "user", "content": "bro hi"}],
        model="zai-org/glm-4.7-flash", max_tokens=500, low_think=True))

    body = mock.last_body()
    sysmsg = " ".join(str(m.get("content", "")) for m in body["messages"]
                      if m.get("role") == "system")
    assert "THINKING BUDGET: MINIMAL" in sysmsg, f"minimal-think directive missing: {sysmsg!r}"

    # Qwen3 uses the native /no_think suffix instead
    run(client.chat_completion(
        messages=[{"role": "user", "content": "bro hi"}],
        model="qwen/qwen3-30b-a3b-fp8", max_tokens=500, low_think=True))
    qbody = mock.last_body()
    assert "/no_think" in str(qbody["messages"][-1]["content"]), "qwen3 /no_think missing"
    return "GLM minimal-think directive + Qwen3 /no_think injected"


def test_provider_glitch_and_fallback(mock):
    # 1. glitched "!!!!!" output from the requested model must fall through
    with MockLLM(glitch_models=("glm-4",)) as glitchy:
        client = make_client(glitchy)
        res = run(client.chat_completion(
            messages=[{"role": "user", "content": "teri maa ki chut"}],
            model="zai-org/glm-4.7-flash", max_tokens=500))
        assert res.content == CONTENT, f"fallback content={res.content!r}"
        assert res.fallback_used is True, "fallback not flagged"
        assert res.model != "zai-org/glm-4.7-flash", res.model

    # 2. empty content (all tokens burned in reasoning) must also fall through
    with MockLLM(empty_models=("glm-4",)) as emptier:
        client = make_client(emptier)
        res = run(client.chat_completion(
            messages=[{"role": "user", "content": "bro hi"}],
            model="zai-org/glm-4.7-flash", max_tokens=500))
        assert res.content == CONTENT, res.content
        assert res.fallback_used is True

    # 3. HTTP 500 on the frontline model must fall back cleanly
    with MockLLM(fail_models=("glm-4",)) as broken:
        client = make_client(broken)
        res = run(client.chat_completion(
            messages=[{"role": "user", "content": "bro hi"}],
            model="zai-org/glm-4.7-flash", max_tokens=500))
        assert res.content == CONTENT, res.content
        assert res.model == "qwen/qwen3-30b-a3b-fp8", res.model
    return "glitch '!!!!' · empty-content · HTTP 500 → all auto-fallback"


def test_registry():
    assert llmchat_provider.resolve_wire_model("zai-org/glm-4.7-flash") == MODEL_WIRE
    assert llmchat_provider.resolve_wire_model(MODEL_WIRE) == MODEL_WIRE
    assert llmchat_provider.resolve_short_model(MODEL_WIRE) == "zai-org/glm-4.7-flash"
    assert llmchat_provider.resolve_wire_model("google/gemma-4-26b-a4b-it") == BRAIN_MODEL_WIRE
    assert llmchat_provider.resolve_wire_model(None) == MODEL_WIRE
    assert llmchat_provider.is_thinking_model("zai-org/glm-4.7-flash") is True
    assert llmchat_provider.is_thinking_model("meta/llama-3.3-70b-instruct-fp8-fast") is False
    assert llmchat_provider.FALLBACK_CHAIN[0] == "zai-org/glm-4.7-flash"
    assert "google/gemma-4-26b-a4b-it" in llmchat_provider.FALLBACK_CHAIN

    # glitch guard
    assert llmchat_provider.is_valid_reply_content("haan bhai, thik hai") is True
    assert llmchat_provider.is_valid_reply_content("!" * 400) is False
    assert llmchat_provider.is_valid_reply_content("") is False
    assert llmchat_provider.is_valid_reply_content("😄") is False
    return "GLM-4.7-Flash primary · Gemma-4 brain · Qwen3 fallback · glitch guard"


def test_server_bridge(mock):
    # Isolated transcripts dir so the real ./transcripts data is never touched
    tmpdir = Path(tempfile.mkdtemp(prefix="ig_pipeline_"))
    env = dict(os.environ,
               LLMCHAT_BASE_URL=mock.base_url,
               IG_BRIDGE_PORT="8791",
               IG_TRANSCRIPTS_DIR=str(tmpdir))
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py")],
        cwd=str(ROOT), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        _, health = wait_http("http://127.0.0.1:8791/health")
        assert health["default_model"] == "zai-org/glm-4.7-flash", health
        assert health["brain_model"] == "google/gemma-4-26b-a4b-it", health
        assert health["default_endpoint"] == MODEL_WIRE, health
        assert health.get("brain_decides") is True, health
        assert health.get("decide_endpoint") == "/v1/decide", health
        assert health["chain"][0] == "zai-org/glm-4.7-flash", health["chain"]
        assert "uptime_s" in health

        _, models = http_json("http://127.0.0.1:8791/v1/models")
        ids = [m["id"] for m in models["data"]]
        assert "zai-org/glm-4.7-flash" in ids and "google/gemma-4-26b-a4b-it" in ids

        # non-streaming OpenAI-compatible completion (thinking budget floor)
        status, oai = http_json("http://127.0.0.1:8791/v1/chat/completions", {
            "messages": [{"role": "user", "content": "bro hi"}],
            "model": "zai-org/glm-4.7-flash", "max_tokens": 500, "stream": False,
        })
        assert status == 200
        assert oai["choices"][0]["message"]["content"] == CONTENT, oai
        assert oai["choices"][0]["message"]["reasoning_content"].strip() == REASONING
        assert oai["model"] == "zai-org/glm-4.7-flash", oai["model"]
        sent = mock.last_body()
        assert sent["max_tokens"] >= server.THINK_MIN_BUDGET, sent["max_tokens"]

        # SSE streaming passthrough
        req = urllib.request.Request(
            "http://127.0.0.1:8791/inference/stream",
            data=json.dumps({"messages": [{"role": "user", "content": "bro hi"}],
                             "model": "zai-org/glm-4.7-flash"}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            sse = r.read().decode("utf-8")
        assert "data: " in sse and "data: [DONE]" in sse
        assert REASONING in sse and CONTENT in sse

        # WebSocket bridge protocol (what the in-page agent actually uses)
        send, recv, close = ws_session(8791)
        try:
            send({"id": "h1", "type": "health"})
            h = recv()
            assert h["ok"] and h["default_endpoint"] == MODEL_WIRE, h
            assert h["brain_endpoint"] == BRAIN_MODEL_WIRE, h

            send({"id": "b1", "type": "bot"})
            b = recv()
            assert b["ok"] and "window.IGAgent" in b["code"], list(b)

            # FRONTLINE reply → GLM-4.7-Flash
            send({"id": "r1", "type": "reply", "messages": [
                {"role": "user", "content": "bro hi"}]})
            r = recv()
            assert r["ok"] and r["text"] == CONTENT, r
            assert r["model"] == "zai-org/glm-4.7-flash", r
            assert r["endpoint"] == MODEL_WIRE, r
            assert r["reasoning_chars"] == len(REASONING), r

            # PARALLEL BRAIN pass → Gemma-4
            send({"id": "br1", "type": "brain", "messages": [
                {"role": "user", "content": "analyze this contact"}]})
            br = recv()
            assert br["ok"] and br["model"] == "google/gemma-4-26b-a4b-it", br
            assert br["role_type"] == "brain", br

            # v8: the BRAIN decides the turn (Gemma-4 → strict JSON)
            send({"id": "d1", "type": "decide", "messages": [
                {"role": "user", "content": "THEIR NEW MESSAGES: kahan gayab ho gayi aaj"},
            ]})
            dec = recv()
            assert dec["ok"] and dec["role_type"] == "decide", dec
            assert dec["model"] == "google/gemma-4-26b-a4b-it", dec["model"]
            assert dec["decision_valid"] is True, dec
            assert dec["decision"]["action"] == "REPLY", dec["decision"]
            assert dec["decision"]["bubble_count"] == 2, dec["decision"]
            assert len(dec["decision"]["bubble_plan"]) == 2, dec["decision"]
            # the decision prompt must have been injected server-side
            assert "DECISION BRAIN" in mock.last_body()["messages"][0]["content"]

            # v7 transcript save (mood_state + reminders + missions + process_log)
            send({"id": "s1", "type": "save", "transcript": {
                "schema_version": "9.0-social-brain",
                "user": "_pipeline_test", "thread_fbid": "0",
                "models": {"answering_model": "zai-org/glm-4.7-flash",
                           "brain_model": "google/gemma-4-26b-a4b-it"},
                "mood_state": {"current_mood": "FURIOUS_ABUSE_CLAPBACK",
                               "mood_intensity": 3,
                               "feeling_note": "genuinely pissed off"},
                "reminders": [{"topic": "baat karte hai", "due_in_minutes": 10,
                               "status": "scheduled"}],
                "missions": [{"target_user": "deeps20_", "type": "prank"}],
                "process_log": [{"turn_id": "t1", "trigger": "incoming_burst"}],
                "last_decision": {"action": "REPLY", "mood": "PLAYFUL_CHILL",
                                  "bubble_count": 2},
                "messages": [{"id": "test:1", "ts": 1, "mine": False,
                              "kind": "text", "label": "text", "text": "hi"}],
            }})
            saved = recv()
            assert saved["ok"] and saved["total_messages"] == 1, saved
            assert saved["process_turn_count"] == 1, saved

            disk = json.loads((tmpdir / "_pipeline_test.json").read_text())
            assert disk["mood_state"]["current_mood"] == "FURIOUS_ABUSE_CLAPBACK"
            assert disk["reminders"][0]["topic"] == "baat karte hai"
            assert disk["missions"][0]["target_user"] == "deeps20_"
            assert disk["last_decision"]["action"] == "REPLY", disk.get("last_decision")

            # v9: the social brain's diary over the WebSocket
            send({"id": "sb1", "type": "save_social", "social": {
                "schema_version": "9.0-social-brain-log",
                "config": {"enabled": True, "dry_run": True, "notes_mode": "agentic"},
                "action_log": [{"kind": "note", "target": "", "text": "chai aur code"}],
                "note_log": [{"text": "chai aur code", "reason": "calm evening"}],
                "cycles": [{"at": 1, "status": "completed", "plan": {"mode": "observe"}}],
            }})
            sbs = recv()
            assert sbs["ok"] and sbs["cycles"] == 1 and sbs["actions"] == 1, sbs

            send({"id": "sb2", "type": "get_social"})
            sbg = recv()
            assert sbg["ok"], sbg
            sb_doc = sbg["social_brain"]
            assert sb_doc["config"]["notes_mode"] == "agentic", sb_doc
            assert sb_doc["action_log"][0]["kind"] == "note", sb_doc
            assert (tmpdir / "_social_brain.json").exists(), "social brain file not written"

            # v8: REST decision endpoint (any client, not just the page script)
            status, d = http_json("http://127.0.0.1:8791/v1/decide", {
                "messages": [{"role": "user",
                              "content": "THEIR NEW MESSAGES: bol na kya scene hai"}],
            })
            assert status == 200, d
            assert d["decision_valid"] is True, d
            assert d["decision"]["action"] == "REPLY", d["decision"]
            assert d["model"] == "google/gemma-4-26b-a4b-it", d["model"]
            assert "DECISION BRAIN" in mock.last_body()["messages"][0]["content"]

            # v9: the social brain's diary over plain HTTP
            status, sb = http_json("http://127.0.0.1:8791/social-brain")
            assert status == 200, sb
            assert sb["config"]["notes_mode"] == "agentic", sb
            assert len(sb["cycles"]) == 1, sb

            status, sb2 = http_json("http://127.0.0.1:8791/social-brain", {
                "config": {"enabled": False, "dry_run": False, "notes_mode": "off"},
                "action_log": [{"kind": "story_reply", "target": "deeps20_"}],
            })
            assert status == 200, sb2
            assert sb2["config"]["notes_mode"] == "off", sb2
            assert any(a.get("kind") == "story_reply" for a in sb2["action_log"]), sb2

            # the diary must never be mistaken for a chat transcript
            _, tlist = http_json("http://127.0.0.1:8791/transcripts")
            names = [t["username"] for t in tlist["transcripts"]]
            assert "_social_brain" not in names, names
            assert "_global_memory" not in names, names

            send({"id": "g1", "type": "save_global", "global": {
                "contacts": {"deeps20_": {"handle": "deeps20_", "vibe": "aggressive"}},
                "gossip": [{"user": "deeps20_", "text": "asked for chocolates"}],
                "reminders": [], "missions": [],
            }})
            gsaved = recv()
            assert gsaved["ok"] and gsaved["people"] >= 1, gsaved

            send({"id": "g2", "type": "get_global"})
            gloaded = recv()
            assert gloaded["ok"] and "deeps20_" in gloaded["global"]["contacts"], gloaded
        finally:
            close()

        shutil.rmtree(tmpdir, ignore_errors=True)
        return ("health · models · OpenAI · SSE · WS reply+brain+decide+"
                "social+save+global")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    print("\nIG-Agent v9 pipeline tests (offline, mock llmchat.in)\n")
    with MockLLM() as mock:
        check("provider · GLM-4.7-Flash SSE (reasoning + content, no duplication)")(
            lambda: test_provider_glm(mock))
        check("provider · minimal-think directive (GLM) + /no_think (Qwen3)")(
            lambda: test_provider_minimal_think(mock))
        check("server · model registry + glitch guard")(test_registry)
        check("bridge · HTTP + WebSocket end-to-end")(lambda: test_server_bridge(mock))
    with MockLLM() as mock2:
        check("provider · glitch/empty/500 auto-fallback")(
            lambda: test_provider_glitch_and_fallback(mock2))

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed\n")
    if FAIL:
        for name, err in FAIL:
            print(f"FAILED: {name}: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
