# IG Agent — Aduu, the Brain-First Autonomous Agent on Instagram (v8)

An autonomous Instagram DM agent. People message the account and **Aduu**
responds how a real person responds in reality — across many chats at once,
remembering each person, sharing cross-chat gossip, planning secret pranks with
one friend and running them on another, and **restarting a dead conversation by
himself only when there is a real reason to**.

> **v8 — the brain decides everything.**
> The Gemma-4 brain is handed the **actual incoming chat messages** and returns
> one strict JSON decision that owns the entire turn: reply or stay silent,
> live mood and *why*, how many bubbles and what each one must do, reminders the
> person asked for, secret cross-chat pranks, gossip, the privacy verdict and
> the steer for the next turn. GLM-4.7-Flash then **only writes** what the brain
> decided. Every side-effect has to cite the chat line that caused it, so the
> **chat messages are what make Aduu do the thing** — never a timer, never a
> hard-coded rule. The old local regexes survive only as the fallback used when
> the brain is unreachable.

> **Version archives:** the previous generations are kept intact —
> [`v5/`](./v5) (gemma-4 edition) and [`v6/`](./v6) (Qwen3 + Gemma-4 dual model).

---

## What changed in v8 (and why)

| v7 behaviour | v8 behaviour |
|---|---|
| Local rules (`agentDecide`) picked the action from regexes on the burst | **`decideTurn()` asks the Gemma-4 brain first.** It reads the real messages and returns the action, mood, bubble plan, reminders, missions, gossip and privacy verdict as one JSON object. Local rules only run if the brain call fails. |
| The brain ran *after* the turn and merely suggested things for next time | The brain runs **before** every reply and is the decision maker; the post-turn brain pass only refreshes memory and the next-turn steer (and may never stomp on the mood the decision brain just chose). |
| Only the writer model saw the plan | The decision is injected into the writer prompt as `[THE BRAIN DECIDED THIS TURN — WRITE EXACTLY THIS PLAN]`, including `my_last` so the reply **moves forward instead of repeating**. |
| Aduu always answered any burst | The brain can decide **`STAY_SILENT`** and leave a dead burst on seen, like a real person (`BRAIN_ALLOW_SILENCE`). |
| Reminders / pranks came from local regex extraction | Reminders and secret cross-chat missions now come from the brain **with an `evidence` field** — a quote from their message. Anything that cannot be traced back to the chat is **thrown away** (`evidenceScore()` gate). |
| Decisions were invisible | Every turn logs `brain_decision` in the process log, `last_decision` at the top of the transcript, and `IGAgent.why('user')` prints the last decision in the console. `/v1/decide` exposes it over REST. |

Everything from v7 is kept: task-driven time triggers (no blind 30-minute
spam), the six-mood engine, the privacy wall, logical `||` multi-bubble
continuity, minimal thinking, and the glitch guard.

---

## Brain-first architecture

```
 instagram.com tab                     your machine                            internet
┌──────────────────────────┐  WebSocket ┌─────────────────────────┐   SSE   ┌──────────────────────────────┐
│ ig-agent-chat.js (v8)    │ ─────────► │ server.py :8787         │ ──────► │ llmchat.in (no API key)      │
│                          │ ws://local │ + llmchat_provider.py   │  stream │ • @cf/google/gemma-4-26b     │
│ 1. BRAIN DECIDES         │            │ • /v1/decide  (brain)   │         │   THE DECISION MAKER         │
│    decideTurn()          │ ◄───────── │ • /v1/chat/completions  │ ◄────── │ • @cf/zai-org/glm-4.7-flash  │
│    → JSON decision       │ decisions  │ • /inference/stream     │  tokens │   the WRITER, minimal-think  │
│ 2. GLM-4.7-Flash WRITES  │ replies +  │ • /ws  (CSP-proof)      │         │ • @cf/qwen/qwen3-30b-a3b-fp8 │
│    exactly that plan     │ brain      │ • /transcripts, /global │         │   fast fallback              │
│ 3. brain updates memory  │            │   -memory, /health      │         │ • llama-3.3-70b … (last)     │
│                          │            │ • glitch guard +        │         └──────────────────────────────┘
│ • mood / reminder /      │            │   auto model fallback   │
│   mission engines        │            └─────────────────────────┘
│ • privacy wall           │
└──────────────────────────┘
        │ seen / typing: Instagram's own GraphQL + DGW gateway
        └─ transcripts/<user>.json — schema 8.0-brain-decides
```

