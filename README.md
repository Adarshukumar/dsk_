# IG Agent Bot — llmchat.in edition (v4)

An autonomous Instagram DM chatbot. People message the account, an AI agent
answers by itself — across many chats at once, remembering each person —
with **real "Seen" receipts**, the **real typing indicator**, and a complete
**JSON transcript of every chat**.

**No API keys.** LLM power comes from [llmchat.in](https://llmchat.in)
(23 free models) via your own provider file.

```
 instagram.com tab                your machine                     internet
┌────────────────────┐ WebSocket ┌──────────────────────┐   SSE    ┌───────────┐
│ ig-agent-chat.js   │ ────────► │ server.py :8787      │ ───────► │ llmchat.in│
│ (console, GraphQL  │ ws://local│ + llmchat_provider.py│  stream  │ 23 models │
│  DM + seen + typing│ ◄──────── │ fallback chain +     │ ◄─────── │  no key   │
│  + transcripts)    │  replies  │ transcript JSON store│  tokens  └───────────┘
└────────────────────┘           └──────────────────────┘
        │ seen/typing: Instagram's own GraphQL + DGW gateway
        └─ transcripts/: one merged JSON per contact (persona + memory + history)
```

## Why WebSocket? (the v3 story)

Instagram's CSP **blocks all `fetch()` from the page to `http://127.0.0.1`** —
so a classic HTTP bridge can never work from an instagram.com tab. But their
CSP explicitly **allows `ws://localhost:*`**, so the bridge speaks WebSocket
(hand-rolled RFC6455 in server.py, no dependencies). HTTP endpoints are still
exposed for curl/other tools.

## The reverse-engineered Instagram layer

Desktop web DMs no longer use `direct_v2` REST (it 404s). The bot speaks the
same GraphQL the site itself does (`POST /api/graphql`), tokens (`fb_dtsg`,
`lsd`, csrf) scraped from the page's own boot JSON:

| Operation | Friendly name | doc_id |
|---|---|---|
| inbox list | `PolarisDirectInboxQuery` | `27909866362025854` |
| thread meta | `IGDInboxHeaderOffMsysQuery` | `28784987187762419` |
| messages | `IGDMessageListOffMsysQuery` | `28798548116496168` |
| send text | `IGDirectTextSendMutation` | `26911679871773184` |
| **mark read** | `useIGDMarkThreadAsReadMutation` | `27399783383056109` |
| **mark read (validation)** | `useIGDMarkThreadAsReadValidationMutation` | `35211594988486314` |

doc_ids are stable server-registered Relay operations; if one ever dies,
re-capture it with the spy technique (hook XHR/fetch in DevTools, click
through the DM UI, read the POST bodies).

## Seen + typing: how they really work (the v4 story)

**Read receipts ("Seen just now")** are two GraphQL mutations — the same pair
the site fires when you open a thread. The bot runs them the moment it decides
a chat has something new, before generating the reply.

**The typing indicator** cannot be published from raw MQTT on the web session
(the edge-chat broker rejects duplicate/replayed CONNECTs and silently drops
`/ig_send_message` publishes). Instead the site itself has a module for it —
`IGDMAPISendTypingIndicator` — which sends
`{"action":"indicate_activity","activity_status":1|0,"thread_id":…}` through
its own `MqttBypassDGWClient` (the `gateway.instagram.com/ws/realtime` DGW
stream). The bot calls that module through the page's `require()` registry:
zero hand-rolled protocol, the site's own authenticated channel. The typing
trail shows for a human-length time (scaled to reply length) while the reply
generates, then turns off right before sending.

## Transcripts (per-contact JSON)

Every targeted chat is kept as `transcripts/<user>.json`:

```json
{ "user": "adarshu.io", "message_count": 21,
  "persona": "You are \"Adu\" …", "owner_bio": "Adarsh — freelance …",
  "memory_profile": "name: Adarsh · lang: Hinglish …",
  "messages": [ { "id": "mid.$…", "ts": 1792162464934, "mine": false,
                  "kind": "text", "text": "Hey hii bro…" }, … ] }
```

- The client fetches **incrementally** (`newer_than_message_id`) — it never
  re-pulls full history, and its own sent replies are appended the moment IG
  confirms them.
- The bridge merges by message id, so nothing is ever lost even if the client
  restarts with an empty cache. Atomic writes, one writer at a time.
- Browse them: `curl http://127.0.0.1:8787/transcripts` and
  `curl http://127.0.0.1:8787/transcripts/<user>`, or `IGAgent.transcripts()`.

## Files

| File | What it is |
|---|---|
| `llmchat_provider.py` | Async llmchat.in provider (unchanged, the engine) |
| `server.py` | Bridge: WS channel + HTTP API + model fallback + think-strip + transcript store |
| `ig-agent-chat.js` | The Instagram bot — paste into DevTools console (v4) |
| `README.md` | This file |
| `transcripts/` | Auto-created: one JSON per contact (persona + memory + history) |

## Run it

```bash
pip install curl_cffi          # once
cd ig-agent-bot
python server.py               # leave running → http://127.0.0.1:8787 + ws://localhost:8787/ws
```

On any **instagram.com** tab where you're logged in → DevTools → Console →
paste all of `ig-agent-chat.js`, then:

```js
IGAgent.test()                 // 11 checks: tokens, WS, LLM, typing, inbox, msgs, seen ids, transcript roundtrip
IGAgent.targets('user1')       // who gets auto-replies (or IGAgent.allTargets())
IGAgent.start()                // DRY_RUN by default — replies logged, NOT sent
IGAgent.dryRun(false)          // flip when you trust it → real sends + seen + typing
IGAgent.say('user','hi')       // manual real send
IGAgent.typingDemo('user')     // show the typing trail for a few seconds (test)
IGAgent.markSeenNow('user')    // mark that chat read right now (test)
IGAgent.transcripts()          // list local transcript state
IGAgent.stop()
```

## What the bot does by itself

- **Replies like a chatbot** — persona "Adu", an honest AI agent answering
  Adarsh's DMs. Edit `IGAgent.config.SYSTEM_PROMPT` / `OWNER_BIO`.
- **Marks messages Seen** — real read receipt the moment it notices a new
  message (live mode only; DRY_RUN never leaves traces).
- **Shows the typing trail** — real "typing…" indicator for a human-length
  time before every reply.
- **Keeps complete JSON transcripts** — per contact: persona, memory profile
  and full history, merged on the bridge, browsable over HTTP.
- **True multi-thread** — every chat independent and parallel: own cooldown,
  own retry queue, own debounce (5–12s quiet-window, 35s max), while bridge
  reply jobs run concurrently.
- **Memory per contact** — after each reply it silently extracts/updates a
  profile (name, work, wants, language, follow-ups owed) in `localStorage`
  and injects it into future replies. `IGAgent.memory('user')` / `.forget()`.
- **Falls back by itself** — server: 7-model chain (fast llama-3.3-70b first,
  kimi last since it's dead upstream); `<think>` stripping. Client: WS
  auto-reconnect, retry queue, circuit breaker (5 fails → 10 min pause).
- **Safety** — text→text only (media/reel/voice detected + skipped), never
  replies to itself or groups, backlog ignored (baseline on first poll),
  hourly/daily caps (20/100), working hours option, auto-stop on 429/403.
- **Fast-react pipeline** — inbox checked every 5–9s; a new message is marked
  **Seen** within seconds and the **typing trail turns on immediately and
  stays on for the entire draft**, switching off exactly when the reply lands.
- **Human-like pacing** — inbox polled with jitter, never overlapping;
  per-thread 60s cooldown after a reply; double-texts merge in a ~0.3–0.9s
  quiet window (or requeue while a draft is in flight).

## Bridge API (curl-friendly)

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/transcripts
curl http://127.0.0.1:8787/transcripts/adarshu.io
curl -X POST http://127.0.0.1:8787/reply -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":100}'
curl -X POST http://127.0.0.1:8787/save -H "Content-Type: application/json" \
  -d '{"transcript":{"user":"x","messages":[{"id":"1","ts":1,"mine":false,"kind":"text","text":"hi"}]}}'
```
`POST /v1/chat/completions` is the OpenAI-style alias. WebSocket protocol:
send `{"id","type":"reply","messages":[…]}` → `{"id","ok":true,"text","model"}`,
or `{"id","type":"save","transcript":{…}}` → `{"id","ok":true,"file",…}`.

## Troubleshooting

- **"Failed to fetch" from the page** — that's the CSP; the WS path handles
  it automatically. If you see WS errors, check `python server.py` is running.
- **"tokens not found"** — reload instagram.com and re-paste (tokens are
  embedded in the page boot).
- **typing "unavailable"** — the page's module registry wasn't exposed; reload
  the tab from the inbox (not a thread URL) and re-paste. Seen still works.
- **GraphQL "missing_required_variable"** — a doc_id/variables drifted; use
  the spy technique to re-capture.
- **Everything passes but no replies** — DRY_RUN (default). Watch
  `[IGAgent:dry]` lines, then `IGAgent.dryRun(false)`.
- **Session expired** — log into Instagram again and re-paste. Targets/
  dry-run/memory/transcripts persist in `localStorage`.

## Risk note

Uses Instagram's private GraphQL endpoints and the site's own realtime
gateway from your own logged-in session, mimicking the web app's own calls.
Defaults are conservative (inbox polled every 5–9s, 20 replies/hour,
100/day, 60s thread cooldown). Don't crank the caps.
Frequent polling can trigger Instagram rate limits, which cause the bot to
stop automatically on HTTP 429/403.
