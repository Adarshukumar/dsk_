"""
Async llmchat.in SSE provider using curl_cffi with Chrome TLS impersonation.

v7 Multi-Model Architecture (GLM-4.7-Flash + Gemma-4-26B Brain + Qwen3-30B):
  - Primary Answering & Creative Agent Model:
      `@cf/zai-org/glm-4.7-flash` (`zai-org/glm-4.7-flash`)
      Tuned with minimal-thinking prompt enforcement (`THINK_MIN_BUDGET = 2500`)
      and native SSE parser support for GLM-4.7-Flash chunks:
        `delta: {"reasoning": "<tok>", "reasoning_content": "<tok>"}`
        followed by `delta: {"content": "<tok>", "reasoning_content": null}`
        and final `{"response": "", "usage": {...}}` + `data: [DONE]`.
  - Background Brain & Strategy Model:
      `@cf/google/gemma-4-26b-a4b-it` (`google/gemma-4-26b-a4b-it`)
      Handles parallel psychological profiling, mood shifts, reminder extraction,
      cross-chat prank/relay planning, and privacy filtering.
  - Built-in Glitch / Punctuation-Flood Filter:
      Rejects model glitches like `"!!!!!!!..."` and automatically falls back
      to the next model in `FALLBACK_CHAIN`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator

from curl_cffi.requests import AsyncSession

log = logging.getLogger("llmchat_provider")

# ---------------------------------------------------------------------------
# Endpoint & Verified Model Registry (v7 GLM-4.7-Flash + Gemma-4 + Qwen3)
# ---------------------------------------------------------------------------

LLMCHAT_BASE_URL = os.environ.get("LLMCHAT_BASE_URL", "https://llmchat.in")
INFERENCE_URL = f"{LLMCHAT_BASE_URL.rstrip('/')}/inference/stream"

# Primary answering model: @cf/zai-org/glm-4.7-flash (with minimal thinking)
DEFAULT_MODEL = os.environ.get(
    "LLMCHAT_MODEL",
    "zai-org/glm-4.7-flash",
)

# Secondary / Background Brain model: @cf/google/gemma-4-26b-a4b-it
DEFAULT_BRAIN_MODEL = os.environ.get(
    "LLMCHAT_BRAIN_MODEL",
    "google/gemma-4-26b-a4b-it",
)

# Verified working models on llmchat.in (/inference/stream)
MODEL_REGISTRY: dict[str, dict[str, Any]] = {
    "zai-org/glm-4.7-flash": {
        "id": "@cf/zai-org/glm-4.7-flash",
        "name": "GLM 4.7 Flash",
        "provider": "Z.ai",
        "thinking": True,
        "low_think": True,
        "context": 131_072,
    },
    "qwen/qwen3-30b-a3b-fp8": {
        "id": "@cf/qwen/qwen3-30b-a3b-fp8",
        "name": "Qwen3 30B A3B",
        "provider": "Alibaba",
        "thinking": True,
        "low_think": True,
        "context": 32_768,
    },
    "google/gemma-4-26b-a4b-it": {
        "id": "@cf/google/gemma-4-26b-a4b-it",
        "name": "Gemma 4 26B A4B",
        "provider": "Google",
        "thinking": True,
        "context": 32_768,
    },
    "meta/llama-3.3-70b-instruct-fp8-fast": {
        "id": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "name": "Llama 3.3 70B",
        "provider": "Meta",
        "thinking": False,
        "context": 131_072,
    },
    "meta/llama-4-scout-17b-16e-instruct": {
        "id": "@cf/meta/llama-4-scout-17b-16e-instruct",
        "name": "Llama 4 Scout",
        "provider": "Meta",
        "thinking": False,
        "context": 131_072,
    },
    "ibm-granite/granite-4.0-h-micro": {
        "id": "@cf/ibm-granite/granite-4.0-h-micro",
        "name": "Granite 4.0 Micro",
        "provider": "IBM",
        "thinking": False,
        "context": 131_072,
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
        "id": "@cf/mistralai/mistral-small-3.1-24b-instruct",
        "name": "Mistral Small 3.1",
        "provider": "Mistral",
        "thinking": False,
        "context": 128_000,
    },
    "nvidia/nemotron-3-120b-a12b": {
        "id": "@cf/nvidia/nemotron-3-120b-a12b",
        "name": "Nemotron 3 120B",
        "provider": "NVIDIA",
        "thinking": True,
        "context": 32_768,
    },
    "google/gemma-3-12b-it": {
        "id": "@cf/google/gemma-3-12b-it",
        "name": "Gemma 3 12B",
        "provider": "Google",
        "thinking": False,
        "context": 8_192,
    },
}

# Ordered fallback chain if the requested model is rate-limited, empty, or glitched
FALLBACK_CHAIN: list[str] = [
    "zai-org/glm-4.7-flash",
    "qwen/qwen3-30b-a3b-fp8",
    "google/gemma-4-26b-a4b-it",
    "meta/llama-3.3-70b-instruct-fp8-fast",
    "meta/llama-4-scout-17b-16e-instruct",
    "mistralai/mistral-small-3.1-24b-instruct",
    "google/gemma-3-12b-it",
]

# Chrome 131 headers matching browser requests to llmchat.in
DEFAULT_HEADERS: dict[str, str] = {
    "Accept": "text/event-stream",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    "Origin": "https://llmchat.in",
    "Referer": "https://llmchat.in/",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
}

# Minimal-thinking instruction injected into GLM-4.7-Flash calls so it doesn't
# waste 600 tokens writing a 7-step markdown essay in reasoning_content.
GLM_LOW_THINK_DIRECTIVE = (
    "\n\n[THINKING BUDGET: MINIMAL. In your internal reasoning, NEVER write "
    "numbered steps (1. Analyze, 2. Intent, 3. Draft...) or markdown headers. "
    "Think in ONE short sentence (<15 words), then immediately output the final answer.]"
)


def resolve_wire_model(model: str | None) -> str:
    """Resolve short name or @cf/ wire ID to full @cf/... wire identifier."""
    if not model:
        model = DEFAULT_MODEL
    model = model.strip()
    if model in MODEL_REGISTRY:
        return MODEL_REGISTRY[model]["id"]
    if model.startswith("@cf/") or model.startswith("@hf/"):
        return model
    for key, info in MODEL_REGISTRY.items():
        if info["id"] == model or key.endswith(f"/{model}"):
            return info["id"]
    return f"@cf/{model}"


def resolve_short_model(model: str | None) -> str:
    """Return canonical short model key when known."""
    wire = resolve_wire_model(model)
    for key, info in MODEL_REGISTRY.items():
        if info["id"] == wire:
            return key
    return wire.removeprefix("@cf/")


def is_thinking_model(model: str | None) -> bool:
    """Return True if the model emits reasoning_content before content."""
    short = resolve_short_model(model)
    return bool(MODEL_REGISTRY.get(short, {}).get("thinking", False))


def is_valid_reply_content(text: str) -> bool:
    """
    Guard against glitched model outputs such as `"!!!!!!!!..."` (seen on
    llama-3.3-70b fallback when prompted with abusive text) or empty symbols.
    Requires at least 2 alphanumeric/Devanagari characters and prevents >75%
    repeated punctuation floods.
    """
    if not text or not text.strip():
        return False
    s = text.strip()
    # Count letters/digits (Latin + Devanagari + emojis count separately)
    alpha_num = re.findall(r"[A-Za-z0-9\u0900-\u097F]", s)
    if len(alpha_num) < 2:
        return False
    # Reject punctuation floods like "!!!!!!!!!!!!!!!!!!!!!!!!"
    punct_flood = re.search(r"([!?.,~*#\-_=])\1{12,}", s)
    if punct_flood and len(alpha_num) < len(s) * 0.25:
        return False
    return True


@dataclass
class CompletionResult:
    content: str
    reasoning: str = ""
    model: str = DEFAULT_MODEL
    wire_model: str = ""
    elapsed_ms: int = 0
    usage: dict[str, Any] = field(default_factory=dict)
    fallback_used: bool = False


class LLMChatClient:
    """
    High-concurrency async client for llmchat.in with:
      - Persistent curl_cffi AsyncSession (Chrome TLS impersonation)
      - Full SSE stream parser (OpenAI delta + Cloudflare response + reasoning_content)
      - GLM-4.7-Flash minimal-thinking enforcement & Qwen3 `/no_think` support
      - Glitch / punctuation-flood rejection (`is_valid_reply_content`)
      - Automatic retries with exponential backoff + model fallback chain
    """

    def __init__(
        self,
        inference_url: str = INFERENCE_URL,
        impersonate: str = "chrome131",
        timeout: float = float(os.environ.get("IG_HTTP_TIMEOUT_S", "30") or 30),
        max_concurrency: int = 8,
        chain_budget_s: float = 40.0,
    ) -> None:
        self.inference_url = inference_url
        self.impersonate = impersonate
        self.timeout = timeout
        # Total wall-clock budget for one chat_completion across every model
        # in the fallback chain. Env-tunable; 0 disables the deadline.
        self.chain_budget_s = float(
            os.environ.get("IG_CHAIN_BUDGET_S", chain_budget_s) or 0)
        self._sem = asyncio.Semaphore(max_concurrency)
        self._session: AsyncSession | None = None
        self._session_lock = asyncio.Lock()
        self._loop = None          # event loop the cached session belongs to
        self._last_empty_digest = ""  # dedupes identical empty-body logs

    async def _get_session(self) -> AsyncSession:
        loop = asyncio.get_running_loop()
        # curl_cffi binds its internal handles to the loop it was created on.
        # If we are being driven from a different loop (tests, multiple
        # asyncio.run() calls, thread pools), drop the stale session and make
        # a fresh one instead of blowing up with "attached to a different loop".
        if self._session is not None and self._loop is not loop:
            stale, self._session, self._loop = self._session, None, None
            try:
                await stale.close()
            except Exception:
                pass
        if self._session is None:
            async with self._session_lock:
                if self._session is None:
                    self._session = AsyncSession(
                        impersonate=self.impersonate,
                        headers=DEFAULT_HEADERS,
                        timeout=self.timeout,
                    )
                    self._loop = loop
        return self._session

    async def close(self) -> None:
        if self._session is not None:
            try:
                await self._session.close()
            except Exception:
                pass
            self._session = None
            self._loop = None

    # Envelope keys the upstream may wrap the real payload in. llmchat.in
    # started wrapping EVERY response in {"result": {...}} (Oct 2026) — the
    # payload survived but `choices` was no longer at the top level, so the
    # parser silently returned ("", "") and every model looked "empty".
    _ENVELOPE_KEYS = ("result", "data", "output", "completion", "body",
                      "payload", "response")

    @classmethod
    def _unwrap_envelope(cls, packet: Any) -> Any:
        """Peel `{"result": {...}}` (and friends) until the real object shows.

        Only descends into dict/list values, so the legacy Cloudflare shape
        `{"response": "some text"}` is left alone and still parsed as content.
        """
        for _ in range(6):
            if not isinstance(packet, dict):
                break
            for key in cls._ENVELOPE_KEYS:
                val = packet.get(key)
                if isinstance(val, (dict, list)):
                    packet = val
                    break
            else:
                break
        return packet

    @staticmethod
    def _take_text(obj: Any, keys: tuple[str, ...]) -> tuple[str, str]:
        """Pull (content, reasoning) out of any delta/message-shaped dict."""
        if not isinstance(obj, dict):
            return "", ""
        rc = obj.get("reasoning_content")
        if rc is None:
            rc = obj.get("reasoning")
        c = obj.get("content")
        # `content` may legitimately be None (tool/role-only chunks)
        return (c if isinstance(c, str) else "",
                rc if isinstance(rc, str) else "")

    @classmethod
    def _parse_sse(cls, raw: str) -> tuple[str, str, dict[str, Any]]:
        """
        Parse a raw llmchat.in response body into (content, reasoning, usage).

        Tolerates every shape this upstream has ever sent:

          - CURRENT (Oct 2026) — a single non-streaming object wrapped in an
            envelope, despite the `text/event-stream` content-type:
                `{"result":{"choices":[{"message":{"content":"…"}}],
                  "usage":{…}}}`
          - OpenAI streaming chunks:
                `data: {"choices":[{"delta":{"content":"…",
                                             "reasoning_content":"…"}}]}`
          - GLM-4.7-Flash bare `delta:` lines
          - Legacy Workers AI `{"response": "…"}` chunks
          - Bare JSON lines with no `data:` prefix at all
          - Inline `<think>…</think>` blocks inside content

        The rule: never return ("", "") for a body that actually carried text.
        """
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        usage: dict[str, Any] = {}

        for raw_line in raw.splitlines():
            line = raw_line.strip()
            if not line or line.startswith(":"):
                continue
            if line.startswith("data:"):
                data_str = line[5:].strip()
            elif line.startswith("delta:"):
                data_str = line[6:].strip()
            elif line.startswith("event:"):
                continue
            elif line[0] in "{[":
                # No SSE prefix — the body is plain JSON (current behaviour).
                data_str = line
            else:
                continue

            if not data_str or data_str == "[DONE]":
                continue

            try:
                packet = json.loads(data_str)
            except json.JSONDecodeError:
                continue
            if not isinstance(packet, dict):
                continue

            packet = cls._unwrap_envelope(packet)
            if not isinstance(packet, dict):
                continue

            # An upstream error object must raise, never look like an empty
            # completion — otherwise the whole chain burns for nothing.
            if packet.get("success") is False or packet.get("error"):
                msg = packet.get("error") or packet.get("message") or "unknown"
                if isinstance(msg, dict):
                    msg = json.dumps(msg)[:200]
                raise RuntimeError(f"upstream error packet: {str(msg)[:200]}")

            if isinstance(packet.get("usage"), dict) and packet["usage"]:
                usage = packet["usage"]

            choices = packet.get("choices")
            if isinstance(choices, list) and choices:
                for entry in choices:
                    if not isinstance(entry, dict):
                        continue
                    # non-streaming completion → `message`; streaming → `delta`
                    for key in ("delta", "message"):
                        c, rc = cls._take_text(entry.get(key),
                                               ("content", "reasoning"))
                        if rc:
                            reasoning_parts.append(rc)
                        if c:
                            content_parts.append(c)
                    # some gateways put text straight on the choice
                    if not entry.get("delta") and not entry.get("message"):
                        c, rc = cls._take_text(entry, ("content", "reasoning"))
                        if rc:
                            reasoning_parts.append(rc)
                        if c:
                            content_parts.append(c)
                continue

            # No `choices` wrapper at all — the packet itself is the payload.
            c, rc = cls._take_text(packet, ("content", "reasoning"))
            if rc:
                reasoning_parts.append(rc)
            if c:
                content_parts.append(c)
                continue

            for key in ("delta", "message"):
                c, rc = cls._take_text(packet.get(key),
                                       ("content", "reasoning"))
                if rc:
                    reasoning_parts.append(rc)
                if c:
                    content_parts.append(c)
                    break
            else:
                for key in ("text", "output_text") :
                    val = packet.get(key)
                    if isinstance(val, str) and val:
                        content_parts.append(val)
                        break
                else:
                    val = packet.get("response")
                    if isinstance(val, str) and val:
                        content_parts.append(val)

        content = "".join(content_parts)
        reasoning = "".join(reasoning_parts)

        # ── LAST LINE OF DEFENCE ──────────────────────────────────────────
        # The whole October-2026 outage was this: the upstream kept answering
        # perfectly, the parser just did not recognise the new envelope, and
        # ("", "") was reported as "the model returned empty content". Every
        # model then looked dead and the entire chain burned for nothing.
        # If a body clearly carries text but nothing was extracted, say so
        # loudly — an unrecognised FORMAT must never masquerade as an empty
        # MODEL. Whoever reads the log should know to fix the parser, not to
        # go hunting for a slow model.
        if not content.strip() and not reasoning.strip() and raw.strip():
            smells_like_text = any(
                tok in raw for tok in ('"content"', '"text"', '"message"',
                                       '"choices"', '"response"', '"result"'))
            if smells_like_text:
                log.error(
                    "UNRECOGNISED RESPONSE FORMAT — the body carries text but "
                    "nothing was extracted (%d chars). This is a PARSER bug, "
                    "not an empty model: fix _parse_sse(). Body: %r",
                    len(raw), raw[:900],
                )

        # Strip inline <think>...</think> blocks if any model embeds them in content
        if "<think>" in content:
            think_matches = re.findall(r"<think>([\s\S]*?)</think>", content)
            if think_matches and not reasoning:
                reasoning = "\n".join(m.strip() for m in think_matches).strip()
            content = re.sub(r"<think>[\s\S]*?</think>", "", content)
            if "<think>" in content:
                content = content.split("<think>", 1)[0]

        return content.strip(), reasoning.strip(), usage

    @staticmethod
    def _merge_system_messages(
        messages: list[dict[str, str]],
    ) -> list[dict[str, str]]:
        """
        Collapse every leading/consecutive run of `system` messages into ONE.

        Why: Cloudflare's chat template (what llmchat.in proxies to) silently
        drops or mangles prompts that carry more than one system message — the
        model then returns an empty stream with reasoning=0. The brain's
        `decide` path was the only caller that produced two system messages
        (its own contract + the injected one), which is exactly why only that
        call kept coming back empty.
        """
        out: list[dict[str, str]] = []
        pending: list[str] = []

        def flush() -> None:
            if pending:
                merged = "\n\n".join(p for p in pending if p)
                out.append({"role": "system", "content": merged})
                pending.clear()

        for m in messages:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            content = m.get("content") or ""
            if role == "system":
                pending.append(str(content))
                continue
            flush()
            out.append(dict(m))
        flush()
        # never leave a system-only or empty request behind
        if not out:
            out = [{"role": "user", "content": "hello"}]
        if all(m.get("role") == "system" for m in out):
            last = out[-1]
            out.append({"role": "user",
                        "content": str(last.get("content") or "Continue.")[:4000]})
        return out

    async def _request_once(
        self,
        messages: list[dict[str, str]],
        wire_model: str,
        max_tokens: int,
        temperature: float,
        low_think: bool = True,
    ) -> tuple[str, str, dict[str, Any]]:
        session = await self._get_session()

        prepared_messages = self._merge_system_messages(messages)
        if low_think and prepared_messages:
            # GLM-4.7-Flash: inject minimal-thinking directive so it doesn't write
            # a 7-step markdown outline in reasoning_content
            if "glm-4" in wire_model:
                injected = False
                for m in prepared_messages:
                    if m.get("role") == "system":
                        if "THINKING BUDGET: MINIMAL" not in (m.get("content") or ""):
                            m["content"] = (m.get("content") or "") + GLM_LOW_THINK_DIRECTIVE
                        injected = True
                        break
                if not injected:
                    prepared_messages.insert(
                        0,
                        {"role": "system", "content": GLM_LOW_THINK_DIRECTIVE.strip()},
                    )
            # Qwen3: supports native `/no_think` suffix
            elif "qwen3" in wire_model:
                for i in range(len(prepared_messages) - 1, -1, -1):
                    if prepared_messages[i].get("role") in ("user", "system"):
                        txt = prepared_messages[i].get("content", "")
                        if "/no_think" not in txt and "/think" not in txt:
                            prepared_messages[i]["content"] = f"{txt}\n/no_think"
                        break

        payload: dict[str, Any] = {
            "model": wire_model,
            "messages": prepared_messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

        async with self._sem:
            resp = await session.post(
                self.inference_url,
                json=payload,
                timeout=self.timeout,
            )

        if resp.status_code != 200:
            body_preview = (resp.text or "")[:240]
            raise RuntimeError(
                f"llmchat.in HTTP {resp.status_code} for {wire_model}: {body_preview}"
            )

        raw = resp.text or ""
        content, reasoning, usage = self._parse_sse(raw)
        if not content.strip():
            # Surface WHY the stream was empty instead of silently burning
            # every model in the chain (rate limits, template rejects, 429s…).
            # The raw body is the whole point: it is the only thing that tells
            # you what the upstream actually changed.
            digest = hashlib.sha1(raw.encode("utf-8", "replace")).hexdigest()[:8]
            if digest == self._last_empty_digest:
                log.warning(
                    "empty stream from %s (max_tokens=%d, msgs=%d) — same raw "
                    "body as before [sha %s, %d chars]",
                    wire_model, max_tokens, len(prepared_messages),
                    digest, len(raw),
                )
            else:
                self._last_empty_digest = digest
                log.warning(
                    "empty stream from %s (max_tokens=%d, temp=%.2f, msgs=%d, "
                    "ct=%s) — raw[%d chars, sha %s]: %r",
                    wire_model, max_tokens, temperature, len(prepared_messages),
                    (resp.headers.get("content-type", "") if hasattr(resp, "headers")
                     else ""),
                    len(raw), digest, raw[:600],
                )
        return content, reasoning, usage

    async def chat_completion(
        self,
        messages: list[dict[str, str]],
        model: str | None = None,
        max_tokens: int = 500,
        temperature: float = 0.85,
        allow_fallback: bool = True,
        retries_per_model: int = 2,
        low_think: bool = True,
    ) -> CompletionResult:
        """
        Execute a chat completion against llmchat.in.
        If the primary model returns empty content, glitches (e.g. `"!!!!..."`),
        or errors out, automatically retries and falls back through FALLBACK_CHAIN.
        """
        t0 = time.monotonic()
        requested_short = resolve_short_model(model or DEFAULT_MODEL)

        candidate_models = [requested_short]
        if allow_fallback:
            for fb in FALLBACK_CHAIN:
                if fb not in candidate_models:
                    candidate_models.append(fb)

        last_error: Exception | None = None
        last_reasoning: str = ""

        # HARD DEADLINE on the whole chain.
        # Seen in production: a sick upstream made one decide take 231 SECONDS
        # (14 calls × a ~50s curl timeout each). The person just sat there.
        # Once the budget is gone we stop trying and let the caller hand back
        # its safe fallback — a late reply is worse than a fallback reply.
        budget_s = float(
            os.environ.get("IG_CHAIN_BUDGET_S", self.chain_budget_s) or 0) or None
        deadline = (time.monotonic() + budget_s) if budget_s else None

        # Retries get more head-room, but bounded RELATIVE TO WHAT WAS ASKED.
        # A 900-token decision must not creep up to a 4096-token one just
        # because the chain kept failing — that only makes it slower.
        base_max_tokens = max_tokens
        retry_ceiling = min(max(int(base_max_tokens * 2.0) + 400, 1200), 4096)

        for idx, cand_short in enumerate(candidate_models):
            wire_model = resolve_wire_model(cand_short)

            # Out of time — stop burning models and report honestly.
            if deadline is not None and time.monotonic() >= deadline:
                log.warning(
                    "chain budget of %.0fs exhausted after %d model(s); "
                    "stopping before %s", budget_s, idx, wire_model,
                )
                last_error = last_error or RuntimeError(
                    f"chain budget of {budget_s:.0f}s exhausted")
                break

            if idx > 0:
                # Breathe before switching models — most upstream empties are
                # rate limits and hammering the next model makes it worse.
                # Kept small (capped) so a fully dead chain still fails fast
                # instead of leaving the person staring at a silent chat.
                await asyncio.sleep(min(0.4 * idx, 1.0))
            for attempt in range(retries_per_model):
                # Don't start a request that cannot finish inside the budget.
                if deadline is not None:
                    left = deadline - time.monotonic()
                    if left <= 0.5:
                        break
                try:
                    content, reasoning, usage = await asyncio.wait_for(
                        self._request_once(
                            messages=messages,
                            wire_model=wire_model,
                            max_tokens=max_tokens,
                            temperature=temperature,
                            low_think=low_think,
                        ),
                        timeout=(min(self.timeout, deadline - time.monotonic())
                                 if deadline is not None else self.timeout),
                    )
                    if reasoning:
                        last_reasoning = reasoning

                    if content and is_valid_reply_content(content):
                        elapsed = int((time.monotonic() - t0) * 1000)
                        return CompletionResult(
                            content=content,
                            reasoning=reasoning,
                            model=cand_short,
                            wire_model=wire_model,
                            elapsed_ms=elapsed,
                            usage=usage,
                            fallback_used=(idx > 0),
                        )

                    # Model either exhausted tokens inside reasoning_content or
                    # emitted glitched punctuation ("!!!!..."). Retry with higher budget.
                    if content and not is_valid_reply_content(content):
                        log.warning(
                            "Model %s emitted glitched content (%r) on attempt %d",
                            wire_model,
                            content[:60],
                            attempt + 1,
                        )
                    else:
                        log.warning(
                            "Model %s returned empty content (reasoning=%d chars) on attempt %d",
                            wire_model,
                            len(reasoning),
                            attempt + 1,
                        )
                    # Give the retry more room — but proportionally, and never
                    # more than the upstream can actually emit. (The old fixed
                    # floor of 2500 turned a 900-token decision into a slow
                    # 2500-token one, which only made empties more likely.)
                    max_tokens = min(int(max_tokens * 1.5) + 400, retry_ceiling)
                except Exception as exc:
                    last_error = exc
                    log.warning(
                        "Model %s attempt %d failed: %s",
                        wire_model,
                        attempt + 1,
                        exc,
                    )
                    if attempt + 1 < retries_per_model:
                        await asyncio.sleep(0.35 * (attempt + 1))

        elapsed = int((time.monotonic() - t0) * 1000)
        if last_error is not None:
            raise RuntimeError(
                f"All llmchat.in models failed after {elapsed}ms; last error: {last_error}"
            )
        raise RuntimeError(
            f"All llmchat.in models returned empty/glitched content after {elapsed}ms "
            f"(last reasoning={len(last_reasoning)} chars)"
        )

    async def stream_chunks(
        self,
        messages: list[dict[str, str]],
        model: str | None = None,
        max_tokens: int = 500,
        temperature: float = 0.85,
        low_think: bool = True,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Yield OpenAI-compatible SSE chunks for streaming clients."""
        result = await self.chat_completion(
            messages=messages,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            low_think=low_think,
        )
        chunk_id = f"chatcmpl-{int(time.time() * 1000)}"
        created = int(time.time())
        yield {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": result.model,
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "role": "assistant",
                        "content": result.content,
                        **(
                            {"reasoning_content": result.reasoning}
                            if result.reasoning
                            else {}
                        ),
                    },
                    "finish_reason": "stop",
                }
            ],
        }