### The decision contract (what the brain answers)

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
  "steer_next": "one line of coaching for Aduu's next turn"
}
```

**The evidence gate** — `reminder` / `cross_chat_mission` are only accepted when
`evidenceScore(evidence, their_messages) >= 0.4` (or `>= 0.34` when they named the
target handle outright). A decision the chat does not support is dropped. That is
what makes the system **message-driven** instead of hallucination-driven.

### The writer prompt the brain produces

```
[THE BRAIN DECIDED THIS TURN — WRITE EXACTLY THIS PLAN]
WHAT THEY MEANT: they went quiet and are poking Aduu for a reaction
WHAT YOU ALREADY SAID (never repeat or remix it): Aduu teased them about the chocolates
YOUR ONE JOB THIS TURN: tease back and leave a hook
STAY ON THIS TOPIC: their last message
MOOD: PLAYFUL_CHILL — witty, flirty-teasy, effortless…
SEND EXACTLY 2 BUBBLE(S). Each one is a DIFFERENT forward step —
never a rephrase of the one before:
  1. tease them about going quiet
  2. ask what they are really up to
Join the bubbles with " || ". Never repeat a line you already sent in this chat.
```

---

## Models

| Role | Model | Job |
|---|---|---|
| **Decision brain** (boss) | `@cf/google/gemma-4-26b-a4b-it` | Decides the whole turn from the chat messages; afterwards refreshes the privacy-safe memory and the next-turn steer. |
| **Frontline writer** | `@cf/zai-org/glm-4.7-flash` | Writes the Hinglish bubbles the brain planned, with `THINKING BUDGET: MINIMAL` so it thinks one short sentence. |
| Fast fallback | `@cf/qwen/qwen3-30b-a3b-fp8` (then llama-3.3-70b …) | Automatic, on glitch / empty / HTTP 500. |

GLM-4.7-Flash streams `delta.reasoning`/`reasoning_content` first, then
`delta.content`, and ends with `{"response":"", "usage":{…}}` + `data: [DONE]`.
Both `reasoning` and `reasoning_content` carry the **same token** on every frame
— the parser reads only one, so thinking is never doubled.

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

After two turns of venting, Aduu cools back down to `PLAYFUL_CHILL` — a real
person does not stay furious forever. In v8 the mood is chosen by the brain with
a quoted `mood_reason`, and you can still force one with `IGAgent.mood(...)`.

---

## Task-driven time triggers (NOT blind 30-minute spam)

```
them: "chal 10 min mein baat karte hai, yaad dila dena"
  → brain DECISION: reminder {topic, due_in_minutes: 10, evidence: "yaad dila dena"}
  → applyBrainDecision() → transcript.reminders[] + agent_state.next_proactive_after
  → pollTick() sees reminderDue → processThread() → brain decides START_CONVO
  → Aduu: "oii abhi yaad aaya, wahi baat adhuri thi…"
  → consumeReminder()  (never fires twice)
```

Supported patterns: `N min mein`, `N ghante mein`, `kal subah/shaam/raat`,
`baad mein baat karte hai` (→ default 30m), `yaad rakhna …`, `remind me to …`.
With no reminder and no mission queued, Aduu **stays quiet on purpose** —
`UNCONDITIONAL_IDLE_STARTER` is `false`.

## Cross-chat pranks & relays (with a hard privacy wall)

```
@deeps20_: "adarshu.io ko bol do ki main chocolate nahi dunga"
  → brain DECISION: cross_chat_mission {target: adarshu.io, type: relay, evidence: "…ko bol do"}
  → Aduu messages @adarshu.io acting on his own
  → PRIVACY WALL: never names @deeps20_, never quotes her chat, never leaks another handle
  → consumeMission() (one shot)
