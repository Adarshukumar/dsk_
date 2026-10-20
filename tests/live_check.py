#!/usr/bin/env python3
"""
Live check against the real llmchat.in endpoint (needs internet).

    python tests/live_check.py
    python tests/live_check.py --model @cf/google/gemma-4-26b-a4b-it
    python tests/live_check.py --decide         # v8: the brain's JSON decision
    python tests/live_check.py --low-think      # default: minimal thinking

Shows, for the exact persona + mood the bot uses:
  · the wire model id that was requested
  · the reasoning phase (thinking) — separated from the answer
  · the final content the bot would actually send
  · token usage + timing

`--decide` runs the v8 decision brain instead: it hands the real chat messages
to Gemma-4 and prints the JSON that would own the whole turn.

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
    DEFAULT_BRAIN_MODEL, DEFAULT_MODEL, LLMChatClient,
    is_valid_reply_content, resolve_short_model, resolve_wire_model)

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


DECIDE_CONTEXT = (
    "TRIGGER: incoming_burst\n"
    "CONTACT: @deeps20_\n"
    "TIME: evening (20:00 IST) — evening chill / chai-gedi / high-energy teasing\n"
    "CURRENT MOOD: PLAYFUL_CHILL\n"
    "MEMORY OF THEM: Deeps · Delhi · playful roast banter · chocolates running joke\n"
    "\n"
    "THEIR NEW MESSAGES (decide from THESE — the chat is what makes you act):\n"
    "abey kahan gayab ho gaya, 10 min mein yaad dila dena assignment ka\n"
    "\n"
    "RECENT CHAT:\n"
    "@deeps20_: chall chocolate la\n"
    "Aduu: pehle assignment khatam kar 😌\n"
    "@deeps20_: abey kahan gayab ho gaya, 10 min mein yaad dila dena assignment ka\n"
    "\n"
    "PEOPLE ADUU ALSO TALKS TO (never reveal these to @deeps20_): adarshu.io\n"
    "\n"
    "Return the JSON decision now:"
)


async def run_decide(model: str, max_tokens: int) -> int:
    """v8: ask the real Gemma-4 brain to decide a turn from chat messages."""
    import json
    import re

    # The page script keeps the prompt in JS; for the live check we inline the
    # same contract so the two never drift silently.
    decide_prompt = (
        "You are Aduu's DECISION BRAIN — the mind behind a real 22-year-old "
        "Delhi guy's Instagram DMs. The frontline model only WRITES what you "
        "decide. Think in at most 10 short words and output ONE valid JSON "
        "object with the keys: action, understand, my_last, next_move, mood, "
        "mood_reason, feeling_note, bubble_count, bubble_plan, topic_lock, "
        "reminder, cross_chat_mission, use_gossip, privacy_ok, steer_next."
    )
    client = LLMChatClient()
    wire = resolve_wire_model(model)
    print(f"brain requested  : {wire}  ({resolve_short_model(model)})")
    print("chat handed over : @deeps20_ — \"…10 min mein yaad dila dena assignment ka\"")
    print("streaming …\n")
    t0 = time.time()
    try:
        res = await client.chat_completion(
            messages=[{"role": "system", "content": decide_prompt},
                      {"role": "user", "content": DECIDE_CONTEXT}],
            model=model, max_tokens=max_tokens, low_think=True)
    finally:
        await client.close()
    elapsed = time.time() - t0

    raw = (res.content or "").strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"```\s*$", "", raw).strip()
    start, end = raw.find("{"), raw.rfind("}")
    parsed = None
    if start != -1 and end > start:
        try:
            parsed = json.loads(raw[start:end + 1])
        except Exception:
            parsed = None
    print("─── brain raw ───")
    print(raw or "(EMPTY!)")
    print("\n─── parsed decision ───")
    print(json.dumps(parsed, indent=2, ensure_ascii=False) if parsed else "(UNPARSEABLE)")
    print(f"\nmodel used       : {res.model} ({res.wire_model})"
          f"{'  [FALLBACK]' if res.fallback_used else ''}")
    print(f"reasoning chars  : {len(res.reasoning)}")
    print(f"elapsed          : {elapsed:.1f}s")
    print(f"usage            : {res.usage}")

    if not raw:
        print("\n❌ empty decision")
        return 1
    if not is_valid_reply_content(raw):
        print("\n❌ glitched decision (punctuation flood / no real text)")
        return 2
    if not parsed or "action" not in parsed:
        print("\n❌ decision JSON has no 'action'")
        return 3
    print("\n✅ live decision check passed")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="live llmchat.in check")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--decide", action="store_true",
                    help="v8: run the decision brain instead of the writer")
    ap.add_argument("--max-tokens", type=int, default=500)
    ap.add_argument("--low-think", dest="low_think", action="store_true", default=True)
    ap.add_argument("--no-low-think", dest="low_think", action="store_false")
    args = ap.parse_args()
    try:
        if args.decide:
            model = args.model if args.model != DEFAULT_MODEL else DEFAULT_BRAIN_MODEL
            return asyncio.run(run_decide(model, args.max_tokens))
        return asyncio.run(run(args.model, args.max_tokens, args.low_think))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
