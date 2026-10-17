# IG Agent — Aduu on Instagram (gemma-4 edition, v5)

An Instagram DM auto-responder. People message the account and **Aduu** answers
by itself — across many chats at once, remembering each person, with real
**Seen** receipts, the real **typing indicator**, and a complete JSON transcript
of every chat. It only speaks when the **newest message in the thread is
theirs**, so it never answers itself or double-texts.

**Primary model: [`@cf/google/gemma-4-26b-a4b-it`](https://llmchat.in)**
via [llmchat.in](https://llmchat.in) — no API key. The provider handles its
`reasoning_content` stream, the bridge strips it, and the bot only ever sends
the finished answer.

```
 instagram.com tab                your machine                      internet
┌────────────────────┐ WebSocket ┌──────────────────────┐   SSE    ┌────────────────┐
│ ig-agent-chat.js   │ ────────► │ server.py :8787      │ ───────► │ llmchat.in     │
│ (console, GraphQL  │ ws://local│ + llmchat_provider.py│  stream  │ gemma-4-26b    │
│  DM + seen + typing│ ◄──────── │ fallback chain +     │ ◄─────── │ reasoning →    │
│  + transcripts)    │  replies  │ think-strip + JSON   │  tokens  │ answer, no key │
└────────────────────┘           │ transcripts          │          └────────────────┘
        │ seen/typing: Instagram's own GraphQL + DGW gateway
        └─ transcripts/: one merged JSON per contact (persona + memory + history)
```

## Repo layout (flat — this folder *is* the project)

| File | What it is |
|---|---|
| `llmchat_provider.py` | Async llmchat.in provider — SSE streaming, reasoning capture, retries |
| `server.py` | Bridge: HTTP + hand-rolled WebSocket, model fallback, think-strip, transcript store |
| `ig-agent-chat.js` | The Instagram bot — paste into the DevTools console (v5) |
| `tests/mock_llmchat.py` | Offline byte-faithful mock of the gemma-4 SSE stream |
| `tests/test_pipeline.py` | End-to-end bridge test (provider → server → HTTP → WS) |
| `tests/test_bot_flow.js` | Full page pipeline against a fake Instagram + fake bridge |
| `tests/test_humanize.js` | Humanizer / persona / state-migration tests |
| `tests/live_check.py` | Live gemma-4 check: prints reasoning vs. final answer |
| `vendor/ig-human/` | MIT lexicon from jakeschincariol/instagram-agent-skill (source of the slop list) |
| `transcripts/` | One merged JSON per contact (persona + memory + history) |
| `requirements.txt` | `curl_cffi` — the only runtime dependency |

## Why WebSocket?

Instagram's CSP **blocks all `fetch()` from the page to `http://127.0.0.1`**,
so a classic HTTP bridge can never work from an instagram.com tab. But their
CSP explicitly **allows `ws://localhost:*`**, so the bridge speaks WebSocket
(hand-rolled RFC6455 in `server.py`, no dependencies). HTTP endpoints are
still exposed for curl/other tools.

## The model: gemma-4 and its reasoning stream

`@cf/google/gemma-4-26b-a4b-it` streams **two phases** on the same SSE
response. A real capture (trimmed):

```text
data: {"choices":[{"delta":{"content":"","reasoning_content":null,"role":"assistant"},"finish_reason":null,...}],...}
data: {"choices":[{"delta":{"reasoning_content":"The"}},...]}
data: {"choices":[{"delta":{"reasoning_content":" user"}},...]}
...
data: {"choices":[{"delta":{"content":"Yo","reasoning_content":null}},...]}
data: {"choices":[{"delta":{"content":"!","reasoning_content":null}},...]}
data: {"choices":[{"delta":{"reasoning_content":null},"finish_reason":"stop"}],...}
data: {"choices":[],...}                                  ← empty keepalive
data: {"response":"","usage":{"prompt_tokens":385,"completion_tokens":250,...}}
data: [DONE]
```

What this project does with it:

- **Provider** — any `reasoning_content` chunk is wrapped in a `<think>…</think>`
  block; `content` chunks are emitted normally. Usage frames are captured so the
  bridge can log real token counts.
- **Bridge** — strips the thinking block, rejects empty answers (so the fallback
  chain retries), and gives thinking models a **3000-token floor** so reasoning
  can never crowd out the reply (the client asks for 600).
- **Fallback chain** — if gemma errors, times out or returns only reasoning:
  `gemma-4-26b → llama-3.3-70b-fast → llama-4-scout → glm-4.7-flash →
  llama-3.1-70b → qwen3-30b → llama-3.1-8b → kimi-k2.5`. `/reply` returns
  `fallback_index` so you can see when a fallback happened.
- Model names are accepted in either form: `google/gemma-4-26b-a4b-it` or
  `@cf/google/gemma-4-26b-a4b-it`.

## The Instagram layer (reverse-engineered)

Desktop web DMs no longer use `direct_v2` REST (it 404s). The bot speaks the
same GraphQL the site itself does (`POST /api/graphql`), tokens (`fb_dtsg`,
`lsd`, csrf) scraped from the page's own boot JSON.

| Operation | Friendly name | doc_id |
|---|---|---|
| inbox list | `PolarisDirectInboxQuery` | `27909866362025854` |
| thread meta | `IGDInboxHeaderOffMsysQuery` | `28784987187762419` |
| messages | `IGDMessageListOffMsysQuery` | `28798548116496168` |
| send text | `IGDirectTextSendMutation` | `26911679871773184` |
| mark read | `useIGDMarkThreadAsReadMutation` | `27399783383056109` |
| mark read (validation) | `useIGDMarkThreadAsReadValidationMutation` | `35211594988486314` |

**Seen** = those two mutations, the same pair the site fires when you open a
thread. **Typing** = the site's own `IGDMAPISendTypingIndicator` module over its
`MqttBypassDGWClient`, called through the page's `require()` registry — no
hand-rolled MQTT.

doc_ids are stable server-registered Relay operations; if one ever dies,
re-capture it with the spy technique (hook XHR/fetch in DevTools, click through
the DM UI, read the POST bodies).

## Aduu: the persona

Aduu is Adarsh's 22-year-old friend from Delhi who handles his DMs — **not
Adarsh**. The full prompt lives in `ig-agent-chat.js` under `CFG.SYSTEM_PROMPT`
and is built around one rule: text like a person, not like software.

- **No machine self-reference, ever** — the persona contains no AI/bot/model
  language at all. If someone asks who they're talking to, Aduu answers as
  Aduu ("Aduu. Adarsh ke DMs sambhalta hoon, uska dost.") and moves on.
- **Texts like a person** — 1–2 short sentences, contractions, casual Hinglish,
  no markdown/bullets/headings, at most one question, emojis only if mirrored.
- **Matches language and energy** — Hinglish → Hinglish, Hindi → Hindi,
  English → English; dry → dry, playful → tease, low → soften. A separate
  `detectLang()` hint enforces the script mix per turn.
- **Flirty in stages** — warm → playful tease → flirty push-pull → cool-down if
  not reciprocated; never explicit, never desperate; drops all flirting
  instantly if the person seems under 18; backs off on request.
- **Funny, not a joke machine** — observational or self-deprecating, one beat
  per message, never a canned quip.
- **Sells Adarsh without being pushy** — websites / automation / agents,
  promises to connect them, never invents prices or deadlines.
- **Never repeats itself** — the prompt includes the last few texts it sent in
  that chat, and a repetition detector retries once with a fresh temperature.

Voice anchors (in the prompt, as style examples — not templates):

```text
them: "kya kar raha hai"   → you: "bas tumhari yaad mein scroll kar raha tha 😏 tu bata"
them: "who are you"        → you: "Aduu. Adarsh ke DMs sambhalta hoon, uska dost. Tu bata, kahan se ho?"
them: "bore ho raha hoon"  → you: "acha? phir meri galti nahi hai, pehle batana tha 😌 batao kya scene hai"
```

Change it live with `IGAgent.prompt("...")`; cached copies of **older default**
personas are ignored after upgrades (only your own custom prompt is restored).

## Last-reply gate

`processThread()` reads the merged transcript and checks the **newest** message
before doing anything else:

```text
newest.mine === true   → do nothing. Turn is closed. No seen, no typing, no reply.
newest.mine === false  → answer their unanswered run of texts (seen → typing → reply)
```

That check runs before the LLM, the queue and the rate limits, so a stale
`localStorage` entry, a retry or a re-poll can never make the bot answer
itself. Both historical transcripts in `transcripts/` end with `mine: true`,
which is exactly the state where the bot now stays silent.

## Humanization layer (v2)

Real-model text is not the same as human texting. The pipeline is ported from
the five-check model in
[jakeschincariol/instagram-agent-skill](https://github.com/jakeschincariol/instagram-agent-skill)
(`ig-human`, MIT — lexicon vendored in `vendor/ig-human/`):

| Stage | What it does |
|---|---|
| `removeMachineTells` | invisible/bidi chars, em dashes, en dashes, curly quotes, ellipsis → plain ASCII; corporate slop from the 92-word + 58-phrase vendored lexicon |
| `humanizeReply` | strips `<think>` leaks, `Aduu:` labels, markdown, code fences, bullets, headings, links, hashtags, wrapping quotes; one paragraph; de-stutters; drops the final full stop on short DMs; cuts >300 chars at a sentence boundary |
| `checkDraft` | scores fingerprint · slop density · burstiness · specificity · voice (0–100, overall = mean×0.6 + weakest×0.4) and flags 15 structural tells without rewriting them; low scores are logged, never sent as a warning |
| `splitBubbles` | a long answer lands as **two texts** 0.7–1.8 s apart, like a person adding a second thought |
| `detectLang` | per-turn hint: Devanagari → Hinglish-in-Latin, English → mostly English, else match the mix |

The prompt is also shape-aware: `buildHistory()` injects the other person's
newest text, a reply-length band derived from **their** message length, and a
"don't greet unless they greeted you" rule. People mirror; assistants perform.

Pacing is humanized too:

- **Seen** happens after a 0.6–2.5s jitter, not instantly;
- the **typing trail** covers the whole draft, floored by reply length
  (~55ms/char, 1.5–7s) jittered ±15–20%, plus a 0.3–1.1s pause before the
  message lands, plus a fresh typing beat between bubbles;
- inbox is polled every 5–9s with jitter; double-texts merge in a 0.3–0.9s
  quiet window (max 8s), and mid-draft texts get their own reply.

## Run it

```bash
pip install -r requirements.txt   # curl_cffi, once
python server.py                  # http://127.0.0.1:8787 + ws://localhost:8787/ws
```

On any **instagram.com** tab where you're logged in → DevTools → Console →
paste all of `ig-agent-chat.js`, then:

```js
IGAgent.test()                 // session, tokens, WS, gemma-4 reply, humanizer, inbox, typing, seen, transcripts
IGAgent.targets('user1')       // who gets auto-replies (or IGAgent.allTargets())
IGAgent.start()                // DRY_RUN by default — replies logged, NOT sent
IGAgent.dryRun(false)          // flip when you trust it → real sends + seen + typing
IGAgent.say('user','hi')       // manual real send
IGAgent.typingDemo('user')     // show the typing trail for a few seconds
IGAgent.markSeenNow('user')    // mark that chat read right now
IGAgent.model('google/gemma-4-26b-a4b-it')
IGAgent.humanize(false)        // turn the humanizer off
IGAgent.transcripts()          // list local transcript state
IGAgent.stop()
```

## What the bot does by itself

- **Polls the GraphQL inbox** with human-like jitter; first poll is a baseline,
  so pre-existing backlog is never answered.
- **TRUE multi-thread** — every chat has its own cooldown, retry queue, debounce
  and memory; bridge reply workers run in parallel threads with serialized
  socket writes.
- **Only answers a live turn** — the newest message must be theirs; if ours is
  on top, the thread is left alone (no seen, no typing, no reply).
- **Marks messages Seen** the moment a new text is detected (live mode only).
- **Shows the real typing trail**, then sends the humanized reply — split into
  two bubbles when it is long.
- **Remembers each contact** — a background LLM call merges a profile (name,
  city, work, wants, language, vibe, nickname, follow-ups, safety flags) and
  injects it into every future prompt.
- **Keeps complete JSON transcripts** — incremental fetches
  (`newer_than_message_id`), merged by message id on the bridge, atomic writes.
- **Self-heals** — server: 8-model fallback chain + think-strip; client: WS
  reconnect, retry queue, circuit breaker (5 fails → 10 min pause).
- **Stays safe** — text→text only (media/reel/voice detected + skipped), never
  replies to itself or groups, hourly/daily caps (20/100), optional working
  hours, auto-stop on 429/403, and it refuses to answer until it knows which
  sender id is its own.

## Bridge API (curl-friendly)

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/transcripts
curl http://127.0.0.1:8787/transcripts/adarshu.io
curl -X POST http://127.0.0.1:8787/reply -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":600}'
curl -X POST http://127.0.0.1:8787/save -H "Content-Type: application/json" \
  -d '{"transcript":{"user":"x","messages":[{"id":"1","ts":1,"mine":false,"kind":"text","text":"hi"}]}}'
```

`POST /reply` returns `{text, model, elapsed_ms, fallback_index, reasoning_chars,
usage}`. `/v1/chat/completions` is the OpenAI-style alias. WebSocket protocol:
`{"id","type":"reply","messages":[…]}` → `{"id","ok":true,"text","model",…}`,
or `{"id","type":"save","transcript":{…}}` → `{"id","ok":true,"file",…}`.

## Transcripts (per-contact JSON)

```json
{ "user": "adarshu.io", "message_count": 25,
  "persona": "You are \"Aduu\" …", "owner_bio": "Adarsh — freelance …",
  "memory_profile": "name: … · lang: Hinglish …",
  "messages": [ { "id": "mid.$…", "ts": 1792162464934, "mine": false,
                  "kind": "text", "text": "Hey hii bro…" }, … ] }
```

The client sends its recent window; the bridge merges by message id, so nothing
is lost even if the browser cache is cleared. Browse with
`IGAgent.transcripts()` or the HTTP endpoints.

> **Privacy:** these files contain real DM text and usernames. New ones are
> git-ignored, but two historical files are still tracked in this repo. If the
> repo is public and you don't want that, run
> `git rm --cached transcripts/*.json` and purge history.

## Offline tests (no network, no Instagram)

llmchat.in is not reachable from CI/sandbox networks, so `tests/mock_llmchat.py`
replays the **exact** gemma-4 stream shape (reasoning → content → usage →
`[DONE]`).

```bash
python tests/test_pipeline.py     # provider · strip · config · fallback · HTTP + WS bridge
node   tests/test_humanize.js     # humanizer · slop lexicon · 5-check score · bubbles · persona has zero AI
node   tests/test_bot_flow.js     # gate → seen → typing → reply → humanize → bubbles → send → transcript
```

To verify the real upstream and watch gemma-4 think (run this on a machine with
internet — it prints the reasoning phase and the final answer separately):

```bash
python tests/live_check.py
```

The bridge honours `LLMCHAT_API` so you can point it at the mock:

```bash
python tests/mock_llmchat.py --port 8899
LLMCHAT_API=http://127.0.0.1:8899/inference/stream python server.py
```

## Troubleshooting

- **"Failed to fetch" from the page** — that's the CSP; the WS path handles it
  automatically. If you see WS errors, check `python server.py` is running.
- **`bridge unreachable`** — the bridge binds `127.0.0.1:8787`; start it before
  pasting the bot. Use `--host 0.0.0.0 --port …` only if you know why.
- **"tokens not found"** — reload instagram.com and re-paste (tokens are
  embedded in the page boot).
- **typing "unavailable"** — the page's module registry wasn't exposed; reload
  the tab from the inbox (not a thread URL) and re-paste. Seen still works.
- **GraphQL "missing_required_variable"** — a doc_id/variables drifted; use the
  spy technique to re-capture.
- **Everything passes but no replies** — DRY_RUN (default). Watch
  `[IGAgent:dry]` lines, then `IGAgent.dryRun(false)`.
- **Replies feel slow** — gemma thinks before it answers; that's expected. The
  typing trail intentionally covers the whole draft. If you want the fast
  fallback instead: `IGAgent.model('meta/llama-3.3-70b-instruct-fp8-fast')`.
- **Session expired** — log into Instagram again and re-paste. Targets/
  dry-run/memory/transcripts persist in `localStorage`.

## Risk note

Uses Instagram's private GraphQL endpoints and the site's own realtime gateway
from your own logged-in session, mimicking the web app's own calls. Defaults are
conservative (5–9s inbox polling, 20 replies/hour, 100/day, 60s thread
cooldown). Frequent polling can trigger Instagram rate limits, which cause the
bot to stop automatically on HTTP 429/403. Don't crank the caps.

**Impersonation:** Aduu is written to stay in character and never volunteers or
confirms a machine nature. That is what the persona was asked to do, but it
means a person can believe they are talking to a human. Run it on your own
account, tell people if they sincerely need to know, and keep the flirting
rules (no minors, back off on request) intact — they are the safety floor, not
decoration.
