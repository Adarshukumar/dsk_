#!/usr/bin/env python3
"""
Round-9 regression suite: THE BRAIN MUST NEVER GO SILENTLY DEAD.

Production failure this suite exists to prevent (2026-10, v9):

    14:10:01 [WARNING] Model @cf/google/gemma-4-26b-a4b-it returned empty
                       content (reasoning=0 chars) on attempt 1
    14:10:12 [WARNING] ... attempt 2
    14:10:23 [WARNING] Model @cf/zai-org/glm-4.7-flash returned empty content
    14:10:32 [WARNING] ... attempt 2

`reasoning=0 chars` on EVERY model meant the upstream was answering with a
200 whose body produced neither content nor reasoning — an upstream wire /
gate change, not a slow model. Two things made it unrecoverable:

  1. ROOT CAUSE — the `decide` path was the only caller that put TWO `system`
     messages on the wire (the page's own contract + the server-injected one).
     Cloudflare-style chat templates silently drop multi-system prompts and
     return an empty stream.
  2. The failure was INVISIBLE — `chat_completion()` never logged the status
     code, content-type or raw body, so nobody could tell what changed.

What this suite locks down:

  A. exactly ONE system message reaches the upstream, always
  B. the parser survives every wire-format change we can simulate
  C. an upstream error packet raises instead of masquerading as "empty"
  D. a dead brain still returns a USABLE decision / social plan (never silence)
  E. /health exposes brain_status so degradation is visible in one glance
  F. the parser failure is logged with the raw body (diagnosable next time)

    /tmp/venv/bin/python tests/test_resilience.py
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import llmchat_provider                                   # noqa: E402
import server                                             # noqa: E402
from mock_llmchat import (                                # noqa: E402
    MockLLM, MODEL_WIRE, CONTENT, REASONING, DECISION_JSON, OBSERVE_PLAN,
    build_silent_stream, build_challenge_page, build_error_packet_stream,
    build_bare_json_stream, build_delta_key_stream,
    build_top_level_message_stream, count_system_messages,
    build_live_envelope_stream, build_live_plain_stream,
    build_live_double_envelope_stream, build_live_sse_envelope_stream,
)
from test_pipeline import (                               # noqa: E402
    check, make_client, run, http_json, wait_http, ws_session, PASS, FAIL,
)

PORT = "8793"


def _env(mock, tmpdir):
    return dict(os.environ,
                LLMCHAT_BASE_URL=mock.base_url,
                IG_BRIDGE_PORT=PORT,
                IG_TRANSCRIPTS_DIR=str(tmpdir))


def _boot(mock, tmpdir):
    return subprocess.Popen(
        [sys.executable, str(ROOT / "server.py")],
        cwd=str(ROOT), env=_env(mock, tmpdir),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def _stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


# ═══════════════════════════ A · single system message ══════════════════════

# ══════════════ AA · the `{"result": …}` envelope (the REAL outage) ═══════════

# Verbatim from the production log, 2026-10 · 17:27:54:
#   empty stream from @cf/google/gemma-4-26b-a4b-it … raw[2420 chars, sha
#   bc37dbbc]: '{"result":{"choices":[{"finish_reason":"stop","index":0,
#   "logprobs":null,"message":{"annotations":null,"audio":null,"content":
#   "{\"action\": \"REPLY\"…}'  →  "returned empty content (reasoning=0 chars)"
#
# The brain was answering PERFECTLY. The parser just could not see past the
# envelope, so every model was reported empty and the whole chain burned.
LIVE_RAW = (
    '{"result":{"choices":[{"finish_reason":"stop","index":0,"logprobs":null,'
    '"message":{"annotations":null,"audio":null,'
    '"content":"{\\"action\\": \\"REPLY\\", \\"understand\\": '
    '\\"she is teasing\\", \\"mood\\": \\"PLAYFUL_CHILL\\"}",'
    '"function_call":null,"reasoning":null,"refusal":null,'
    '"role":"assistant"}}],"created":1792508047,"id":"chatcmpl-x",'
    '"model":"@cf/google/gemma-4-26b-a4b-it","object":"chat.completion",'
    '"usage":{"completion_tokens":250,"prompt_tokens":385,'
    '"total_tokens":635}}}'
)


def test_result_envelope_is_unwrapped():
    """THE bug: {"result":{"choices":[{"message":{"content":…}}]}}."""
    P = llmchat_provider.LLMChatClient._parse_sse
    c, r, u = P(LIVE_RAW)
    assert c.strip().startswith('{"action": "REPLY"'), f"content={c!r}"
    assert "PLAYFUL_CHILL" in c, c
    assert u.get("completion_tokens") == 250, u
    return "the exact production body now parses → JSON decision recovered"


def test_every_known_wire_shape_parses():
    """One assertion per upstream shape — past, present and defensive."""
    P = llmchat_provider.LLMChatClient._parse_sse
    cases = {
        "result envelope (current)": build_live_envelope_stream(),
        "plain completion object": build_live_plain_stream(),
        "double envelope": build_live_double_envelope_stream(),
        "envelope over SSE": build_live_sse_envelope_stream(),
        "bare json (no data: prefix)": build_bare_json_stream(),
        "delta: key": build_delta_key_stream(),
        "top-level message object": build_top_level_message_stream(),
    }
    for name, body in cases.items():
        c, _, _ = P(body.decode())
        assert c.strip(), f"{name} parsed to nothing"
        assert c.strip() == CONTENT.strip() or c.strip().startswith("{"), \
            f"{name} parsed to {c!r}"

    # reasoning travels inside the message object too
    c2, r2, _ = P(build_live_envelope_stream(CONTENT, "short think").decode())
    assert c2.strip() == CONTENT.strip(), c2
    assert r2.strip() == "short think", r2
    return f"{len(cases)} wire shapes all parse (incl. reasoning in the envelope)"


def test_unrecognised_format_is_not_reported_as_empty():
    """
    The whole outage hinged on this confusion: the upstream answered, the
    parser did not recognise the shape, and ("", "") was logged as
    "the model returned empty content". Every model then looked dead.
    An unrecognised FORMAT must be shouted as a parser bug instead.
    """
    import logging
    buf = []

    class Cap(logging.Handler):
        def emit(self, record):
            buf.append(record.getMessage())

    cap = Cap(level=logging.DEBUG)
    lg = logging.getLogger("llmchat_provider")
    lg.addHandler(cap)
    lg.setLevel(logging.DEBUG)
    try:
        P = llmchat_provider.LLMChatClient._parse_sse
        P('{"result":{"deep":{"deeper":{"content":"lost in there"}}}}')
        # a shape with no text at all must stay quiet (no false alarm)
        P('{"ping":123,"ok":true}')
    finally:
        lg.removeHandler(cap)

    msgs = "\n".join(buf)
    assert "UNRECOGNISED RESPONSE FORMAT" in msgs, f"silent failure:\n{msgs}"
    assert "_parse_sse" in msgs, "log must point at the parser"
    assert "not an empty model" in msgs, "log must say it is not the model"
    # …and it must NOT fire for a body that genuinely carries no text
    assert msgs.count("UNRECOGNISED RESPONSE FORMAT") == 1, \
        f"false alarm on a text-free body:\n{msgs}"
    return "unrecognised shape → loud parser-bug log, no false alarms"


def test_no_shape_silently_becomes_empty():
    """
    The invariant that broke: a body carrying text must NEVER parse to ''.

    Guards against the next envelope rename — if the upstream starts wrapping
    in something new this fails loudly, instead of looking like a slow model.
    """
    P = llmchat_provider.LLMChatClient._parse_sse
    bodies = [
        build_live_envelope_stream(),
        build_live_plain_stream(),
        build_live_double_envelope_stream(),
        build_live_sse_envelope_stream(),
        build_bare_json_stream(),
        build_delta_key_stream(),
        build_top_level_message_stream(),
    ]
    empties = [i for i, b in enumerate(bodies) if not P(b.decode())[0].strip()]
    assert not empties, f"these carried text but parsed empty: {empties}"

    # …but a genuinely empty body must STILL be reported as empty
    c, r, _ = P(build_silent_stream().decode())
    assert c == "" and r == "", "silent stream must stay empty (no false ok)"
    return f"{len(bodies)} text-bearing bodies all non-empty · silent stays empty"


def test_envelope_end_to_end_through_the_bridge():
    """Full decide + reply round-trip against the CURRENT upstream format."""
    import shutil
    tmpdir = Path(tempfile.mkdtemp(prefix="ig_env_"))
    with MockLLM(live=True) as mock:
        proc = _boot(mock, tmpdir)
        try:
            wait_http(f"http://127.0.0.1:{PORT}/health")

            status, d = http_json(f"http://127.0.0.1:{PORT}/v1/decide", {
                "messages": [{"role": "user",
                              "content": "THEIR NEW MESSAGES: bol na"}],
            })
            assert status == 200, d
            assert d.get("_fallback") is not True, f"brain still blind: {d}"
            assert d["decision_valid"] is True, d
            assert d["decision"]["action"] == "REPLY", d["decision"]

            # the writer path (a plain reply, not a decision)
            send, recv, close = ws_session(int(PORT))
            try:
                send({"id": "r1", "type": "reply",
                      "messages": [{"role": "user", "content": "hi"}],
                      "model": "zai-org/glm-4.7-flash"})
                m = recv()
                assert m.get("ok") is True, m
                assert m["text"].strip() == CONTENT.strip(), m
            finally:
                close()

            # brain health must be clean, not degraded
            _, h = http_json(f"http://127.0.0.1:{PORT}/health")
            assert h["brain_status"]["degraded"] is not True, h["brain_status"]
        finally:
            _stop(proc)
            shutil.rmtree(tmpdir, ignore_errors=True)
    return "decide + reply both work against the live `result` envelope"



def test_merge_system_messages():
    C = llmchat_provider.LLMChatClient

    # the exact Round-9 killer: two contracts stacked
    merged = C._merge_system_messages([
        {"role": "system", "content": "YOU ARE THE DECISION BRAIN."},
        {"role": "system", "content": "YOU ARE THE DECISION BRAIN TOO."},
        {"role": "user", "content": "THEIR NEW MESSAGES: bol na"},
    ])
    n = sum(1 for m in merged if m.get("role") == "system")
    assert n == 1, f"expected 1 system message on the wire, got {n}: {merged}"
    assert "DECISION BRAIN." in merged[0]["content"]
    assert "DECISION BRAIN TOO." in merged[0]["content"], "second contract lost"
    assert merged[-1] == {"role": "user", "content": "THEIR NEW MESSAGES: bol na"}

    # system messages sprinkled later in the conversation also collapse
    merged2 = C._merge_system_messages([
        {"role": "user", "content": "a"},
        {"role": "system", "content": "mid-turn steer"},
        {"role": "system", "content": "and another"},
        {"role": "assistant", "content": "b"},
    ])
    assert [m["role"] for m in merged2] == ["user", "system", "assistant"], merged2
    assert merged2[1]["content"] == "mid-turn steer\n\nand another", merged2

    # a system-only request must never go out with no user turn
    merged3 = C._merge_system_messages([{"role": "system", "content": "only me"}])
    assert any(m["role"] == "user" for m in merged3), merged3

    # garbage in, nothing crashes
    assert C._merge_system_messages([]) == [{"role": "user", "content": "hello"}]
    return "2 contracts → 1 system message, order preserved, never system-only"


def test_one_system_message_on_the_wire():
    """The actual Round-9 root cause, asserted at the wire level."""
    with MockLLM() as mock:
        client = make_client(mock)
        run(client.chat_completion(
            messages=[
                # exactly what the page sends on a decide turn
                {"role": "system", "content": "You are Aduu's DECISION BRAIN — ..."},
                {"role": "user", "content": "THEIR NEW MESSAGES: bol na"},
            ],
            model="google/gemma-4-26b-a4b-it", max_tokens=900))
        assert count_system_messages(mock.last_body()) == 1, mock.last_body()

        # three in a row still collapses to one
        run(client.chat_completion(
            messages=[{"role": "system", "content": "a"},
                      {"role": "system", "content": "b"},
                      {"role": "system", "content": "c"},
                      {"role": "user", "content": "hi"}],
            model="zai-org/glm-4.7-flash"))
        assert count_system_messages(mock.last_body()) == 1, mock.last_body()
    return "provider collapses N system messages → 1 before every upstream call"


def test_server_does_not_double_inject():
    """The server must not stack its contract on top of the page's."""
    tmpdir = Path(tempfile.mkdtemp(prefix="ig_resil_"))
    with MockLLM() as mock:
        proc = _boot(mock, tmpdir)
        try:
            wait_http(f"http://127.0.0.1:{PORT}/health")
            status, d = http_json(f"http://127.0.0.1:{PORT}/v1/decide", {
                "messages": [
                    {"role": "system", "content": "You are Aduu's DECISION BRAIN — mine."},
                    {"role": "user", "content": "THEIR NEW MESSAGES: bol na"},
                ],
            })
            assert status == 200, d
            body = mock.last_body()
            n = count_system_messages(body)
            assert n == 1, f"{n} system messages went upstream: {body['messages']}"
            assert "mine." in body["messages"][0]["content"], body["messages"][0]
            # and when the caller sends NO contract, the server supplies one
            status, d2 = http_json(f"http://127.0.0.1:{PORT}/v1/decide", {
                "messages": [{"role": "user", "content": "THEIR NEW MESSAGES: hi"}],
            })
            assert status == 200, d2
            body2 = mock.last_body()
            assert count_system_messages(body2) == 1, body2
            assert "DECISION BRAIN" in body2["messages"][0]["content"], body2
        finally:
            _stop(proc)
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
    return "decide never sends 2 system messages, injects 1 when none supplied"


