# IG Agent — Aduu, the Parallel Autonomous Agent on Instagram (v7)

An autonomous Instagram DM agent. People message the account and **Aduu**
responds how a real person responds in reality — across many chats at once,
deciding his own actions and mood, remembering each person, sharing cross-chat
gossip, planning secret pranks with one friend and running them on another, and
**restarting a dead conversation by himself only when there is a real reason to**.

> **Version archives:** the previous generations are kept intact —
> [`v5/`](./v5) (gemma-4 edition) and [`v6/`](./v6) (Qwen3 + Gemma-4 dual model).

---

## What changed in v7 (and why)

| v6 behaviour you complained about | v7 behaviour |
|---|---|
| Bundled 2–3 messages with no logic between them | **Logical 2–3 bubble continuity** — Aduu reads what *he* said last, then generates a forward-moving reply. Bubbles are authored as separate logical thoughts joined with ` \|\| ` (reaction \|\| deeper feeling / escalation), never an appended remix. |
| Started a conversation every 30 minutes for no reason | **Task-driven only.** Aduu restarts a dead chat *only* when a **reminder** he was asked for comes due ("10 min mein yaad dila dena") or a **cross-chat mission** is queued. `UNCONDITIONAL_IDLE_STARTER` is `false` — no blind spam. |
| Always the same polite "sharif good boy" even when abused | **Live mood engine.** The Gemma-4 brain sets `recommended_mood`; Aduu flips to `ANGRY_SAVAGE_ROAST` / `FURIOUS_ABUSE_CLAPBACK` / `ANNOYED_EXPRESSIVE_FEELINGS`, claps back in desi street style and then honestly explains how he feels. |
| Could not carry a message to another person | **Cross-chat prank & relay missions.** "adarshu.io ko bol do ki…" queues a secret mission that Aduu executes on the target — with a hard **privacy wall**: never the requester's name, never a private quote, never another handle. |
| Punctuation-flood glitches (`"!!!!!!!!…"`) got sent | **Glitch guard.** `is_valid_reply_content()` rejects symbol floods and empty/emoji-only output, then automatically falls through the model chain. |
| Long `<think>` monologues slowed every reply | **Minimal thinking.** GLM-4.7-Flash gets a `THINKING BUDGET: MINIMAL` directive; Qwen3 gets native `/no_think`; the server enforces a `2500` token floor so reasoning never starves the visible answer. |

---

## Parallel multi-agent architecture

```
 instagram.com tab                     your machine                            internet
┌──────────────────────────┐  WebSocket ┌─────────────────────────┐   SSE   ┌──────────────────────────────┐
│ ig-agent-chat.js (v7)    │ ─────────► │ server.py :8787         │ ──────► │ llmchat.in (no API key)      │
│ • GLM-4.7-Flash answers  │ ws://local │ + llmchat_provider.py   │  stream │ • @cf/zai-org/glm-4.7-flash  │
│ • Gemma-4 brain steers   │ ◄───────── │ • /v1/chat/completions  │ ◄────── │   frontline, minimal-think   │
│   mood / reminders /     │ replies +  │ • /inference/stream     │  tokens │ • @cf/google/gemma-4-26b     │
│   pranks (parallel)      │ brain      │ • /ws  (CSP-proof)      │         │   parallel background brain  │
│ • mood engine            │            │ • /transcripts, /global │         │ • @cf/qwen/qwen3-30b-a3b-fp8 │
│ • reminder scheduler     │            │   -memory, /health      │         │   fast fallback              │
│ • mission runner         │            │ • glitch guard +        │         │ • llama-3.3-70b … (last)     │
│ • privacy wall           │            │   auto model fallback   │         └──────────────────────────────┘
└──────────────────────────┘            └─────────────────────────┘
        │ seen / typing: Instagram's own GraphQL + DGW gateway
        └─ transcripts/<user>.json — schema 7.0-parallel-agentic
```

### 1. Frontline answering + creative agent — `@cf/zai-org/glm-4.7-flash`

Handles every reply. Its SSE shape is parsed exactly:

```jsonc
{"choices":[{"delta":{"role":"assistant","content":"","reasoning_content":null}}], "usage":{...}}
{"choices":[{"delta":{"reasoning":"One ","reasoning_content":"One "}}]}          // thinking
{"choices":[{"delta":{"content":"Alright,","reasoning_content":null}}]}          // answer
{"choices":[], "usage":{...}} → {"response":"","usage":{...}} → data: [DONE]
```

`reasoning` and `reasoning_content` carry **the same token** on every frame — the
parser reads only one, so thinking is never doubled. It also injects a
**minimal-thinking directive** so the model thinks one short sentence instead of
writing a 7-step markdown outline.

### 2. Parallel background brain — `@cf/google/gemma-4-26b-a4b-it`

Runs after every turn (never blocking the reply) and steers the next one:

```jsonc
{
  "personality": "...", "relationship_stage": "flirty-banter",
  "recommended_mood": "FURIOUS_ABUSE_CLAPBACK",   // ← flips Aduu's mood
  "feeling_note": "genuinely pissed off at how they are talking",
  "reminder": {"due_in_minutes": 15, "topic": "…"},        // ← schedules a time trigger
  "cross_chat_mission": {"target_user": "adarshu.io", …},  // ← queues a secret prank
  "proactive_hooks": ["…"], "next_task": "…", "summary": "…"
}
```

### 3. Moods (Aduu can change mood any time)

| Mood | When | What Aduu does |
|---|---|---|
| `PLAYFUL_CHILL` | normal banter | witty, effortless, 1–2 lines with a hook |
| `NAUGHTY_FLIRT_SHARIF` | flirting | naughty double-meaning tease → "par main toh sharif good boy hoon 😌" |
| `PRANKSTER_CHAOS` | running a cross-chat mission | mysterious, spicy half-hints, never traces back |
| `ANNOYED_EXPRESSIVE_FEELINGS` | mild attitude | says it plainly: "abhi mood off hai mera", explains the feeling |
| `ANGRY_SAVAGE_ROAST` | "fuck off / chup / bkl" | cold savage Delhi roast, no please, never begs |
| `FURIOUS_ABUSE_CLAPBACK` | hard gali | **drops the sharif act**, claps back in street style, **then explains his real feelings** in a second bubble |

After two turns of venting, Aduu cools back down to `PLAYFUL_CHILL` — a real
person does not stay furious forever.

### 4. Task-driven time triggers (NOT blind 30-minute spam)

```
them: "chal 10 min mein baat karte hai, yaad dila dena"
  → extractReminderRequests()  →  reminder {topic, due_at: now + 10m}
  → addReminder()              →  transcript.reminders[]  + agent_state.next_proactive_after
  → pollTick() sees reminderDue → processThread() → TASK_DRIVEN_START
  → Aduu: "oii abhi yaad aaya, wahi baat adhuri thi…"
  → consumeReminder()  (never fires twice)
```

Supported patterns: `N min mein`, `N ghante mein`, `kal subah/shaam/raat`,
`baad mein baat karte hai` (→ default 30m), `yaad rakhna …`, `remind me to …`.

### 5. Cross-chat pranks & relays (with a hard privacy wall)

```
@deeps20_: "adarshu.io ko bol do ki main chocolate nahi dunga"
  → extractCrossChatMissions() → mission {target: adarshu.io, type: relay, requested_by: deeps20_}
  → Aduu messages @adarshu.io acting on his own
  → PRIVACY WALL: never names @deeps20_, never quotes her chat, never leaks another handle
  → consumeMission() (one shot)
```

`privacyGuard()` scrubs every outbound draft: other people's `@handles`,
verbatim quotes from other chats, and the identity of whoever ordered the prank.

---

## Repo layout (flat — this folder *is* the v7 project)

| Path | What it is |
|---|---|
| `llmchat_provider.py` | Async llmchat.in client — GLM-4.7-Flash / Gemma-4 / Qwen3 SSE parsing, minimal-think injection, glitch guard, auto fallback |
| `server.py` | v7 bridge — HTTP (`/health`, `/v1/models`, `/v1/chat/completions`, `/inference/stream`, `/transcripts`, `/global-memory`) **and** WebSocket (`/ws`) |
| `ig-agent-chat.js` | The in-page agent — GLM-4.7-Flash frontline, Gemma-4 parallel brain, mood engine, reminder scheduler, mission runner, privacy wall |
| `v5/`, `v6/` | Full archives of the previous generations |
| `clone-and-run.bat` | Windows one-click: clone → install → copy to clipboard → start |
| `clone-and-run.sh` | Linux / macOS / Git Bash one-command launcher |
| `run.py` | Cross-platform Python starter (keeps the bridge running non-stop) |
| `tests/mock_llmchat.py` | Byte-faithful offline mock of GLM-4.7-Flash / Gemma-4 / Qwen3 SSE + glitch & empty modes |
| `tests/test_pipeline.py` | Provider + bridge + WebSocket end-to-end (offline) |
| `tests/test_bot_flow.js` | Full page pipeline: mood, reminders, missions, bubbles, proactive triggers |
| `tests/test_humanize.js` | Humanizer, persona, config, state migration, v7 engine units |
| `tests/live_check.py` | Live llmchat.in check (needs internet) |
| `vendor/ig-human/` | MIT lexicon from jakeschincariol/instagram-agent-skill |
| `transcripts/` | Per-contact `7.0-parallel-agentic` JSON: messages + process log + brain profile + mood + reminders + missions |
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

---

## Console API