```

`privacyGuard()` scrubs every outbound draft, and the brain's `privacy_ok: false`
verdict switches the gossip/leak paths off for that turn.

---

## Repo layout (flat — this folder *is* the v8 project)

| Path | What it is |
|---|---|
| `llmchat_provider.py` | Async llmchat.in client — GLM-4.7-Flash / Gemma-4 / Qwen3 SSE parsing, minimal-think injection, glitch guard, auto fallback |
| `server.py` | v8 bridge — HTTP (`/health`, `/v1/models`, `/v1/chat/completions`, `/inference/stream`, **`/v1/decide`**, `/transcripts`, `/global-memory`) **and** WebSocket (`/ws` with `reply` / `brain` / **`decide`**) |
| `ig-agent-chat.js` | The in-page agent — brain-first decision engine, mood engine, reminder scheduler, mission runner, privacy wall, GLM writer |
| `v5/`, `v6/` | Full archives of the previous generations |
| `clone-and-run.bat` | Windows one-click: clone → install → copy to clipboard → start |
| `clone-and-run.sh` | Linux / macOS / Git Bash one-command launcher |
| `run.py` | Cross-platform Python starter (keeps the bridge running non-stop) |
| `tests/mock_llmchat.py` | Byte-faithful offline mock of GLM-4.7-Flash / Gemma-4 / Qwen3 SSE + **decision brain** + glitch & empty modes |
| `tests/test_pipeline.py` | Provider + bridge + WebSocket + `/v1/decide` end-to-end (offline) |
| `tests/test_bot_flow.js` | Full page pipeline: brain decisions, moods, reminders, missions, bubbles, proactive triggers, fallback |
| `tests/test_humanize.js` | Humanizer, persona, config, state migration, v7/v8 engine units |
| `tests/live_check.py` | Live llmchat.in check (needs internet) |
| `vendor/ig-human/` | MIT lexicon from jakeschincariol/instagram-agent-skill |
| `transcripts/` | Per-contact `8.0-brain-decides` JSON: messages + process log + **last decision** + brain profile + mood + reminders + missions |
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
/* ── v8 · THE BRAIN ── */
IGAgent.why('deeps20_')          // the brain's last JSON decision + its evidence line
IGAgent.decide('deeps20_')       // ask the brain to decide that chat right now (sends nothing)
IGAgent.brainMode(false)         // fall back to the old local rules
IGAgent.brainSilence(false)      // never let the brain leave a burst unanswered

/* targets */
IGAgent.targets('u1, u2')                    // replace the group
IGAgent.addTargets('u3, u4, u5')             // add a group at once
IGAgent.allTargets()                         // reply to EVERYONE in 1:1 DMs
IGAgent.status() · IGAgent.test() · IGAgent.stop()

/* MOODS — change Aduu's mood any time */
IGAgent.mood('deeps20_')                     // read the current mood
IGAgent.mood('deeps20_', 'ANGRY_SAVAGE_ROAST')
IGAgent.mood('FURIOUS_ABUSE_CLAPBACK')       // force it on every target
IGAgent.moods()                              // list all moods

/* REMINDERS — real task-driven time triggers */
IGAgent.remind('deeps20_', 'assignment submit karna hai', 15)
IGAgent.reminders('deeps20_') · IGAgent.reminders()
IGAgent.idleStarter(false)                   // default: never blind-spam a dead chat

/* SECRET CROSS-CHAT PRANKS / RELAYS */
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

## Bridge API

| Endpoint | What it does |
|---|---|
| `GET /health` | models, endpoints, `brain_decides`, `decide_endpoint`, fallback chain |
| `GET /v1/models` | the 8-model registry with thinking/context flags |
| `POST /v1/chat/completions` | OpenAI-compatible completion (thinking-budget floor enforced) |
| `POST /inference/stream` | Raw SSE passthrough |
| `POST /v1/decide` | **Ask the brain to decide a turn.** Body `{messages, context?}` → `{decision, decision_valid, raw, model, thinking_trace}` |
| `GET /transcripts` · `GET,POST /transcripts/<user>` | per-contact JSON round-trip |
| `GET,POST /global-memory` | social graph, contacts, cross-chat gossip |
| `WS /ws` | `health` · `bot` · `reply` (GLM) · `brain` (Gemma-4 memory pass) · **`decide`** (Gemma-4 decision) · `save` · `save_global` · `get_global` |

---

## Saved format — `transcripts/<user>.json`

```jsonc
{
  "schema_version": "8.0-brain-decides",
  "models": { "answering_model": "@cf/zai-org/glm-4.7-flash",
              "brain_model": "@cf/google/gemma-4-26b-a4b-it" },
  "agent_state": { "relationship_stage": "flirty-banter", "proactive_streak": 0, … },
  "mood_state":  { "current_mood": "FURIOUS_ABUSE_CLAPBACK", "mood_intensity": 3,
                   "feeling_note": "genuinely pissed off",
                   "updated_by": "gemma-4-brain-decide" },
  "reminders":   [ { "topic": "baat karte hai", "due_in_minutes": 10, "due_at": …,
                     "status": "scheduled", "evidence": "yaad dila dena", "evidence_score": 1 } ],
  "missions":    [ { "target_user": "adarshu.io", "type": "prank", "requested_by": "deeps20_" } ],
  "brain_profile": { "personality": …, "recommended_mood": …, "proactive_hooks": […], "summary": … },
  "last_decision": { "action": "REPLY", "mood": "PLAYFUL_CHILL", "bubble_count": 2, … },
  "process_log": [ {
      "turn_id": "turn_…", "trigger": "incoming_burst | reminder_due_trigger | cross_chat_mission_trigger",
      "coalesced_input": "…",
      "emotion_tool":  { "their_mood": […], "emotion_mode": "…", "coaching": "…" },
      "mood_tool":     { "mood": "FURIOUS_ABUSE_CLAPBACK", "detected_from_burst": "…" },
      "reminder_tool": [ { "topic": …, "due_in_minutes": 10, "evidence": "…", "evidence_score": 1 } ],
      "mission_tool":  [ { "target_user": …, "type": "prank", "evidence": "…" } ],
      "gossip_tool":   [ { "friend": "deeps20_", "recent_messages": […] } ],
      "agent_decision": { "action": "BRAIN_REPLY", "mood": "…", "decided_by": "gemma-4-brain",
                          "directive": "…" },
      "brain_decision": { "action": "REPLY", "understand": "…", "my_last": "…",
                          "next_move": "…", "mood": "…", "mood_reason": "their abuse",
                          "feeling_note": "…", "bubble_count": 2, "bubble_plan": ["…", "…"],
                          "topic_lock": "…", "use_gossip": false, "privacy_ok": true,
                          "steer_next": "…", "brain_model": "google/gemma-4-26b-a4b-it" },
      "answering_trace": { "model": "zai-org/glm-4.7-flash", "thinking_trace": "…",
                           "raw_draft": "…", "final_bubbles": ["…", "…"], "human_score": 88 },
      "brain_update": { "recommended_mood": "…", "reminder_scheduled": true, "cross_chat_mission": … }
  } ],
  "messages": [ { "id": …, "ts": …, "mine": true, "text": "…",
                  "process": { "turn_id": …, "trigger": …, "mood": "…", "action": "BRAIN_REPLY",
                               "bubble_index": 1, "bubble_total": 2, "replied_to": "…" } } ]
}
```

---

## Tests

```bash
node tests/test_humanize.js     # 30 passed
node tests/test_bot_flow.js     # 28 passed
python tests/test_pipeline.py   # 5 passed   (needs curl_cffi)
```

All suites run fully offline against `tests/mock_llmchat.py`, which also
impersonates the v8 decision brain.

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
* Zero AI mention, ever: Aduu never breaks character.
* Errors are swallowed and retried, never surfaced — it runs non-stop.