# ══════════════════════ B · parser survives format changes ══════════════════

def test_parse_sse_format_changes():
    P = llmchat_provider.LLMChatClient._parse_sse

    # SSE frames with no `data:` prefix (plain JSON lines)
    c, r, _ = P(build_bare_json_stream().decode())
    assert c.strip() == CONTENT.strip(), f"bare-json content={c!r}"
    assert r.strip() == REASONING.strip(), f"bare-json reasoning={r!r}"

    # `delta:` key instead of `data:`
    c2, _, _ = P(build_delta_key_stream().decode())
    assert c2.strip() == CONTENT.strip(), f"delta-key content={c2!r}"

    # one non-streaming `message` object
    c3, _, _ = P(build_top_level_message_stream().decode())
    assert c3.strip() == CONTENT.strip(), f"message-obj content={c3!r}"

    # a genuinely empty stream really is empty (no false positives)
    c4, r4, _ = P(build_silent_stream().decode())
    assert c4 == "" and r4 == "", (c4, r4)

    # an HTML interstitial must not be mistaken for an empty model reply
    c5, _, _ = P(build_challenge_page().decode())
    assert c5 == "", c5
    return "bare-json · delta-key · message-object · silent · html all handled"


def test_error_packet_raises():
    """An upstream error object must raise, not look like an empty completion."""
    with MockLLM(error_packet=True) as mock:
        client = make_client(mock)
        raised = None
        try:
            run(client.chat_completion(
                messages=[{"role": "user", "content": "hi"}],
                model="zai-org/glm-4.7-flash", allow_fallback=False,
                retries_per_model=1))
        except RuntimeError as e:
            raised = e
    assert raised is not None, "error packet was swallowed as an empty result"
    assert "rate limited" in str(raised), str(raised)
    return "upstream {\"success\":false} raises RuntimeError, never silent-empty"


