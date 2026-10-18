#!/usr/bin/env python3
"""
Offline stand-in for https://llmchat.in/inference/stream

It speaks the *exact* SSE shape the real gemma-4 endpoint sends (captured from
a live run): a role-only first chunk, a long `reasoning_content` phase, then
`content` chunks, a stop chunk, an empty-choices usage chunk, one final
`{"response":"","usage":{…}}` frame and `[DONE]`.

Why: llmchat.in is not reachable from CI/sandboxes.  Point the provider at this
server with LLMCHAT_API and the whole bridge can be exercised offline.

    python tests/mock_llmchat.py --port 8899

    LLMCHAT_API=http://127.0.0.1:8899/inference/stream python server.py
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MODEL_WIRE = "@cf/qwen/qwen3-30b-a3b-fp8"
BRAIN_MODEL_WIRE = "@cf/google/gemma-4-26b-a4b-it"
MODEL_RESP = "@cf/qwen/qwen3-30b-a3b-fp8"
BRAIN_MODEL_RESP = "@cf/google/gemma-4-26b-a4b-it-external"

REASONING = (
    'Okay, the user said "hey bro". Let me think about how to respond. '
    "Keep the tone relaxed and approachable. Ready to respond."
)
CONTENT = "Yo! I'm listening, bro. What's up?"


def _qwen_frame(content=None, role=None, finish=None, usage=None, choices=True) -> str:
    """Exact @cf/qwen/qwen3-30b-a3b-fp8 SSE chunk shape (both delta.content and top-level response)."""
    delta = {}
    if role is not None:
        delta["role"] = role
    if content is not None:
        delta["content"] = content
    payload = {
        "id": "chatcmpl-3086a16e-6cd6-4d99-b342-4d495aa4797e",
        "object": "chat.completion.chunk",
        "created": 1792321951,
        "model": MODEL_RESP,
        "choices": ([{"index": 0, "delta": delta, "logprobs": None,
                      "finish_reason": finish, "token_ids": None}] if choices else []),
        "usage": usage or {"prompt_tokens": 0, "completion_tokens": 1 if content else 0,
                           "total_tokens": 1 if content else 0,
                           "prompt_tokens_details": {"cached_tokens": 0},
                           "neurons": 0.030474770814180374 if content else 0},
        "tool_calls": [],
        "p": "mockqwen",
    }
    if content is not None:
        payload["response"] = content
    return "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n"


def _gemma_frame(delta: dict, finish=None, usage=None, choices=True) -> str:
    payload = {
        "choices": ([{"delta": delta, "finish_reason": finish, "index": 0,
                      "logprobs": None, "matched_stop": None}] if choices else []),
        "created": int(time.time()),
        "id": "mock-completion-id",
        "model": BRAIN_MODEL_RESP,
        "object": "chat.completion.chunk",
        "p": "mock",
        "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0,
                           "total_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0},
                           "neurons": 0.0},
    }
    return "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n"


def _usage_frame(prompt=112, completion=250) -> str:
    payload = {
        "response": "",
        "usage": {"prompt_tokens": prompt, "completion_tokens": completion,
                  "total_tokens": prompt + completion,
                  "prompt_tokens_details": {"cached_tokens": 0},
                  "neurons": 5.21106780320406},
    }
    return "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n"


def build_qwen_stream() -> bytes:
    """Exact @cf/qwen/qwen3-30b-a3b-fp8 SSE stream (inline <think>...</think> + response field)."""
    out = []
    out.append(_qwen_frame(content="", role="assistant",
                           usage={"prompt_tokens": 112, "completion_tokens": 0,
                                  "total_tokens": 112,
                                  "prompt_tokens_details": {"cached_tokens": 0},
                                  "neurons": 0.517953097820282}))
    out.append(_qwen_frame(content="<think>"))
    out.append(_qwen_frame(content="\n"))
    for word in REASONING.split(" "):
        out.append(_qwen_frame(content=word + " "))
    out.append(_qwen_frame(content="\n"))
    out.append(_qwen_frame(content="</think>"))
    out.append(_qwen_frame(content="\n\n"))
    for word in CONTENT.split(" "):
        out.append(_qwen_frame(content=word + " "))
    out.append(_qwen_frame(finish="stop"))
    out.append(_qwen_frame(choices=False))
    out.append(_usage_frame())
    out.append("data: [DONE]\n\n")
    return "".join(out).encode()


def build_gemma_stream() -> bytes:
    """Full Gemma-4 SSE body (delta.reasoning_content phase -> delta.content)."""
    out = []
    out.append(_gemma_frame({"content": "", "reasoning_content": None, "role": "assistant"},
                            usage={"prompt_tokens": 385, "completion_tokens": 0,
                                   "total_tokens": 385,
                                   "prompt_tokens_details": {"cached_tokens": 0},
                                   "neurons": 3.5}))
    for word in REASONING.split(" "):
        out.append(_gemma_frame({"reasoning_content": word + " "},
                                usage={"prompt_tokens": 0, "completion_tokens": 1,
                                       "total_tokens": 1,
                                       "prompt_tokens_details": {"cached_tokens": 0},
                                       "neurons": 0.027}))
    for word in CONTENT.split(" "):
        out.append(_gemma_frame({"content": word + " ", "reasoning_content": None},
                                usage={"prompt_tokens": 0, "completion_tokens": 1,
                                       "total_tokens": 1,
                                       "prompt_tokens_details": {"cached_tokens": 0},
                                       "neurons": 0.027}))
    out.append(_gemma_frame({"reasoning_content": None}, finish="stop"))
    out.append(_gemma_frame({}, choices=False))
    out.append(_usage_frame())
    out.append("data: [DONE]\n\n")
    return "".join(out).encode()


def build_stream(model: str = "") -> bytes:
    if "gemma" in (model or "").lower():
        return build_gemma_stream()
    return build_qwen_stream()


class MockLLM:
    """Threaded mock server.  `fail_models` turns matching model ids into 500s."""

    def __init__(self, port: int = 0, fail_models: tuple[str, ...] = ()):
        self.fail_models = tuple(fail_models)
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "MockLLMChat/1.0"

            def log_message(self, *a):  # quiet
                pass

            def do_POST(self):
                url = urlparse(self.path)
                model = (parse_qs(url.query).get("model") or [""])[0]
                n = int(self.headers.get("Content-Length") or 0)
                try:
                    body = json.loads(self.rfile.read(n) or b"{}")
                except Exception:
                    body = {}
                with outer.lock:
                    outer.requests.append({"model": model, "body": body,
                                           "path": url.path})
                if url.path != "/inference/stream":
                    return self._json(404, {"error": "unknown path"})
                if any(part in model for part in outer.fail_models):
                    return self._json(500, {"error": "mock upstream failure"})
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

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def main():
    ap = argparse.ArgumentParser(description="offline llmchat.in stream mock")
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--fail", default="", help="comma-separated model substrings to fail")
    args = ap.parse_args()
    fails = tuple(x.strip() for x in args.fail.split(",") if x.strip())
    with MockLLM(args.port, fails) as mock:
        print(f"mock llmchat stream → {mock.url}")
        print(f"answering as {MODEL_WIRE}  (reasoning then content)")
        if fails:
            print(f"failing models containing: {', '.join(fails)}")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
