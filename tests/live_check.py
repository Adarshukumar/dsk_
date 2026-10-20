#!/usr/bin/env python3
"""
Live check against the real llmchat.in endpoint (needs internet).

    python tests/live_check.py
    python tests/live_check.py --model @cf/google/gemma-4-26b-a4b-it
    python tests/live_check.py --low-think      # default: minimal thinking

Shows, for the exact persona + mood the bot uses:
  · the wire model id that was requested
  · the reasoning phase (thinking) — separated from the answer
  · the final content the bot would actually send
  · token usage + timing

Exit code 0 only if the endpoint returned real, non-glitched content.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from llmchat_provider import (                                   # noqa: E402
    DEFAULT_MODEL, LLMChatClient, is_valid_reply_content, resolve_short_model,
    resolve_wire_model)

PERSONA = (
    'You are "Aduu" — the person who runs Adarsh\'s Instagram DMs. You are NOT '
    "Adarsh. You are a witty, warm, slightly flirty Delhi guy who texts like a "
    "real person: 1-3 short sentences, casual Hinglish, no markdown, no lists. "
    "If someone abuses you, clap back hard and then explain how you actually "
    "feel. Reply with ONLY the message text."
)
USER = "Hey bro, kya scene hai? Aaj kuch kaam mila kya?"


async def run(model: str, max_tokens: int, low_think: bool) -> int:
    client = LLMChatClient()
    wire = resolve_wire_model(model)
    print(f"model requested : {wire}  ({resolve_short_model(model)})")
    print(f"minimal thinking: {low_think}")
    print(f"messages        : persona + \"{USER}\"")
    print("streaming …\n")

    t0 = time.time()
    try:
        res = await client.chat_completion(
            messages=[{"role": "system", "content": PERSONA},
                      {"role": "user", "content": USER}],
            model=model, max_tokens=max_tokens, low_think=low_think)
    finally:
        await client.close()
    elapsed = time.time() - t0

    print("─── thinking (internal, never sent) ───")
    print(res.reasoning or "(none)")
    print("\n─── final answer (what Aduu sends) ───")
    print(res.content or "(EMPTY!)")
    print(f"\nmodel used      : {res.model} ({res.wire_model})"
          f"{'  [FALLBACK]' if res.fallback_used else ''}")
    print(f"reasoning chars : {len(res.reasoning)}")
    print(f"elapsed         : {elapsed:.1f}s")
    print(f"usage           : {res.usage}")

    if not res.content:
        print("\n❌ empty content")
        return 1
    if not is_valid_reply_content(res.content):
        print("\n❌ glitched content (punctuation flood / no real text)")
        return 2
    print("\n✅ live check passed")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="live llmchat.in check")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--max-tokens", type=int, default=500)
    ap.add_argument("--low-think", dest="low_think", action="store_true", default=True)
    ap.add_argument("--no-low-think", dest="low_think", action="store_false")
    args = ap.parse_args()
    try:
        return asyncio.run(run(args.model, args.max_tokens, args.low_think))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