def test_empty_stream_is_logged():
    """The next outage must be diagnosable from the log alone."""
    import logging
    buf = []

    class Cap(logging.Handler):
        def emit(self, record):
            buf.append(record.getMessage())

    cap = Cap(level=logging.DEBUG)
    lg = logging.getLogger("llmchat_provider")
    lg.addHandler(cap)
    lg.setLevel(logging.DEBUG)
    try:
        with MockLLM(silent_all=True) as mock:
            client = make_client(mock)
            try:
                run(client.chat_completion(
                    messages=[{"role": "user", "content": "hi"}],
                    model="zai-org/glm-4.7-flash",
                    allow_fallback=False, retries_per_model=1))
            except RuntimeError:
                pass          # expected: nothing to return, but it must be logged
    finally:
        lg.removeHandler(cap)
    msgs = "\n".join(buf)
    assert "empty stream from" in msgs, f"no diagnostic log:\n{msgs}"
    assert MODEL_WIRE in msgs, f"log does not name the model:\n{msgs}"
    assert "raw[" in msgs, f"log does not include the raw body:\n{msgs}"
    return "empty upstream → WARNING naming the model + raw body length + preview"


# ═══════════════════ C · dead brain still returns something ═════════════════

def test_dead_brain_returns_usable_decision():
    """Total outage (every model silent) → a safe human decision, not silence."""
    tmpdir = Path(tempfile.mkdtemp(prefix="ig_resil_"))
    with MockLLM(silent_all=True) as mock:
        proc = _boot(mock, tmpdir)
        try:
            wait_http(f"http://127.0.0.1:{PORT}/health")

            # HTTP /v1/decide
            status, d = http_json(f"http://127.0.0.1:{PORT}/v1/decide", {
                "messages": [{"role": "user",
                              "content": "THEIR NEW MESSAGES: bol na kya scene"}],
            })
            assert status == 200, d
            assert d.get("_fallback") is True, d
            assert d["decision_valid"] is False, d
            dec = d["decision"]
            assert dec["action"] == "REPLY", dec          # still replies, human
            assert dec["mood"] == "PLAYFUL_CHILL", dec
            assert 1 <= dec["bubble_count"] <= 3, dec
            assert dec["bubble_plan"], dec
            assert dec["privacy_ok"] is True, dec         # never leaks chats
            assert dec["cross_chat_mission"] is None, dec
            assert dec["reminder"] is None, dec
            # even a dead brain must pace the reply like a human
            t = dec["timing"]
            assert 0 <= t["seen_delay_s"] <= 45, t
            assert 1 <= t["typing_s"] <= 25, t
            assert 1 <= t["bubble_gap_s"] <= 8, t

            # WebSocket decide — the path the in-page agent actually uses
            send, recv, close = ws_session(int(PORT))
            try:
                send({"id": "d1", "type": "decide",
                      "messages": [
                          {"role": "system", "content": "You are Aduu's DECISION BRAIN — x"},
                          {"role": "user", "content": "THEIR NEW MESSAGES: bol na"},
                      ]})
                m = recv()
                assert m.get("ok") is True, m
                assert m.get("_fallback") is True, m
                assert m["decision"]["action"] == "REPLY", m
                assert m["decision_valid"] is False, m
                # and only ONE system message went out even on this path
                assert count_system_messages(mock.last_body()) == 1, mock.last_body()
            finally:
                close()

            # health must now say the brain is degraded
            _, h = http_json(f"http://127.0.0.1:{PORT}/health")
            bs = h.get("brain_status") or {}
            assert bs.get("degraded") is True, h
            assert bs.get("last_error"), h
        finally:
            _stop(proc)
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
    return "total outage → safe REPLY decision + degraded flag on /health"


