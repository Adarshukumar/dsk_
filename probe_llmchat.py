#!/usr/bin/env python3
"""
probe_llmchat.py — find out what llmchat.in is ACTUALLY saying.

When every model starts returning empty content, guessing is useless. This
script talks to the real upstream exactly like the bridge does and prints, for
each model:

  · HTTP status
  · content-type
  · how many SSE lines arrived
  · whether content / reasoning / usage were parsed
  · the first ~600 chars of the RAW response body

That raw body is the whole point: paste it and the wire-format problem is
obvious in one look instead of hiding behind "returned empty content".

Usage
-----
    python3 probe_llmchat.py                    # probe every model in the registry
    python3 probe_llmchat.py glm-4.7-flash      # probe just one
    python3 probe_llmchat.py --raw out.txt      # also dump raw bodies to a file
    python3 probe_llmchat.py --prompt "hi"      # custom prompt text
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from llmchat_provider import (
    DEFAULT_HEADERS,
    INFERENCE_URL,
    MODEL_REGISTRY,
    LLMChatClient,
    resolve_wire_model,
)

PROBE_PROMPT = (
    "Reply with exactly this, nothing else:\n"
    "PROBE_OK"
)


async def probe_one(client: LLMChatClient, short: str, wire: str,
                    prompt: str, max_tokens: int) -> dict:
    """One live request, instrumented end to end."""
    session = await client._get_session()
    payload = {
        "model": wire,
        "messages": [
            {"role": "system", "content": "You are a tireless echo machine."},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "stream": True,
    }
    row: dict = {"short": short, "wire": wire}
    try:
        headers = dict(DEFAULT_HEADERS)
        headers["Content-Type"] = "application/json"
        resp = await session.post(
            INFERENCE_URL,
            data=json.dumps(payload),
            headers=headers,
            timeout=90,
        )
    except Exception as e:
        row["error"] = f"transport: {type(e).__name__}: {str(e)[:200]}"
        return row

    row["status"] = resp.status_code
    row["content_type"] = (resp.headers.get("content-type", "") if hasattr(
        resp, "headers") else "")
    raw = resp.text or ""
    row["raw_len"] = len(raw)
    row["lines"] = len([l for l in raw.splitlines() if l.strip()])
    row["raw_head"] = raw[:600]

    try:
        content, reasoning, usage = LLMChatClient._parse_sse(raw)
        row["content_len"] = len(content)
        row["reasoning_len"] = len(reasoning)
        row["usage"] = usage
        row["content_head"] = content[:200]
    except Exception as e:
        row["parse_error"] = f"{type(e).__name__}: {str(e)[:200]}"

    return row


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("models", nargs="*",
                    help="short model ids to probe (default: all)")
    ap.add_argument("--raw", metavar="PATH",
                    help="also write every raw body to this file")
    ap.add_argument("--prompt", default=PROBE_PROMPT,
                    help="user prompt to send")
    ap.add_argument("--max-tokens", type=int, default=64,
                    help="max_tokens to request (default 64)")
    args = ap.parse_args()

    wanted = args.models or list(MODEL_REGISTRY.keys())
    unknown = [m for m in wanted if m not in MODEL_REGISTRY]
    if unknown:
        print(f"unknown model(s): {', '.join(unknown)}")
        print(f"known: {', '.join(MODEL_REGISTRY)}")
        return 2

    client = LLMChatClient()
    print(f"endpoint : {INFERENCE_URL}")
    print(f"models   : {len(wanted)}")
    print("=" * 78)

    rows = []
    for short in wanted:
        wire = resolve_wire_model(short)
        try:
            row = await probe_one(client, short, wire, args.prompt,
                                  args.max_tokens)
        except Exception as e:
            row = {"short": short, "wire": wire,
                   "error": f"{type(e).__name__}: {str(e)[:200]}"}
        rows.append(row)

        head = f"{short}  ({wire})"
        print(head)
        print("-" * len(head))
        if row.get("error"):
            print(f"  ERROR      : {row['error']}")
        else:
            print(f"  status     : {row.get('status')}")
            print(f"  content-ty : {row.get('content_type')}")
            print(f"  raw        : {row.get('raw_len')} chars / "
                  f"{row.get('lines')} lines")
            if row.get("parse_error"):
                print(f"  PARSE ERR  : {row['parse_error']}")
            else:
                print(f"  content    : {row.get('content_len')} chars")
                print(f"  reasoning  : {row.get('reasoning_len')} chars")
                print(f"  usage      : {row.get('usage')}")
                if row.get("content_head"):
                    print(f"  says       : {row['content_head']!r}")
            if row.get("raw_head"):
                print(f"  raw head   : {row['raw_head']!r}")
            else:
                print("  raw head   : (EMPTY BODY — upstream returned nothing)")
        print()

    if args.raw:
        with open(args.raw, "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(f"\n{'=' * 70}\n{r['short']}  ({r['wire']})\n")
                fh.write(f"status={r.get('status')} "
                         f"ct={r.get('content_type', '')}\n")
                fh.write((r.get("raw_head") or "(empty)") + "\n")
        print(f"raw bodies written to {args.raw}")

    print("=" * 78)
    dead = [r["short"] for r in rows
            if r.get("error") or r.get("parse_error")
            or not (r.get("content_len") or 0)]
    if dead:
        print(f"EMPTY/BROKEN ({len(dead)}/{len(rows)}): {', '.join(dead)}")
        print("Paste the 'raw head' lines above — that is the actual upstream "
              "reply and it tells us the new wire format.")
        return 1
    print(f"ALL {len(rows)} MODEL(S) RETURNED CONTENT")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
