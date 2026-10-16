# IG Agent Bot — llmchat.in edition (v3)

An autonomous Instagram DM chatbot. People message the account, an AI agent
answers by itself — across many chats at once, remembering each person.

**No API keys.** LLM power comes from [llmchat.in](https://llmchat.in)
(23 free models) via your own provider file.

```
 instagram.com tab                your machine                     internet
┌────────────────────┐ WebSocket ┌──────────────────────┐   SSE    ┌───────────┐
│ ig-agent-chat.js   │ ────────► │ server.py :8787      │ ───────► │ llmchat.in│
│ (console, GraphQL  │ ws://local│ + llmchat_provider.py│  stream  │ 23 models │
│  DM layer + WS)    │ ◄──────── │ fallback chain +     │ ◄─────── │  no key   │
└────────────────────┘  replies  │ <think> stripping    │  tokens  └───────────┘
```

## Why WebSocket? (the v3 story)

Instagram's CSP **blocks all `fetch()` from the page to `http://127.0.0.1`** —
so a classic HTTP bridge can never work from an instagram.com tab. But their
CSP explicitly **allows `ws://localhost:*`**, so the bridge speaks WebSocket
(hand-rolled RFC6455 in server.py, no dependencies). HTTP endpoints are still
exposed for curl/other tools.

## The reverse-engineered Instagram layer

Desktop web DMs no longer use `direct_v2` REST (it 404s). v3 speaks the same
GraphQL the site itself does (`POST /api/graphql`), tokens (`fb_dtsg`, `lsd`,
csrf) scraped from the page's own boot JSON:

| Operation | Friendly name | doc_id |
|---|---|---|
| inbox list | `PolarisDirectInboxQuery` | `27909866362025854` |
| thread meta | `IGDInboxHeaderOffMsysQuery` | `28784987187762419` |
| messages | `IGDMessageListOffMsysQuery` | `28798548116496168` |
| send text | `IGDirectTextSendMutation` | `26911679871773184` |

doc_ids are stable server-registered Relay operations; if one ever dies,
re-capture it with the spy technique (hook XHR/fetch in DevTools, click
through the DM UI, read the POST bodies).

## Files

| File | What it is |
|---|---|
| `llmchat_provider.py` | Async llmchat.in provider (unchanged, the engine) |
| `server.py` | Bridge: WS channel + `POST /reply` + OpenAI alias, model fallback, think-strip |
| `ig-agent-chat.js` | The Instagram bot — paste into DevTools console (v3) |
| `README.md` | This file |

## Run it

```bash
pip install curl_cffi          # once
cd ig-agent-bot
python server.py               # leave running → http://127.0.0.1:8787 + ws://localhost:8787/ws
```

On any **instagram.com** tab where you're logged in → DevTools → Console →
paste all of `ig-agent-chat.js`, then:

```js
IGAgent.test()                 // 8 checks: tokens, WS, LLM, inbox, meta, messages
IGAgent.targets('user1')       // who gets auto-replies (or IGAgent.allTargets())
IGAgent.start()                // DRY_RUN by default — replies logged, NOT sent
IGAgent.dryRun(false)          // flip when you trust it
IGAgent.say('user','hi')       // manual real send
IGAgent.stop()
```

## What the bot does by itself

- **Replies like a chatbot** — persona "Adu", an honest AI agent answering
  Adarsh's DMs. Edit `IGAgent.config.SYSTEM_PROMPT` / `OWNER_BIO`.
- **True multi-thread** — every chat independent and parallel: own cooldown,
  own retry queue, own debounce (5–12s quiet-window, 35s max).
- **Memory per contact** — after each reply it silently extracts/updates a
  profile (name, work, wants, language, follow-ups owed) in `localStorage`
  and injects it into future replies. `IGAgent.memory('user')` / `.forget()`.
- **Falls back by itself** — server: 7-model chain (fast llama-3.3-70b first,
  kimi last since it's dead upstream); `<think>` stripping. Client: WS
  auto-reconnect, retry queue, circuit breaker (5 fails → 10 min pause).
- **Safety** — text→text only (media/reel/voice detected + skipped), never
  replies to itself or groups, backlog ignored (baseline on first poll),
  hourly/daily caps (20/100), working hours option, auto-stop on 429/403.
- **Fast inbox checks** — checks the inbox every 500 ms without overlapping
  requests; slow requests finish before the next check begins.

## Bridge API (curl-friendly)

```bash
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/reply -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":100}'
```
`POST /v1/chat/completions` is the OpenAI-style alias. WebSocket protocol:
send `{"id","type":"reply","messages":[...]}` → `{"id","ok":true,"text","model"}`.

## Troubleshooting

- **"Failed to fetch" from the page** — that's the CSP; v3 uses the WebSocket
  path automatically. If you see WS errors, check `python server.py` is running.
- **"tokens not found"** — reload instagram.com and re-paste (tokens are
  embedded in the page boot).
- **GraphQL "missing_required_variable"** — a doc_id/variables drifted; use
  the spy technique to re-capture.
- **Everything passes but no replies** — DRY_RUN (default). Watch
  `[IGAgent:dry]` lines, then `IGAgent.dryRun(false)`.
- **Session expired** — log into Instagram again and re-paste. Targets/
  dry-run/memory persist in `localStorage`.

## Risk note

Uses Instagram's private GraphQL endpoints from your own logged-in session,
mimicking the web app's own calls. The inbox is checked every 500 ms; the
reply limits remain conservative (20 replies/hour, 100/day, 60s thread
cooldown). Frequent polling can trigger Instagram rate limits, which cause the
bot to stop automatically on HTTP 429/403.