def test_dead_brain_social_observes():
    """A dead social brain must do NOTHING, never a blind DM or comment."""
    tmpdir = Path(tempfile.mkdtemp(prefix="ig_resil_"))
    with MockLLM(silent_all=True) as mock:
        proc = _boot(mock, tmpdir)
        try:
            wait_http(f"http://127.0.0.1:{PORT}/health")
            send, recv, close = ws_session(int(PORT))
            try:
                send({"id": "s1", "type": "decide", "kind": "social",
                      "messages": [
                          {"role": "system", "content": "You are the SOCIAL BRAIN of Aduu"},
                          {"role": "user", "content": "OBSERVATION: ..."},
                      ]})
                m = recv()
                assert m.get("ok") is True, m
                assert m.get("_fallback") is True, m
                plan = m["decision"]
                assert plan["mode"] == "observe", plan       # never "act" blind
                assert plan["actions"] == [], plan           # does nothing at all
                assert plan["skip_reason"], plan
                assert 15 <= plan["next_check_in_minutes"] <= 240, plan
            finally:
                close()
        finally:
            _stop(proc)
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
    return "dead social brain → observe + zero actions (no blind DM/comment)"


def test_healthy_brain_is_not_flagged():
    """When the upstream answers normally there must be no fallback flags."""
    tmpdir = Path(tempfile.mkdtemp(prefix="ig_resil_"))
    with MockLLM() as mock:
        proc = _boot(mock, tmpdir)
        try:
            wait_http(f"http://127.0.0.1:{PORT}/health")
            status, d = http_json(f"http://127.0.0.1:{PORT}/v1/decide", {
                "messages": [{"role": "user", "content": "THEIR NEW MESSAGES: hi"}],
            })
            assert status == 200, d
            assert d.get("_fallback") is not True, d
            assert d["decision_valid"] is True, d
            assert d["decision"]["action"] == DECISION_JSON["action"], d
            assert d["decision"]["bubble_count"] == 2, d

            send, recv, close = ws_session(int(PORT))
            try:
                send({"id": "h1", "type": "health"})
                h = recv()
                assert h["ok"] is True, h
                bs = h.get("brain_status") or {}
                assert bs.get("degraded") is not True, h
                assert bs.get("ok") is True, h
                assert bs.get("decisions", 0) >= 1, h
                assert bs.get("last_ok_ago_s") is not None, h
            finally:
                close()
        finally:
            _stop(proc)
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
    return "healthy upstream → no fallback flags, brain_status.ok=true"