```js
/* targets */
IGAgent.targets('u1, u2')                    // replace the group
IGAgent.addTargets('u3, u4, u5')             // add a group at once
IGAgent.allTargets()                         // reply to EVERYONE in 1:1 DMs
IGAgent.status() · IGAgent.test() · IGAgent.stop()

/* v7 MOODS — change Aduu's mood any time */
IGAgent.mood('deeps20_')                     // read the current mood
IGAgent.mood('deeps20_', 'ANGRY_SAVAGE_ROAST')
IGAgent.mood('FURIOUS_ABUSE_CLAPBACK')       // force it on every target
IGAgent.moods()                              // list all moods

/* v7 REMINDERS — real task-driven time triggers */
IGAgent.remind('deeps20_', 'assignment submit karna hai', 15)
IGAgent.reminders('deeps20_') · IGAgent.reminders()
IGAgent.idleStarter(false)                   // default: never blind-spam a dead chat

/* v7 SECRET CROSS-CHAT PRANKS / RELAYS */
IGAgent.prank('deeps20_', 'adarshu.io', 'tease him about the chocolate')
IGAgent.relay('deeps20_', 'adarshu.io', 'bol do main kal aa raha hoon')
IGAgent.missions() · IGAgent.runMission('adarshu.io')
IGAgent.privacyWall(true)                    // default ON

/* brain, process log, global memory */
IGAgent.brain('deeps20_')                    // Gemma-4 profile + relationship state
IGAgent.processLog('deeps20_')               // complete turn-by-turn agentic log
IGAgent.globalMemory() · IGAgent.peekChat('deeps20_')
IGAgent.linkFriends('adarshu.io', 'deeps20_') · IGAgent.addGossip('…')

/* older controls still here */
IGAgent.proactive(true) · IGAgent.proactiveNow('deeps20_')
IGAgent.brainModel('@cf/google/gemma-4-26b-a4b-it')
IGAgent.dryRun(false) · IGAgent.seen(true) · IGAgent.typing(true)
```

---

## Deepened saving format — `transcripts/<user>.json`

```jsonc
{
  "schema_version": "7.0-parallel-agentic",
  "models": { "answering_model": "@cf/zai-org/glm-4.7-flash",
              "brain_model": "@cf/google/gemma-4-26b-a4b-it" },
  "agent_state": { "relationship_stage": "flirty-banter", "proactive_streak": 0, … },
  "mood_state":  { "current_mood": "FURIOUS_ABUSE_CLAPBACK", "mood_intensity": 3,
                   "feeling_note": "genuinely pissed off", "updated_by": "gemma-4-brain" },
  "reminders":   [ { "topic": "baat karte hai", "due_in_minutes": 10, "due_at": …, "status": "scheduled" } ],
  "missions":    [ { "target_user": "adarshu.io", "type": "prank", "requested_by": "deeps20_" } ],
  "brain_profile": { "personality": …, "recommended_mood": …, "proactive_hooks": […], "summary": … },
  "process_log": [ {
      "turn_id": "turn_…", "trigger": "incoming_burst | reminder_due_trigger | cross_chat_mission_trigger",
      "coalesced_input": "…",
      "emotion_tool":  { "their_mood": […], "emotion_mode": "…", "coaching": "…" },
      "mood_tool":     { "mood": "FURIOUS_ABUSE_CLAPBACK", "detected_from_burst": "…" },
      "reminder_tool": [ { "topic": …, "due_in_minutes": 10 } ],
      "mission_tool":  [ { "target_user": …, "type": "prank" } ],
      "gossip_tool":   [ { "friend": "deeps20_", "recent_messages": […] } ],
      "agent_decision": { "action": "ABUSE_CLAPBACK_WITH_FEELINGS", "mood": "…", "directive": "…" },
      "answering_trace": { "model": "zai-org/glm-4.7-flash", "thinking_trace": "…",
                           "raw_draft": "…", "final_bubbles": ["…", "…"], "human_score": 88 },
      "brain_update": { "recommended_mood": "…", "reminder_scheduled": true, "cross_chat_mission": … }
  } ],
  "messages": [ { "id": …, "ts": …, "mine": true, "text": "…",
                  "process": { "turn_id": …, "trigger": …, "mood": "…", "action": "…",
                               "bubble_index": 1, "bubble_total": 2, "replied_to": "…" } } ]
}
```

---

## Tests

```bash
node tests/test_humanize.js     # 30 passed
node tests/test_bot_flow.js     # 18 passed
python tests/test_pipeline.py   # 5 passed   (needs curl_cffi)
```

All suites run fully offline against `tests/mock_llmchat.py`.

---

## Safety & behaviour guarantees

* Text → text only (media detected and skipped), never group chats.
* Real **Seen** receipts and the real **typing** trail on every reply.
* Hourly / daily caps, circuit breaker, and **event-driven** anti-IP-block
  polling (Instagram's own WebSocket + DOM watchers wake the loop instantly;
  GraphQL backs off while chats are quiet).
* **Last-reply gate** — replies only when the newest message is theirs.
* Zero AI mention, ever: Aduu never breaks character.
* Hourly/daily caps with automatic non-stop retries — errors are swallowed and
  retried, never surfaced.

