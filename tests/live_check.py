#!/usr/bin/env python3
"""
Live check against the real llmchat.in endpoint (needs internet).

    python tests/live_check.py
    python tests/live_check.py --model @cf/google/gemma-4-26b-a4b-it

Shows, for the exact persona the bot uses:
  · the wire model id that was requested
  · the reasoning_content phase (thinking) — separated from the answer
  · the final content the bot would actually send
  · token usage + timing

Exit code 0 only if the endpoint returned real content.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmchat_provider import LLMChatProvider  # noqa: E402

DEFAULT_MODEL = "@cf/google/gemma-4-26b-a4b-it"

PERSONA = (
    'You are "Aduu" — the person who runs Adarsh\'s Instagram DMs. You are NOT '
    "Adarsh. You are a witty, warm, slightly flirty Delhi guy who texts like a "
    "real person: 1-3 short sentences, casual Hinglish, no markdown, no lists. "
    "Reply with ONLY the message text."
)
USER = "Hey bro, kya scene hai? Aaj kuch kaam mila kya?"


def split_reasoning(raw: str) -> tuple[str, str]:
    """The provider wraps reasoning_content in <think>…</think>."""
    if "<think>" not in raw:
        return "", raw
    after_open = raw.split("<think>", 1)[1]
    if "</think>" in after_open:
        reasoning, content = after_open.split("</think>", 1)
        return reasoning.strip(), content.strip()
    return after_open.strip(), ""


async def run(model: str, max_tokens: int) -> int:
    prov = LLMChatProvider(
        model=model, system=None, temperature=0.9,
        max_tokens=max_tokens, timeout=120, retries=1,
    )
    print(f"model requested : {prov.model.endpoint}")
    print(f"messages        : persona + \"{USER}\"")
    print("streaming …\n")

    t0 = time.time()
    first_reasoning = first_content = None
    raw: list[str] = []
    try:
        async for tok in prov.chat(messages=[
            {"role": "system", "content": PERSONA},
            {"role": "user", "content": USER},
        ]):
            if not raw:
                first_reasoning = time.time()
            raw.append(tok)
    except Exception as e:
        print(f"FAILED: {type(e).__name__}: {e}")
        return 1
    dt = time.time() - t0
    text = "".join(raw)
    reasoning, content = split_reasoning(text)

    print("── reasoning_content (not sent to anyone) ──────────────────")
    print((reasoning[:1200] + ("…" if len(reasoning) > 1200 else "")) or "(none)")
    print("\n── final content (what Aduu would send) ────────────────────")
    print(content or "(EMPTY — the bridge would fall back to another model)")
    print("\n── stats ───────────────────────────────────────────────────")
    print(f"reasoning chars : {prov.reasoning_chars}")
    print(f"content chars   : {prov.content_chars}")
    print(f"time            : {dt:.1f}s")
    print(f"usage           : {prov.last_usage or '(none)'}")

    if not content:
        print("\nRESULT: FAIL — no content phase")
        return 1
    print("\nRESULT: OK — reasoning and final answer separated cleanly")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="live llmchat.in gemma-4 check")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--max-tokens", type=int, default=800)
    args = ap.parse_args()
    return asyncio.run(run(args.model, args.max_tokens))


if __name__ == "__main__":
    sys.exit(main())