def test_decide_token_budget_is_small():
    """Decisions must not ask for a 2500-token think budget any more."""
    with MockLLM() as mock:
        client = make_client(mock)
        run(client.chat_completion(
            messages=[{"role": "user", "content": "hi"}],
            model="google/gemma-4-26b-a4b-it", max_tokens=700))
        assert mock.last_body()["max_tokens"] == 700
    tmpdir = Path(tempfile.mkdtemp(prefix="ig_resil_"))
    with MockLLM() as mock:
        proc = _boot(mock, tmpdir)
        try:
            wait_http(f"http://127.0.0.1:{PORT}/health")
            http_json(f"http://127.0.0.1:{PORT}/v1/decide", {
                "messages": [{"role": "user", "content": "hi"}],
            })
            mt = mock.last_body()["max_tokens"]
            assert mt == server.DECIDE_THINK_BUDGET, f"decide max_tokens={mt}"
            assert mt < server.THINK_MIN_BUDGET, mt
            # a normal chat reply keeps the big floor
            send, recv, close = ws_session(int(PORT))
            try:
                send({"id": "m1", "type": "reply",
                      "messages": [{"role": "user", "content": "hi"}],
                      "model": "zai-org/glm-4.7-flash"})
                recv()
                mt2 = mock.last_body()["max_tokens"]
                assert mt2 >= server.THINK_MIN_BUDGET, f"reply max_tokens={mt2}"
            finally:
                close()
        finally:
            _stop(proc)
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)
    return (f"decide={server.DECIDE_THINK_BUDGET} < reply="
            f"{server.THINK_MIN_BUDGET} (no oversized think budget)")


