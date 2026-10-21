# IG Agent — Aduu, the Autonomous Social Brain on Instagram (v10)

An autonomous Instagram agent. People message the account and **Aduu** responds
how a real person responds in reality — and the same brain also runs the whole
account's social life: it watches the story tray, reacts to a story when one
deserves it, comments on a post, answers a comment on Aduu's own post, sends a
DM out of the blue, and writes the **Instagram NOTE**.

> **v10 — one brain, the whole account, and it never goes silently dead.**
> The Gemma-4 brain is the single decision maker. For every DM turn it returns a
> strict JSON decision that owns that turn — **including the human pacing of the
> reply**. On a slow social cycle it returns a strict JSON plan that owns the
> account. GLM-4.7-Flash only **writes** what the brain decided.
>
> **Resilient by design.** v9 died silently when llmchat.in changed: every model
> returned empty content and nobody could tell why. v10 fixes the root cause
> (see [What changed in v10](#what-changed-in-v10)), makes every failure
> diagnosable in the log, and — if the whole upstream really is down — still
> answers like a human instead of leaving the person hanging.
>
> **Rare by design.** A real person scrolls past almost everything. The social
> brain observes every 45–120 minutes, and the runtime lets at most **one**
> public action per cycle through, with per-person cooldowns (story replies
> 14h, comments 8h), daily caps (3 comments, 2 story replies, 4 notes) and
> quiet hours. Doing nothing is the default and the correct answer most times.
>
> **Chats never collide.** Three locks guard every outgoing line: no other
> contact's `@handle`, no verbatim line from another person's chat, and every
> social action declares the single audience that will see it.

> **v10.2 — it stops when Instagram says stop.** Instagram rate-limits by
> returning **HTTP 200** with `errors:[{message:"Rate limit exceeded"}]`. v10.1
> did not recognise that at all, counted every one of them as an *LLM* failure,
> and retried on a flat 3–6 s loop. The result was a permanent ~1 request/second
> hammer that kept the account rate-limited forever. v10.2 adds a global request
> **pacer** and an **escalating cooldown** 60 s → 2 m → 5 m → 10 m → 15 m, and
> keeps Instagram failures out of the LLM circuit breaker.

> **Version archives:** [`v5/`](./v5) and [`v6/`](./v6) hold the previous
> generations. The story/comment/notes primitives were ported in from the
> experimental `arena/71d3f44b-dsk` branch and rebuilt brain-first here.

---

## What changed in v10.1 — the actual outage fix

> **Correction:** in v10 I blamed the two-`system`-message payload. **That
> diagnosis was wrong.** It was a plausible theory (the `decide` path really
> was the only caller sending two system messages, and the hardening is still
> worth keeping) but it was not the cause — v10.0 shipped and production was
> *still* 100% empty. The real cause is below, and it is visible in the log
> v10's new raw-body diagnostic captured.

### Root cause: llmchat.in wraps every response in `{"result": …}`

The upstream changed its wire format. It still sends
`Content-Type: text/event-stream`, but the body is now a single
**non-streaming** completion object inside an envelope:

```jsonc
// OLD — what the parser was written for
data: {"choices":[{"delta":{"content":"hi"}}],"usage":{…}}
data: [DONE]

// NEW — what actually arrives
{"result":{"choices":[{"finish_reason":"stop","index":0,"logprobs":null,
  "message":{"annotations":null,"audio":null,"content":"hi",
  "function_call":null,"reasoning":null,"refusal":null,"role":"assistant"}}],
  "created":1792508047,"id":"chatcmpl-x","model":"@cf/google/gemma-4-26b-a4b-it",
  "object":"chat.completion","usage":{…}}}
```

Two changes at once: everything is under `result`, and it is a `message`
object (non-streaming) rather than a `delta` stream. `packet.get("choices")`
returned `None` because `choices` had moved one level down, every branch fell
through, and the parser handed back `("", "", {})`.

**The models were never broken.** They were returning perfect JSON decisions
and natural Hinglish replies the whole time. We simply could not read them,
and reported it as *"returned empty content (reasoning=0 chars)"* — which then
burned all 7 models in the fallback chain for every single message.

| | v10.1 |
|---|---|
| `{"result": …}` envelope | `_unwrap_envelope()` peels `result` / `data` / `output` / `completion` / `body` / `payload` / `response`, recursively, until the real object is found. |
| Non-streaming `message` object | Extracted from `choices[].message` as well as `choices[].delta`. |
| A future format change would look identical to a dead model | If a body carries text but nothing is extracted, the bridge logs **"UNRECOGNISED RESPONSE FORMAT … This is a PARSER bug, not an empty model: fix `_parse_sse()`"** with the body. Never again will a parser gap be mistaken for a slow model. |
| One `decide` took **231 seconds** (14 calls × a ~50 s curl timeout) | Hard wall-clock budget on the whole chain (`IG_CHAIN_BUDGET_S`, default 40 s). When it expires the chain stops and the safe fallback answers. Per-request timeout is now `IG_HTTP_TIMEOUT_S` (default 30 s). |
| Latency getting worse as the chain burned | Retry token growth is capped **relative to what was asked** — a 900-token decision can no longer creep to 4096. |

### v10.1 · the backlog gate — history is never answered again

Chat history gets lost constantly: cleared browser storage, a deleted or
trimmed transcript, or the handled-set hitting its 2000-id cap. The messages
refetch, and **every old inbound message looks brand new** — Aduu would
suddenly answer a conversation from two days ago, which no real person does.

Two independent guards, both persisted:

1. **High-water mark** — `S.highWater[tid]` is the newest inbound timestamp
   already absorbed (answered, skipped, or seen on first contact). Anything at
   or below it is history, *whatever happened to the handled-set*. One number
   per thread, saved to `localStorage` and into each transcript, and
   deliberately not gated on the targets version.
2. **Freshness on first contact** — the very first time a thread is seen, a
   message older than `MAX_BACKLOG_AGE_MS` (45 min, tunable via
   `IGAgent.backlogWindow(n)`) is read as history and absorbed silently.

The gate lives **only** in the branch that answers messages — never in the
proactive branch, so reminders and secret cross-chat missions still fire. It
is bypassed by manual turns (`IGAgent.say()`, `forceProactive`).

```
[backlog] @testuser: absorbed 4 existing message(s) — first contact · newest
          message is 1291 min old (history, not a new message)
[backlog] @testuser: absorbed 4 existing message(s) — already read up to 2:54:07 PM
```

---

## What changed in v10.2 — it stops hammering Instagram

### The symptom

The console was an endless loop, for **all five targets at once**:

```
[IGAgent:queue] @adarshu.io: retrying (IG GQL: Rate limit exceeded) — retry in 4s
[IGAgent:queue] @deeps20_:    retrying (IG GQL: Rate limit exceeded) — retry in 4s
[IGAgent:queue] @adarshu.io: LLM circuit breather — retry in 2s
[IGAgent:queue] @deeps20_:    LLM circuit breather — retry in 2s
… forever, every few seconds, on every target
```

Nothing was broken about the LLM. The "LLM circuit breather" lines were a
**lie** — they were Instagram failures wearing an LLM label.

### Root cause 1 — Instagram rate-limits with HTTP 200, not 429

```json
HTTP/1.1 200 OK
{"errors":[{"message":"Rate limit exceeded"}],"status":"fail"}
```

`res.status` was `200`, so the existing `if (res.status === 429 || 403)` branch
never ran. The error surfaced as a plain `Error('IG GQL: Rate limit exceeded')`
with **no** `fatal` flag and **no** rate-limit marker, so the retry path could
not tell a rate limit from a genuine failure.

Fixed: `isRateLimitMessage()` matches Instagram's wording (`rate limit`,
`too many requests`, `please wait`, `try again later`, `slow down`, `throttl`)
and the throw is now tagged `{ fatal: false, rateLimited: true }`.

### Root cause 2 — Instagram failures were counted as LLM failures

The single `catch` in `processThread` did `S.llmFailStreak++` on *every*
failure. Ten of them and the circuit breaker tripped — for `CIRCUIT_COOLDOWN_MS`
= **5 seconds** — logging `LLM circuit breather`, then immediately retrying
straight back into the same rate limit.

Fixed: the catch now has two branches.

| | behaviour |
|---|---|
| `e.rateLimited` | `S.tries[tid] = 0` (a rate limit is not a failed attempt), wait `max(retryAfterMs, 5s) + rand(0, 10s)`, log `Instagram rate limit — backing off Ns`, **never touches `llmFailStreak`** |
| genuine failure | exponential backoff `min(RETRY_BASE_MS · 2^n, RETRY_MAX_MS) · rand(.85, 1.15)` — 4 s → 8 s → 16 s … → 5 min cap |

### Root cause 3 — no pacing at all, and the first poll fired everything at once

Five targets × a flat `rand(3s, 6s)` retry is a sustained ~1 req/s. And on the
very first poll all of them went out together.

Fixed: `BASELINE_STAGGER_MS` spreads the first sweep, and **every** Instagram
call now goes through one choke point.

### The pacer

```
                    ┌─ cooldown active? ──► throw {rateLimited, retryAfterMs}   (no network)
every IG call  ──►  ├─ serialize on RL.queue (no burst can leave at once)
                    ├─ min gap IG_MIN_GAP_MS + jitter between calls
                    └─ success?  ──► reset the escalation ladder
                        rate limited? ──► pause EVERYTHING, escalate the ladder
```

| knob | default | what it does |
|---|---|---|
| `IG_MIN_GAP_MS` | `900` | minimum gap between two Instagram calls |
| `IG_GAP_JITTER_MS` | `700` | random spread on top of that gap |
| `IG_COOLDOWN_STEPS_MS` | `[60s, 120s, 300s, 600s, 900s]` | the escalation ladder |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | `4s` / `300s` | genuine-failure backoff |
| `BASELINE_STAGGER_MS` | `2500` | spacing of the first sweep across targets |

The ladder only relaxes when calls start succeeding again (`igNoteSuccess()`),
so a persistent rate limit walks itself up to a 15-minute pause instead of
sitting at 60 s forever.

**The social brain shares it.** The REST calls (`/api/v1/feed/reels_tray/`,
profile lookups) used to bypass the pacer entirely — so the story tray kept
hammering the same rate-limited account while the DM side was politely backing
off. They now go through the same choke point, and a rate limit there rests the
social brain for 3 hours instead of being mislabelled `fatal`.

### What it looks like when it happens

```
[IGAgent:ig]    Instagram rate limit — all Instagram calls paused for 60s
                (strike 1/5). This is Instagram protecting the account, not a bug.
[IGAgent:queue] @deeps20_: Instagram rate limit — backing off 61s — retry in 61s
[IGAgent:queue] @adarshu.io: Instagram rate limit — backing off 64s — retry in 64s
```

…then silence. That silence is the fix. `IGAgent.igStatus()` tells you so:

```
> IGAgent.igStatus()
{ coolingFor: '47s', until: '2:04:03 PM', strikes: '1/5', nextPause: '120s',
  minGapMs: 900, pollsHeld: false,
  queued: [ { user: 'deeps20_', retryIn: '48s', why: 'Instagram rate limit — backing off 61s' } ] }
```

`IGAgent.status()` now reports the same thing under `instagram`, and the retry
queue entries carry `retryIn` + `why` so a 60-second pause is never mistaken
for a hung bot.

---

## What changed in v10

This is the **outage triage** release — everything below is real hardening,
but note the root cause turned out to be the envelope above, not the payload
shape. Symptom in production:

```
14:10:01 [WARNING] Model @cf/google/gemma-4-26b-a4b-it returned empty content (reasoning=0 chars) on attempt 1
14:10:12 [WARNING] ... attempt 2
14:10:23 [WARNING] Model @cf/zai-org/glm-4.7-flash returned empty content (reasoning=0 chars) on attempt 1
14:10:32 [WARNING] ... attempt 2
```

`reasoning=0 chars` on **every** model meant the upstream was answering with a
`200` whose body yielded neither content nor reasoning — and two things made it
unrecoverable.

| Root cause / gap | v10 |
|---|---|
| The `decide` path sent TWO `system` messages — the page's own contract *and* the server-injected one. It was the only call in the system that did this. (Not the root cause, as v10.0 proved — but two system messages are genuinely fragile with some chat templates, so the hardening stays.) | `_merge_system_messages()` collapses **every** run of `system` messages into exactly one, in the provider, before anything goes on the wire. The server also no longer stacks its contract on top of the page's. |
| **The failure was invisible.** `chat_completion()` never logged the status code, content-type, or the raw body — so nobody could see *what* had changed. | Every empty stream now logs the model, `max_tokens`, temperature, message count, **content-type** and the **first 600 chars of the raw body**, with a SHA so repeat bodies are collapsed to one line. |
| A wire-format change turned into `("", "")` — indistinguishable from a slow model. | `_parse_sse()` now also reads bare-JSON frames (no `data:` prefix), `delta:` keys, top-level `message` / `delta` / `text` / `output_text` objects, and **raises** on `{"success": false, "error": …}` instead of masquerading as empty. |
| The whole chain dead ⇒ **nothing happened** and the person waited forever. | A dead brain returns a **safe synthesized decision** (`REPLY`, neutral mood, 1 bubble, human pacing, `privacy_ok`, no invented tasks) — and a dead *social* brain returns `observe` with **zero actions**. Never a blind DM or comment. |
| A 700-token decision asked for a 2500-token think budget, and retries inflated it to 4096. | Decisions use `DECIDE_THINK_BUDGET` (900); retries grow proportionally and are capped relative to what was asked. |
| No way to see whether the brain was healthy. | `/health` and `IGAgent.brainStatus()` report `brain_status`: `ok`, `degraded`, `last_error`, `decisions`, `last_ok_ago_s`. |
| **Timing was still hard-coded** — seen delay, typing duration and bubble gaps were random constants. | The brain owns the pacing: `"timing": {"seen_delay_s", "typing_s", "bubble_gap_s"}`, clamped to human bounds, chosen from the mood. |

### Diagnosing the next upstream change

```bash
python probe_llmchat.py                 # probe every model, print status + raw body
python probe_llmchat.py --raw out.txt   # also dump the raw bodies to a file
python probe_llmchat.py glm-4.7-flash   # one model only
```

For each model it prints HTTP status, content-type, SSE line count, parsed
content/reasoning lengths, and the raw response. **Paste the raw body and the
wire-format problem is obvious.**

You can also reproduce every failure mode locally with the offline mock:

```bash
python tests/mock_llmchat.py --port 8899 --silent-all     # every model empty
python tests/mock_llmchat.py --port 8899 --challenge      # HTML interstitial
python tests/mock_llmchat.py --port 8899 --error-packet   # {"success":false}
python tests/mock_llmchat.py --port 8899 --bare-json      # no `data:` prefix
LLMCHAT_BASE_URL=http://127.0.0.1:8899 python server.py
```

---

## What changed in v9

| Before | v9 |
|---|---|
| DM brain + a separate experimental "social agent" with its own hard-coded prompts and cadence | **One brain.** The same Gemma-4 decision maker handles DM turns *and* the account's social life, with one consistent personality. |
| Story handling proxied a post | **Real story tray** — `GET /api/v1/feed/reels_tray/` lists who has a live story and its media id, and the brain reacts to the actual story. |
| Every social scan acted on everything it found | **Rarity gates.** Cooldowns per (kind, target), daily caps, quiet hours, a minimum 3h gap between public actions, and one action per cycle. The brain "wants"; the runtime "allows". |
| Cross-chat leakage was possible | **Isolation engine.** `isolationGuard()` + `collisionCheck()` strip foreign handles and verbatim lines from other chats; actions that still leak are **dropped, not sent**. |
| Notes were an experimental extra | **First-class NOTE power** — `IGAgent.note()`, `IGAgent.notes()`, `IGAgent.deleteNote()`, `IGAgent.noteNow()` — and the brain writes/replaces/deletes the note by itself, ≤60 chars. |
| Social activity was invisible | Every cycle is reflected into `transcripts/_social_brain.json`: what the brain saw, what it decided, what the gate allowed, what it did. |

Everything from v8 is kept: brain-first DM turns, the evidence gate, moods,
task-driven reminders, secret cross-chat pranks, the privacy wall, logical
`||` multi-bubble continuity, minimal thinking and the glitch guard.

---

## Architecture

```
 instagram.com tab                     your machine                            internet
┌──────────────────────────┐  WebSocket ┌─────────────────────────┐   SSE   ┌──────────────────────────────┐
│ ig-agent-chat.js (v10)   │ ─────────► │ server.py :8787         │ ──────► │ llmchat.in (no API key)      │
│                          │ ws://local │ + llmchat_provider.py   │  stream │ • @cf/google/gemma-4-26b     │
│  ONE BRAIN, TWO LOOPS    │            │ • /v1/decide  (brain)   │         │   THE DECISION MAKER         │
│                          │            │ • /v1/chat/completions  │ ◄────── │ • @cf/zai-org/glm-4.7-flash  │
│  A · DM TURN LOOP        │ decisions  │ • /inference/stream     │  tokens │   the WRITER, minimal-think  │
│    per contact, instant  │ replies +  │ • /ws  (CSP-proof)      │         │ • @cf/qwen/qwen3-30b-a3b-fp8 │
│  B · SOCIAL LOOP         │ brain      │ • /transcripts          │         │   fast fallback              │
│    account-wide, 45-120m │ ◄───────── │ • /global-memory        │         │ • llama-3.3-70b … (last)     │
│                          │            │ • /social-brain (diary) │         └──────────────────────────────┘
│ ISOLATION ENGINE         │            │ • glitch guard +        │
│  handle · quote ·        │            │   auto model fallback   │
│  audience locks          │            └─────────────────────────┘
└──────────────────────────┘
   │ Instagram surface: GraphQL DM + notes tray + comments,
   │ private REST: story tray · user feed · media comments
   └─ transcripts/<user>.json (10.0-brain-resilient) + _social_brain.json (diary)
```

---

## A · The DM turn decision (+ v10 `timing`)

```jsonc
{
  "action": "REPLY" | "STAY_SILENT" | "START_CONVO",
  "understand":  "what their messages actually mean",
  "my_last":     "what Aduu already said — so the reply moves forward, never repeats",
  "next_move":   "the single new thing this reply must accomplish",
  "mood":        "PLAYFUL_CHILL | NAUGHTY_FLIRT_SHARIF | PRANKSTER_CHAOS |
                  ANNOYED_EXPRESSIVE_FEELINGS | ANGRY_SAVAGE_ROAST | FURIOUS_ABUSE_CLAPBACK",
  "mood_reason": "the exact line from their messages that caused this mood",
  "feeling_note":"how Aduu genuinely feels right now",
  "bubble_count": 2,
  "bubble_plan": ["tease them about going quiet", "ask what they are really up to"],
  "topic_lock":  "the exact topic the reply must stay on",
  "reminder":            null | {"topic": "…", "due_in_minutes": 10, "evidence": "yaad dila dena"},
  "cross_chat_mission":  null | {"target_user": "adarshu.io", "type": "prank",
                                 "instruction": "…", "evidence": "adarshu.io ko bol do"},
  "use_gossip": false,
  "privacy_ok": true,
  "timing": {"seen_delay_s": 2, "typing_s": 4, "bubble_gap_s": 2},
  "steer_next": "one line of coaching for Aduu's next turn"
}
```

**v10 · the brain owns the pacing.** A real friend is not instantly available
and does not type at a constant speed, so `timing` is decided from the mood and
their message — eager/hyped is fast, ANNOYED/ANGRY/FURIOUS is slow and heavy,
teasing leaves a deliberate pause before the punchline.

| field | range | what it controls |
|---|---|---|
| `seen_delay_s` | 0–45 | seconds before their message shows as seen. `0` = replied instantly; bigger = Aduu was busy, is making them wait, or is sulking. |
| `typing_s` | 1–25 | seconds the typing bubble is up. Long for a serious reply, short for a one-liner. |
| `bubble_gap_s` | 1–8 | seconds between bubbles when more than one is sent. |

Values are clamped to those bounds (absurd numbers are not trusted), and when
the field is missing the runtime falls back to a natural random jitter — with
heavy moods waiting longer than light ones by default.

The **evidence gate**: a reminder or secret prank is accepted only when it
quotes a line the person actually sent (`evidenceScore ≥ 0.4`). Decisions the
chat does not support are thrown away — the messages are what make Aduu act.

---

## B · The social brain (v9, unchanged)

### The loop it designed for itself

```
1 · OBSERVE   notes tray · live story tray · watched people's latest posts
              unanswered comments on Aduu's own posts · privacy-safe DM pulse
2 · PLAN      the brain returns ONE strict JSON plan (usually mode = "observe")
3 · GATE      cooldowns · daily caps · quiet hours · one action per cycle
4 · ISOLATE   every line is audience-checked before it can leave
5 · ACT       note · story reply · comment · comment reply · DM
6 · REFLECT   the whole cycle is written to _social_brain.json
```

### The plan JSON

```jsonc
{
  "mode": "observe" | "act",
  "intent": "one line on what Aduu is feeling about the account right now",
  "skip_reason": "why you are doing nothing (required when mode is observe)",
  "actions": [
    { "kind": "note",         "op": "keep" | "replace" | "delete",
      "text": "chai, code aur thodi si shanti ☕", "reason": "old note is 5h old" },
    { "kind": "story_reply",  "target": "deeps20_", "story_pk": "341…",
      "text": "oye ye kahan ghoomne nikla hai 😏", "reason": "fresh story, 10 min old" },
    { "kind": "comment",      "target": "adarshu.io", "media_pk": "341…",
      "text": "ye shot kahan ka hai bhai 🔥", "reason": "new post, 2h old" },
    { "kind": "comment_reply","target": "somefan", "media_pk": "341…", "comment_pk": "178…",
      "text": "haan bhai, pura tutorial aa raha hai", "reason": "they asked how" },
    { "kind": "dm",           "target": "deeps20_",
      "text": "oye sun, ek baat yaad aayi teri 👀", "reason": "3 days quiet" }
  ],
  "next_check_in_minutes": 75
}
```

### The rarity gate (why it is "not always, so less times")

| Rule | Value |
|---|---|
| Observe/plan cadence | 45–120 min (the brain also suggests `next_check_in_minutes`) |
| Actions allowed per cycle | **1** |
| Note change cooldown | 4 h |
| Comment cooldown (per person) | 8 h |
| Comment-reply cooldown | 2 h |
| Story reply cooldown (per person) | **14 h** |
| Out-of-the-blue DM cooldown | 6 h |
| Minimum gap between public actions | 3 h |
| Daily caps | notes 4 · comments 3 · replies 6 · story replies 2 · DMs 2 |
| Quiet hours | 02:00–09:00 IST — never acts |

Nothing runs until you call `IGAgent.Social.enable()`, and even then
`DRY_RUN` is on until you flip it off.

### What the brain sees each cycle

```
TIME: evening (20:00 IST) — evening chill / chai-gedi / high-energy teasing
MODE: DRY RUN (nothing is really sent)

ADUU'S NOTE: chai aur code ☕ (posted 320 min ago)
OTHER PEOPLE'S NOTES:
  @deeps20_: assignment kar raha hoon

LIVE STORY TRAY (you can react to these):
  @deeps20_ · 12m old · pk=341…

WATCHED PEOPLE:
  @deeps20_: latest post 5h old · "shaam ki chai aur coding ☕" · 12 comments · pk=341…
      dm: last from them 47m ago · mood PLAYFUL_CHILL
      your last action: story_reply 62h ago

WHAT ADUU DID IN THE LAST 24H: note=1
DAILY LIMITS LEFT: note 3/4 · comment 3/3 · comment_reply 6/6 · story_reply 2/2 · dm 2/2
```

The DM pulse carries **mood and timing only** — never a verbatim line from
someone else's chat, so the account-wide view can never become a leak source.

---

## Chat isolation — chats never collide

```
1 · HANDLE LOCK    no other contact's @handle (or bare handle) in an outgoing line
2 · CONTENT LOCK   no verbatim sentence another contact actually wrote
3 · AUDIENCE LOCK  every action names the one person who will see it, and the
                   text is re-checked against that audience
4 · LOCK           one decision at a time per person (withLock), so two brain
                   runs can never interleave on the same contact
```

```js
isolationGuard('haan wahi, @deeps20_ ne bola tha na 😏', 'adarshu.io')
// → "haan wahi, ek dost ne bola tha na 😏"        (handle scrubbed, logged)

isolationGuard('kal raat party mein kya hua tha?', 'adarshu.io')
// → scrubbed when that exact line belongs to @deeps20_'s chat

collisionCheck({kind:'comment', target:'adarshu.io', text:'yeh @deeps20_ wali baat…'})
// → { ok:false, problems:['mentions @deeps20_'] } → the action is DROPPED
```

The DM path runs `privacyGuard()` **and** `isolationGuard()` on every draft
before it is sent.

---

## The NOTE (new power)

Instagram's note is the 60-character bubble on top of the inbox. Aduu can put a
nice one up, take it down, and — by default — let the brain manage it.

```js
IGAgent.note('chai, code aur thodi si shanti ☕')  // put a note up right now
IGAgent.notes()                                    // read the whole tray (mine + theirs)
IGAgent.deleteNote()                               // take it down
IGAgent.noteNow()                                  // ask the brain for one note decision
IGAgent.Social.notes('agentic' | 'off')            // brain-managed or manual only
```

Brain-managed notes are capped at 4 changes/day with a 4h cooldown, and the
brain's own rule is *"the note is your mood status, not an advertisement —
change it only when it is stale or your mood genuinely shifted."*

---

## Models

| Role | Model | Job |
|---|---|---|
| **Decision brain** (boss) | `@cf/google/gemma-4-26b-a4b-it` | Decides every DM turn and every social cycle; refreshes memory and next-turn steer afterwards. |
| **Frontline writer** | `@cf/zai-org/glm-4.7-flash` | Writes the Hinglish lines the brain planned, with `THINKING BUDGET: MINIMAL`. |
| Fast fallback | `@cf/qwen/qwen3-30b-a3b-fp8` (then llama-3.3-70b …) | Automatic, on glitch / empty / HTTP 500. |

---

## Moods (Aduu can change mood any time)

| Mood | When | What Aduu does |
|---|---|---|
| `PLAYFUL_CHILL` | normal banter | witty, effortless, 1–2 lines with a hook |
| `NAUGHTY_FLIRT_SHARIF` | flirting | naughty double-meaning tease → "par main toh sharif good boy hoon 😌" |
| `PRANKSTER_CHAOS` | running a cross-chat mission | mysterious, spicy half-hints, never traces back |
| `ANNOYED_EXPRESSIVE_FEELINGS` | mild attitude | says it plainly: "abhi mood off hai mera", explains the feeling |
| `ANGRY_SAVAGE_ROAST` | "fuck off / chup / bkl" | cold savage Delhi roast, no please, never begs |
| `FURIOUS_ABUSE_CLAPBACK` | hard gali | **drops the sharif act**, claps back in street style, **then explains his real feelings** in a second bubble |

After two turns of venting, Aduu cools back down to `PLAYFUL_CHILL`.

## Task-driven time triggers (NOT blind 30-minute spam)

```
them: "chal 10 min mein baat karte hai, yaad dila dena"
  → brain DECISION: reminder {topic, due_in_minutes: 10, evidence: "yaad dila dena"}
  → pollTick() sees reminderDue → processThread() → brain decides START_CONVO
  → Aduu: "oii abhi yaad aaya, wahi baat adhuri thi…"
  → consumeReminder()  (never fires twice)
```

With no reminder and no mission queued, Aduu **stays quiet on purpose** —
`UNCONDITIONAL_IDLE_STARTER` is `false`.

---

## Repo layout (flat — this folder *is* the v10 project)

| Path | What it is |
|---|---|
| `llmchat_provider.py` | Async llmchat.in client — GLM-4.7-Flash / Gemma-4 / Qwen3 SSE parsing, minimal-think injection, glitch guard, auto fallback |
| `server.py` | v10 bridge — HTTP (`/health`, `/v1/models`, `/v1/chat/completions`, `/inference/stream`, `/v1/decide`, **`/social-brain`**, `/transcripts`, `/global-memory`) **and** WebSocket (`/ws` with `reply` / `brain` / `decide` / **`save_social`** / **`get_social`**) |
| `ig-agent-chat.js` | The in-page agent — one Gemma-4 brain (DM turns + social loop), GLM writer, isolation engine, mood engine, reminder scheduler, mission runner, notes |
| `v5/`, `v6/` | Full archives of the previous generations |
| `clone-and-run.bat` | Windows one-click: clone → install → copy to clipboard → start |
| `clone-and-run.sh` | Linux / macOS / Git Bash one-command launcher |
| `run.py` | Cross-platform Python starter (keeps the bridge running non-stop) |
| `probe_llmchat.py` | **v10** · hits the real llmchat.in and prints each model's HTTP status, content-type and RAW body — use it when the upstream changes |
| `tests/mock_llmchat.py` | Offline mock of GLM-4.7-Flash / Gemma-4 / Qwen3 SSE + the decision brain, plus the v10 outage modes (`--silent-all`, `--challenge`, `--error-packet`, `--bare-json`, `--delta-key`, `--message-obj`) |
| `tests/test_pipeline.py` | Provider + bridge + WebSocket + `/v1/decide` + social-brain diary (offline) |
| `tests/test_resilience.py` | **v10.1** · the outage suite — the `result` envelope, every wire shape, unrecognised-format detection, single-system-message rule, chain latency budget, dead-brain fallbacks, brain health |
| `tests/test_bot_flow.js` | Full page pipeline: brain decisions, isolation, rarity gates, notes, stories, moods, reminders, missions |
| `tests/test_humanize.js` | Humanizer, persona, config, state migration, engine units |
| `tests/live_check.py` | Live llmchat.in check (`--decide` for the brain) |
| `vendor/ig-human/` | MIT lexicon from jakeschincariol/instagram-agent-skill |
| `transcripts/` | Per-contact `10.0-brain-resilient` JSON + `_global_memory.json` + **`_social_brain.json`** |
| `requirements.txt` | `curl_cffi` — the only runtime dependency |

---

## Quick start

```bash
git clone -b arena/d05a574d-dsk https://github.com/Adarshukumar/dsk_.git
cd dsk_

# Windows
clone-and-run.bat
# Linux / macOS
bash clone-and-run.sh
# or
python run.py
```

Then on any **logged-in instagram.com** tab, open DevTools → Console and paste
the one-liner the launcher prints:

```js
(()=>{const w=new WebSocket('ws://localhost:8787/ws');w.onopen=()=>w.send('{"id":"b","type":"bot"}');w.onmessage=e=>{eval(JSON.parse(e.data).code);w.close()}})()
```

It auto-starts **LIVE** with the default targets `adarshu.io` and `deeps20_`
(`DRY_RUN: false`, `AUTO_START: true`, no timeouts — it runs non-stop).
The social brain stays **off** until you enable it.

---

## Console API

```js
/* ── v9 · SOCIAL BRAIN ── */
IGAgent.Social.enable()                  // turn it on (dry-run first!)
IGAgent.Social.dryRun(false)             // when you trust it
IGAgent.Social.watch('deeps20_', 'adarshu.io')   // who it may engage with
IGAgent.Social.commentTargets('deeps20_')        // whose posts may get a comment
IGAgent.Social.storyTargets('deeps20_')          // whose stories may get a reaction
IGAgent.Social.commentReplies(true)              // answer comments on my posts
IGAgent.Social.notes('agentic')                  // brain writes the note ('off' = manual)
IGAgent.Social.plan()                    // what would the brain do right now? (no side effects)
IGAgent.Social.now()                     // run one full cycle now
IGAgent.Social.status() · .log()         // caps, last actions, cycle diary
IGAgent.Social.stories() · .feed('u') · .comments(pk) · .tray()
IGAgent.Social.comment(pkOrUrl, 'text') · .replyToComment(mediaPk, commentPk, 'text')
IGAgent.Social.storyReact('deeps20_', 'oye ye kahan 😏')
IGAgent.Social.disable()

/* ── NOTES ── */
IGAgent.note('chai, code aur thodi si shanti ☕')   // put a nice note up
IGAgent.notes() · IGAgent.deleteNote() · IGAgent.noteNow()

/* ── v8 · BRAIN ── */
IGAgent.why('deeps20_')          // the brain's last JSON decision + its evidence line
IGAgent.decide('deeps20_')       // ask the brain to decide that chat right now
IGAgent.backlogWindow(45)         // v10.1 · first-contact freshness window (min)
IGAgent.resetBacklog('deeps20_')  // v10.1 · forget how far we read that thread
IGAgent.igStatus()                // v10.2 · the Instagram pacer: cooldown, strikes, retry queue
IGAgent.holdPolls()               // v10.2 · pause the background sweep (keep state)
IGAgent.releasePolls()            // v10.2 · resume it
IGAgent.brainStatus()            // v10 · is the decision brain actually answering?
                                 //   → {ok, degraded, last_error, decisions, last_ok_ago_s, ...}
IGAgent.brainMode(false)         // fall back to the old local rules
IGAgent.brainSilence(false)      // never let the brain leave a burst unanswered

/* targets */
IGAgent.targets('u1, u2') · IGAgent.addTargets('u3, u4') · IGAgent.allTargets()
IGAgent.status() · IGAgent.test() · IGAgent.stop()

/* MOODS */
IGAgent.mood('deeps20_') · IGAgent.mood('deeps20_', 'ANGRY_SAVAGE_ROAST') · IGAgent.moods()

/* REMINDERS (task-driven, never blind spam) */
IGAgent.remind('deeps20_', 'assignment submit karna hai', 15) · IGAgent.reminders()
IGAgent.idleStarter(false)

/* SECRET CROSS-CHAT PRANKS / RELAYS */
IGAgent.prank('deeps20_', 'adarshu.io', 'tease him about the chocolate')
IGAgent.relay(...) · IGAgent.missions() · IGAgent.runMission('adarshu.io')
IGAgent.privacyWall(true)

/* brain, process log, global memory */
IGAgent.brain('deeps20_') · IGAgent.processLog('deeps20_')
IGAgent.globalMemory() · IGAgent.peekChat('deeps20_')
IGAgent.linkFriends('adarshu.io', 'deeps20_') · IGAgent.addGossip('…')
```

---

## Bridge API

| Endpoint | What it does |
|---|---|
| `GET /health` | models, endpoints, `brain_decides`, `decide_endpoint`, `social_brain` |
| `GET /v1/models` | the 8-model registry with thinking/context flags |
| `POST /v1/chat/completions` | OpenAI-compatible completion (thinking-budget floor enforced) |
| `POST /inference/stream` | Raw SSE passthrough |
| `POST /v1/decide` | **Ask the brain to decide a DM turn** → `{decision, decision_valid, raw, model}` |
| `GET,POST /social-brain` | **The social brain's diary** — cycles, action log, note log, config |
| `GET /transcripts` · `GET,POST /transcripts/<user>` | per-contact JSON round-trip |
| `GET,POST /global-memory` | social graph, contacts, cross-chat gossip |
| `WS /ws` | `health` · `bot` · `reply` (GLM) · `brain` (memory pass) · `decide` (brain) · **`save_social`** · **`get_social`** · `save` · `save_global` · `get_global` |

---

## Saved format

### `transcripts/<user>.json` — schema `10.0-brain-resilient`

```jsonc
{
  "schema_version": "10.0-brain-resilient",
  "models": { "answering_model": "@cf/zai-org/glm-4.7-flash",
              "brain_model": "@cf/google/gemma-4-26b-a4b-it" },
  "agent_state": { "relationship_stage": "flirty-banter", "proactive_streak": 0, … },
  "mood_state":  { "current_mood": "FURIOUS_ABUSE_CLAPBACK", "mood_intensity": 3,
                   "feeling_note": "genuinely pissed off",
                   "updated_by": "gemma-4-brain-decide" },
  "reminders":   [ { "topic": "baat karte hai", "due_in_minutes": 10,
                     "evidence": "yaad dila dena", "evidence_score": 1 } ],
  "missions":    [ { "target_user": "adarshu.io", "type": "prank", "requested_by": "deeps20_" } ],
  "brain_profile": { … }, "last_decision": { … },
  "process_log": [ { "turn_id": …, "trigger": …, "agent_decision": { "decided_by": "gemma-4-brain" },
                     "brain_decision": { … }, "answering_trace": { … } } ],
  "messages": [ { "text": "…", "process": { "action": "BRAIN_REPLY", … } } ]
}
```

### `transcripts/_social_brain.json` — schema `10.0-brain-resilient-log`

```jsonc
{
  "schema_version": "10.0-brain-resilient-log",
  "updated_at": "2026-10-21T…",
  "config": { "enabled": true, "dry_run": false, "notes_mode": "agentic",
              "watch": ["deeps20_"], "comment_targets": [], "story_targets": ["deeps20_"] },
  "action_log": [ { "kind": "story_reply", "target": "deeps20_", "text": "oye ye kahan 😏",
                    "reason": "fresh story, 10 min old", "status": "sent" } ],
  "note_log":   [ { "text": "chai, code aur thodi si shanti ☕", "reason": "…", "op": "replace" } ],
  "cycles": [ {
      "at": …, "iso_time": "…", "status": "completed", "decided_by": "gemma-4-brain",
      "observation_chars": 1420,
      "plan": { "mode": "act", "intent": "…", "actions": [ … ] },
      "outcome": [ { "kind": "note", "status": "dry_run", "note": "would set \"…\"" },
                   { "kind": "story_reply", "status": "deferred", "reason": "cycle_action_limit" } ],
      "next_check_in_minutes": 80
  } ]
}
```

---

## Tests

```bash
node tests/test_humanize.js        #  32 passed
node tests/test_bot_flow.js        #  73 passed
python tests/test_pipeline.py      #   5 passed   (needs curl_cffi)
python tests/test_resilience.py    #  18 passed   ← the outage suite
```

**128 tests, fully offline** against `tests/mock_llmchat.py`, which also
impersonates the decision brain.

`tests/test_bot_flow.js` also carries the **v10.2 rate-limit suite** — 13 tests
that fail against the pre-v10.2 code. It reproduces the exact bug at the wire
level: a fake Instagram that answers `HTTP 200 + {errors:[{message:"Rate limit
exceeded"}]}` for the per-thread message fetch while the inbox keeps working,
five targets, and a 12-second window.

Before v10.2 that logged **25 Instagram calls in 20 s** and never stopped.
The suite asserts:

- Instagram's HTTP-200 wording is recognised — and a genuine failure is not
- the throw is tagged `rateLimited`, never `fatal`
- one rate limit pauses **all** Instagram calls for at least 30 s
- during the cooldown **zero** requests leave the browser
- the cooldown **escalates** (60 s → 120 s → 300 s …) and resets on success
- an HTTP 429 gets the same treatment
- an Instagram rate limit does **not** move `llmFailStreak` — the bug that
  produced the bogus `LLM circuit breather` lines
- a rate-limited thread requeues **minutes** out, not 4 seconds
- five rate-limited targets make ≤ 6 calls in 12 s
- the social **REST** path shares the same cooldown and sends nothing during it

`tests/test_resilience.py` exists so the v10 outage can never come back
silently. It asserts, at the wire level, that:

- **the exact production `{"result": …}` body parses** (byte-for-byte fixture)
- every known wire shape parses, and no text-bearing body ever parses to empty
- an unrecognised shape is logged as a **parser bug**, never as an empty model
- N `system` messages collapse to exactly **1** before any upstream call
- the server never double-injects the decide contract
- a hopeless chain respects its wall-clock budget (was 231 s, now bounded)
- the parser survives bare-JSON, `delta:` keys, `message` objects and HTML
- an upstream `{"success": false}` **raises** instead of looking empty
- an empty stream logs the model + content-type + raw body
- a totally dead brain still returns a usable DM decision
- a totally dead social brain observes and does **nothing**
- a healthy brain carries **no** fallback flags
- decisions ask for a small think budget, replies keep the big one
- an HTML interstitial fails fast
- the 500/glitch fallback chain still works

### Reproducing the outage locally

```bash
# the CURRENT upstream format (what production really sends)
python tests/mock_llmchat.py --port 8899 --live

# a totally dead upstream
python tests/mock_llmchat.py --port 8899 --silent-all

LLMCHAT_BASE_URL=http://127.0.0.1:8899 IG_BRIDGE_PORT=8787 python server.py
# then paste ig-agent-chat.js into Instagram, or:
curl -X POST localhost:8787/v1/decide -H 'Content-Type: application/json' \
     -d '{"messages":[{"role":"user","content":"bol na"}]}'
# → {"decision":{"action":"REPLY", ...}, "_fallback": true, ...}
#   and /health reports brain_status.degraded = true
```

---

## Safety & behaviour guarantees

* Text → text only (media detected and skipped), never group chats.
* Real **Seen** receipts and the real **typing** trail on every reply.
* Hourly / daily caps, circuit breaker, and **event-driven** anti-IP-block
  polling (Instagram's own WebSocket + DOM watchers wake the loop instantly;
  GraphQL backs off while chats are quiet).
* **Last-reply gate** — replies only when the newest message is theirs.
* **Evidence gate** — the brain's reminders and pranks must be traceable to a
  line the person actually sent.
* **Isolation gate** — no handle, no quote, no private line ever crosses chats.
* **Backlog gate** — lost chat history is re-read, never re-answered. A
  per-thread high-water mark plus a first-contact freshness window mean Aduu
  cannot resurrect a conversation from days ago.
* **Rarity gate** — the social brain is capped, cooled down and quiet at night.
* **One-system-message rule** — no request ever puts two `system` messages on
  the wire, so a template that drops them cannot silently kill the brain.
* **Dead-brain gate** — if every upstream model returns nothing, the reply is
  still human (or the social cycle does nothing at all). **Never** a blind DM,
  comment or note, and **never** an invented reminder or prank.
* **Diagnosable failures** — every empty stream is logged with the model, the
  content-type and the raw body, and `/health` carries `brain_status`.
* Zero AI mention, ever: Aduu never breaks character.
* Errors are swallowed and retried, never surfaced — it runs non-stop.
