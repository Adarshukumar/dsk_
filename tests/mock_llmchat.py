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

MODEL_WIRE = "@cf/google/gemma-4-26b-a4b-it"
MODEL_RESP = "@cf/google/gemma-4-26b-a4b-it-external"

REASONING = (
    'The user said "bro hi". They are casual and friendly, so the reply should '
    "be short, warm and human. Match the Hinglish tone, keep it to one or two "
    "sentences, and end with a light question."
)
CONTENT = "Yo! I'm listening, bro. What's up?"


def _frame(delta: dict, finish=None, usage=None, choices=True) -> str:
    payload = {
        "choices": ([{"delta": delta, "finish_reason": finish, "index": 0,
                      "logprobs": None, "matched_stop": None}] if choices else []),
        "created": int(time.time()),
        "id": "mock-completion-id",
        "model": MODEL_RESP,
        "object": "chat.completion.chunk",
        "p": "mock",
        "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0,
                           "total_tokens": 0, "prompt_tokens_details": {"cached_tokens": 0},
                           "neurons": 0.0},
    }
    return "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n"


def _usage_frame(prompt=385, completion=250) -> str:
    payload = {
        "response": "",
        "usage": {"prompt_tokens": prompt, "completion_tokens": completion,
                  "total_tokens": prompt + completion,
                  "prompt_tokens_details": {"cached_tokens": 0},
                  "neurons": 10.318181835114956},
    }
    return "data: " + json.dumps(payload, separators=(",", ":")) + "\n\n"


def build_stream() -> bytes:
    """Full SSE body, in wire order."""
    out = []
    # 1. role-only opener (content "" / reasoning_content null)
    out.append(_frame({"content": "", "reasoning_content": None, "role": "assistant"},
                      usage={"prompt_tokens": 385, "completion_tokens": 0,
                             "total_tokens": 385,
                             "prompt_tokens_details": {"cached_tokens": 0},
                             "neurons": 3.5}))
    # 2. reasoning phase, token by token (thinking models stream this first)
    for word in REASONING.split(" "):
        out.append(_frame({"reasoning_content": word + " "},
                          usage={"prompt_tokens": 0, "completion_tokens": 1,
                                 "total_tokens": 1,
                                 "prompt_tokens_details": {"cached_tokens": 0},
                                 "neurons": 0.027}))
    # 3. answer
    for word in CONTENT.split(" "):
        out.append(_frame({"content": word + " ", "reasoning_content": None},
                          usage={"prompt_tokens": 0, "completion_tokens": 1,
                                 "total_tokens": 1,
                                 "prompt_tokens_details": {"cached_tokens": 0},
                                 "neurons": 0.027}))
    # 4. stop + empty-choices keepalive + summary + [DONE]
    out.append(_frame({"reasoning_content": None}, finish="stop"))
    out.append(_frame({}, choices=False))
    out.append(_usage_frame())
    out.append("data: [DONE]\n\n")
    return "".join(out).encode()


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
                data = build_stream()
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
