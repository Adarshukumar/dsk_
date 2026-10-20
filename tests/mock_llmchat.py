#!/usr/bin/env python3
"""
Offline stand-in for https://llmchat.in/inference/stream

It speaks the exact SSE shapes the real endpoints send (captured from live
runs), so the whole v7 bridge can be exercised offline:

  · @cf/zai-org/glm-4.7-flash  (FRONTLINE answering model)
      chunk 1 : delta {"role":"assistant","content":"","reasoning_content":null}
      reasoning: delta {"reasoning": tok, "reasoning_content": tok}
      content  : delta {"content": tok, "reasoning_content": null}
      stop     : delta {"content": tok}, finish_reason "stop"
      tail     : {"choices":[], ...} then {"response":"","usage":{...}} then [DONE]

  · @cf/google/gemma-4-26b-a4b-it  (PARALLEL background brain)
      delta.reasoning_content phase, then delta.content phase

  · @cf/qwen/qwen3-30b-a3b-fp8  (fallback; inline <think> + top-level
    "response" on the same frame — the duplication trap)

Why: llmchat.in is not reachable from CI/sandboxes. Point the provider at this
server with LLMCHAT_BASE_URL and the bridge runs fully offline.

    python tests/mock_llmchat.py --port 8899
    LLMCHAT_BASE_URL=http://127.0.0.1:8899 python server.py
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MODEL_WIRE = "@cf/zai-org/glm-4.7-flash"
BRAIN_MODEL_WIRE = "@cf/google/gemma-4-26b-a4b-it"
FALLBACK_MODEL_WIRE = "@cf/qwen/qwen3-30b-a3b-fp8"

REASONING = "One short sentence then answer."
CONTENT = "Alright, I'm listening. What's up, bro?"

# v8: what the Gemma-4 decision brain answers with.
DECISION_JSON = {
    "action": "REPLY",
    "understand": "they are poking Aduu for a reaction after going quiet",
    "my_last": "Aduu teased them about the chocolates",
    "next_move": "tease back and leave a hook",
    "mood": "PLAYFUL_CHILL",
    "mood_reason": "",
    "feeling_note": "",
    "bubble_count": 2,
    "bubble_plan": ["tease them about going quiet", "ask what they are really up to"],
    "topic_lock": "their last message",
    "reminder": None,
    "cross_chat_mission": None,
    "use_gossip": False,
    "privacy_ok": True,
    "steer_next": "keep it short",
}


# ─────────────────────────────── frame builders ───────────────────────────────

def _frame(payload: dict) -> str:
    return "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n"


def _usage(prompt=0, completion=0, neurons=0.0) -> dict:
    return {
        "prompt_tokens": prompt, "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "prompt_tokens_details": {"cached_tokens": 0},
        "neurons": neurons,
    }


def glm_frame(delta: dict, finish=None, usage=None, choices=True, model=MODEL_WIRE) -> str:
    """Exact @cf/zai-org/glm-4.7-flash chunk shape."""
    payload = {
        "id": "chatcmpl-b65275be31c0d16d",
        "object": "chat.completion.chunk",
        "created": 1792508047,
        "model": model,
        "choices": ([{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish}]
                    if choices else []),
        "usage": usage or _usage(0, 1, 0.0364),
    }
    return _frame(payload)


def gemma_frame(delta: dict, finish=None, usage=None, choices=True) -> str:
    payload = {
        "choices": ([{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish,
                      "matched_stop": None}] if choices else []),
        "created": int(time.time()),
        "id": "mock-completion-id",
        "model": BRAIN_MODEL_WIRE,
        "object": "chat.completion.chunk",
        "usage": usage or _usage(0, 1, 0.027),
    }
    return _frame(payload)


def qwen_frame(content=None, role=None, finish=None, usage=None, choices=True,
               model=FALLBACK_MODEL_WIRE) -> str:
    """Qwen3 sends BOTH delta.content and a top-level "response" (duplication trap)."""
    delta = {}
    if role is not None:
        delta["role"] = role
    if content is not None:
        delta["content"] = content
    payload = {
        "id": "chatcmpl-3086a16e-6cd6-4d99-b342-4d495aa4797e",
        "object": "chat.completion.chunk",
        "created": 1792321951,
        "model": model,
        "choices": ([{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish}]
                    if choices else []),
        "usage": usage or _usage(0, 1 if content else 0, 0.0304),
    }
    if content is not None:
        payload["response"] = content
    return _frame(payload)


def _tail(final_usage) -> list[str]:
    """Empty-choices frame + final {"response":"","usage":{...}} + [DONE]."""
    return [
        _frame({"choices": [], "usage": _usage(0, 0, 0.0)}),
        _frame({"response": "", "usage": final_usage}),
        "data: [DONE]\n\n",
    ]


# ─────────────────────────────── stream builders ───────────────────────────────

def build_glm_stream(content: str = CONTENT, reasoning: str = REASONING) -> bytes:
    """Exact @cf/zai-org/glm-4.7-flash SSE stream."""
    out = [
        glm_frame({"role": "assistant", "content": "", "reasoning_content": None},
                  usage=_usage(94, 0, 0.517)),
    ]
    for tok in reasoning.split(" "):
        out.append(glm_frame({"reasoning": tok + " ", "reasoning_content": tok + " "}))
    words = content.split(" ")
    for i, tok in enumerate(words):
        last = (i == len(words) - 1)
        out.append(glm_frame({"content": tok + ("" if last else " "),
                              "reasoning_content": None},
                             finish="stop" if last else None))
    out.extend(_tail(_usage(94, 658, 24.4682)))
    return "".join(out).encode()


def build_gemma_stream(content: str = CONTENT, reasoning: str = REASONING) -> bytes:
    out = [gemma_frame({"content": "", "reasoning_content": None, "role": "assistant"},
                       usage=_usage(385, 0, 3.5))]
    for tok in reasoning.split(" "):
        out.append(gemma_frame({"reasoning_content": tok + " "}))
    words = content.split(" ")
    for i, tok in enumerate(words):
        last = (i == len(words) - 1)
        out.append(gemma_frame({"content": tok + ("" if last else " "),
                                "reasoning_content": None},
                               finish="stop" if last else None))
    out.extend(_tail(_usage(385, 250, 5.21)))
    return "".join(out).encode()


def build_qwen_stream(content: str = CONTENT, reasoning: str = REASONING) -> bytes:
    """Qwen3 emits an inline <think> block inside delta.content."""
    out = [qwen_frame(content="", role="assistant", usage=_usage(112, 0, 0.517))]
    out.append(qwen_frame(content="<think>"))
    for tok in reasoning.split(" "):
        out.append(qwen_frame(content=tok + " "))
    out.append(qwen_frame(content="</think>\n\n"))
    words = content.split(" ")
    for i, tok in enumerate(words):
        last = (i == len(words) - 1)
        out.append(qwen_frame(content=tok + ("" if last else " "),
                              finish="stop" if last else None))
    out.extend(_tail(_usage(112, 250, 5.21)))
    return "".join(out).encode()


def build_glitch_stream() -> bytes:
    """The llama-3.3-70b glitch seen in production: a wall of exclamation marks."""
    out = [gemma_frame({"content": "", "reasoning_content": None, "role": "assistant"})]
    out.append(gemma_frame({"content": "!" * 600, "reasoning_content": None}, finish="stop"))
    out.extend(_tail(_usage(90, 300, 1.0)))
    return "".join(out).encode()


def build_empty_stream() -> bytes:
    """Model burned every token inside reasoning_content and never answered."""
    out = [glm_frame({"role": "assistant", "content": "", "reasoning_content": None})]
    for tok in ("thinking " * 40).split(" "):
        out.append(glm_frame({"reasoning": tok + " ", "reasoning_content": tok + " "}))
    out.extend(_tail(_usage(94, 250, 12.0)))
    return "".join(out).encode()


def build_decision_stream(decision: dict | None = None) -> bytes:
    """v8: the Gemma-4 brain answering with its strict JSON decision."""
    body = json.dumps(decision or DECISION_JSON, ensure_ascii=False,
                      separators=(", ", ": "))
    return build_gemma_stream(content=body, reasoning="Decide from the chat.")


def is_decide_request(body: dict) -> bool:
    """True when the request carries the v8 DECISION BRAIN system prompt."""
    try:
        for m in body.get("messages") or []:
            if isinstance(m, dict) and "DECISION BRAIN" in str(m.get("content", "")):
                return True
    except Exception:
        pass
    return False


def build_stream(model: str = "") -> bytes:
    m = (model or "").lower()
    if "gemma" in m:
        return build_gemma_stream()
    if "qwen" in m:
        return build_qwen_stream()
    return build_glm_stream()


# ─────────────────────────────── mock server ───────────────────────────────

class MockLLM:
    """Threaded mock server.

    fail_models   → HTTP 500 for matching model substrings
    glitch_models → return the "!!!!!!" glitch body (tests the bridge's guard)
    empty_models  → return reasoning-only body (tests the empty-content fallback)
    """

    def __init__(self, port: int = 0, fail_models: tuple[str, ...] = (),
                 glitch_models: tuple[str, ...] = (),
                 empty_models: tuple[str, ...] = ()):
        self.fail_models = tuple(fail_models)
        self.glitch_models = tuple(glitch_models)
        self.empty_models = tuple(empty_models)
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MockLLMChat/2.0"

            def log_message(self, *a):
                pass

            def do_POST(self):
                url = urlparse(self.path)
                n = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(n) or b"{}")
                except Exception:
                    body = {}
                model = (body.get("model")
                         or (parse_qs(url.query).get("model") or [""])[0] or "")
                with outer.lock:
                    outer.requests.append({"model": str(model), "body": body,
                                           "path": url.path})
                if url.path != "/inference/stream":
                    return self._json(404, {"error": "unknown path"})
                if any(part in model for part in outer.fail_models):
                    return self._json(500, {"error": "mock upstream failure"})
                if is_decide_request(body):
                    data = build_decision_stream()
                elif any(part in model for part in outer.glitch_models):
                    data = build_glitch_stream()
                elif any(part in model for part in outer.empty_models):
                    data = build_empty_stream()
                else:
                    data = build_stream(model)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                self.wfile.flush()

            def do_GET(self):
                if urlparse(self.path).path == "/requests":
                    with outer.lock:
                        return self._json(200, {"requests": outer.requests})
                return self._json(404, {"error": "unknown path"})

            def _json(self, code, obj):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/inference/stream"

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def last_body(self) -> dict:
        with self.lock:
            return self.requests[-1]["body"] if self.requests else {}

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def main():
    ap = argparse.ArgumentParser(description="offline llmchat.in stream mock (v7)")
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--fail", default="", help="comma-separated model substrings to fail")
    args = ap.parse_args()
    fails = tuple(x.strip() for x in args.fail.split(",") if x.strip())
    with MockLLM(args.port, fails) as mock:
        print(f"mock llmchat stream → {mock.url}")
        print(f"frontline {MODEL_WIRE} · brain {BRAIN_MODEL_WIRE} · fallback {FALLBACK_MODEL_WIRE}")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