def test_challenge_page_does_not_hang():
    """An HTML interstitial must fail fast, not look like a slow model."""
    with MockLLM(challenge=True) as mock:
        client = make_client(mock)
        t0 = time.time()
        try:
            run(client.chat_completion(
                messages=[{"role": "user", "content": "hi"}],
                model="zai-org/glm-4.7-flash",
                allow_fallback=False, retries_per_model=1))
            outcome = "no exception"
        except RuntimeError as e:
            outcome = str(e)[:80]
        elapsed = time.time() - t0
    assert elapsed < 60, f"took {elapsed:.1f}s — should fail fast"
    return f"interstitial → {outcome} in {elapsed:.1f}s"


def test_chain_never_stalls_past_its_budget():
    """
    Production: one decide took 231 SECONDS (14 calls x ~50s curl timeouts).
    The chain must now respect a hard wall-clock budget and give up early so
    the caller's safe fallback can answer instead of making the person wait.
    """
    import shutil
    tmpdir = Path(tempfile.mkdtemp(prefix="ig_budget_"))

    class SlowMock(MockLLM):
        """Answers like the real upstream but only after a long delay."""

        def __init__(self, port=0, delay=3.0):
            super().__init__(port=port)
            self.delay = delay

    # Drive the provider directly against a deliberately slow-but-valid mock
    # so we measure the chain, not the HTTP layer.
    with MockLLM() as mock:
        client = llmchat_provider.LLMChatClient(
            inference_url=mock.url, chain_budget_s=1.0)

        # Patch the transport to be slow, forcing the budget to bind.
        real = client._request_once

        async def slow(*a, **kw):
            await asyncio.sleep(2.0)
            return ("", "", {})

        client._request_once = slow
        t0 = time.time()
        try:
            run(client.chat_completion(
                messages=[{"role": "user", "content": "hi"}],
                model="zai-org/glm-4.7-flash", allow_fallback=True,
                retries_per_model=2))
            raised = False
        except RuntimeError:
            raised = True
        elapsed = time.time() - t0
        client._request_once = real

    assert elapsed < 25, f"chain took {elapsed:.1f}s — budget is not binding"
    assert raised, "expected the exhausted chain to raise so fallback kicks in"
    shutil.rmtree(tmpdir, ignore_errors=True)
    return f"a hopeless chain gives up in {elapsed:.1f}s, not 231s"


def test_fallback_chain_still_works():
    """The outage fix must not break the existing 500/glitch fallback."""
    with MockLLM(fail_models=("glm-4.7-flash",),
                 glitch_models=("qwen3-30b",)) as mock:
        client = make_client(mock)
        res = run(client.chat_completion(
            messages=[{"role": "user", "content": "bro hi"}],
            model="zai-org/glm-4.7-flash", max_tokens=500))
    assert res.content == CONTENT, res.content
    assert res.fallback_used is True, res
    assert res.model != "zai-org/glm-4.7-flash", res.model
    models_tried = [r["model"] for r in mock.requests]
    assert len(models_tried) >= 3, models_tried
    return f"500 + glitch → fell through to {res.model} ({len(models_tried)} tries)"


# ═══════════════════════════════════ runner ═════════════════════════════════

def main():
    print("\nIG-Agent v10.1 · brain-resilience suite (offline, mock llmchat.in)\n")
    print(" AA · the {\"result\": …} envelope — the real outage")
    check("envelope · the exact production body now parses")(
        test_result_envelope_is_unwrapped)
    check("envelope · every known wire shape parses")(
        test_every_known_wire_shape_parses)
    check("envelope · no text-bearing body ever parses to empty")(
        test_no_shape_silently_becomes_empty)
    check("diagnostics · an unrecognised shape is logged as a parser bug")(
        test_unrecognised_format_is_not_reported_as_empty)
    check("envelope · decide + reply end-to-end against the live format")(
        test_envelope_end_to_end_through_the_bridge)

    print("\n A · single system message (hardening)")
    check("provider · N system messages collapse to exactly 1")(
        test_merge_system_messages)
    check("wire · decide sends ONE system message upstream")(
        test_one_system_message_on_the_wire)
    check("server · never double-injects the decide contract")(
        test_server_does_not_double_inject)

    print("\n B · parser survives upstream format changes")
    check("parser · bare-json / delta-key / message-object / html")(
        test_parse_sse_format_changes)
    check("parser · upstream error packet raises instead of empty")(
        test_error_packet_raises)
    check("diagnostics · empty stream logs model + raw body")(
        test_empty_stream_is_logged)

    print("\n C · a dead brain never leaves the person waiting")
    check("outage · dead brain returns a usable DM decision")(
        test_dead_brain_returns_usable_decision)
    check("outage · dead social brain observes and does nothing")(
        test_dead_brain_social_observes)
    check("healthy · no fallback flags when the brain answers")(
        test_healthy_brain_is_not_flagged)
    check("budget · decide think budget is small, reply keeps the floor")(
        test_decide_token_budget_is_small)
    check("outage · HTML interstitial fails fast")(test_challenge_page_does_not_hang)
    check("regression · 500/glitch fallback chain still works")(
        test_fallback_chain_still_works)
    check("latency · a hopeless chain respects its wall-clock budget")(
        test_chain_never_stalls_past_its_budget)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed\n")
    if FAIL:
        for name, err in FAIL:
            print(f"FAILED: {name}: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
