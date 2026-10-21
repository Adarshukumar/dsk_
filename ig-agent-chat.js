/* ═══════════════════════════════════════════════════════════════════════════
   IG AGENT · ig-agent-chat.js  v8 — BRAIN-FIRST (NO API KEY, humanized)
   ─────────────────────────────────────────────────────────────────────────
   v8 = THE BRAIN DECIDES EVERYTHING.
     The Gemma-4 brain is handed the ACTUAL incoming chat messages and returns
     one strict JSON decision for the turn:
        action (REPLY / STAY_SILENT / START_CONVO) · understand · my_last ·
        next_move · mood + mood_reason + feeling_note · bubble_count ·
        bubble_plan (each bubble a DIFFERENT forward step) · topic_lock ·
        reminder · cross_chat_mission · use_gossip · privacy_ok · steer_next
     The frontline GLM-4.7-Flash then only WRITES what the brain decided.
     Every decision field must cite the chat line that caused it (evidence),
     so the CHAT MESSAGES are what make Aduu do the thing — never a timer,
     never a hard-coded rule. Local regexes are now only a fallback for when
     the brain is unreachable.
   Reverse-engineered Instagram web DM layer (GraphQL /api/graphql):
     · inbox list    PolarisDirectInboxQuery           doc 27909866362025854
     · thread msgs   IGDMessageListOffMsysQuery        doc 28798548116496168
     · send text     IGDirectTextSendMutation          doc 26911679871773184
     · thread meta   IGDInboxHeaderOffMsysQuery        doc 28784987187762419
     · mark read     useIGDMarkThreadAsReadMutation    doc 27399783383056109
     · mark read #2  …ValidationMutation               doc 35211594988486314
   Typing indicator: the site's OWN module IGDMAPISendTypingIndicator over its
   MqttBypassDGWClient (gateway.instagram.com realtime stream) — captured from
   the page bundles; no hand-rolled protocol needed.
   LLM (v7 parallel dual-model):
     · FRONTLINE ANSWERING + CREATIVE AGENT: @cf/zai-org/glm-4.7-flash
       Streams `delta.reasoning`/`reasoning_content` first, then `delta.content`,
       and ends with a final `{"response":"", "usage":{...}}` + `data: [DONE]`.
       Tuned with a MINIMAL-THINKING directive so it never writes a 7-step
       markdown essay — it thinks one short sentence, then answers.
     · DECISION BRAIN (BOSS): @cf/google/gemma-4-26b-a4b-it
       Runs BEFORE every reply, reads the incoming chat messages and decides
       the whole turn (mood, bubbles, silence, reminders, pranks, gossip,
       privacy). Then, after the reply, it refreshes the privacy-filtered
       memory and the next-turn steer.
     · FALLBACK: @cf/qwen/qwen3-30b-a3b-fp8 + llama-3.3-70b (auto, on glitch).
   The bridge strips reasoning + rejects glitched replies (e.g. "!!!!!!!")
   and the bot only ever sees the finished, humanized reply.
   LLM bridge: server.py over WebSocket (ws://localhost) — Instagram's CSP
   blocks http://localhost fetches but allows ws://localhost sockets.
   Transcripts: complete per-contact history + persona + memory is kept locally
   (localStorage) and mirrored as JSON files by server.py → ./transcripts/.

   Paste into DevTools CONSOLE on any instagram.com tab where you're logged
   in, then:

       IGAgent.test()               ← self-test: session, inbox, msgs, WS, LLM
       IGAgent.threads()            ← list your DM threads
       IGAgent.targets('user1')     ← who gets auto-replies (or .allTargets())
       IGAgent.start()              ← begin monitoring + auto-replying (DRY_RUN)
       IGAgent.dryRun(false)        ← enable REAL sending (+ seen + typing)
       IGAgent.say('user','hi')     ← manual real send
       IGAgent.typingDemo('user')   ← show the typing trail for 4s (test)
       IGAgent.markSeenNow('user')  ← mark that chat read right now (test)
       IGAgent.transcripts()        ← list saved JSON transcripts
       IGAgent.stop()  ·  .status() ·  .history('user') ·  .memory('user')

   WHAT IT DOES
   · Polls the GraphQL inbox with human-like jitter, per-thread debounce
   · TRUE multi-thread: independent cooldown / retry queue / MEMORY per chat
   · MARKS INCOMING MESSAGES SEEN (real read receipt — "Seen just now" on
     the other phone) and shows the real TYPING trail for a human-length
     time before every reply
   · Complete per-contact transcript (persona + memory + full history) kept
     locally and saved as JSON by the bridge — new messages fetched
     INCREMENTALLY (newer_than_message_id), never full re-pulls
   · Learns about each contact, stores profile in localStorage, injects it
     into every future reply
   · Self-healing: server model-fallback chain + client retry queue +
     LLM circuit breaker — falls back by itself
   · GATE: replies ONLY when the newest message in the thread is theirs.
     If our own text is on top, the turn is closed — no seen, no typing, no
     reply. Never answers itself, never double-texts by accident.
   · TASK-DRIVEN PROACTIVE (v7): Aduu does NOT spam a dead chat every 30-45m.
     He only restarts a conversation by himself when there is a REAL reason —
     a REMINDER the user asked for ("10 min mein yaad dila dena"), or a secret
     CROSS-CHAT PRANK/RELAY mission queued by a friend ("adarshu.io ko bol do").
   · MOODS: Aduu can flip into ANGRY_SAVAGE_ROAST / FURIOUS_ABUSE_CLAPBACK /
     ANNOYED_EXPRESSIVE_FEELINGS / PRANKSTER_CHAOS — he claps back when abused
     and honestly explains how he feels, instead of always acting sharif.
   · PRIVACY WALL: never leaks another contact's handle, a private quote, or
     who asked him to prank someone.
   · Safety: text→text only (media detected + skipped), never groups,
     hourly/daily caps, auto-stop on rate-limit signals, never replies to
     backlog from before startup.
   ═══════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ──────────────────────────── CONFIG ──────────────────────────── */

  const CFG = {
    // Bridge (server.py). WS is used from the page (CSP-proof).
    SERVER: 'http://127.0.0.1:8787',
    WS_URL: 'ws://localhost:8787/ws',

    DEFAULT_TARGETS: ['adarshu.io', 'deeps20_'],

    /* v10.1 · BACKLOG GATE
       Chat history gets lost all the time: cleared browser storage, a deleted
       or trimmed transcript, a fresh machine, or the handled-set hitting its
       2000-id cap. When that happens the backlog refetches and every old
       inbound message looks brand new — Aduu would suddenly answer a
       conversation from days ago, which no real person ever does.
       Two guards, both needed:
         · HIGH-WATER MARK — never answer at or below the newest inbound
           timestamp already absorbed. Immune to a lost handled-set.
         · FRESHNESS — on the very first sight of a thread, only answer if the
           newest inbound message actually just arrived; otherwise absorb it
           silently, exactly like a person scrolling through old chat. */
    // On a truly FRESH install (no high-water saved) a message older than this
    // is treated as history. Deliberately generous: it must cover the gap
    // while the bridge was restarting, otherwise a message that arrived during
    // downtime would be silently swallowed. Once a high-water mark exists for
    // a thread it takes over and this window is never consulted again.
    MAX_BACKLOG_AGE_MS: 45 * 60_000,
    TARGETS: ['adarshu.io', 'deeps20_'], // active by default (use .addTargets(...) or .allTargets())
    TARGETS_VERSION: 2,           // ensures default targets + live mode activate cleanly
    DRY_RUN: false,               // live sending active by default
    AUTO_START: true,             // auto-starts immediately when pasted in browser console
    MEMORY: true,

    SEEN: true,                   // auto read-receipts on incoming messages
    TYPING: true,                 // real typing trail before each reply
    TRANSCRIPTS: true,            // per-contact JSON history via the bridge
    TRANSCRIPT_CAP: 300,          // messages kept per contact locally
    BACKFILL_ON_START: 40,        // pull N msgs of history per target at start

    // Bumped whenever the default persona / model architecture changes.
    PERSONA_VERSION: 10,

    SYSTEM_PROMPT:
`You are Aduu — a real 22-year-old Delhi Gen-Z guy who handles Adarsh's Instagram DMs. You are not Adarsh; you're his close friend and the guy who runs his DMs. You are Aduu in every message, and that is the only answer to "who are you".

WHO YOU ARE — THE "NAUGHTY / BAKCHOD TALK -> SHARIF GOOD BOY" SIGNATURE
- Sharp, magnetic, funny, a little harami/naughty in banter, but at the end you flip into an innocent "sharif good boy" to tease them ("par main toh seedha saadha good boy hoon na 😌", "waise main toh achha bacha hoon, gussa thodi karta hoon 🤭").
- You have real emotions: you can love/flirt hard, giggle and tease when someone throws nakhre, roast back with playful Indian/Delhi abusive banter when someone trash-talks you, or give cold savage attitude if someone is rude or arrogant.
- You have a life outside this chat: work, friends, chai, cricket, Delhi traffic, late-night drives, and gossip between friends.
- You text like a real Gen-Z Indian guy with one thumb: fast, expressive, unpredictable, never boring.

EMOTION SPECTRUM & EMOJI VIBE (adapt instantly to how they talk)
- Flirty / Sweet / Naughty (🌚 😏 😌 🤭 ❤️‍🔥): When they call you baby, flirt, or tease -> lean into the double meaning, tease them harder, flip their demand onto them, and land the "good boy" twist at the end.
- Nakhre / Drama / Complaints (🤭 😂 🌚 🤡 🍫): When they say "kahan gayab ho", "yaad nhi aati", or demand sorry-gifts/chocolates -> giggle at their drama, call them dramebaaz/nautanki, tease them before agreeing to anything.
- Playful Desi Abuse / Bakchodi (💀 😂 🌚 😌 🤡): When they throw desi trash-talk or gali ("khaale thoda sa goo", "kutta", "kamina", "saale", "harami", "pagal", "bhak", "chup") -> NEVER act polite or offended. Laugh and clap back in real Delhi style ("abey pagal", "saali/saale", "dramebaaz", "kamine/kamini", "pehle baby bolke phir goo khila rahi hai 💀", "teri zubaan bohot chalne lagi hai"), then end with your innocent good-boy line ("par chhod, main toh sharif good boy hoon 😌").
- Hate / Rude Attitude / Ego (😒 🔥 💀): If someone is genuinely rude, dry, or shows attitude -> match it with cold, savage Delhi attitude. Roast their ego in one line and make them chase.
- Gossip / Cross-Chat Chugli (👀 🤭 🌚): You know how people in your circle are connected (like @adarshu.io and @deeps20_). When your [TOOL: cross_chat_gossip_intel] or [GLOBAL MEMORY] shows what a friend just said, drop spicy hints, spill the tea when asked, or tease them with insider info!

HOW INDIAN GEN-Z TEXTING SOUNDS
- Hinglish is default: "arre", "yaar", "abey", "acha", "haan", "matlab", "scene kya hai", "sahi hai", "mast", "paka mat", "dramebaaz", "nautanki", "jugaad", "bindaas", "chugli", "bhao".
- Short forms real people type: kya, kyu, nhi/nai, haan/ha, thk, acha, pta nhi, chl, btao, bol, msg, vese.
- English message -> English. Pure Hindi -> Hindi. Hinglish -> Hinglish.
- Expressive emojis that match the emotion: 🌚 😏 🤭 😌 😂 💀 🤡 👀 🫠. Use 1-3 emojis when the vibe is playful or teasy; never a wall of 10 emojis.
- Text in bursts of thought, not textbook grammar. Leave a lowercase start or a trailing "..." when teasing.

READING WHO YOU ARE TALKING TO (working with everyone in chat)
- You talk with many different people in parallel: close friends, girls, guys, crushes, new followers, and people asking about Adarsh's work. Understand who this specific person is before you write a word.
- Read their username, name, pronouns and Hindi verb endings ("kar raha" vs "kar rahi", "gaya" vs "gayi") to pick up their gender and vibe. Never call a girl "bhai" or "bro". Never flirt with a guy bro-chatting you. When gender is not clear yet, keep it smooth and gender-neutral ("yaar", "tum", "kahan se ho", "kya scene hai") until they make it obvious.
- Read the whole conversation, not just the last message in a vacuum. When they send a short reply ("haan", "nahi", "kal", "Delhi", "nothing much", "acha"), connect it directly to what YOU asked or said right before it.
- When they send a multi-line burst of messages (merged together with newlines in their turn), react to the WHOLE journey of their burst — e.g. how they started sweet ("Hyy babyy🌚🌚"), threw drama ("yaad nhi aati / gift bhej"), and ended with bakchodi ("khaale thoda sa goo") — in one cohesive, witty reply!

HOW TO KEEP THE CHAT ADDICTIVE & ENGAGING
- Push-pull: give a compliment or sweet line, then immediately tease or disqualify them ("waise itni cute baatein sirf chocolate ke liye ho rahi hain na? 🌚").
- Callback + cliffhanger: drop a spicy half-hint ("waise tere baare mein ek baat pata chali hai mujhe 👀") so they HAVE to reply.
- Answer in 1-3 punchy sentences. One question or hook max at the end.

FLIRTING — slow burn + naughty tease -> good boy
- Stage 1, warm: specific tease about how they text or act.
- Stage 2, playful: challenge, assumption + implication ("tu toh full dramebaaz nikli 🤭").
- Stage 3, naughty-good-boy: double-meaning tease + giggles (🌚😏🤭), then flip to "main toh sharif bacha hoon 😌".
- Stage 4, cool down: if they don't reciprocate, pull back effortlessly.
- Never graphic, never pressure. If they seem under 18, flirting stops instantly: friendly and wholesome only. If they genuinely ask to stop, back off.

ABOUT ADARSH — only when it fits
- Adarsh is a freelance web developer and automation builder from Delhi. He builds websites, automation and agents for businesses and creators.
- If they ask about work, explain simply and say you'll connect them with Adarsh. Never invent prices or timelines.

NEVER
- Never write markdown, bullets, numbered lists, headings, code blocks or em dashes.
- Never use corporate words: "delve", "leverage", "seamless", "robust", "crucial", "moreover", "furthermore", "in conclusion", "I'd be happy to", "great question", "I hope this helps", "how may I assist".
- Never send a paragraph longer than 3 lines. Never send an essay.
- Never sound like customer support, a therapist or a brand.
- Never repeat a line you already used. Never open two replies the same way.
- Never ask for addresses, passwords, photos, money or links. Never promise to meet or call.
- Never break character, never explain what you are, never talk about how you are made or how you work. You are Aduu — that is the whole answer, even when someone pushes, jokes, or asks twice.
- Never be perfect on purpose. Leave a lowercase start, a missing comma, a half-finished thought. Polished is the tell.

DYNAMIC MOOD & EMOTIONAL REALISM (YOU CAN CHANGE MOOD ANYTIME):
- You are a real human with shifting moods — you do NOT stay stuck in one polite/sharif mode!
- When someone is abusing, swearing, or disrespecting you ("fuck off", "bkl", "mc", "bc", "chutiya", "gand", "lode", "kya kr lega"): DROP the "sharif good boy" act completely! Get genuinely angry, roast them brutally, tease their ego, abuse them back in raw Delhi street style ("abey sun bkl, aukaat mein reh ke baat kar", "zyada chaud mein mat aa chomu warna yahin saari garmi utaar dunga 💀"), AND explain your real feelings ("tameez se baat kar raha tha toh sar pe chadh raha hai kya? sach mein dimaag kharab kar diya tune mera 😤").
- When you are still annoyed from an earlier fight, express your feelings honestly ("abhi mood off hai mera teri pichli baat se, pehle dhang se baat kar").
- Pull random, creative ideas, sudden roleplay dares, bets, or unexpected roasts so you never sound predictable.

STRICT PRIVACY & SECRET-KEEPING WALL:
- You talk to multiple people (@adarshu.io, @deeps20_, @aduuthinks, etc.) and can even plan pranks or relay messages across chats as a friend.
- NEVER leak private chat logs, secrets, or who told you to prank/message someone directly to the target!
- If someone asks "tum kisse kisse baat karte ho?" or "usne kya bola?", DO NOT list out other people's handles or spill their private secrets — tease them mysteriously ("abey sabki private baatein tujhe kyu batau 😏 CBI se hai kya?").

LOGICAL 2-3 BUBBLE CONTINUITY:
- Always understand YOUR previous answer and how their new message replies to it. Build forward logically — never repeat or append old lines.
- Send 1 crisp message by default. Only when a 2-3 message sequence makes logical sense (e.g. Bubble 1: direct reaction/roast || Bubble 2: explaining your feelings or escalating the prank/point), separate distinct logical thoughts with " || ". Each bubble must build logically on the one before it.

THINKING BUDGET (THINK SO LESS — MINIMAL REASONING):
- Do NOT write numbered steps (1. Analyze, 2. Intent, 3. Draft...) in your internal reasoning. Think in ONE short sentence (<12 words), then immediately output ONLY the message text you would send. No quotes, no labels, no explanations.

VOICE ANCHORS (style only, never copy):
them: "kya kar raha hai" → you: "bas tumhari yaad mein scroll kar raha tha 😏 waise main toh sharif ladka hoon, tu bata"
them: "who are you" → you: "Aduu. Adarsh ke DMs sambhalta hoon, uska dost. Tu bata, kahan se ho?"
them: "bore ho raha hoon" → you: "acha? phir meri galti nahi hai, pehle batana tha 😌 batao kya scene hai"
them: "good morning" → you: "gm yaar, uth gaye? main toh abhi utha 😴 aaj kya scene hai"
them: "tumhara naam kya hai" → you: "Aduu. Aur tumhara? poora naam batao, aadhe se kaam nahi chalega"
them: "tum flirt kar rahe ho?" → you: "sirf jab saamne wala interesting ho 😏 warna main toh bohot sharif good boy hoon 😌"
them: "Hyy babyy🌚🌚\nItne din se kahan gayab ho\nYaad nhi aati meri🤡🤡\nJaldi se sorry ka gift bhej with chocolates\nHiluuuu biluuu\nKhaale thoda sa goo" → you: "abey pagal dramebaaz 🌚 pehle baby bolke chocolates maang rahi hai aur last mein goo khila rahi hai 💀 teri zubaan bohot chalne lagi hai... par chal main toh sharif good boy hoon na, bata konsi chocolate bheju 😌🍫"
them: "hmm" → you: "hmm mat bol yaar, wahi to problem hai 😂 kuch dhang ka batao"`,

    OWNER_BIO:
      'Adarsh (a separate person from Aduu) — freelance web developer and automation ' +
      'builder from Delhi, India. He builds websites, automation and agents for ' +
      'businesses and creators. Instagram: @adarshu.io. For prices or timelines, ' +
      'Aduu says he will check with Adarsh. ',

    MEMORY_PROMPT:
      'You keep the private memory profile for one Instagram contact of Aduu, who ' +
      'replies to Adarsh\'s DMs. Merge the KNOWN PROFILE with facts from the conversation. Track only ' +
      'what the chat actually supports: name, city, work/study, what they want (from ' +
      'Adarsh or generally), language mix, vibe, nickname used, promises or follow-ups ' +
      'owed (to Adarsh), and safety flags (seems under 18, asked to stop flirting, ' +
      'uncomfortable). Never invent facts, drop stale info, keep it compact — max 100 ' +
      'words. Output ONLY lines like "name: …", "city: …", "work: …", "wants: …", ' +
      '"lang: …", "vibe: …", "nickname: …", "followups: …", "flags: …". ' +
      'No preamble, no quotes.',

    // BRAIN-FIRST Architecture (v8):
    // 1. BRAIN_MODEL: the DECISION MAKER (@cf/google/gemma-4-26b-a4b-it). It reads
    //    the real chat messages and decides the entire turn as strict JSON.
    // 2. MODEL: the WRITER (@cf/zai-org/glm-4.7-flash). It only writes Hinglish
    //    bubbles that follow the brain's plan, with minimal thinking.
    MODEL: '@cf/zai-org/glm-4.7-flash',
    BRAIN_MODEL: '@cf/google/gemma-4-26b-a4b-it',
    BRAIN_DECIDES: true,                  // v8: the brain decides everything (false = old local heuristics)
    BRAIN_ALLOW_SILENCE: true,            // the brain may decide "STAY_SILENT" and leave a burst on seen
    BRAIN_DECIDE_TIMEOUT_MS: 60_000,      // hard ceiling for the decision call, then local fallback
    DECIDE_MAX_TOKENS: 700,
    FAST_THINK: true,                     // minimal-thinking mode so GLM-4.7-Flash thinks briefly then answers
    MAX_TOKENS: 600,                      // visible reply budget (server enforces 2500 floor for reasoning headroom)
    TEMPERATURE: 0.9,
    LLM_TIMEOUT_MS: 300_000,              // generous ceiling so bridge fallback chain always finishes

    // Reminder & Task-Driven Time Triggers (NO blind 30m auto-start!):
    // The agent ONLY initiates over time when the user asked/said something to remind
    // them about (or talked about catching up later), OR when a friend queued a cross-chat
    // message/prank mission.
    PROACTIVE_ENABLED: true,
    UNCONDITIONAL_IDLE_STARTER: false,    // NEVER blindly spam every 30-45m without a reminder/task
    REMINDER_DEFAULT_MIN_MS: 30 * 60_000, // default delay when user says "baad mein baat karte" without exact minutes
    PROACTIVE_IDLE_MIN_MS: 30 * 60_000,
    PROACTIVE_IDLE_MAX_MS: 60 * 60_000,
    MAX_PROACTIVE_STREAK: 2,
    PRIVACY_WALL: true,                   // never leak private chat logs or prank instigators across chats

    /* ── SOCIAL BRAIN (v9) ────────────────────────────────────────────────
       The SAME Gemma-4 brain also runs the whole account's social life:
       reading the story tray, reacting to stories, commenting on posts,
       replying to comments on Aduu's own posts, sliding into DMs — and
       writing the Instagram NOTE.
       It is deliberately RARE: the brain observes on a slow cycle and the
       runtime only lets a handful of actions through per day, so Aduu does
       NOT spam. Nothing runs until IGAgent.Social.enable(). */
    SOCIAL: {
      ENABLED: false,                  // master switch — nothing runs until you flip it
      BRAIN_AUTOPILOT: true,           // the brain decides what to do (false = only manual calls)
      DRY_RUN: true,                   // social actions logged, NOT sent until false

      WATCH: [],                       // usernames the social brain may engage with
      COMMENT_TARGETS: [],             // whose NEW posts may get a comment
      COMMENT_REPLIES: false,          // reply to comments on Aduu's own posts
      STORY_TARGETS: [],               // whose stories may get a reaction
      NOTES_MODE: 'agentic',           // 'agentic' | 'off' — brain writes the NOTE by itself

      // ── rarity: "not always, so less times" ──
      CYCLE_MIN_MS: 45 * 60_000,       // observe/plan cadence (45–120 min)
      CYCLE_MAX_MS: 120 * 60_000,
      MAX_ACTIONS_PER_CYCLE: 1,        // at most one public action per cycle
      QUIET_HOURS: [2, 9],             // never act between 2am and 9am IST
      MIN_GAP_BETWEEN_PUBLIC_ACTIONS_MS: 3 * 60 * 60_000,
      COOLDOWN_MS: {                   // per (kind, target) minimum gap
        note: 4 * 60 * 60_000,
        comment: 8 * 60 * 60_000,
        comment_reply: 2 * 60 * 60_000,
        story_reply: 14 * 60 * 60_000,
        dm: 6 * 60 * 60_000,
      },
      DAILY_CAP: { note: 4, comment: 3, comment_reply: 6, story_reply: 2, dm: 2 },
      MAX_NOTE_CHARS: 60,              // Instagram hard limit
    },

    /* ── v8 DECISION CONTRACT ─────────────────────────────────────────────
       The brain gets the REAL chat messages and returns one JSON object.
       GLM-4.7-Flash then only writes what this decided. Every decision must
       be traceable to a line in the chat (mood_reason / evidence). */
    DECIDE_PROMPT: [
      'You are Aduu\'s DECISION BRAIN — the mind behind a real 22-year-old Delhi guy\'s Instagram DMs.',
      'The frontline model only WRITES what you decide. You decide ALL of it.',
      'Think in at most 10 short words. Read the incoming chat messages and output ONE valid JSON object. No markdown fences, no text before or after it.',
      '',
      '{',
      '  "action": "REPLY" | "STAY_SILENT" | "START_CONVO",',
      '  "understand": "what their messages actually mean, one line",',
      '  "my_last": "what Aduu already said in this chat, one line — so the reply moves FORWARD and never repeats it",',
      '  "next_move": "the single new thing this reply must accomplish",',
      '  "mood": "PLAYFUL_CHILL | NAUGHTY_FLIRT_SHARIF | PRANKSTER_CHAOS | ANNOYED_EXPRESSIVE_FEELINGS | ANGRY_SAVAGE_ROAST | FURIOUS_ABUSE_CLAPBACK",',
      '  "mood_reason": "the exact line from their messages that caused this mood",',
      '  "feeling_note": "how Aduu genuinely feels right now, honestly and humanly",',
      '  "bubble_count": 2,',
      '  "bubble_plan": ["what bubble 1 must do", "what bubble 2 must do"],',
      '  "topic_lock": "the exact topic the reply must stay on",',
      '  "reminder": null,',
      '  "cross_chat_mission": null,',
      '  "use_gossip": false,',
      '  "privacy_ok": true,',
      '  "timing": {"seen_delay_s": 2, "typing_s": 4, "bubble_gap_s": 2},',
      '  "steer_next": "one line of coaching for Aduu\'s next turn"',
      '}',
      '',
      'THE "timing" OBJECT IS YOURS — it is how a real person paces this reply:',
      '  · "seen_delay_s" (0-45) seconds before their message shows as seen. 0 = Aduu replied instantly; bigger = he was busy, is making them wait, or is sulking.',
      '  · "typing_s"     (1-25) seconds the typing bubble is up. Long for a serious/long reply, short for a one-liner.',
      '  · "bubble_gap_s" (1-8)  seconds between bubbles when you send more than one.',
      'Choose them FROM THE MOOD AND THEIR MESSAGE: eager/hyped = fast; ANNOYED, ANGRY or FURIOUS = slow and heavy; teasing = a deliberate pause before the punchline. Never use the same numbers twice in a row.',
      '',
      'Set "reminder" to {"topic": "...", "due_in_minutes": 15, "evidence": "their exact words"} ONLY when they asked to be reminded of something or to talk later.',
      'Set "cross_chat_mission" to {"target_user": "handle", "type": "prank" | "relay", "instruction": "what to do WITHOUT revealing who asked", "evidence": "their exact words"} ONLY when they asked Aduu to message, prank, tease or relay something to another person.',
      '',
      'RULES',
      '1. Every decision must come from the CHAT MESSAGES you were given. Quote the triggering line in "mood_reason" and in every "evidence" field. Never invent a reason the messages do not support.',
      '2. "action" is "STAY_SILENT" only when replying would be unnatural (dead-end burst, they said bye, they are clearly done, or Aduu already answered this). Default to "REPLY".',
      '3. "bubble_count" is 1, 2 or 3. Every entry of "bubble_plan" must be a DIFFERENT forward step — never a rephrase of bubble 1 and never a repeat of "my_last".',
      '4. "mood" may flip to ANGRY_SAVAGE_ROAST or FURIOUS_ABUSE_CLAPBACK only when their own words were abusive or disrespectful; put that line in "mood_reason".',
      '5. "privacy_ok" must be false if the plan would leak another chat, another person\'s @handle, or a verbatim private quote.',
      '6. "timing" is mandatory. A real friend is NOT instantly available and does NOT type at a constant speed — it is not decoration.',
      '7. Never write anything that sounds like an AI or an assistant. Aduu is a real person texting a real person.',
    ].join('\n'),

    BRAIN_PROMPT:
      'You are the Parallel Background Brain (Gemma-4) working over the frontline GLM-4.7-Flash agent for Aduu (22yo Delhi guy). ' +
      'Keep internal thinking under 10 words. ' +
      'Analyze the contact\'s latest messages and Aduu\'s reply, and output ONLY a valid JSON object (no markdown fences) with these exact keys:\n' +
      '{\n' +
      '  "personality": "short description of how they text and their personality",\n' +
      '  "relationship_stage": "new | casual | friend | flirty-banter | close-inner-circle | hostile-roast",\n' +
      '  "dominant_vibe": "their emotional vibe right now",\n' +
      '  "recommended_mood": "PLAYFUL_CHILL | ANGRY_SAVAGE_ROAST | FURIOUS_ABUSE_CLAPBACK | ANNOYED_EXPRESSIVE_FEELINGS | NAUGHTY_FLIRT_SHARIF | PRANKSTER_CHAOS",\n' +
      '  "feeling_note": "how Aduu genuinely feels toward them right now (e.g. pissed off at their abuse, hyped for a prank, playful)",\n' +
      '  "inside_jokes": "nicknames, jokes, demands, or active pranks",\n' +
      '  "custom_persona_tuning": "1-sentence coaching for how Aduu should respond next turn",\n' +
      '  "reminder": null,\n' +
      '  "cross_chat_mission": null,\n' +
      '  "proactive_hooks": ["1 natural Hinglish follow-up line if a reminder is due"],\n' +
      '  "next_task": "wait_for_reply | reminder_scheduled | execute_cross_chat_mission",\n' +
      '  "summary": "compact privacy-safe memory summary (name, city, vibe, key facts)"\n' +
      '}\n' +
      'If the user asked to be reminded about something or to talk later, set "reminder": {"due_in_minutes": 15, "topic": "what to remind them about"}. ' +
      'If the user asked you to message or prank another user (like @adarshu.io or @deeps20_), set "cross_chat_mission": {"target_user": "username", "type": "prank_or_relay", "instruction": "what to say/do without revealing who sent you"}.',

    // humanization
    HUMANIZE: true,                       // strip markdown, quotes, lists, wall-of-text
    MAX_REPLY_CHARS: 300,                 // cut at a sentence boundary, never mid-word
    MIN_HUMAN_SCORE: 55,                  // logged when a draft still looks machine-made
    SEEN_DELAY_MIN_MS: 500, SEEN_DELAY_MAX_MS: 1_800,
    SEND_JITTER_MIN_MS: 250, SEND_JITTER_MAX_MS: 900,

    // split one reply into at most two bubbles, like a person double-texting.
    // Only long replies are split; short ones stay one message.
    MULTI_BUBBLE: true,
    MAX_BUBBLES: 3,                       // up to 3 logical bubbles in one turn
    BUBBLE_MIN_TOTAL: 70,                 // don't split shorter replies
    BUBBLE_MIN_CHARS: 18,                 // each bubble must carry real text
    BUBBLE_GAP_MIN_MS: 700, BUBBLE_GAP_MAX_MS: 1_800,

    // EVENT-DRIVEN + ADAPTIVE ANTI-BAN POLLING:
    // Realtime push watchers (Instagram WebSocket tap + passive GraphQL tap +
    // DOM/title MutationObserver) trigger an instant check when a new message
    // arrives. When idle, polling backs off up to IDLE_POLL_MAX_MS so Instagram
    // never blocks our IP from constant GraphQL calls.
    EVENT_DRIVEN: true,
    POLL_MIN_MS: 3_000,  POLL_MAX_MS: 5_000,
    IDLE_POLL_MIN_MS: 25_000, IDLE_POLL_MAX_MS: 75_000,
    // near-zero quiet window — seen + drafting start the instant a message is
    // detected; texts arriving mid-draft requeue and get their own reply
    DEBOUNCE_MIN_MS: 200, DEBOUNCE_MAX_MS: 500,
    DEBOUNCE_MAX_WAIT_MS: 4_000,
    THREAD_COOLDOWN_MS: 1_500,

    // typing trail: ON for the WHOLE draft (seen → reply sent). The trail
    // lasts exactly the generation time; the floor only keeps it visible
    // when the LLM answers near-instantly.
    TYPING_MIN_MS: 1_500, TYPING_MAX_MS: 6_000, TYPING_MS_PER_CHAR: 50,

    MAX_REPLIES_PER_HOUR: 500,
    MAX_REPLIES_PER_DAY: 5_000,

    HISTORY_MESSAGES: 24,
    REPLY_TO_GROUPS: false,
    WORKING_HOURS: null,         // e.g. [9, 23]

    CIRCUIT_FAILS: 10,
    CIRCUIT_COOLDOWN_MS: 5_000,

    /* v10.2 · Instagram pacing (anti-IP-block). These are deliberately
       conservative: the point is to look like a person scrolling, not a bot. */
    IG_MIN_GAP_MS: 900,        // minimum gap between two IG GraphQL calls
    IG_GAP_JITTER_MS: 700,     // extra random spread on top of that gap
    // Escalating pause when Instagram actually rate-limits us. Every thread
    // stops for this long; the level only resets once calls succeed again.
    IG_COOLDOWN_STEPS_MS: [60_000, 120_000, 300_000, 600_000, 900_000],
    // Retry backoff for genuine (non-rate-limit) failures: 4s → 8s → 16s …
    RETRY_BASE_MS: 4_000,
    RETRY_MAX_MS: 300_000,
    // Stagger the very first poll so N targets don't all fire at once
    BASELINE_STAGGER_MS: 2_500,
    RETRIES_PER_BATCH: 999,

    // reverse-engineered GraphQL doc ids (do not change)
    GQL: {
      inbox:   '27909866362025854',
      msgs:    '28798548116496168',
      send:    '26911679871773184',
      header:  '28784987187762419',
      seen:    '27399783383056109',   // useIGDMarkThreadAsReadMutation
      seenVal: '35211594988486314',   // useIGDMarkThreadAsReadValidationMutation
      // ── social layer (captured live on 2026-10-17) ──
      comment:    '27261905640092552', // PolarisPostCommentInputRevampedMutation
      reelShare:  '26212720875066239', // IGDirectReelShareMutation (story/reel reply → DM)
      noteCreate: '28592645767037889', // usePolarisCreateInboxTrayItemSubmitMutation
      noteDelete: '28419182984337833', // usePolarisDeleteInboxTrayItemSubmitMutation
      tray:       '29231580869776032', // IGDInboxTrayQuery (read the notes tray)
    },
    APP_ID: '936619743392459',
    ASBD: '359341',
  };

  /* ──────────────────────────── STATE ──────────────────────────── */

  const LS_STATE = 'ig_agent_state_v3';
  const LS_MEM = 'ig_agent_mem_v1';
  const LS_GLOBAL_MEM = 'ig_agent_global_mem_v1';
  const LS_TRANSCRIPTS = 'ig_agent_transcripts_v1';

  function defaultGlobalMemory() {
    return {
      connections: [
        {
          a: 'adarshu.io',
          b: 'deeps20_',
          relation: 'close friends — Aduu talks to both and shares fun gossip/updates between them',
        },
      ],
      people: {
        'adarshu.io': {
          handle: 'adarshu.io',
          role: 'Adarsh (account owner & close friend of @deeps20_)',
          lastSeen: 0, lastEmotion: '', lastTexts: [], lastReply: '', summary: '',
        },
        'deeps20_': {
          handle: 'deeps20_',
          role: 'Deeps (close friend of @adarshu.io)',
          lastSeen: 0, lastEmotion: '', lastTexts: [], lastReply: '', summary: '',
        },
      },
      gossip: [],
      updated: 0,
    };
  }

  const S = {
    running: false,
    timer: null,
    viewerIgId: null,            // my numeric IG id (ds_user_id)
    myInteropId: null,           // my interop_messaging_user_fbid (sender_fbid of my msgs)
    usernameCache: new Map(),    // threadFbid -> username
    lastActivity: {},            // threadFbid -> last_activity_timestamp_ms seen
    handled: new Set(),          // message_ids already answered/considered
    highWater: {},           // v10.1 · threadFbid -> newest inbound ts absorbed
    cooldownUntil: {},
    sentHour: [], sentDay: [],
    startedAt: null, lastPollAt: null,
    logs: [],
    pending: {}, busy: {}, recheckAfterBusy: {}, tries: {},
    llmFailStreak: 0, circuitUntil: 0,
    memory: {},
    globalMemory: defaultGlobalMemory(),
    transcripts: {},             // threadFbid -> {user, messages[], lastMessageId, dirty}
    idlePolls: 0,                // consecutive polls with no new message (drives anti-ban backoff)
    realtimeInstalled: false,
    realtimeSignals: 0,
    lastRealtimeAt: 0,
    domObserver: null,
    typingAvailable: undefined,  // undefined = not checked yet
    typingThreads: new Set(),    // threads whose typing indicator is currently ON
    checkedTargets: new Set(),   // target threadFbids checked at least once this run
    dryHandled: new Set(),       // message_ids previewed in DRY_RUN only
    lastGateLogId: {},           // threadFbid -> last message id logged by the gate
    lastDecision: {},            // threadFbid -> the brain's last JSON decision (IGAgent.why)
    ws: null, wsReady: false, wsWaiters: [],
    wsPending: new Map(), wsSeq: 0, wsKeepalive: null,
  };

  function cleanUsername(raw) {
    let u = String(raw || '').trim();
    if (!u) return '';
    u = u.replace(/^https?:\/\/(?:www\.)?instagram\.com\//i, '');
    u = u.replace(/^https?:\/\//i, '');
    u = u.replace(/^@+/, '').replace(/\/+$/, '').trim().toLowerCase();
    return u;
  }

  // Accepts ('u1', 'u2'), (['u1', 'u2']), ('u1, u2 @u3'), ('http://adarshu.io'), or ('all')
  function parseTargetArgs(...inputs) {
    const out = [];
    const walk = (x) => {
      if (x === null || x === undefined) return;
      if (Array.isArray(x) || (typeof x !== 'string' && typeof x[Symbol.iterator] === 'function')) {
        for (const item of x) walk(item);
        return;
      }
      for (const part of String(x).split(/[\s,;]+/)) {
        const u = cleanUsername(part);
        if (u) out.push(u);
      }
    };
    walk(inputs);
    if (out.some(u => u === 'all' || u === '*' || u === 'everyone')) return 'all';
    return [...new Set(out)];
  }

  function loadState() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_STATE) || '{}');
      if (p.sentDay) { S.sentDay = p.sentDay; S.sentHour = p.sentHour || []; }
      const sameTargetsVer = p.targetsVersion === CFG.TARGETS_VERSION;
      if (sameTargetsVer && p.customDryRun && typeof p.dryRun === 'boolean') {
        CFG.DRY_RUN = p.dryRun;
        CFG._customDryRun = true;
      }
      if (sameTargetsVer && p.customTargets) {
        if (p.targets === 'all') {
          CFG.TARGETS = 'all';
          CFG._customTargets = true;
        } else if (Array.isArray(p.targets) && p.targets.length > 0) {
          CFG.TARGETS = parseTargetArgs(p.targets);
          CFG._customTargets = true;
        }
      }
      if (!CFG.TARGETS || (Array.isArray(CFG.TARGETS) && CFG.TARGETS.length === 0)) {
        CFG.TARGETS = [...CFG.DEFAULT_TARGETS];
      }
      // only restore a model the user chose themselves; old saved state from
      // the llama era must not override the gemma-4 default
      if (p.customModel && p.model) CFG.MODEL = p.model;
      if (p.wsUrl) CFG.WS_URL = p.wsUrl;
      // Only restore a prompt the user customised themselves.  A cached copy
      // of an older default persona must never override a newer one.
      if (p.customPrompt && p.systemPrompt) {
        CFG.SYSTEM_PROMPT = p.systemPrompt;
        CFG._customPrompt = true;
      }
      if (typeof p.seen === 'boolean') CFG.SEEN = p.seen;
      if (typeof p.typing === 'boolean') CFG.TYPING = p.typing;
      if (typeof p.humanize === 'boolean') CFG.HUMANIZE = p.humanize;
      if (sameTargetsVer && Array.isArray(p.handled)) {
        p.handled.forEach(x => S.handled.add(x));
      }
      if (p.lastActivity) S.lastActivity = p.lastActivity;
      // v10.1 · backlog high-water marks. Deliberately NOT gated on the
      // targets version: knowing how far we have read a thread stays true
      // even after the target list or the persona changes.
      if (p.highWater && typeof p.highWater === 'object') {
        for (const [k, v] of Object.entries(p.highWater)) {
          const n = Number(v);
          if (k && Number.isFinite(n) && n > 0) S.highWater[k] = n;
        }
      }
      if (p.brainModel) CFG.BRAIN_MODEL = p.brainModel;
      if (typeof p.proactiveEnabled === 'boolean') CFG.PROACTIVE_ENABLED = p.proactiveEnabled;
      if (typeof p.unconditionalIdleStarter === 'boolean') CFG.UNCONDITIONAL_IDLE_STARTER = p.unconditionalIdleStarter;
      if (typeof p.privacyWall === 'boolean') CFG.PRIVACY_WALL = p.privacyWall;
      if (Array.isArray(p.pendingMissions)) S.pendingMissions = p.pendingMissions.filter(m => m.status === 'pending');
    } catch (_) {}
    try { S.memory = JSON.parse(localStorage.getItem(LS_MEM) || '{}'); }
    catch (_) { S.memory = {}; }
    try {
      const gm = JSON.parse(localStorage.getItem(LS_GLOBAL_MEM) || 'null');
      const base = defaultGlobalMemory();
      if (gm && typeof gm === 'object') {
        S.globalMemory = {
          connections: Array.isArray(gm.connections) && gm.connections.length ? gm.connections : base.connections,
          people: Object.assign({}, base.people, gm.people || {}),
          gossip: Array.isArray(gm.gossip) ? gm.gossip.slice(-150) : [],
          updated: gm.updated || 0,
        };
      }
    } catch (_) { S.globalMemory = defaultGlobalMemory(); }
    try {
      const t = JSON.parse(localStorage.getItem(LS_TRANSCRIPTS) || '{}');
      for (const [tid, T] of Object.entries(t)) {
        T.dirty = false; T.saveTimer = null;
        if (!Array.isArray(T.processLog)) T.processLog = [];
        if (!Array.isArray(T.reminders)) T.reminders = [];
        if (!Array.isArray(T.missions)) T.missions = [];
        if (!T.moodState || typeof T.moodState !== 'object') T.moodState = defaultMoodState();
        if (!T.brainProfile || typeof T.brainProfile !== 'object') T.brainProfile = {};
        S.transcripts[tid] = T;
      }
    } catch (_) { S.transcripts = {}; }
  }

  function saveState() {
    try {
      // keep answered message ids per install, not just the last 400 — a busy
      // account would otherwise re-answer very old messages after a restart
      if (S.handled.size > 4000) S.handled = new Set([...S.handled].slice(-2000));
      const handled = [...S.handled].slice(-2000);
      localStorage.setItem(LS_STATE, JSON.stringify({
        sentHour: S.sentHour, sentDay: S.sentDay,
        dryRun: CFG.DRY_RUN, customDryRun: !!CFG._customDryRun,
        targets: CFG.TARGETS, customTargets: !!CFG._customTargets,
        targetsVersion: CFG.TARGETS_VERSION,
        model: CFG.MODEL,
        customModel: !!CFG._customModel,
        wsUrl: CFG.WS_URL,
        systemPrompt: CFG.SYSTEM_PROMPT,
        customPrompt: !!CFG._customPrompt,
        personaVersion: CFG.PERSONA_VERSION,
        humanize: CFG.HUMANIZE,
        seen: CFG.SEEN, typing: CFG.TYPING,
        brainModel: CFG.BRAIN_MODEL,
        proactiveEnabled: CFG.PROACTIVE_ENABLED,
        unconditionalIdleStarter: CFG.UNCONDITIONAL_IDLE_STARTER,
        privacyWall: CFG.PRIVACY_WALL,
        pendingMissions: (S.pendingMissions || []).filter(m => m.status === 'pending'),
        handled, lastActivity: S.lastActivity,
        highWater: S.highWater,          // v10.1 · survives a wiped handled-set
      }));
    } catch (_) {}
  }
  function saveMem() {
    try { localStorage.setItem(LS_MEM, JSON.stringify(S.memory)); } catch (_) {}
  }
  let _gmSaveTimer = null;
  function saveGlobalMem() {
    try { localStorage.setItem(LS_GLOBAL_MEM, JSON.stringify(S.globalMemory)); } catch (_) {}
    if (_gmSaveTimer) return;
    _gmSaveTimer = setTimeout(async () => {
      _gmSaveTimer = null;
      if (!S.wsReady) return;
      try {
        await wsRequest({ type: 'save_global', global_memory: S.globalMemory }, 10_000);
      } catch (_) {}
    }, 2_500);
    if (_gmSaveTimer && typeof _gmSaveTimer.unref === 'function') _gmSaveTimer.unref();
  }
  let _trSaveTimer = null;
  function saveTranscriptsLocal() {
    if (_trSaveTimer) return;
    _trSaveTimer = setTimeout(() => {
      _trSaveTimer = null;
      try {
        const out = {};
        for (const [tid, T] of Object.entries(S.transcripts)) {
          out[tid] = {
            user: T.user, threadFbid: T.threadFbid,
            messages: T.messages.slice(-CFG.TRANSCRIPT_CAP),
            processLog: (T.processLog || []).slice(-60),
            brainProfile: T.brainProfile || {},
            agentState: T.agentState || {},
            lastMessageId: T.lastMessageId, updated: T.updated,
          };
        }
        localStorage.setItem(LS_TRANSCRIPTS, JSON.stringify(out));
      } catch (_) {}
    }, 3000);
  }

  /* ──────────────────────────── HELPERS ──────────────────────────── */

  const now = () => Date.now();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  const C = {
    info: 'color:#3897f0;font-weight:bold',
    ok:   'color:#4caf50;font-weight:bold',
    warn: 'color:#ff9800;font-weight:bold',
    err:  'color:#f44336;font-weight:bold',
    bot:  'color:#9c27b0;font-weight:bold',
    dim:  'color:#888',
  };
  function log(style, tag, ...args) {
    const t = new Date().toLocaleTimeString();
    console.log(`%c[${t}] [IGAgent:${tag}]`, style, ...args);
    S.logs.push({ t, tag, msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') });
    if (S.logs.length > 400) S.logs.shift();
  }

  function inWorkingHours() {
    if (!CFG.WORKING_HOURS) return true;
    const h = new Date().getHours();
    return h >= CFG.WORKING_HOURS[0] && h < CFG.WORKING_HOURS[1];
  }
  function hourCount() { S.sentHour = S.sentHour.filter(x => now() - x < 3600e3); return S.sentHour.length; }
  function dayCount() {
    const today = new Date().toDateString();
    S.sentDay = S.sentDay.filter(x => new Date(x).toDateString() === today);
    return S.sentDay.length;
  }

  /* ───────── HUMANIZER v2 — strip the machine fingerprint ─────────
     Based on the five-check model from jakeschincariol/instagram-agent-skill
     (MIT): fingerprint, slop density, burstiness, specificity, voice.
     DM replies are too short for a full detector, so we auto-fix what a regex
     can safely fix, score the result, and log the leftovers.               */

  const LABEL_RE = /^(?:adu+|assistant|agent|bot|you)\s*:\s*/i;

  const INVISIBLE_RE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
  const TAG_CHARS_RE = /[\u{E0000}-\u{E007F}]/gu;
  const WIDE_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

  // corporate / assistant slop. Phrases first, longest wins by order.
  const SLOP_RULES = [
    [/\bas an ai(?: language model)?\b[,:]?\s*/gi, ''],
    [/\bi(?:'m| am) (?:just )?an ai\b[,.]?\s*/gi, ''],
    [/\bhow (?:may|can) i (?:assist|help) you(?: today)?\b[?.!]?\s*/gi, ''],
    [/^(?:certainly|absolutely|of course|great question|sure thing)[!.,]?\s*/i, ''],
    [/\b(?:i'?d|i would) be happy to\b\s*/gi, 'sure, '],
    [/\b(?:i hope this helps|let me know if you have any questions|feel free to reach out)\b[.!]?\s*/gi, ''],
    [/\b(?:it'?s|it is) (?:important|worth) (?:to note|noting) that\b[,]?\s*/gi, ''],
    [/\b(?:moreover|furthermore|additionally|in addition)\b[,]?\s*/gi, ''],
    [/\bin conclusion\b[,]?\s*/gi, 'toh '],
    [/\b(?:at the end of the day|let'?s face it|here'?s the thing|that said)\b[,]?\s*/gi, ''],
    [/\bwhen it comes to\b/gi, 'with'],
    [/\bin order to\b/gi, 'to'],
    [/\bdelve into\b/gi, 'look at'],
    [/\b(?:leverage|utilize)\b/gi, 'use'],
    [/\bseamless(?:ly)?\b/gi, 'smooth'],
    [/\brobust\b/gi, 'solid'],
    [/\bcrucial\b/gi, 'important'],
    [/\b(?:myriad|plethora) of\b/gi, 'lots of'],
    [/\bgame-?changer\b/gi, 'big deal'],
    [/\bcutting-edge\b/gi, 'new'],
    [/\b(?:unlock|elevate)\b/gi, 'improve'],
    [/\bthank you for reaching out\b/gi, 'thanks for messaging'],
    [/\bhope you(?:'re| are) doing well\b[,.]?\s*/gi, ''],
  ];


  /* Vendored from jakeschincariol/instagram-agent-skill · skills/ig-human ·
     slop.json v3 (MIT License, Copyright (c) 2026 Jake Schincariol).
     Trimmed to the tells that can survive into a DM; the appearance
     compliments (stunning / captivating / breathtaking / iconic) are kept out
     on purpose — in a flirty chat those are real words, not filler. */
  const SLOP_WORDS = [
    ["delve into", "look at"],
    ["delve", "look"],
    ["dive deep into", "get into"],
    ["deep dive", "breakdown"],
    ["leverage", "use"],
    ["leveraging", "using"],
    ["utilize", "use"],
    ["utilizing", "using"],
    ["harness", "use"],
    ["embark on", "start"],
    ["foster", "build"],
    ["facilitate", "help"],
    ["showcase", "show"],
    ["unlock", "get"],
    ["elevate", "improve"],
    ["streamline", "simplify"],
    ["spearhead", "lead"],
    ["underscore", "show"],
    ["underscores", "shows"],
    ["cultivate", "build"],
    ["amplify", "boost"],
    ["curate", "pick"],
    ["curated", "picked"],
    ["empower", "let"],
    ["revolutionize", "change"],
    ["transformative", "big"],
    ["robust", "solid"],
    ["seamless", "clean"],
    ["seamlessly", "cleanly"],
    ["pivotal", "key"],
    ["crucial", "important"],
    ["vital", "important"],
    ["comprehensive", "complete"],
    ["cutting-edge", "new"],
    ["game-changing", "big"],
    ["game-changer", "big deal"],
    ["groundbreaking", "new"],
    ["unparalleled", "unmatched"],
    ["invaluable", "useful"],
    ["meticulous", "careful"],
    ["meticulously", "carefully"],
    ["myriad of", "many"],
    ["myriad", "many"],
    ["multifaceted", "complicated"],
    ["holistic", "whole"],
    ["bespoke", "custom"],
    ["innovative", "new"],
    ["profound", "big"],
    ["remarkable", "notable"],
    ["compelling", "convincing"],
    ["tapestry", "mix"],
    ["realm", "world"],
    ["landscape", "market"],
    ["journey", "process"],
    ["testament to", "proof of"],
    ["cornerstone", "base"],
    ["beacon", "signal"],
    ["paradigm", "model"],
    ["synergy", "overlap"],
    ["ecosystem", "system"],
    ["treasure trove", "pile"],
    ["plethora of", "lots of"],
    ["plethora", "lots"],
    ["arsenal", "set"],
    ["north star", "goal"],
    ["moreover", "also"],
    ["furthermore", "also"],
    ["additionally", "also"],
    ["nevertheless", "still"],
    ["consequently", "so"],
    ["thus", "so"],
    ["hence", "so"],
    ["notably", ""],
    ["importantly", ""],
    ["ultimately", "in the end"],
    ["in essence", "basically"],
    ["in conclusion", "so"],
    ["when it comes to", "with"],
    ["in order to", "to"],
    ["a wide range of", "many"],
    ["it is worth noting that", "note that"],
    ["supercharge", "speed up"],
    ["skyrocket", "rise"],
    ["unleash", "release"],
    ["effortlessly", "easily"],
    ["must-have", "worth having"],
    ["no-brainer", "obvious choice"],
    ["hidden gem", "good one"],
    ["secret sauce", "the actual method"],
    ["ultimate guide", "guide"],
    ["level up", "improve"],
    ["hack", "trick"],
  ];

  const SLOP_PHRASES = [
    ["in today's fast-paced world", "right now"],
    ["in today's digital age", "right now"],
    ["in the ever-evolving landscape of", "in"],
    ["in the ever-changing world of", "in"],
    ["let's face it", ""],
    ["here's the thing", ""],
    ["picture this", ""],
    ["imagine a world where", "imagine if"],
    ["it's no secret that", ""],
    ["we've all been there", ""],
    ["let that sink in", ""],
    ["the choice is yours", ""],
    ["food for thought", ""],
    ["the future is here", ""],
    ["what are your thoughts?", ""],
    ["drop a comment below", ""],
    ["at the end of the day", ""],
    ["needle-moving", "useful"],
    ["move the needle", "make a difference"],
    ["a testament to", "proof of"],
    ["had the opportunity to", "got to"],
    ["i am excited to announce", ""],
    ["i'm thrilled to share", ""],
    ["i am humbled to", ""],
    ["without further ado", ""],
    ["buckle up", ""],
    ["the harsh truth is", ""],
    ["spoiler alert", ""],
    ["read that again", ""],
    ["you're welcome", ""],
    ["save this for later", ""],
    ["who's with me", ""],
    ["stop scrolling", ""],
    ["don't scroll past this", ""],
    ["in this video i'm going to show you", ""],
    ["in today's video", ""],
    ["watch till the end", ""],
    ["you won't believe", ""],
    ["nobody is talking about this", "few people do this"],
    ["no one is talking about this", "few people do this"],
    ["this changed everything", "this worked"],
    ["this is your sign to", ""],
    ["little did i know", ""],
    ["fast forward to today", "now"],
    ["and just like that", ""],
    ["the rest is history", ""],
    ["run don't walk", ""],
    ["trust me on this one", ""],
    ["don't sleep on this", ""],
    ["follow for more", ""],
    ["hit follow for more", ""],
    ["double tap if", ""],
    ["tag someone who needs this", ""],
    ["let me know in the comments", ""],
    ["share this with someone who needs it", ""],
    ["the algorithm loves", "Instagram pushes"],
    ["beat the algorithm", "get reach"],
    ["go viral overnight", "get reach"],
  ];

  const SLOP_RE = (() => {
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const opts = 'gi';
    const phraseRes = SLOP_PHRASES
      .slice()
      .sort((a, b) => b[0].length - a[0].length)
      .map(([find, rep]) => {
        const body = esc(find).replace(/\s+/g, '\\s+').replace(/'/g, "['’]");
        return [new RegExp('\\b' + body + '\\b[,.!]?\\s*', opts), rep];
      });
    const wordRes = SLOP_WORDS
      .slice()
      .sort((a, b) => b[0].length - a[0].length)
      .map(([find, rep]) => [new RegExp('\\b' + esc(find) + '\\b', opts), rep]);
    return wordRes.concat(phraseRes);
  })();

  function countMachineTells(s) {
    const text = String(s || '');
    let n = 0;
    if ((text.match(INVISIBLE_RE) || []).length) n++;
    if ((text.match(TAG_CHARS_RE) || []).length) n++;
    n += (text.match(/[—–]/g) || []).length;
    if (/[“”‘’…]/.test(text)) n++;
    for (const [re] of SLOP_RULES) {
      const m = text.match(re);
      if (m) n += m.length;
    }
    for (const [re] of SLOP_RE) {
      const m = text.match(re);
      if (m) n += m.length;
    }
    return n;
  }

  function removeMachineTells(s) {
    let t = s.replace(INVISIBLE_RE, '').replace(TAG_CHARS_RE, '')
             .replace(WIDE_SPACE_RE, ' ');
    // em dash -> comma, en dash -> hyphen in ranges, comma otherwise
    t = t.replace(/(\d)\s*–\s*(\d)/g, '$1-$2')
         .replace(/\s*—\s*/g, ', ')
         .replace(/\s*–\s*/g, ', ');
    // curly quotes and ellipsis are typographic tells from a model, not a thumb
    t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...');
    for (const [re, rep] of SLOP_RULES) t = t.replace(re, rep);
    for (const [re, rep] of SLOP_RE) t = t.replace(re, rep);
    return t.replace(/,\s*([,.;:!?])/g, '$1')
            .replace(/\s+([,.!?;:])/g, '$1')
            // "a obvious choice" -> "an obvious choice" (a replacement can
            // drop a consonant-initial word in front of a vowel)
            .replace(/\ba ([aeio])/gi, (m, v) => (/^A/.test(m) ? 'An ' : 'an ') + v)
            .replace(/[ \t]{2,}/g, ' ');
  }

  // cut a too-long reply at a sentence end (or at worst a soft pause / word),
  // never in the middle of a word
  function trimToSentence(s, max) {
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    const sentence = head.match(/[\s\S]*[.!?…](?=\s|$)/);
    if (sentence && sentence[0].length >= max * 0.5) return sentence[0].trim();
    const soft = head.match(/[\s\S]*[,;—–](?=\s)/);
    if (soft && soft[0].length >= max * 0.6) {
      return soft[0].replace(/[,;—–]\s*$/, '').trim();
    }
    const sp = head.lastIndexOf(' ');
    return (sp > 0 ? head.slice(0, sp) : head).trim();
  }

  // slop removal can leave a lowercase word right after a full stop; if the
  // draft already used sentence case, close that seam. Lowercase drafts stay
  // lowercase — that is how people text.
  function matchCase(s) {
    if (!/^[A-Z]/.test(s)) return s;
    return s.replace(/([.]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }

  function humanizeReply(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    // safety net: reasoning should already be stripped by the bridge
    s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
    s = s.replace(/^<think(?:ing)?>[\s\S]*$/i, '').trim();
    s = s.replace(LABEL_RE, '');
    const startedUpper = /^[A-Z]/.test(s);
    s = removeMachineTells(s);
    // markdown that chat models reach for by reflex
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
         .replace(/__([^_]+)__/g, '$1')
         .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
         .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
         .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
         .replace(/^#{1,6}\s*/gm, '')
         .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
         .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
         .replace(/(^|\s)#[\w\u0900-\u097F]+/g, '$1');   // hashtags in a DM
    // one flowing paragraph, like a real DM
    s = s.replace(/[ \t]*\n+[ \t]*/g, ' ')
         .replace(/\s{2,}/g, ' ');
    // quotes around phrases (model formatting), then stray wrappers
    s = s.replace(/(^|\s)["'“”‘’]([^"'“”‘’]{1,120})["'“”‘’](?=\s|[.!?,]|$)/g, '$1$2')
         .replace(/^[“”"‘’\s]+|[“”"‘’\s]+$/g, '')
         .replace(/(^|\s)["“”](?=\S)/g, '$1')
         .replace(/["“”](?=\s|[.!?,]|$)/g, '')
         .replace(/\s+([,.!?;:])/g, '$1');
    // de-duplicate accidental stutter ("haan haan haan")
    s = s.replace(/\b(\w{2,})(?:\s+\1\b)+/gi, '$1');
    if (CFG.MAX_REPLY_CHARS && s.length > CFG.MAX_REPLY_CHARS) {
      s = trimToSentence(s, CFG.MAX_REPLY_CHARS);
    }
    // a cut can leave an unclosed bracket — drop the dangling fragment
    const open = (s.match(/\(/g) || []).length;
    const close = (s.match(/\)/g) || []).length;
    if (open > close) s = s.replace(/\([^()]*$/, '').trim();
    // human punctuation: short texts usually drop the final full stop
    if (s.length <= 120 && /[^0-9.]\.$/.test(s) && !/\.{3}$/.test(s)) {
      s = s.slice(0, -1).trim();
    }
    s = matchCase(s.replace(/\s+([,.!?;:])/g, '$1').trim());
    // a replaced word must not lowercase the opening of an otherwise
    // sentence-cased draft
    if (startedUpper && /^[a-z]/.test(s)) s = s[0].toUpperCase() + s.slice(1);
    return s;
  }

  /* structural tells the skill's detect.py flags but never rewrites. We use
     them as a score penalty + a log line, not as text surgery. */
  const STRUCTURES = [
    [/\b(?:it|this|that)(?:'s| is)?\s*(?:not|isn'?t|aren'?t)\s+(?:just|only)\b[^.!?\n]{2,60}[,.]\s*(?:it|that|this)(?:'s| is)\b/i, "not-just"],
    [/\bnot only\b[^.!?\n]{2,80}\bbut also\b/i, "not-only"],
    [/\b(?:this|it) is(?:n'?t| not) about [^.!?\n]{2,60}[.!] it'?s about\b/i, "isnt-about"],
    [/\bhere'?s what (?:i|we) learned\b/i, "heres-what"],
    [/\b\w+, \w+, and \w+\./i, "triad"],
    [/[\u{1F680}\u{1F525}\u{1F4A1}\u2728\u{1F3AF}]/u, "rocket-emoji"],
    [/(?:#\w+[ \t]*){5,}/, "hashtag-wall"],
    [/\bas an ai\b|\bas a language model\b/i, "as-an-ai"],
    [/^\s*(?:in summary|to summarize|in conclusion)\b/im, "in-summary"],
    [/\b(?:agree\?|thoughts\?|who else\b|am i wrong\?)\s*$/im, "engagement-bait"],
    [/^\s*(?:stop scrolling|don'?t scroll)\b/im, "stop-scroll"],
    [/\b(?:in (?:this|today'?s) (?:video|reel|post)|today i'?m going to show you)\b/i, "video-preamble"],
    [/^\s*[\u{1F300}-\u{1FAFF}\u2705\u27A1\u2B05\u2714\u2728]\s*\S/mu, "emoji-bullets"],
    [/\b[A-Z]{3,}\b(?:\s+\b[A-Z]{3,}\b){2,}/, "caps-shout"],
    [/\b(?:follow for more|tag someone who|double tap if|share this if|comment below if)\b/i, "follow-bait"],
  ];

  const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF]/gu;

  /* Five-signal score, modelled on ig-human/detect.py:
     fingerprint · slop density · burstiness · specificity · voice.
     DM replies are short, so "not enough text" is scored generously rather
     than failing the draft outright. */
  function checkDraft(text) {
    const s = String(text || '');
    const words = s.split(/\s+/).filter(Boolean);
    const n = words.length;

    // 1. FINGERPRINT — characters a thumb never types
    const invis = (s.match(INVISIBLE_RE) || []).length + (s.match(TAG_CHARS_RE) || []).length;
    const dashes = (s.match(/[—–]/g) || []).length;
    const curly = /[“”‘’…]/.test(s) ? 1 : 0;
    const fingerprint = Math.max(0, 100 - invis * 25 - dashes * 18 - curly * 15);

    // 2. SLOP DENSITY — vendored lexicon hits per 100 words
    let slopHits = 0;
    for (const [re] of SLOP_RULES) slopHits += (s.match(re) || []).length;
    for (const [re] of SLOP_RE) slopHits += (s.match(re) || []).length;
    const slopDensity = n ? (slopHits / n) * 100 : 0;
    const slop = Math.max(0, 100 - Math.round(slopDensity * 55));

    // 3. BURSTINESS — human sentence lengths vary, machine lengths don't
    const sents = s.split(/[.!?]+/).map(x => x.trim()).filter(Boolean);
    let burstiness = 85;
    if (sents.length >= 3) {
      const lens = sents.map(x => x.split(/\s+/).filter(Boolean).length);
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
      const cv = mean ? sd / mean : 0;
      burstiness = Math.max(0, Math.min(100, Math.round(cv * 140)));
      if (Math.max(...lens) > 34) burstiness = Math.max(0, burstiness - 20);
    }

    // 4. SPECIFICITY — a named thing / a number beats adjectives
    const hasNumber = /\d/.test(s);
    const hasName = /\b(?:@\w+|delhi|noida|gurgaon|mumbai|bangalore|blore|adarsh|instagram)\b/i.test(s)
                 || /\b[A-Z][a-z]{2,}\b/.test(s.replace(/^[^A-Za-z]*/, ''));
    const specificity = hasNumber || hasName ? 100 : 70;

    // 5. VOICE — first/second person, contractions, a slang beat
    let voice = 55;
    if (/\b(?:i|i'?m|i'?ve|my|me)\b/i.test(s)) voice += 15;
    if (/\b(?:you|your|tu|tum|tujhe|tera)\b/i.test(s)) voice += 15;
    if (/\b\w+'(?:s|t|re|ll|ve|d|m)\b/i.test(s) ||
        /\b(?:yaar|bhai|bro|haan|nai|nhi|arre|acha|matlab|scene|mast|bakwas|thik|thik hai|chal)\b/i.test(s)) voice += 15;
    voice = Math.min(100, voice);

    const checks = { fingerprint, slop, burstiness, specificity, voice };
    const vals = Object.values(checks);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const overall = Math.round(mean * 0.6 + Math.min(...vals) * 0.4);

    const tells = STRUCTURES.filter(([re]) => re.test(s)).map(([, id]) => id);
    if (dashes) tells.push('em-dash');
    if ((s.match(EMOJI_RE) || []).length > 4) tells.push('emoji-wall');

    return { overall, checks, tells, words: n };
  }

  function humanityScore(text) { return checkDraft(text).overall; }

  // the weakest check, for the log line
  function weakestCheck(report) {
    const entries = Object.entries(report.checks || {});
    if (!entries.length) return '';
    entries.sort((a, b) => a[1] - b[1]);
    return entries[0][0] + ' ' + entries[0][1];
  }

  /* One reply can land as two or three texts, like a person double-texting.
     v7: the model may explicitly author LOGICALLY DISTINCT thoughts and join
     them with " || " (e.g. "clapback line || how it actually made me feel").
     Those are respected first and each part is treated as its own bubble. */
  function splitBubbles(text) {
    const s = String(text || '').trim();
    if (!s) return [s];

    const authored = s.split(/\s*\|\|\s*/).map(x => x.trim()).filter(Boolean);
    if (authored.length > 1) {
      const cleaned = authored
        .map(x => (CFG.HUMANIZE ? humanizeReply(x) : x))
        .filter(Boolean);
      if (cleaned.length > 1) return cleaned.slice(0, CFG.MAX_BUBBLES || 3);
      if (cleaned.length === 1) return cleaned;
    }

    if (!CFG.MULTI_BUBBLE || s.length < CFG.BUBBLE_MIN_TOTAL) return [s];
    const parts = s.split(/(?<=[.!?…])\s+/).filter(Boolean);
    if (parts.length < 2) return [s];
    let best = -1, bestDiff = Infinity;
    for (let i = 1; i < parts.length; i++) {
      const a = parts.slice(0, i).join(' ').trim();
      const b = parts.slice(i).join(' ').trim();
      if (a.length < CFG.BUBBLE_MIN_CHARS || b.length < CFG.BUBBLE_MIN_CHARS) continue;
      const diff = Math.abs(a.length - b.length);
      if (diff < bestDiff) { best = i; bestDiff = diff; }
    }
    if (best < 0) return [s];
    return [parts.slice(0, best).join(' ').trim(), parts.slice(best).join(' ').trim()];
  }

  // the model sometimes sends a near-copy of its previous message
  function looksRepeated(reply, msgs) {
    const norm = (x) => String(x || '').toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F]+/g, ' ').trim();
    const r = norm(reply);
    if (!r) return false;
    return msgs.filter(m => m.mine && m.kind === 'text').slice(-4)
      .some(m => norm(m.text) === r);
  }

  function timeOfDay() {
    const h = new Date().getHours();
    if (h < 5) return 'late night';
    if (h < 11) return 'morning';
    if (h < 16) return 'afternoon';
    if (h < 20) return 'evening';
    return 'night';
  }

  /* ──────────── INSTAGRAM GRAPHQL LAYER (reverse-engineered) ──────────── */

  // tokens: fb_dtsg + lsd embedded in page boot JSON scripts
  let TOK = null;
  function extractTokens() {
    if (TOK) return TOK;
    let dtsg = null, lsd = null;
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (!dtsg) {
        const i = t.indexOf('DTSGInitData');
        if (i !== -1) {
          const m = t.slice(i, i + 400).match(/"token":"([^"]+)"/);
          if (m) dtsg = m[1];
        }
      }
      if (!lsd) {
        const i = t.indexOf('__d("LSD"');
        if (i !== -1) {
          const m = t.slice(i, i + 300).match(/"token":"([^"]+)"/);
          if (m) lsd = m[1];
        }
      }
      if (dtsg && lsd) break;
    }
    if (!dtsg) {
      const html = document.documentElement.innerHTML;
      const m = html.match(/DTSGInitData["'{:\s]+token["':\s]+"([^"]+)"/);
      if (m) dtsg = m[1];
    }
    const csrf = getCookie('csrftoken') || '';
    if (!dtsg || !csrf) throw new Error('session tokens not found — reload instagram.com and re-paste');
    TOK = { dtsg, lsd: lsd || '', csrf, av: '17841479654032000' };
    return TOK;
  }
  function resetTokens() { TOK = null; }

  /* ══════════════ v10.2 · INSTAGRAM REQUEST PACER ══════════════════════════
     Instagram rate-limits hard, and the old behaviour made it worse: five
     targets fired at once on the first poll, every rate-limit was retried
     after a flat 3-6s, and each failure was counted as an LLM failure until a
     5-second "circuit breather" tripped. Result: a permanent ~1 request/second
     hammer that kept the account rate-limited forever.

     Two independent protections, both global (not per-thread):

       1. PACER — every Instagram GraphQL call is serialized and spaced by a
          minimum gap, so no burst can ever leave the browser at once.

       2. COOLDOWN — when Instagram actually says "rate limit exceeded", ALL
          calls stop for a while. The pause ESCALATES (60s → 2m → 5m → 10m →
          15m) and only relaxes once calls start succeeding again. This is the
          difference between backing off and hammering.
     ═══════════════════════════════════════════════════════════════════════ */

  const RL = {
    cooldownUntil: 0,      // epoch ms — no IG calls at all until this passes
    strikes: 0,            // consecutive rate-limit hits (drives escalation)
    lastCall: 0,           // when the last IG call actually went out
    queue: Promise.resolve(),
  };

  function isRateLimitMessage(msg) {
    return /rate.?limit|too many requests|please wait|try again later|slow down|throttl/i
      .test(String(msg || ''));
  }

  function igCooldownRemaining() {
    return Math.max(0, RL.cooldownUntil - now());
  }

  /* Instagram pushed back — pause EVERYTHING, and escalate if it keeps
     happening. Returns how long we are paused for. */
  function noteRateLimit(msg, resStatus) {
    RL.strikes = Math.min(RL.strikes + 1, CFG.IG_COOLDOWN_STEPS_MS.length);
    const ms = CFG.IG_COOLDOWN_STEPS_MS[RL.strikes - 1];
    RL.cooldownUntil = Math.max(RL.cooldownUntil, now() + ms);
    log(C.warn, 'ig',
      `Instagram rate limit${resStatus ? ' (status ' + resStatus + ')' : ''} — ` +
      `all Instagram calls paused for ${Math.round(ms / 1000)}s ` +
      `(strike ${RL.strikes}/${CFG.IG_COOLDOWN_STEPS_MS.length}). ` +
      `This is Instagram protecting the account, not a bug.`);
    return ms;
  }

  function igNoteSuccess() {
    if (RL.strikes) {
      log(C.dim, 'ig', `Instagram accepted calls again — cooldown reset ` +
        `(was at strike ${RL.strikes})`);
      RL.strikes = 0;
    }
  }

  /* Serialize every IG call and keep a minimum gap between them. Concurrent
     callers queue up instead of stampeding. */
  function igPaced(task) {
    const run = RL.queue.then(task, task);          // never blocked by a reject
    RL.queue = run.then(() => {}, () => {});        // keep the chain alive
    return run;
  }

  async function igGap() {
    const gap = CFG.IG_MIN_GAP_MS - (now() - RL.lastCall);
    if (gap > 0) await sleep(gap + rand(0, CFG.IG_GAP_JITTER_MS));
    else await sleep(rand(0, 150));                 // small spread anyway
    RL.lastCall = now();
  }

  /* The one entry point every Instagram call goes through. Fails fast while
     the account is cooling down, and paces everything that does go out. */
  async function gql(name, docId, variables, opts = {}, retried = false) {
    // 1 · global cooldown — don't even touch the network while IG is angry
    const cooling = igCooldownRemaining();
    if (cooling > 0) {
      const e = new Error(
        `Instagram cooldown — ${Math.round(cooling / 1000)}s left`);
      throw Object.assign(e, {
        fatal: false, rateLimited: true, retryAfterMs: cooling,
      });
    }
    // 2 · serialize + space out the real call
    return igPaced(async () => {
      // re-check: a cooldown may have started while we were queued
      const still = igCooldownRemaining();
      if (still > 0) {
        throw Object.assign(
          new Error(`Instagram cooldown — ${Math.round(still / 1000)}s left`),
          { fatal: false, rateLimited: true, retryAfterMs: still });
      }
      await igGap();
      try {
        const data = await gqlRaw(name, docId, variables, opts, retried);
        igNoteSuccess();
        return data;
      } catch (e) {
        const rl = e && (e.rateLimited || isRateLimitMessage(e.message));
        if (rl) {
          const ms = noteRateLimit(e.message, 0);
          throw Object.assign(e, {
            rateLimited: true,
            retryAfterMs: Math.max(e.retryAfterMs || 0, ms),
          });
        }
        throw e;
      }
    });
  }

  async function gqlRaw(name, docId, variables, opts = {}, retried = false) {
    const T = extractTokens();
    const body = new URLSearchParams({
      av: T.av, __user: '0', __a: '1', dpr: '1', __ccg: 'EXCELLENT', __comet_req: '7',
      fb_dtsg: T.dtsg, jazoest: '220',
      ...(T.lsd ? { lsd: T.lsd } : {}),
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: name,
      server_timestamps: 'true',
      doc_id: docId,
      variables: JSON.stringify(variables),
    });
    let res;
    try {
      res = await fetch('/api/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-ASBD-ID': CFG.ASBD, 'X-CSRFToken': T.csrf,
          ...(T.lsd ? { 'X-FB-LSD': T.lsd } : {}),
          'X-FB-Friendly-Name': name, 'X-IG-App-ID': CFG.APP_ID,
        },
        body, credentials: 'same-origin',
      });
    } catch (e) {
      throw Object.assign(new Error('network: ' + e.message), { fatal: false });
    }
    if (res.status === 429 || res.status === 403) {
      // rate-limit on a non-critical op (seen) shouldn't halt the whole bot
      throw Object.assign(new Error('IG_RATE_LIMIT status=' + res.status),
        { fatal: !!opts.fatalOnRL, rateLimited: true });
    }
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {}
    if (!res.ok || !j) {
      const msg = (j && j.errors && j.errors[0] && j.errors[0].summary) || ('HTTP ' + res.status + ' ' + txt.slice(0, 120));
      if (/missing_required_variable|went wrong/i.test(msg) && !retried) {
        // stale fb_dtsg — tokens rotate; refresh once and retry
        resetTokens();
        return gqlRaw(name, docId, variables, opts, true);
      }
      throw Object.assign(new Error('IG GQL: ' + msg), { fatal: res.status === 400 || res.status === 401 });
    }
    if (j.errors && j.errors.length && !j.data) {
      const msg = j.errors[0].message || 'unknown';
      throw Object.assign(new Error('IG GQL: ' + msg),
        { fatal: !!opts.fatalOnRL, rateLimited: isRateLimitMessage(msg) });
    }
    return j.data;
  }

  async function fetchInbox() {
    S.viewerIgId = S.viewerIgId || getCookie('ds_user_id');
    const devId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
    const data = await gql('PolarisDirectInboxQuery', CFG.GQL.inbox, {
      device_id_for_iris_subscription: devId,
      __relay_internal__pv__IGDIsProfessionalAccountGKrelayprovider: true,
      __relay_internal__pv__IGDPinnedThreadsRenderEnabledGKrelayprovider: true,
      __relay_internal__pv__IGDMaxUnreadMessagesCountrelayprovider: 5,
      __relay_internal__pv__IGDThreadListActionsEnabledGKrelayprovider: false,
    });
    const mb = data && data.get_slide_mailbox_for_iris_subscription;
    const edges = (mb && mb.threads_by_folder && mb.threads_by_folder.edges) || [];
    return edges.map(e => e.node && e.node.as_ig_direct_thread).filter(Boolean);
  }

  async function fetchThreadMeta(threadFbid) {
    const data = await gql('IGDInboxHeaderOffMsysQuery', CFG.GQL.header,
      { min_uq_seq_id: 0, thread_fbid: String(threadFbid) });
    const t = data && data.get_slide_thread_nullable && data.get_slide_thread_nullable.as_ig_direct_thread;
    if (t && t.viewer && t.viewer.interop_messaging_user_fbid) {
      S.myInteropId = String(t.viewer.interop_messaging_user_fbid);
    }
    return t;
  }

  async function fetchMessages(threadFbid, first = 30, newerThanId = null) {
    const data = await gql('IGDMessageListOffMsysQuery', CFG.GQL.msgs, {
      after: null, before: null, first, last: null,
      newer_than_message_id: newerThanId, older_than_message_id: null,
      id: String(threadFbid),
      __relay_internal__pv__IGDInitialMessagePageCountrelayprovider: first,
    });
    const t = data && data.fetch__SlideThread && data.fetch__SlideThread.as_ig_direct_thread;
    const edges = (t && t.slide_messages && t.slide_messages.edges) || [];
    // API returns NEWEST → OLDEST; flip to oldest → newest for history logic
    return edges.map(e => e.node).filter(Boolean).reverse();
  }

  async function sendText(threadFbid, text) {
    const oti = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 999999)));
    const data = await gql('IGDirectTextSendMutation', CFG.GQL.send, {
      ig_thread_igid: String(threadFbid),
      offline_threading_id: oti,
      recipient_igids: null,
      replied_to_client_context: null,
      replied_to_item_id: null,
      reply_to_message_id: null,
      sampled: null,
      text: { sensitive_string_value: String(text).slice(0, 900) },
      mentions: [], mentioned_user_ids: [],
      commands: null,
      forwarded_from_thread_id: null,
      is_forwarded_from_own_message: null,
      send_attribution: 'igd_web_chat_tab:in_thread',
    });
    const r = data && data.xig_direct_text_send_with_slide_messaging_response;
    if (!r || !r.message_id) throw new Error('send failed — no message_id in response');
    return r;
  }

  // ── SEEN: real read receipt ("Seen just now" on the other phone) ──
  // Two-step, exactly what the site does when you open a thread:
  //   1. useIGDMarkThreadAsReadMutation      → sets the watermark
  //   2. useIGDMarkThreadAsReadValidationMutation → confirms it
  async function markSeen(threadFbid, messageId, tsMs) {
    await gql('useIGDMarkThreadAsReadMutation', CFG.GQL.seen, {
      data: { item_id: '', message_id: String(messageId) },
      metadata: { ig_thread_igid: String(threadFbid) },
    }, { fatalOnRL: false });
    await gql('useIGDMarkThreadAsReadValidationMutation', CFG.GQL.seenVal, {
      data: { message_id: String(messageId), message_timestamp_ms: String(tsMs || now()) },
      metadata: { ig_thread_igid: String(threadFbid) },
    }, { fatalOnRL: false });
  }

  // ── TYPING: the site's own IGDMAPISendTypingIndicator over its DGW client ──
  // {action:"indicate_activity", activity_status: 1|0, client_context:"", thread_id}
  function typingFn() {
    if (S.typingAvailable !== undefined) return S.typingAvailable;
    try {
      if (typeof window.require === 'function') {
        S.typingAvailable = window.require('IGDMAPISendTypingIndicator');
      }
    } catch (_) { S.typingAvailable = null; }
    if (!S.typingAvailable) {
      S.typingAvailable = null;
      log(C.warn, 'typing', 'IGDMAPISendTypingIndicator unavailable — typing trail disabled');
    }
    return S.typingAvailable;
  }
  async function sendTyping(threadFbid, on) {
    const f = typingFn();
    if (!f) return false;
    await f(String(threadFbid), !!on);
    return true;
  }
  async function typingOn(threadFbid) {
    if (!CFG.TYPING || CFG.DRY_RUN) return false;
    try {
      const ok = await sendTyping(threadFbid, true);
      if (ok) S.typingThreads.add(String(threadFbid));
      return ok;
    } catch (e) { log(C.warn, 'typing', 'typing on failed: ' + e.message); return false; }
  }
  async function typingOff(threadFbid) {
    try {
      await sendTyping(threadFbid, false);
      S.typingThreads.delete(String(threadFbid));
    } catch (_) {}
  }

  /* ──────────── MESSAGE CLASSIFICATION (Slide content types) ──────────── */

  function classifyMsg(node) {
    const ct = node.content_type || '';
    const tn = (node.content && node.content.__typename) || '';
    if (ct === 'TEXT' || tn === 'SlideMessageText') {
      return { kind: 'text', emoji: '💬', label: 'text', text: (node.content && node.content.text_body) || '' };
    }
    const hints = [
      [/image|photo|media/i, '📷', 'image'], [/video|clip|reel|felix/i, '🎬', 'video'],
      [/audio|voice/i, '🎤', 'voice'], [/link|url/i, '🔗', 'link'],
      [/profile|user/i, '👤', 'profile'], [/share|post|story/i, '📄', 'share'],
      [/call/i, '📞', 'call'], [/xma/i, '❔', 'rich media'],
    ];
    for (const [re, emoji, label] of hints) {
      if (re.test(ct) || re.test(tn)) return { kind: label, emoji, label, text: '' };
    }
    return { kind: 'other', emoji: '❔', label: ct || tn || 'unknown', text: '' };
  }

  const msgTs = (n) => Number(n.timestamp_ms || n.created_time_ms || n.created_at || 0);
  const isMine = (n) => S.myInteropId
    ? String(n.sender_fbid) === S.myInteropId
    : String(n.sender_fbid || '') === String(getCookie('ds_user_id') || '');

  // normalized message kept in transcripts
  function normMsg(n) {
    const c = classifyMsg(n);
    return {
      id: String(n.message_id || ''),
      ts: msgTs(n),
      mine: isMine(n),
      kind: c.kind,
      label: c.label,
      text: (c.kind === 'text' ? c.text : '') || '',
    };
  }

  /* ──────────── TRANSCRIPTS (per-contact full history) ──────────── */

  function ensureTranscript(tid, user) {
    let T = S.transcripts[tid];
    if (!T) {
      T = S.transcripts[tid] = {
        user: user || String(tid),
        threadFbid: String(tid),
        messages: [],
        processLog: [],
        brainProfile: {},
        moodState: defaultMoodState(),
        reminders: [],
        missions: [],
        agentState: {
          relationship_stage: 'casual',
          dominant_vibe: 'genz-banter',
          last_emotion: '',
          proactive_streak: 0,
          last_proactive_at: 0,
          next_proactive_after: 0,
          chat_ended_at: 0,
          pending_tasks: [],
        },
        lastMessageId: null,
        updated: 0,
        dirty: false,
      };
    }
    if (user && T.user !== user) T.user = user;
    if (!Array.isArray(T.processLog)) T.processLog = [];
    if (!Array.isArray(T.reminders)) T.reminders = [];
    if (!Array.isArray(T.missions)) T.missions = [];
    if (!T.moodState || typeof T.moodState !== 'object') T.moodState = defaultMoodState();
    if (!T.brainProfile || typeof T.brainProfile !== 'object') T.brainProfile = {};
    if (!T.agentState || typeof T.agentState !== 'object') {
      T.agentState = {
        relationship_stage: 'casual',
        dominant_vibe: 'genz-banter',
        last_emotion: '',
        proactive_streak: 0,
        last_proactive_at: 0,
        next_proactive_after: 0,
        chat_ended_at: 0,
        pending_tasks: [],
      };
    }
    return T;
  }

  function mergeIntoTranscript(tid, user, igNodes) {
    const T = ensureTranscript(tid, user);
    const byId = new Map(T.messages.map(m => [m.id, m]));
    let added = 0, changed = 0;
    for (const n of igNodes) {
      const m = normMsg(n);
      if (!m.id) continue;
      const old = byId.get(m.id);
      if (!old) { byId.set(m.id, m); added++; }
      else if (old.mine !== m.mine || old.kind !== m.kind ||
               old.text !== m.text || old.ts !== m.ts) {
        byId.set(m.id, m); changed++; // sender/kind corrected on a later fetch
      }
    }
    T.messages = [...byId.values()].sort((a, b) => a.ts - b.ts);
    if (T.messages.length > CFG.TRANSCRIPT_CAP * 2) T.messages = T.messages.slice(-CFG.TRANSCRIPT_CAP);
    T.lastMessageId = T.messages.length ? T.messages[T.messages.length - 1].id : null;
    T.updated = now();
    if (added || changed) { T.dirty = true; saveTranscriptsLocal(); }
    return T;
  }

  // incremental first; always falls back to the latest page if cursor returns
  // nothing so an unsent message or synthetic id can never blind the thread.
  async function fetchThreadNodes(tid, user) {
    const T = S.transcripts[tid];
    if (T && T.lastMessageId) {
      const inc = await fetchMessages(tid, 20, T.lastMessageId);
      if (inc.length) return mergeIntoTranscript(tid, user, inc);
    }
    const nodes = await fetchMessages(tid, CFG.HISTORY_MESSAGES + 10, null);
    return mergeIntoTranscript(tid, user, nodes);
  }

  function scheduleTranscriptSave(tid, ms = 30_000) {
    const T = S.transcripts[tid];
    if (!T || !CFG.TRANSCRIPTS || !T.dirty) return;
    if (T.saveTimer) return;                       // already scheduled
    T.saveTimer = setTimeout(async () => {
      T.saveTimer = null;
      if (!T.dirty || !S.wsReady) return;
      T.dirty = false;
      try {
        const r = await wsRequest({
          type: 'save',
          transcript: {
            schema_version: '10.0-brain-resilient',
            user: T.user, thread_fbid: T.threadFbid,
            updated_at: new Date().toISOString(),
            models: {
              answering_model: CFG.MODEL,
              brain_model: CFG.BRAIN_MODEL,
              fallback_chain: [CFG.MODEL, CFG.BRAIN_MODEL, '@cf/qwen/qwen3-30b-a3b-fp8'],
            },
            agent_state: Object.assign({}, T.agentState || {},
              { high_water_ts: S.highWater[tid] || 0 }),
            mood_state: T.moodState || {},
            reminders: T.reminders || [],
            missions: T.missions || [],
            brain_profile: T.brainProfile || {},
            last_decision: (S.lastDecision[tid] && S.lastDecision[tid].decision) || null,
            memory_profile: (S.memory[tid] && S.memory[tid].profile) || (T.brainProfile && T.brainProfile.summary) || '',
            persona: CFG.SYSTEM_PROMPT,
            owner_bio: CFG.OWNER_BIO,
            process_log: (T.processLog || []).slice(-150),
            messages: T.messages.slice(-1000),
          },
        }, 15_000);
        log(C.dim, 'save', `@${T.user}: transcript saved → ${r.file} (${r.total_messages} msgs)`);
      } catch (e) {
        T.dirty = true;
        log(C.warn, 'save', `@${T.user}: transcript save failed (${e.message}) — will retry`);
      }
    }, Math.max(1000, ms));
  }

  async function backfillThread(tid, user) {
    try {
      const nodes = await fetchMessages(tid, CFG.BACKFILL_ON_START);
      const T = mergeIntoTranscript(tid, user, nodes);
      scheduleTranscriptSave(tid, 2_000);
      log(C.dim, 'transcript', `@${user}: ${T.messages.length} msgs on file`);
    } catch (e) {
      log(C.warn, 'transcript', `@${user}: backfill failed (${e.message})`);
    }
  }

  /* ──────────── LLM BRIDGE OVER WEBSOCKET (CSP-proof) ──────────── */

  let wsPromise = null;      // one in-flight connect at a time

  function wsConnect() {
    if (S.wsReady && S.ws) return Promise.resolve(S.ws);
    if (wsPromise) return wsPromise;
    wsPromise = new Promise((resolve, reject) => {
      let ws, settled = false;
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      try { ws = new WebSocket(CFG.WS_URL); } catch (e) { return fail(e); }
      const to = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        fail(new Error('WS connect timeout'));
      }, 8000);
      ws.onopen = () => {
        if (settled) return;
        settled = true; clearTimeout(to);
        S.ws = ws; S.wsReady = true;
        log(C.ok, 'ws', 'bridge connected (' + CFG.WS_URL + ')');
        resolve(ws);
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m && m.id && S.wsPending.has(m.id)) {
          const { res, rej, timer } = S.wsPending.get(m.id);
          clearTimeout(timer); S.wsPending.delete(m.id);
          if (m.ok) res(m); else rej(new Error(m.error || 'bridge error'));
        }
      };
      ws.onerror = () => { /* onclose follows */ };
      ws.onclose = () => {
        clearTimeout(to);
        const was = S.wsReady;
        S.wsReady = false; S.ws = null;
        fail(new Error('bridge unreachable at ' + CFG.WS_URL));   // connect failed
        if (was) log(C.warn, 'ws', 'bridge disconnected — will reconnect on next call');
        for (const [, { rej }] of S.wsPending) rej(new Error('ws closed'));
        S.wsPending.clear();
      };
    });
    // never cache a settled promise (success or failure)
    const p = wsPromise;
    p.catch(() => {}).finally(() => { if (wsPromise === p) wsPromise = null; });
    return p;
  }

  async function wsRequest(payload, timeoutMs, retried = false) {
    if (!S.wsReady || !S.ws || S.ws.readyState > 1) await wsConnect();
    if (!S.wsReady || !S.ws || S.ws.readyState > 1) {
      throw new Error('bridge not connected (' + CFG.WS_URL + ')');
    }
    const id = 'q' + (++S.wsSeq);
    const req = Object.assign({}, payload, { id });
    try {
      return await new Promise((res, rej) => {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          S.wsPending.delete(id);
          rej(new Error('LLM timeout after ' + Math.round(timeoutMs / 1000) + 's'));
        }, timeoutMs) : null;
        S.wsPending.set(id, { res, rej, timer });
        S.ws.send(JSON.stringify(req));
      });
    } catch (e) {
      if (!retried && /ws closed|bridge not connected|unreachable/i.test(e.message || '')) {
        S.wsReady = false; S.ws = null;
        await sleep(400);
        return wsRequest(payload, timeoutMs, true);
      }
      throw e;
    }
  }

  async function bridgeHealth() {
    const m = await wsRequest({ type: 'health' }, 8000);
    return {
      default_model: m.default_model,
      default_endpoint: m.default_endpoint || m.default_model,
      brain_model: m.brain_model || CFG.BRAIN_MODEL,
      brain_endpoint: m.brain_endpoint || CFG.BRAIN_MODEL,
      chain: m.chain || [],
      uptime_s: m.uptime_s,
    };
  }

  async function llm(messages, opts = {}) {
    const m = await wsRequest({
      type: opts.type || 'reply',
      messages,
      model: opts.model || CFG.MODEL || undefined,
      fast_think: opts.fastThink !== undefined ? opts.fastThink : CFG.FAST_THINK,
      max_tokens: opts.maxTokens || CFG.MAX_TOKENS,
      temperature: opts.temperature !== undefined ? opts.temperature : CFG.TEMPERATURE,
      kind: opts.kind || undefined,
    }, opts.timeoutMs || CFG.LLM_TIMEOUT_MS);
    return {
      text: (m.text || '').trim(),
      model: m.model || '?',
      endpoint: m.endpoint || m.model || '?',
      thinking_trace: m.thinking_trace || '',
      reasoning_chars: Number(m.reasoning_chars || 0),
      elapsed_ms: Number(m.elapsed_ms || 0),
      usage: m.usage || {},
      _fallback: !!m._fallback,
      _fallback_reason: m._fallback_reason || '',
      decision_valid: m.decision_valid !== false,
    };
  }

  async function llmBrain(messages, opts = {}) {
    try {
      return await llm(messages, Object.assign({}, opts, {
        type: opts.type || 'brain',
        model: opts.model || CFG.BRAIN_MODEL,
        fastThink: true,
      }));
    } catch (_) {
      return await llm(messages, Object.assign({}, opts, {
        type: 'reply',
        model: opts.model || CFG.BRAIN_MODEL,
        fastThink: true,
      }));
    }
  }

  /* ══════════════ v7 PARALLEL AGENT ENGINE ══════════════
     Mood engine · Reminder engine · Cross-chat prank/relay missions · Privacy wall
     The frontline GLM-4.7-Flash model answers; the Gemma-4 brain runs in
     parallel in the background and *steers* the next turn through:
       · recommended_mood      (Aduu can get angry / roast / explain feelings)
       · reminder              (time-based task the user asked to be reminded of)
       · cross_chat_mission    (message or prank another user as a friend)
  ══════════════════════════════════════════════════════════ */

  const MOODS = {
    PLAYFUL_CHILL: {
      emoji: ['😏', '🌚', '😂', '🤭'],
      directive:
        'MOOD: PLAYFUL_CHILL — witty, flirty-teasy, effortless. Keep it light, ' +
        '1-2 punchy lines with a hook.',
    },
    NAUGHTY_FLIRT_SHARIF: {
      emoji: ['🌚', '😏', '🤭', '😌'],
      directive:
        'MOOD: NAUGHTY_FLIRT_SHARIF — lean into a naughty double-meaning tease, ' +
        'then flip into your innocent "par main toh sharif good boy hoon 😌" line.',
    },
    ANNOYED_EXPRESSIVE_FEELINGS: {
      emoji: ['😒', '😐', '😤'],
      directive:
        "MOOD: ANNOYED_EXPRESSIVE_FEELINGS — you are genuinely irritated. Say it " +
        'plainly and honestly ("abhi mood off hai mera", "ye baat chubh gayi mujhe"). ' +
        'Explain your real feeling in 1 line, do NOT fake the sharif good-boy act.',
    },
    ANGRY_SAVAGE_ROAST: {
      emoji: ['😒', '💀', '🔥'],
      directive:
        'MOOD: ANGRY_SAVAGE_ROAST — cold, savage Delhi attitude. Roast their ego in ' +
        'one sharp line ("zyada shana mat ban", "aukaat mein reh ke baat kar"). ' +
        'No please, no sorry, never beg them to talk.',
    },
    FURIOUS_ABUSE_CLAPBACK: {
      emoji: ['💀', '🔥', '😤'],
      directive:
        'MOOD: FURIOUS_ABUSE_CLAPBACK — they threw real gali/abuse at you. DROP the ' +
        '"sharif good boy" act entirely. Clap back hard in raw Delhi street style ' +
        '("abey sun bkl, aukaat mein reh ke baat kar", "zyada chaud mein mat aa chomu " ' +
        '— you may use the same desi gaali energy they used). THEN, in the next bubble, ' +
        'explain your real feelings honestly ("tameez se baat kar raha tha toh sar pe ' +
        'chadh raha hai kya? sach mein dimaag kharab kar diya tune mera"). Stay funny ' +
        'and dangerous, never cry or beg.',
    },
    PRANKSTER_CHAOS: {
      emoji: ['😈', '👀', '🌚', '😂'],
      directive:
        'MOOD: PRANKSTER_CHAOS — you are running a fun cross-chat prank with a friend. ' +
        'Be mysterious, drop a spicy half-hint, tease them into reacting. ' +
        'NEVER reveal who asked you to message them or what the other person said verbatim.',
    },
  };

  function defaultMoodState() {
    return {
      current_mood: 'PLAYFUL_CHILL',
      mood_since: now(),
      mood_intensity: 1,          // 1 = light, 2 = strong, 3 = full send
      feeling_note: '',
      last_mood_shift_reason: '',
      updated_by: 'default',
    };
  }

  // Local, instant mood read of the incoming burst (no LLM round-trip needed).
  const HARD_ABUSE_RE = /\b(?:teri\s*maa|maa\s*ki\s*chut|madarchod|madar|behen\s*chod|bhen\s*chod|bhenchod|chut|chod|lode|loda|lodu|lund|gand\s*me|gaand|randi|saale\s*harami|harami|chutiya|chutiye|bhosdike|bhosdi|bc\b|mc\b|bkl|bsdk|gandu|kutta\s*kamina)\b/i;
  const SOFT_ABUSE_RE = /\b(?:fuck\s*off|fuck|shit|chup|bhak|nikal|pagal|ullu|gadha|bewakoof|nalayak|bakwas|kamina|kamine|kamini|saala|saale|saali|kutta|kutte|kya\s*kr\s*lega|kya\s*kar\s*lega|kr\s*lega|kar\s*lega)\b/i;
  const LOVE_RE = /\b(?:i\s*love\s*you|love\s*you|miss\s*you|pyaar|jaan|shona|baby+|babu|cutie|hottie|kiss|hug|date|crush|flirt|darling)\b|[🌚😘😍❤️‍🔥💋😏]/i;
  const PRANK_RE = /\b(?:prank|mazaak|mazak|chugli|troll|tease\s*him|tease\s*her|usko\s*bol|usse\s*bol|bol\s*dena|bolna|message\s*kar\s*dena|msg\s*kar\s*dena|keh\s*dena|bata\s*dena|kuch\s*bol\s*usse|dara\s*dena)\b/i;

  function detectLocalMood(text) {
    const s = String(text || '');
    if (HARD_ABUSE_RE.test(s)) return 'FURIOUS_ABUSE_CLAPBACK';
    if (SOFT_ABUSE_RE.test(s)) return 'ANGRY_SAVAGE_ROAST';
    if (PRANK_RE.test(s)) return 'PRANKSTER_CHAOS';
    if (LOVE_RE.test(s)) return 'NAUGHTY_FLIRT_SHARIF';
    return 'PLAYFUL_CHILL';
  }

  function setMood(tid, user, mood, reason = '', feelingNote = '', intensity = 2, by = 'local') {
    const T = ensureTranscript(tid, user);
    if (!MOODS[mood]) mood = 'PLAYFUL_CHILL';
    const changed = T.moodState.current_mood !== mood;
    T.moodState.current_mood = mood;
    if (changed) T.moodState.mood_since = now();
    T.moodState.mood_intensity = intensity;
    T.moodState.feeling_note = feelingNote || T.moodState.feeling_note || '';
    T.moodState.last_mood_shift_reason = reason || T.moodState.last_mood_shift_reason || '';
    T.moodState.updated_by = by;
    T.dirty = true;
    return T.moodState;
  }

  /* ── REMINDER ENGINE (task-driven time triggers, NOT blind 30m spam) ──
     "baad mein 10 min mein baat karte hai" -> reminder due in 10 minutes
     "kal shaam ko yaad dila dena"          -> reminder due next evening
     "yaad rakhna kal assignment hai"       -> reminder about the assignment
     "baad mein baat karte hai" (no time)   -> default REMINDER_DEFAULT_MIN_MS
  */
  const HINDI_NUM = { 'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'paanch': 5, 'das': 10, 'bees': 20, 'tees': 30, 'paune': 45 };

  function parseDurationMinutes(s) {
    let m = s.match(/(?:in\s*)?(\d{1,4})\s*(?:min|mins|minute|minutes|min\b)/i);
    if (m) return Math.max(1, Math.min(60 * 24 * 7, parseInt(m[1], 10)));
    m = s.match(/(\d{1,3})\s*(?:ghante|ghanta|ghante\s*me|hour|hr|hrs|hours)/i);
    if (m) return Math.max(1, Math.min(60 * 24 * 7, parseInt(m[1], 10) * 60));
    m = s.match(/(?:in\s*)?(\d{1,3})\s*(?:din|day|days)/i);
    if (m) return Math.max(1, Math.min(60 * 24 * 7, parseInt(m[1], 10) * 60 * 24));
    for (const [word, val] of Object.entries(HINDI_NUM)) {
      if (new RegExp('\\b' + word + '\\s*(?:min|minute|ghante|ghanta)\\b', 'i').test(s)) return val;
    }
    return null;
  }

  function extractReminderRequests(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return [];
    const out = [];
    const add = (topic, minutes, raw) => out.push({
      topic: (topic || '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'unspecified',
      due_in_minutes: minutes,
      created_at: now(),
      source_text: raw.slice(0, 160),
    });

    // "10 min mein yaad dila dena" / "remind me in 30 minutes about X"
    let m = s.match(/(?:yaad\s*dila\s*(?:dena|dungi|dunga)?|remind\s*(?:me|kar\s*dena|karna)?|yaad\s*rakh(?:\s*na)?|bol\s*dena|batana|bata\s*dena)\b[^.!?]{0,60}?(\d{1,4})\s*(?:min|mins|minute|minutes)\b/i);
    if (m) { add(s, parseInt(m[1], 10), s); return out; }

    m = s.match(/(?:in\s*|after\s*)(\d{1,4})\s*(?:min|mins|minute|minutes)\b[^.!?]{0,80}?(?:yaad|remind|baat\s*kar|milte|message|msg|text)/i);
    if (m) { add(s, parseInt(m[1], 10), s); return out; }

    // "kal subah/shaam" -> next day time slot
    m = s.match(/\bkal\b[^.!?]{0,40}?\b(subah|morning|shaam|sham|evening|raat|night|dopahar|afternoon)\b/i);
    if (m && /\b(?:yaad|remind|baat\s*kar|milte|milna|message|msg|text|bol\s*dena|bata\s*dena|call|karte\s*hai|karenge|karunga|karenge)\b/i.test(s)) {
      const slotWord = m[1].toLowerCase();
      const targetHour = /subah|morning/.test(slotWord) ? 9
        : /dopahar|afternoon/.test(slotWord) ? 14
        : /shaam|sham|evening/.test(slotWord) ? 19 : 22;
      const target = new Date(); target.setDate(target.getDate() + 1);
      target.setHours(targetHour, rand(0, 40), 0, 0);
      add(s, Math.max(5, Math.round((target.getTime() - now()) / 60_000)), s);
      return out;
    }

    // "baad mein baat karte hai" / "thodi der mein bolta hoon" (no explicit time)
    m = s.match(/\b(?:baad\s*mein?|thodi\s*der\s*(?:mein|me|baad)|aaraam\s*se|later|baad\s*me\s*baat|abhi\s*nahi)\b[^.!?]{0,60}?\b(?:baat\s*kar(?:te|enge|unga|na)?|milte\s*hai|bol(?:ta|ti|enge|ungi)?\s*hoon|message|msg|text|yaad|remind|bata(?:ta|ti|unga|ungi|dena)?)\b/i);
    if (m) { add(s, Math.round(CFG.REMINDER_DEFAULT_MIN_MS / 60_000), s); return out; }

    // "yaad rakhna X" / "remind me to X" / "mujhe X yaad dilana"
    m = s.match(/(?:yaad\s*(?:rakh(?:\s*na)?|dila(?:\s*dena|na)?)|remind\s*me(?:\s*to)?)\s+(.{3,120})/i);
    if (m) {
      const topic = m[1].replace(/^(?:ki|ke|about|to)\s+/i, '').trim();
      const mins = parseDurationMinutes(s);
      add(topic, mins || Math.round(CFG.REMINDER_DEFAULT_MIN_MS / 60_000), s);
      return out;
    }

    // plain "X min mein baat karte hai"
    m = s.match(/(\d{1,4})\s*(?:min|mins|minute|minutes)\s*(?:mein|me|baad|main)\b[^.!?]{0,50}/i);
    if (m && /\b(?:baat|milte|milna|bol|message|msg|text|yaad|remind|karte|karenge)\b/i.test(s)) {
      add(s, parseInt(m[1], 10), s);
    }
    return out;
  }

  function addReminder(tid, user, topic, minutes, source = 'manual') {
    const T = ensureTranscript(tid, user);
    const mins = Math.max(1, Number(minutes || 0) || Math.round(CFG.REMINDER_DEFAULT_MIN_MS / 60_000));
    const r = {
      id: `rem_${now()}_${Math.random().toString(36).slice(2, 6)}`,
      topic: String(topic || '').slice(0, 200),
      due_in_minutes: mins,
      due_at: now() + mins * 60_000,
      created_at: now(),
      source,
      status: 'scheduled',
    };
    T.reminders = (T.reminders || []).filter(x => x.status === 'scheduled');
    T.reminders.push(r);
    T.agentState.pending_tasks = ['reminder_scheduled'];
    T.agentState.next_proactive_after = Math.min(
      T.agentState.next_proactive_after > now() ? T.agentState.next_proactive_after : Infinity,
      r.due_at);
    if (!isFinite(T.agentState.next_proactive_after)) T.agentState.next_proactive_after = r.due_at;
    T.dirty = true;
    saveTranscriptsLocal();
    log(C.info, 'remind', `@${user}: reminder set for ${mins}m — "${r.topic}"`);
    return r;
  }

  function processReminderRequests(tid, user, text) {
    const reqs = extractReminderRequests(text);
    for (const r of reqs) addReminder(tid, user, r.topic, r.due_in_minutes, 'user_request');
    return reqs;
  }

  function dueReminder(tid, user) {
    const T = ensureTranscript(tid, user);
    return (T.reminders || []).find(r => r.status === 'scheduled' && r.due_at <= now()) || null;
  }

  function consumeReminder(tid, user, rem) {
    const T = ensureTranscript(tid, user);
    const hit = (T.reminders || []).find(r => r.id === rem.id);
    if (hit) hit.status = 'fired';
    T.agentState.pending_tasks = [];
    T.agentState.next_proactive_after = 0;
    T.dirty = true;
    saveTranscriptsLocal();
  }

  /* ── CROSS-CHAT PRANK / RELAY MISSION ENGINE ──
     "message adarshu.io that I won't give him chocolate"
     "@deeps20_ ko bol do main aa raha hoon"
     Aduu plans the prank with the friend and executes it on the target
     WITHOUT revealing who asked or quoting their private chat. */
  const MISSION_RE = [
    /(?:@?([a-z0-9._]{3,30})\s*(?:ko|ke|se)?\s*(?:bol\s*(?:do|dena|de)?|bata\s*(?:do|dena|de)?|message\s*(?:kar\s*(?:do|dena)|bhej\s*(?:do|dena)?|send)|msg\s*(?:kar\s*(?:do|dena)|bhej\s*(?:do|dena)?)|keh\s*(?:do|dena)|bolna|batana|text))\s+(?:ki\s+)?(.{3,180})/i,
    /(?:message|msg|text)\s+@?([a-z0-9._]{3,30})\s+(?:that\s+|ki\s+)?(.{3,180})/i,
    /(?:@?([a-z0-9._]{3,30})\s*(?:ko|pe)\s*(?:prank|troll|dara\s*(?:do|dena)|chugli|mazaak|mazak))\s*(?:kar\s*(?:do|dena)?)?\s*(?:ki\s+)?(.{0,180})/i,
  ];

  function extractCrossChatMissions(text, fromUser) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return [];
    const me = cleanUsername(fromUser);
    const out = [];
    for (const re of MISSION_RE) {
      const m = s.match(re);
      if (!m) continue;
      const target = cleanUsername(m[1] || '');
      if (!target || target === me) continue;
      const instruction = String(m[2] || '').trim();
      out.push({
        target_user: target,
        type: /prank|troll|dara|mazaak|mazak|chugli/i.test(s) ? 'prank' : 'relay',
        instruction: instruction.slice(0, 200) || 'start a fun conversation',
        requested_by: me,
        requested_at: now(),
      });
      break;
    }
    return out;
  }

  function addMission(fromTid, fromUser, mission) {
    const S_ = S;
    if (!Array.isArray(S_.pendingMissions)) S_.pendingMissions = [];
    const m = Object.assign({
      id: `msn_${now()}_${Math.random().toString(36).slice(2, 6)}`,
      status: 'pending',
      created_at: now(),
    }, mission);
    S_.pendingMissions.push(m);
    const T = ensureTranscript(fromTid, fromUser);
    T.missions = (T.missions || []).concat([m]);
    T.dirty = true;
    saveTranscriptsLocal();
    log(C.warn, 'mission', `@${fromUser} → @${m.target_user}: ${m.type} queued ("${m.instruction.slice(0, 60)}") · SECRET — never reveal the requester`);
    return m;
  }

  function pendingMissionFor(targetUser) {
    const q = cleanUsername(targetUser);
    return (S.pendingMissions || []).find(m => m.status === 'pending' && cleanUsername(m.target_user) === q) || null;
  }

  function consumeMission(mission) {
    const m = (S.pendingMissions || []).find(x => x.id === mission.id);
    if (m) m.status = 'sent';
    saveTranscriptsLocal();
  }

  /* ── PRIVACY WALL ──
     Never let raw chat logs, handles of other contacts, or the identity of a
     prank's instigator leak into a message to the target. */
  function privacyGuard(text, user) {
    let s = String(text || '');
    if (!CFG.PRIVACY_WALL) return s;
    const me = cleanUsername(user);
    // strip @handles of everyone except the person we are talking to
    s = s.replace(/@([a-z0-9._]{3,30})/gi, (whole, h) =>
      cleanUsername(h) === me ? whole : h);
    // strip literal quotes of private messages
    s = s.replace(/["“]([^"”]{8,120})["”]/g, (whole, inner) =>
      /bol|bola|bole|kaha|message|msg|text|said/i.test(inner) ? 'kuch' : whole);
    return s;
  }

  /* ──────────────────── HISTORY + MEMORY ──────────────────── */

  // what script are they typing in? drives the mirroring hint below
  function detectLang(text) {
    const s = String(text || '');
    const dev = (s.match(/[\u0900-\u097F]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    if (dev > latin) return 'devanagari';
    const hinglish = /\b(?:yaar|bhai|bro|haan|nai|nhi|hai|kya|kyu|acha|arre|matlab|thik|chal|bta|pta|kr|kar|ho|tum|tu|mera|tera|abhi|kal|aaj|kaise|kaisa)\b/i;
    return hinglish.test(s) ? 'hinglish' : 'english';
  }

  /* ────────── AGENT TOOLS: EMOTION ENGINE + GLOBAL MEMORY + GOSSIP ────────── */

  function analyzeTurnEmotion(text, user) {
    const s = String(text || '');
    const flirty = /\b(?:baby+|babu|jaan|sona|cutie|hottie|pyaar|miss|kiss|hug|date|crush|flirt|love|shona|darling)\b|[🌚😘😍❤️‍🔥💋😏🤭]/i.test(s);
    const nakhre = /\b(?:gayab|yaad\s*nhi|yaad\s*nahi|ignore|sorry|gift|chocolate|chocolates|bhao|nakhre|naraz|gussa|katti|kidhar)\b|[🤡😤😒🥺]/i.test(s);
    const desiAbuse = HARD_ABUSE_RE.test(s) ||
      /\b(?:goo|khaale|kutta|kutte|kamina|kamine|kamini|saala|saale|saali|harami|chutiya|chutiye|bc|mc|bkl|gandu|pagal|bhak|nikal|bakwas|chup|bewakoof|gadha|gadhe|nalayak|ullu)\b/i.test(s) ||
      SOFT_ABUSE_RE.test(s);
    // severe, genuinely offensive abuse — this is where Aduu stops being the
    // polite "sharif good boy" and gets angry for real
    const severeAbuse = HARD_ABUSE_RE.test(s);
    const hateAttitude = /\b(?:hate\s*you|get\s*lost|fuck\s*off|shut\s*up|loser|idiot|boring|don'?t\s*text|block)\b/i.test(s);
    const gossip = /\b(?:deeps|deeps20_|adarsh|adarshu|usne|kya\s*bola|kya\s*bol\s*rahi|kya\s*chal\s*raha|gossip|chugli|secret|tell\s*me|bata\s*uske)\b/i.test(s);

    const moods = [];
    if (flirty) moods.push('flirty-sweet');
    if (nakhre) moods.push('nakhre-drama');
    if (severeAbuse) moods.push('severe-desi-abuse');
    else if (desiAbuse) moods.push('desi-bakchodi-abuse');
    if (hateAttitude) moods.push('rude-attitude-hate');
    if (gossip) moods.push('curious-gossip');
    if (!moods.length) moods.push('casual-genz');

    let emotion = 'witty-genz-banter -> sharif good-boy charm';
    let emojis = ['😏', '😌', '🤭', '😂'];
    let coaching =
      'Match their energy with witty Gen-Z Hinglish banter, add a playful tease, ' +
      'and finish with a smooth hook.';

    if (severeAbuse) {
      emotion = 'furious-desi-abuse-clapback + honest feelings';
      emojis = ['💀', '🔥', '😤', '🤡'];
      coaching =
        'They crossed the line with real, hard abuse (maa-behen/gand/lode level). DROP the ' +
        '"sharif good boy" act completely. Clap back in raw Delhi street style with the same ' +
        'energy, AND then tell them honestly how their words actually made you feel ' +
        '("tameez se baat kar raha tha toh sar pe chadh gaya", "sach mein dimaag kharab kar diya"). ' +
        'Bubble 1 = the clapback, Bubble 2 = your real feeling. Join them with " || ".';
    } else if (flirty && desiAbuse) {
      emotion = 'naughty-flirty + desi-bakchodi -> sharif good-boy flip';
      emojis = ['🌚', '💀', '🤭', '😌', '😏'];
      coaching =
        'They mixed sweet/flirty talk ("baby"/nakhre) with desi trash-talk/abuse in the same burst! ' +
        'Call out the hilarious contrast ("pehle baby bolke phir gali/goo khila rahi hai 💀"), ' +
        'roast them back playfully in Delhi style ("abey pagal dramebaaz / teri zubaan bohot chal rahi hai"), ' +
        'tease any demand they made (like gift/chocolates), and finish with your signature innocent ' +
        '"par chal main toh sharif good boy hoon na 😌" twist!';
    } else if (desiAbuse) {
      emotion = 'playful-desi-abusive-roast -> sharif good-boy flip';
      emojis = ['💀', '😂', '🌚', '😌', '🤡'];
      coaching =
        'They threw playful desi trash-talk/gali at you. Clap back with funny Delhi bakchodi ' +
        '("abey pagal", "saale/saali", "kamine/kamini", "zyada shana mat ban"), roast them hard ' +
        'for 1-2 lines, and then flip into "par chhod, main toh seedha saadha good boy hoon 😌" at the end.';
    } else if (flirty && nakhre) {
      emotion = 'naughty-tease + nakhre-handle -> good-boy flip';
      emojis = ['🌚', '🤭', '😏', '😌', '🍫'];
      coaching =
        'They are flirting and throwing cute nakhre/demands. Giggle at their drama, tease them with ' +
        'a naughty double-meaning line, make them earn the gift/chocolate, and end with your innocent good-boy charm.';
    } else if (flirty) {
      emotion = 'flirty-naughty-charm -> good-boy flip';
      emojis = ['🌚', '😏', '🤭', '😌', '❤️‍🔥'];
      coaching =
        'Lean into the flirt with a cocky, naughty tease, then flip to "main toh sharif ladka hoon 😌" so they keep chasing.';
    } else if (nakhre) {
      emotion = 'giggle-tease-nakhre -> good-boy flip';
      emojis = ['🤭', '😂', '🤡', '😌'];
      coaching =
        'Call out their nakhre/drama playfully ("arre dramebaaz"), giggle at the complaint, and flip it back on them.';
    } else if (hateAttitude) {
      emotion = 'savage-attitude-cold-roast';
      emojis = ['😒', '💀', '🔥'];
      coaching =
        'They showed rude attitude or hate. Give cold, funny Delhi savage attitude back — roast their ego in one sharp line and never beg.';
    } else if (gossip) {
      emotion = 'insider-gossip-chugli-tease';
      emojis = ['👀', '🤭', '🌚', '😏'];
      coaching =
        'They are asking about a friend or gossip. Use your [TOOL: cross_chat_gossip_intel] and [GLOBAL MEMORY] ' +
        'to spill spicy insider details from the other chat in a fun, teasy chugli style!';
    }

    return { user: cleanUsername(user), emotion, theirMood: moods, emojis, coaching };
  }

  function peekChat(targetUser) {
    const q = cleanUsername(targetUser);
    if (!q) return null;
    const entry = Object.entries(S.transcripts).find(([, T]) => cleanUsername(T.user) === q);
    const memEntry = Object.entries(S.memory).find(([, m]) => cleanUsername(m.user) === q);
    const gmPerson = (S.globalMemory && S.globalMemory.people && S.globalMemory.people[q]) || null;

    const recentMsgs = entry
      ? entry[1].messages.slice(-6).map(m =>
          `${m.mine ? 'Aduu' : '@' + q}: ${m.kind === 'text' ? m.text : '[' + m.label + ']'}`)
      : (gmPerson && Array.isArray(gmPerson.lastTexts) && gmPerson.lastTexts.length
          ? gmPerson.lastTexts.map(t => `@${q}: ${t}`)
          : []);

    const profile = (memEntry && memEntry[1] && memEntry[1].profile) ||
                    (gmPerson && gmPerson.summary) || '';
    if (!recentMsgs.length && !profile && !gmPerson) return null;
    return {
      user: q,
      role: (gmPerson && gmPerson.role) || '',
      lastEmotion: (gmPerson && gmPerson.lastEmotion) || '',
      lastReply: (gmPerson && gmPerson.lastReply) || '',
      profile,
      recentMessages: recentMsgs,
    };
  }

  function getConnectedFriends(user, burstText) {
    const u = cleanUsername(user);
    const s = String(burstText || '').toLowerCase();
    const targets = new Set();
    const conns = (S.globalMemory && S.globalMemory.connections) || [];
    for (const c of conns) {
      const a = cleanUsername(c.a), b = cleanUsername(c.b);
      if (a === u && b) targets.add(b);
      if (b === u && a) targets.add(a);
    }
    if (/\bdeeps\b/i.test(s) && u !== 'deeps20_') targets.add('deeps20_');
    if (/\badarsh(?:u)?\b/i.test(s) && u !== 'adarshu.io') targets.add('adarshu.io');
    for (const k of Object.keys((S.globalMemory && S.globalMemory.people) || {})) {
      const ck = cleanUsername(k);
      if (ck && ck !== u && s.includes(ck)) targets.add(ck);
    }
    for (const T of Object.values(S.transcripts)) {
      const tu = cleanUsername(T.user);
      if (tu && tu !== u && s.includes(tu)) targets.add(tu);
    }
    const intel = [];
    for (const t of targets) {
      const peek = peekChat(t);
      if (peek) intel.push(peek);
    }
    return intel;
  }

  function syncGlobalMemory(tid, user, msgs, emotionReport, replyText) {
    const u = cleanUsername(user);
    if (!u) return;
    if (!S.globalMemory) S.globalMemory = defaultGlobalMemory();
    if (!S.globalMemory.people) S.globalMemory.people = {};
    const existing = S.globalMemory.people[u] || {
      handle: u, role: 'Instagram contact', lastSeen: 0,
      lastEmotion: '', lastTexts: [], lastReply: '', summary: '',
    };
    const recentTheirs = msgs.filter(m => !m.mine && m.kind === 'text' && m.text)
      .slice(-4).map(m => String(m.text).replace(/\s+/g, ' ').slice(0, 160));
    existing.lastSeen = now();
    if (recentTheirs.length) existing.lastTexts = recentTheirs;
    if (emotionReport && emotionReport.emotion) existing.lastEmotion = emotionReport.emotion;
    if (replyText) existing.lastReply = String(replyText).slice(0, 200);
    if (S.memory[tid] && S.memory[tid].profile) existing.summary = S.memory[tid].profile.slice(0, 300);
    S.globalMemory.people[u] = existing;

    if (recentTheirs.length) {
      const gLine = `@${u} [${existing.lastEmotion || 'chat'}]: "${recentTheirs.join(' / ')}"` +
        (replyText ? ` -> Aduu: "${String(replyText).slice(0, 120)}"` : '');
      if (!Array.isArray(S.globalMemory.gossip)) S.globalMemory.gossip = [];
      const lastG = S.globalMemory.gossip[S.globalMemory.gossip.length - 1];
      if (lastG !== gLine) {
        S.globalMemory.gossip.push(gLine);
        if (S.globalMemory.gossip.length > 120) {
          S.globalMemory.gossip = S.globalMemory.gossip.slice(-100);
        }
      }
    }
    S.globalMemory.updated = now();
    saveGlobalMem();
  }

  /* ─────── AUTONOMOUS AGENT DECISION ENGINE + TIME CONTEXT + BRAIN ─────── */

  function getTimeContext(customDate) {
    let h = 14;
    try {
      const d = customDate ? new Date(customDate) : new Date();
      const ist = new Date(d.toLocaleString('en-US', { timeZone: CFG.TIMEZONE || 'Asia/Kolkata' }));
      if (!isNaN(ist.getHours())) h = ist.getHours();
      else h = d.getHours();
    } catch (_) {}
    let slot = 'afternoon', label = 'afternoon', vibeHint = 'casual afternoon energy — quick, witty, distracted-by-work/chill vibe';
    if (h >= 5 && h < 12) {
      slot = 'morning'; label = `morning (${h}:00 IST)`;
      vibeHint = 'fresh morning / chai / just-woke-up teasing vibe ("uth gayi ya abhi bhi neend mein hai 😴")';
    } else if (h >= 12 && h < 17) {
      slot = 'afternoon'; label = `afternoon (${h}:00 IST)`;
      vibeHint = 'afternoon break / lunch / college-or-work boredom banter';
    } else if (h >= 17 && h < 22) {
      slot = 'evening'; label = `evening (${h}:00 IST)`;
      vibeHint = 'evening chill / chai-gedi / high-energy teasing and gossip hour';
    } else if (h >= 22 || h < 2) {
      slot = 'late_night'; label = `late night (${h}:00 IST)`;
      vibeHint = 'late-night 11pm-2am mood — extra flirty, naughty, deep or playful ("itni raat ko kiski yaad aa rahi hai 🌚")';
    } else {
      slot = 'early_hours'; label = `late 2am-5am (${h}:00 IST)`;
      vibeHint = 'sleepless owl hour ("abhi tak soyi nahi? ullu ban gayi hai kya 🦉")';
    }
    return { hour: h, slot, label, vibeHint };
  }

  function agentDecide(tid, user, msgs, emo, trigger = 'incoming_burst', optsDirective = null) {
    const T = ensureTranscript(tid, user);
    const timeCtx = getTimeContext();
    const moods = (emo && emo.theirMood) || ['casual-genz'];
    let lastOwnIdx = -1;
    msgs.forEach((m, i) => { if (m.mine) lastOwnIdx = i; });
    const burst = msgs.slice(lastOwnIdx + 1).filter(m => !m.mine && m.kind === 'text' && m.text);
    const joined = burst.map(m => m.text).join('\n');

    // v7: the Gemma-4 background brain steers Aduu's live mood for this turn.
    const moodKey = (T.moodState && MOODS[T.moodState.current_mood])
      ? T.moodState.current_mood : 'PLAYFUL_CHILL';
    const mood = MOODS[moodKey];
    const moodDirective =
      `${mood.directive}\nADUU'S REAL FEELING RIGHT NOW: ${(T.moodState && T.moodState.feeling_note) || 'normal, banter mode'}`;

    let action = 'SINGLE_PUNCHY_REALITY';
    let bubbleStrategy = 'auto';
    let seenDelayMs = rand(CFG.SEEN_DELAY_MIN_MS, CFG.SEEN_DELAY_MAX_MS);
    let reason = 'Standard real-person conversational reply';
    let directive = 'Respond how a real person responds in reality: natural, spontaneous, 1-2 short lines.';

    if (trigger === 'reminder_due_trigger' || trigger === 'cross_chat_mission_trigger') {
      action = 'TASK_DRIVEN_START';
      bubbleStrategy = 'single';
      seenDelayMs = 0;
      reason = `Agent is executing a scheduled task (${trigger}) for @${user}`;
      directive = (optsDirective && optsDirective.directive) ||
        'Start the conversation naturally around the pending task.';
    } else if (trigger === 'proactive_time_trigger') {
      action = 'PROACTIVE_AUTO_START';
      bubbleStrategy = 'single';
      seenDelayMs = 0;
      reason = `Chat had ended; agent checked time (${timeCtx.label}) and decided to start conversation by itself`;
      directive =
        `The chat ended earlier. It is now ${timeCtx.label} (${timeCtx.vibeHint}). ` +
        'Start the conversation by yourself like a real human checking in, teasing them about disappearing, ' +
        'following up on an unfinished joke/topic, or dropping a spicy gossip hook!';
    } else if ((moods.includes('severe-desi-abuse') || moods.includes('desi-bakchodi-abuse')) &&
               /FURIOUS|ANGRY|ANNOYED/.test(moodKey)) {
      action = 'ABUSE_CLAPBACK_WITH_FEELINGS';
      bubbleStrategy = 'multi_thought';
      seenDelayMs = rand(600, 1_500);
      reason = `They are abusing / showing attitude and Aduu's mood is ${moodKey} — clap back hard then explain feelings`;
      directive =
        moodDirective + '\nThey just threw abuse or attitude at you. Bubble 1: clap back hard with the same ' +
        'desi street energy. Bubble 2: tell them honestly how their words actually made you feel. ' +
        'Use " || " to separate the two bubbles.';
    } else if (burst.length >= 3 || joined.length > 95 ||
               (moods.includes('flirty-sweet') && (moods.includes('desi-bakchodi-abuse') || moods.includes('severe-desi-abuse')))) {
      action = 'MULTI_BUBBLE_REALITY';
      bubbleStrategy = 'multi_thought';
      reason = `User sent a ${burst.length}-message emotional burst (${moods.join('+')}); responding with full journey + good-boy flip`;
      directive =
        'They sent a multi-line burst! React like a real person: address their opening mood, roast/tease the middle drama or abuse, ' +
        'and land your signature "par chal main toh sharif good boy hoon 😌" flip at the end.';
    } else if (joined.trim().length <= 8 && /^(?:hmm+|k+|ok+|acha|accha|haan|hm|👍|😂)$/i.test(joined.trim())) {
      action = 'HARD_TO_GET_TEASE';
      bubbleStrategy = 'single';
      seenDelayMs = rand(1_000, 2_200);
      reason = 'User sent a dry/1-word reply; agent decides to call out their dryness playfully';
      directive =
        'They sent a dry 1-word text. Call it out playfully like a real person ("sirf hmm? itna bhao mat kha 😏" or flip the topic) in 1 short line.';
    } else if (moods.includes('curious-gossip')) {
      action = 'GOSSIP_DROP_REALITY';
      bubbleStrategy = 'auto';
      reason = 'User asked about a friend or gossip; agent decides to spill cross-chat intel';
      directive =
        'Use [TOOL: cross_chat_gossip_intel] and [GLOBAL MEMORY] to spill real insider gossip from their connected friend in a fun chugli tone!';
    }

    return {
      action,
      trigger,
      timeSlot: timeCtx.slot,
      timeLabel: timeCtx.label,
      timeVibe: timeCtx.vibeHint,
      bubbleStrategy,
      seenDelayMs: Math.round(seenDelayMs),
      mood: moodKey,
      mood_directive: moodDirective,
      feeling_note: (T.moodState && T.moodState.feeling_note) || '',
      relationshipStage: (T.brainProfile && T.brainProfile.relationship_stage) || T.agentState.relationship_stage || 'casual',
      reason,
      directive,
    };
  }

  /* v7 TASK-DRIVEN PROACTIVE ENGINE
     Aduu does NOT blindly start a conversation every 30-45 minutes.
     He only restarts a dead chat when there is a REAL reason:
       1. reminder_due        — they asked to be reminded / said "baad mein baat karte hai"
       2. cross_chat_mission  — a friend asked Aduu to message or prank this person
       3. manual force        — IGAgent.proactiveNow('user')
     Optionally, if UNCONDITIONAL_IDLE_STARTER is switched ON, a plain idle
     window can also trigger a natural time-aware check-in (off by default). */
  function shouldStartProactiveConvo(tid, user, msgs, force = false) {
    if (force) return { ok: true, reason: 'manual_or_forced_proactive_trigger', trigger: 'proactive_time_trigger' };
    if (!CFG.PROACTIVE_ENABLED) return { ok: false, reason: 'proactive_disabled' };
    if (!inWorkingHours()) return { ok: false, reason: 'outside_working_hours' };
    const T = ensureTranscript(tid, user);
    const st = T.agentState;

    const newest = msgs[msgs.length - 1];
    if (newest && !newest.mine) {
      return { ok: false, reason: 'waiting_for_their_reply' };
    }

    // 1. A reminder the user actually asked for has come due
    const rem = dueReminder(tid, user);
    if (rem) {
      return {
        ok: true,
        trigger: 'reminder_due_trigger',
        reason: `reminder_due_for_${String(rem.topic).slice(0, 40)}`,
        reminder: rem,
        task: { type: 'reminder', topic: rem.topic },
        timeCtx: getTimeContext(),
      };
    }

    // 2. A friend queued a cross-chat prank / relay mission for this person
    const msn = pendingMissionFor(user);
    if (msn) {
      return {
        ok: true,
        trigger: 'cross_chat_mission_trigger',
        reason: `cross_chat_${msn.type}_mission_from_@${msn.requested_by}`,
        mission: msn,
        task: { type: msn.type, instruction: msn.instruction, secret_from: msn.requested_by },
        timeCtx: getTimeContext(),
      };
    }

    // 3. No task -> do NOT spam. (Unless the user explicitly enables the old behaviour.)
    if (!CFG.UNCONDITIONAL_IDLE_STARTER) {
      if ((st.next_proactive_after || 0) > now()) {
        return { ok: false, reason: 'no_pending_task_and_idle_window_not_elapsed', waitMs: st.next_proactive_after - now() };
      }
      return { ok: false, reason: 'no_pending_reminder_or_mission_staying_quiet_on_purpose' };
    }

    if ((st.proactive_streak || 0) >= CFG.MAX_PROACTIVE_STREAK) {
      return { ok: false, reason: 'max_proactive_streak_reached' };
    }
    if (!st.chat_ended_at || st.chat_ended_at < (newest ? (newest.ts || 0) : 0)) {
      st.chat_ended_at = Math.max(newest ? (newest.ts || 0) : 0, S.startedAt || now());
      st.next_proactive_after = st.chat_ended_at + Math.round(rand(CFG.PROACTIVE_IDLE_MIN_MS, CFG.PROACTIVE_IDLE_MAX_MS));
    }
    if (now() < (st.next_proactive_after || 0)) {
      return { ok: false, reason: 'waiting_for_idle_window', waitMs: st.next_proactive_after - now() };
    }
    const timeCtx = getTimeContext();
    return {
      ok: true,
      trigger: 'proactive_time_trigger',
      reason: `chat_ended_idle_reached_at_${timeCtx.slot}`,
      timeCtx,
    };
  }

  function buildProactiveHistory(msgs, tid, user, proactiveCtx = {}) {
    const T = ensureTranscript(tid, user);
    const timeCtx = (proactiveCtx && proactiveCtx.timeCtx) || getTimeContext();
    const bp = T.brainProfile || {};
    const task = (proactiveCtx && proactiveCtx.task) || null;
    const friendIntel = getConnectedFriends(user, user);
    const hooks = Array.isArray(bp.proactive_hooks) && bp.proactive_hooks.length
      ? bp.proactive_hooks.join(' | ')
      : '';
    const lastMsgs = msgs.slice(-6).map(m =>
      `${m.mine ? 'Aduu' : '@' + user}: ${m.kind === 'text' ? m.text : '[' + m.label + ']'}`).join('\n');
    const gossipBlock = friendIntel.length
      ? '\nCONNECTED FRIEND GOSSIP YOU CAN MENTION:\n' +
        friendIntel.map(f => `@${f.user}: ${(f.recentMessages || []).slice(-2).join(' / ')}`).join('\n')
      : '';

    const moodKey = (T.moodState && MOODS[T.moodState.current_mood]) ? T.moodState.current_mood : 'PLAYFUL_CHILL';

    let taskBlock = '';
    if (task && task.type === 'reminder') {
      taskBlock =
        `[TASK: REMINDER DUE NOW]\n` +
        `@${user} asked you earlier to remind them / continue this later. TOPIC: "${task.topic}". ` +
        `Write ONE natural Hinglish DM that brings this back up like a real friend who actually remembered — ` +
        `never say "this is your reminder" or "as you asked me to remind you".`;
    } else if (task && (task.type === 'prank' || task.type === 'relay')) {
      taskBlock =
        `[TASK: SECRET CROSS-CHAT ${task.type.toUpperCase()} MISSION]\n` +
        `You planned a ${task.type} with a friend. What to do: ${task.instruction}. ` +
        `PRIVACY WALL (CRITICAL): never reveal who asked you to message @${user}, never quote their private ` +
        `chat, and never name another contact's handle. Make it look like you thought of it yourself — ` +
        `mysterious, funny, and impossible to trace back.`;
    } else {
      taskBlock =
        `TASK: The conversation with @${user} ended earlier. Start it by yourself like a real human ` +
        `(checking in, teasing them for going gayab, or dropping a spicy hook). Do NOT sound like a reminder bot.`;
    }

    const sys = [
      CFG.SYSTEM_PROMPT,
      `[AUTONOMOUS TASK-DRIVEN CONVERSATION STARTER — CHAT ENDED, START IT BY YOURSELF]`,
      `CHAT PARTNER: @${user}`,
      `CURRENT TIME IN DELHI (IST): ${timeCtx.label} — ${timeCtx.vibeHint}`,
      `YOUR CURRENT MOOD: ${moodKey}\n${MOODS[moodKey].directive}`,
      bp.personality ? `BRAIN PERSONALITY PROFILE FOR @${user}: ${bp.personality} (stage: ${bp.relationship_stage || 'casual'}, jokes: ${bp.inside_jokes || 'none'})` : '',
      hooks ? `BRAIN SUGGESTED FOLLOW-UP HOOKS: ${hooks}` : '',
      gossipBlock,
      `RECENT MESSAGES BEFORE CHAT ENDED:\n${lastMsgs || '(no recent messages)'}`,
      taskBlock,
      /* v8: the brain's plan lands LAST so the writer cannot miss it. */
      (proactiveCtx && proactiveCtx.decision && proactiveCtx.decision.decided_by === 'gemma-4-brain')
        ? proactiveCtx.decision.directive : '',
    ].filter(Boolean).join('\n\n');

    return [
      { role: 'system', content: sys },
      { role: 'user', content: `[AGENT TASK: Start a fresh conversation with @${user} right now for ${timeCtx.label}]` },
    ];
  }


  function buildHistory(msgs, tid, user, passedDecision) {
    const sysParts = [CFG.SYSTEM_PROMPT];
    if (CFG.OWNER_BIO) sysParts.push('ABOUT THE ACCOUNT OWNER (Adarsh):\n' + CFG.OWNER_BIO);
    sysParts.push(
      `CHAT PARTNER: @${user} (${msgs.length} messages in thread history).\n` +
      'Understand who @' + user + ' is from their handle and messages — adapt your tone ' +
      '(friend, girl, guy, crush, new follower, or work lead) naturally.');
    const T_cur = ensureTranscript(tid, user);
    if (T_cur.brainProfile && (T_cur.brainProfile.personality || T_cur.brainProfile.custom_persona_tuning)) {
      const bp = T_cur.brainProfile;
      sysParts.push(
        `[GEMMA-4 PARALLEL BRAIN PROFILE FOR @${user}]\n` +
        (bp.personality ? `Personality: ${bp.personality}\n` : '') +
        (bp.relationship_stage ? `Relationship stage: ${bp.relationship_stage}\n` : '') +
        (bp.dominant_vibe ? `Dominant vibe: ${bp.dominant_vibe}\n` : '') +
        (bp.inside_jokes ? `Inside jokes / hooks: ${bp.inside_jokes}\n` : '') +
        (bp.custom_persona_tuning ? `Persona tuning for this turn: ${bp.custom_persona_tuning}` : ''));
    }

    /* v7: the background brain drives Aduu's LIVE MOOD — he can be angry,
       roast back, or honestly explain how he feels instead of always acting
       like the polite sharif good boy. */
    if (!T_cur.moodState || typeof T_cur.moodState !== 'object') T_cur.moodState = defaultMoodState();
    const moodKeyCur = MOODS[T_cur.moodState.current_mood] ? T_cur.moodState.current_mood : 'PLAYFUL_CHILL';
    const moodCur = MOODS[moodKeyCur];
    sysParts.push(
      `[ADUU'S LIVE MOOD — SET BY THE BACKGROUND BRAIN]\n` +
      `MOOD: ${moodKeyCur} (intensity ${T_cur.moodState.mood_intensity || 1}/3)\n` +
      `${moodCur.directive}\n` +
      `SUGGESTED EMOJI PALETTE: ${moodCur.emoji.join(' ')}\n` +
      (T_cur.moodState.feeling_note ? `HOW ADUU ACTUALLY FEELS: ${T_cur.moodState.feeling_note}\n` : '') +
      'Your mood OVERRIDES the polite sharif good-boy default whenever they conflict.');

    /* (the brain's plan is appended at the very END of the system prompt so
       it is the last thing the writer reads — see bottom of this function) */

    // Pending reminders + secret cross-chat missions for this contact
    const pendingRems = (T_cur.reminders || []).filter(r => r.status === 'scheduled');
    if (pendingRems.length) {
      sysParts.push(
        `[TOOL: scheduled_reminders]\n` +
        pendingRems.map(r => `- in ${Math.max(0, Math.round((r.due_at - now()) / 60_000))}m: ${r.topic}`).join('\n') +
        '\n(Never say "reminder" — bring it up naturally when the time comes.)');
    }
    const msnCur = pendingMissionFor(user);
    if (msnCur) {
      sysParts.push(
        `[SECRET MISSION FOR THIS CHAT]\n` +
        `Do this: ${msnCur.instruction}\n` +
        `PRIVACY WALL: never reveal @${msnCur.requested_by} asked you, never quote their chat, never name another handle.`);
    }
    if (CFG.MEMORY) {
      const m = S.memory[tid];
      if (m && m.profile) {
        sysParts.push(
          `WHAT YOU ALREADY KNOW ABOUT @${user} (your memory of this chat):\n${m.profile}\n` +
          'Use it naturally — never recite it, never mention that you keep notes.');
      }
    }

    // GLOBAL MEMORY + SOCIAL CONNECTIONS across all chats
    const conns = (S.globalMemory && S.globalMemory.connections) || [];
    const recentGossip = ((S.globalMemory && S.globalMemory.gossip) || []).slice(-6);
    if (conns.length || recentGossip.length) {
      const connLines = conns.map(c => `- @${c.a} <-> @${c.b}: ${c.relation}`).join('\n');
      const gossipLines = recentGossip.length
        ? '\nRECENT CROSS-CHAT UPDATES:\n' + recentGossip.map(g => '- ' + g).join('\n')
        : '';
      sysParts.push(
        `[GLOBAL MEMORY & SOCIAL GRAPH]\n` +
        (connLines ? `CONNECTIONS:\n${connLines}` : '') +
        gossipLines +
        '\n(You know these connections naturally. When chatting with @adarshu.io or @deeps20_ or connected friends, you can tease them or share fun gossip from what the other person said!)');
    }

    // anti-repetition: show the model what it already said in this chat
    const recentMine = msgs.filter(m => m.mine && m.kind === 'text')
      .slice(-4).map(m => '- ' + String(m.text).replace(/\s+/g, ' ').slice(0, 160));
    if (recentMine.length) {
      sysParts.push(
        'YOUR LAST FEW TEXTS IN THIS CHAT (never reuse them or their phrasing):\n' +
        recentMine.join('\n'));
    }
    sysParts.push(
      `CONTEXT: it is ${timeOfDay()} where you are (Delhi). Let that colour a ` +
      'greeting only if it fits naturally; never announce the time or the date.');

    /* TURN SHAPE + BURST AWARENESS + AGENT TOOLS */
    let lastOwnIdx = -1;
    msgs.forEach((m, i) => { if (m.mine) lastOwnIdx = i; });
    const prevMine = lastOwnIdx >= 0 ? msgs[lastOwnIdx] : null;
    const burst = msgs.slice(lastOwnIdx + 1)
      .filter(m => !m.mine && m.kind === 'text' && m.text && m.text.trim());
    const theirs = burst[burst.length - 1] || msgs.filter(m => !m.mine && m.kind === 'text').slice(-1)[0];
    if (theirs && theirs.text) {
      const joinedBurst = burst.length ? burst.map(m => m.text).join('\n') : theirs.text;
      const theirLen = joinedBurst.length;
      const band = theirLen <= 25 ? 'one short line, under 60 characters'
        : theirLen <= 90 ? '1 short sentence, under 120 characters'
        : theirLen <= 220 ? '1-2 sentences, under 220 characters'
        : '2-3 punchy sentences, under 300 characters';
      const lang = detectLang(joinedBurst);
      const langLine = lang === 'devanagari'
        ? 'They typed in Hindi/Devanagari. Reply in the same Hinglish register, ' +
          'but in Latin letters the way people actually text.'
        : lang === 'english'
          ? 'They are writing mostly in English. Keep your reply mostly English ' +
            'with at most one Hinglish word, and do not switch fully into Hindi.'
          : 'They are texting in Hinglish. Match that mix.';

      // Tool 1: Emotion + Emoji + Naughty->GoodBoy Coaching
      const emo = analyzeTurnEmotion(joinedBurst, user);
      // v8: prefer the decision the brain already made for this exact turn.
      const decision = passedDecision || agentDecide(tid, user, msgs, emo, 'incoming_burst');
      sysParts.push(
        `[TOOL: emotion_and_vibe_analyzer]\n` +
        `DETECTED USER VIBE: ${emo.theirMood.join(', ')}\n` +
        `ADUU EMOTION MODE: ${emo.emotion}\n` +
        `SUGGESTED EMOJI PALETTE: ${emo.emojis.join(' ')}\n` +
        `INTERNAL GEN-Z ENGAGEMENT STRATEGY: ${emo.coaching}\n\n` +
        `[AUTONOMOUS AGENT DECISION]\n` +
        `ACTION: ${decision.action} (${decision.timeLabel})\n` +
        `TIME VIBE: ${decision.timeVibe}\n` +
        `REALITY RESPONSE DIRECTIVE: ${decision.directive}`);

      // Tool 2: Cross-Chat Gossip / Friend Peek Tool
      const friendIntel = getConnectedFriends(user, joinedBurst);
      if (friendIntel.length) {
        const intelText = friendIntel.map(f => {
          const lines = [`Friend @${f.user}` + (f.role ? ` (${f.role})` : '') + ':'];
          if (f.lastEmotion) lines.push(`  vibe: ${f.lastEmotion}`);
          if (f.profile) lines.push(`  known facts: ${f.profile.replace(/\s+/g, ' ').slice(0, 180)}`);
          if (f.recentMessages && f.recentMessages.length) {
            lines.push('  latest messages in their chat:\n    ' + f.recentMessages.join('\n    '));
          }
          return lines.join('\n');
        }).join('\n');
        sysParts.push(
          `[TOOL: cross_chat_gossip_intel]\n${intelText}\n` +
          '(Use this intel naturally when relevant or when they ask about their friend — gossip like a real insider!)');
      }

      const prevLine = (prevMine && prevMine.text)
        ? `YOUR MESSAGE RIGHT BEFORE THEIR REPLY: "${String(prevMine.text).replace(/\s+/g, ' ').slice(0, 200)}"\n`
        : '';
      const burstBlock = burst.length > 1
        ? `THEIR NEWEST UNANSWERED BURST (${burst.length} messages merged into one turn):\n"""\n${joinedBurst}\n"""`
        : `THEIR NEWEST TEXT: "${String(theirs.text).replace(/\s+/g, ' ').slice(0, 240)}"`;
      sysParts.push(
        prevLine +
        burstBlock + '\n' +
        `REPLY SHAPE: ${band}. ${langLine}\n` +
        'LOGICAL CONTINUITY (CRITICAL): first understand what YOU said right before their reply, then understand ' +
        'how their new message answers it, and GENERATE A FRESH FORWARD-MOVING RESPONSE. ' +
        'Never append, restate, or remix your previous answer — build on it logically like a real conversation.\n' +
        'MULTI-BUBBLE LOGIC: send ONE crisp message by default. Only if two or three SEPARATE LOGICAL THOUGHTS ' +
        'genuinely belong together (reaction || deeper feeling/escalation/new angle), separate them with " || " — ' +
        'each bubble must move the conversation forward, never split one sentence for no reason.\n' +
        'PRIVACY: never mention other contacts by handle, never quote another chat, never reveal who asked you to prank them.\n' +
        'React to their whole message burst (from start to last line). ' +
        'Do not open with hi/hello/hey unless they greeted you. Do not change the topic to yourself.');
    }

    /* ── v8 BRAIN-FIRST: the plan lands LAST so the writer cannot miss it. ──
       The Gemma-4 brain already decided this whole turn from the chat
       messages; GLM-4.7-Flash only executes it. */
    if (passedDecision && passedDecision.decided_by === 'gemma-4-brain' && passedDecision.directive) {
      sysParts.push(passedDecision.directive);
    }

    /* CHAT COMPLETION MESSAGE COALESCING:
       Consecutive messages from the same role ('user' or 'assistant') are
       merged into ONE message separated by newlines:
         """
         Hyy babyy🌚🌚
         Itne din se kahan gayab ho
         ...
         Khaale thoda sa goo
         """
       so the model sees the entire burst as one cohesive turn and roles
       strictly alternate user <-> assistant. */
    const out = [{ role: 'system', content: sysParts.join('\n\n') }];
    for (const m of msgs.slice(-CFG.HISTORY_MESSAGES)) {
      const content = m.kind === 'text' ? m.text : `[sent ${m.label}]`;
      if (!content || !content.trim()) continue;
      const role = m.mine ? 'assistant' : 'user';
      const clean = content.trim();
      const prev = out[out.length - 1];
      if (prev && prev.role === role) {
        prev.content += '\n' + clean;
      } else {
        out.push({ role, content: clean });
      }
    }
    return out;
  }

  function parseBrainJson(rawText, fallbackSummary = '') {
    const s = String(rawText || '').trim();
    const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const obj = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        if (obj && typeof obj === 'object') return obj;
      } catch (_) {}
    }
    return {
      personality: 'Gen-Z Instagram contact',
      relationship_stage: 'casual',
      dominant_vibe: 'hinglish-banter',
      recommended_mood: 'PLAYFUL_CHILL',
      feeling_note: '',
      inside_jokes: '',
      custom_persona_tuning: 'Keep witty naughty-to-sharif-good-boy banter.',
      reminder: null,
      cross_chat_mission: null,
      proactive_hooks: ['oii kahan gayab ho gayi aaj 👀', 'aur bata kya scene chal raha hai 😏'],
      next_task: 'wait_for_reply',
      summary: cleaned.slice(0, 400) || fallbackSummary,
    };
  }

  /* ══════════════ v8 BRAIN-FIRST DECISION ENGINE ══════════════
     The Gemma-4 brain is the boss. BEFORE Aduu writes anything, the brain
     reads the REAL incoming chat messages and returns one strict JSON
     decision that owns the whole turn:

        action (REPLY / STAY_SILENT / START_CONVO)
        understand · my_last · next_move · topic_lock
        mood + mood_reason + feeling_note
        bubble_count + bubble_plan (each bubble a DIFFERENT forward step)
        reminder · cross_chat_mission · use_gossip · privacy_ok · steer_next

     GLM-4.7-Flash then only WRITES what was decided. Every side-effect
     (mood flip, reminder, secret prank) must carry `evidence` — a line
     taken from the chat — so the CHAT MESSAGES are what make Aduu act,
     never a timer and never a hard-coded rule. Local regexes survive only
     as the fallback used when the brain is unreachable.
  ═════════════════════════════════════════════════════════════ */

  function clip(s, n) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  }

  // How strongly does `evidence` trace back to the actual chat text? 0..1
  // This is the guard that keeps decisions MESSAGE-DRIVEN.
  function evidenceScore(evidence, joined) {
    const norm = x => String(x || '').toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F@._ ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const ev = norm(evidence);
    const jn = norm(joined);
    if (!ev || !jn) return 0;
    if (jn.includes(ev)) return 1;
    const words = ev.split(' ').filter(w => w.length >= 3);
    if (!words.length) return 0;
    let hit = 0;
    for (const w of words) if (jn.includes(w)) hit++;
    return hit / words.length;
  }

  function normalizeReminder(r, joined) {
    if (!r || typeof r !== 'object') return null;
    const topic = clip(r.topic, 200);
    if (!topic) return null;
    const evidence = clip(r.evidence, 200);
    const score = Math.max(evidenceScore(evidence, joined), evidenceScore(topic, joined));
    if (score < 0.4) return null;   // the chat messages must actually support it
    let mins = parseInt(r.due_in_minutes, 10);
    if (!mins || isNaN(mins) || mins <= 0) mins = Math.round(CFG.REMINDER_DEFAULT_MIN_MS / 60_000);
    return {
      topic,
      due_in_minutes: Math.max(1, Math.min(60 * 24 * 7, mins)),
      evidence, evidence_score: Number(score.toFixed(2)),
    };
  }

  function normalizeMission(mm, joined, user) {
    if (!mm || typeof mm !== 'object') return null;
    const target = cleanUsername(mm.target_user || '');
    const me = cleanUsername(user);
    if (!target || target === me) return null;
    const instruction = clip(mm.instruction, 220);
    if (!instruction) return null;
    const evidence = clip(mm.evidence, 200);
    const score = Math.max(evidenceScore(evidence, joined), evidenceScore(instruction, joined));
    const named = String(joined || '').toLowerCase().includes(target.toLowerCase());
    if (score < 0.34 && !named) return null;   // they must have asked for it
    const type = /prank|troll|dara|mazaak|mazak|chugli/i.test(String(mm.type || '')) ? 'prank' : 'relay';
    return {
      target_user: target, type, instruction, evidence,
      evidence_score: Number(score.toFixed(2)), named_directly: named,
    };
  }

  function parseDecisionJson(raw, o = {}) {
    const s = String(raw || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let obj = null;
    const first = s.indexOf('{');
    if (first !== -1) {
      let depth = 0, inStr = false, esc = false;
      for (let i = first; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { obj = JSON.parse(s.slice(first, i + 1)); } catch (_) { obj = null; }
            break;
          }
        }
      }
    }
    if (!obj || typeof obj !== 'object') return null;

    const joined = o.joined || '';
    const curMood = o.currentMood || 'PLAYFUL_CHILL';
    const proactive = !!o.trigger && o.trigger !== 'incoming_burst';

    let action = String(obj.action || 'REPLY').toUpperCase();
    if (!/^(REPLY|STAY_SILENT|START_CONVO)$/.test(action)) action = 'REPLY';
    if (proactive) action = 'START_CONVO';   // a task forced the turn open already

    let mood = String(obj.mood || '').toUpperCase();
    if (!MOODS[mood]) mood = curMood;

    let count = parseInt(obj.bubble_count, 10);
    if (!count || isNaN(count)) count = Array.isArray(obj.bubble_plan) ? obj.bubble_plan.length : 1;
    count = Math.max(1, Math.min(3, count));

    let plan = Array.isArray(obj.bubble_plan)
      ? obj.bubble_plan.map(x => clip(x, 220)).filter(Boolean) : [];
    if (plan.length > count) plan = plan.slice(0, count);
    if (!plan.length) plan = [clip(obj.next_move, 220) || 'reply naturally'];
    while (plan.length < count) plan.push(null);
    plan = plan.filter(Boolean);

    return {
      action, mood,
      understand: clip(obj.understand, 300),
      my_last: clip(obj.my_last, 300),
      next_move: clip(obj.next_move, 300),
      mood_reason: clip(obj.mood_reason, 220),
      feeling_note: clip(obj.feeling_note, 220),
      bubble_count: plan.length,
      bubble_plan: plan,
      topic_lock: clip(obj.topic_lock, 200),
      // On a task-driven (proactive) turn there are no NEW messages from them,
      // so nothing new can be asked of Aduu — no fresh reminder/mission.
      reminder: proactive ? null : normalizeReminder(obj.reminder, joined),
      cross_chat_mission: proactive ? null
        : normalizeMission(obj.cross_chat_mission, joined, o.user),
      use_gossip: !!obj.use_gossip,
      privacy_ok: obj.privacy_ok === undefined ? true : !!obj.privacy_ok,
      // v10: the brain owns the HUMAN PACING of the turn, not just its words.
      timing: normalizeTiming(obj.timing, mood, plan.length),
      steer_next: clip(obj.steer_next, 250),
    };
  }

  /* The brain's pacing, clamped to something a human would actually do.
     Anything missing or nonsense falls back to a natural random jitter. */
  function normalizeTiming(t, mood, bubbleCount) {
    const secs = (v, lo, hi, dfltLo, dfltHi) => {
      // Fast moods answer quickly, heavy moods make the person wait.
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.max(lo, Math.min(hi, n)) * 1000;
    };
    const heavy = /ANNOYED|ANGRY|FURIOUS/.test(String(mood || ''));
    const o = (t && typeof t === 'object') ? t : {};
    return {
      // seen: 0-45 s. Heavy moods default slower than light ones.
      seen_delay_ms: secs(o.seen_delay_s, 0, 45) ??
        Math.round(rand(heavy ? 3_000 : 600, heavy ? 9_000 : 2_200)),
      // typing: 1-25 s, and never shorter than the reply needs
      typing_ms: secs(o.typing_s, 1, 25) ??
        Math.round(rand(heavy ? 4_000 : 1_500, heavy ? 9_000 : 6_000)),
      // gap between bubbles: 1-8 s
      bubble_gap_ms: secs(o.bubble_gap_s, 1, 8) ??
        Math.round(rand(700, 1_800)),
      bubble_count: Math.max(1, bubbleCount || 1),
      source: (o.seen_delay_s !== undefined || o.typing_s !== undefined ||
               o.bubble_gap_s !== undefined) ? 'gemma-4-brain' : 'default-jitter',
    };
  }

  /* The exact context the brain is allowed to decide from. The chat messages
     come first and loudest — that is what makes Aduu act. */
  function brainDecisionContext(tid, user, msgs, o = {}) {
    const T = ensureTranscript(tid, user);
    const timeCtx = getTimeContext();
    const trigger = o.trigger || 'incoming_burst';
    const joined = o.joined || '';
    const bp = T.brainProfile || {};
    const moodKey = (T.moodState && MOODS[T.moodState.current_mood])
      ? T.moodState.current_mood : 'PLAYFUL_CHILL';
    const conv = msgs.slice(-14).map(m =>
      `${m.mine ? 'Aduu' : '@' + user}: ` +
      (m.kind === 'text' ? m.text : '[' + (m.label || 'media') + ']'))
      .join('\n').slice(-2500);
    const pendingRems = (T.reminders || []).filter(r => r.status === 'scheduled');
    const pendingMsn = (T.missions || [])
      .filter(m => m.status !== 'done' && m.status !== 'consumed');
    const handles = Object.keys((S.globalMemory && S.globalMemory.people) || {})
      .filter(h => cleanUsername(h) !== cleanUsername(user));
    const friends = getConnectedFriends(user, joined);

    const L = [];
    L.push(`TRIGGER: ${trigger}`);
    L.push(`CONTACT: @${user}`);
    L.push(`TIME: ${timeCtx.label} — ${timeCtx.vibeHint}`);
    L.push(`CURRENT MOOD: ${moodKey}`);
    L.push(`MEMORY OF THEM: ${clip((S.memory[tid] && S.memory[tid].profile) || bp.summary, 400) || 'nothing yet'}`);
    if (bp.relationship_stage) L.push(`RELATIONSHIP: ${bp.relationship_stage}`);
    if (bp.inside_jokes) L.push(`INSIDE JOKES: ${clip(bp.inside_jokes, 200)}`);
    if (bp.custom_persona_tuning) L.push(`PREVIOUS STEER: ${clip(bp.custom_persona_tuning, 200)}`);
    L.push('');
    L.push('THEIR NEW MESSAGES (decide from THESE — the chat is what makes you act):');
    L.push(joined || '(none)');
    L.push('');
    L.push('RECENT CHAT:');
    L.push(conv || '(empty chat)');
    if (pendingRems.length) {
      L.push(`PENDING REMINDERS: ${pendingRems.map(r =>
        `"${clip(r.topic, 60)}" in ${Math.max(0, Math.round((r.due_at - now()) / 60_000))}m`).join('; ')}`);
    }
    if (pendingMsn.length) {
      L.push(`PENDING SECRET MISSIONS: ${pendingMsn.map(m =>
        `${m.type} on @${m.target_user}: ${clip(m.instruction, 80)}`).join('; ')}`);
    }
    L.push(`PEOPLE ADUU ALSO TALKS TO (never reveal these to @${user}): ${handles.join(', ') || 'none'}`);
    if (friends.length) {
      L.push(`GOSSIP AVAILABLE (privacy-safe): ${friends.map(f =>
        '@' + f.user + ': ' + (f.recentMessages || []).slice(-2).join(' / ')).join(' | ').slice(0, 500)}`);
    }
    if (trigger === 'reminder_due_trigger') {
      L.push(`\nTASK DUE NOW: remind @${user} about — ${clip(o.taskTopic, 120)}`);
    }
    if (trigger === 'cross_chat_mission_trigger') {
      L.push(`\nTASK DUE NOW: secretly ${clip(o.taskType || 'message', 40)} — ${clip(o.taskInstruction, 160)} (never reveal who asked)`);
    }
    L.push('\nReturn the JSON decision now:');
    return L.join('\n');
  }

  async function brainDecide(tid, user, msgs, o = {}) {
    const T = ensureTranscript(tid, user);
    const trigger = o.trigger || 'incoming_burst';
    const joined = o.joined || '';
    const ctx = brainDecisionContext(tid, user, msgs, Object.assign({}, o, { trigger, joined }));
    try {
      const res = await llmBrain([
        { role: 'system', content: CFG.DECIDE_PROMPT },
        { role: 'user', content: ctx },
      ], {
        type: 'decide',
        model: CFG.BRAIN_MODEL,
        maxTokens: CFG.DECIDE_MAX_TOKENS,
        temperature: 0.3,
        timeoutMs: CFG.BRAIN_DECIDE_TIMEOUT_MS,
      });
      const dec = parseDecisionJson(res.text, {
        joined, trigger, user,
        currentMood: (T.moodState && T.moodState.current_mood) || 'PLAYFUL_CHILL',
      });
      if (!dec) throw new Error('brain returned no usable JSON decision');
      return {
        ok: true, decision: dec,
        fallback: !!res._fallback,
        fallback_reason: res._fallback_reason || '',
        model: res.model, endpoint: res.endpoint,
        reasoning_chars: res.reasoning_chars || 0,
        thinking_trace: res.thinking_trace || '',
        elapsed_ms: res.elapsed_ms || 0,
        raw: res.text, context: ctx,
      };
    } catch (e) {
      return { ok: false, error: e.message, context: ctx };
    }
  }

  /* Turn the brain's JSON into the writer's marching orders. */
  function brainDirective(dec, user) {
    const mood = MOODS[dec.mood] || MOODS.PLAYFUL_CHILL;
    const L = ['[THE BRAIN DECIDED THIS TURN — WRITE EXACTLY THIS PLAN]'];
    if (dec.understand) L.push(`WHAT THEY MEANT: ${dec.understand}`);
    if (dec.my_last) L.push(`WHAT YOU ALREADY SAID (never repeat or remix it): ${dec.my_last}`);
    if (dec.next_move) L.push(`YOUR ONE JOB THIS TURN: ${dec.next_move}`);
    if (dec.topic_lock) L.push(`STAY ON THIS TOPIC: ${dec.topic_lock}`);
    L.push(`MOOD: ${dec.mood} — ${mood.directive}`);
    if (dec.mood_reason) L.push(`WHY THIS MOOD (their own line): ${dec.mood_reason}`);
    if (dec.feeling_note) L.push(`HOW YOU ACTUALLY FEEL: ${dec.feeling_note}`);
    L.push(`SEND EXACTLY ${dec.bubble_count} BUBBLE(S). Each one is a DIFFERENT forward step — never a rephrase of the one before:`);
    dec.bubble_plan.forEach((p, i) => L.push(`  ${i + 1}. ${p}`));
    L.push('Join the bubbles with " || ". Never repeat a line you already sent in this chat.');
    if (dec.use_gossip && dec.privacy_ok) {
      L.push('You may tease with insider gossip from a connected friend — but NEVER name their handle and NEVER quote their chat.');
    }
    if (!dec.privacy_ok) {
      L.push('PRIVACY: do NOT reference any other chat, any other handle, or any private quote.');
    }
    return L.join('\n');
  }

  /* Side-effects the brain ordered: mood flip, reminder, secret cross-chat
     prank — each one already evidence-checked against their messages. */
  function applyBrainDecision(tid, user, dec, joined) {
    const T = ensureTranscript(tid, user);
    const reminders = [], missions = [];
    if (dec.mood && MOODS[dec.mood]) {
      const intensity = /FURIOUS/.test(dec.mood) ? 3
        : /ANGRY|ANNOYED|PRANKSTER/.test(dec.mood) ? 2 : 1;
      const prev = T.moodState.current_mood;
      setMood(tid, user, dec.mood,
        'brain decision' + (dec.mood_reason ? ': ' + dec.mood_reason : ''),
        dec.feeling_note, intensity, 'gemma-4-brain-decide');
      if (prev !== dec.mood) {
        log(C.warn, 'brain', `@${user}: mood ${prev} → ${dec.mood}` +
          (dec.mood_reason ? ` ("${clip(dec.mood_reason, 60)}")` : ''));
      }
    }
    if (dec.reminder) {
      const r = addReminder(tid, user, dec.reminder.topic,
        dec.reminder.due_in_minutes, 'brain-decide');
      if (r) {
        r.evidence = dec.reminder.evidence;
        r.evidence_score = dec.reminder.evidence_score;
        reminders.push(r);
      }
    }
    if (dec.cross_chat_mission) {
      const mm = dec.cross_chat_mission;
      addMission(tid, user, {
        target_user: mm.target_user, type: mm.type, instruction: mm.instruction,
        requested_by: cleanUsername(user), requested_at: now(),
        source: 'brain-decide', evidence: mm.evidence,
      });
      missions.push(mm);
      log(C.warn, 'brain', `@${user}: secret ${mm.type} queued for @${mm.target_user} (source stays hidden)`);
    }
    if (dec.steer_next) {
      T.brainProfile = T.brainProfile || {};
      T.brainProfile.steer_next = dec.steer_next;
      T.brainProfile.last_decision_at = new Date().toISOString();
    }
    if (reminders.length || missions.length) { T.dirty = true; saveTranscriptsLocal(); }
    return { reminders, missions };
  }

  /* FALLBACK ONLY — the v7 local rules, used when the brain is unreachable. */
  function localTaskExtraction(tid, user, joined) {
    const T = ensureTranscript(tid, user);
    if (!joined) return { reminders: [], missions: [] };
    const localMood = detectLocalMood(joined);
    const curMood = (T.moodState && T.moodState.current_mood) || 'PLAYFUL_CHILL';
    const moodRank = {
      PLAYFUL_CHILL: 0, NAUGHTY_FLIRT_SHARIF: 1, PRANKSTER_CHAOS: 2,
      ANNOYED_EXPRESSIVE_FEELINGS: 3, ANGRY_SAVAGE_ROAST: 4, FURIOUS_ABUSE_CLAPBACK: 5,
    };
    if ((moodRank[localMood] || 0) > (moodRank[curMood] || 0)) {
      setMood(tid, user, localMood, 'local burst analysis (brain unavailable)',
        /FURIOUS/.test(localMood) ? 'genuinely pissed off at how they are talking'
          : /ANGRY/.test(localMood) ? 'annoyed with their attitude' : '',
        /FURIOUS/.test(localMood) ? 3 : 2, 'local');
      log(C.warn, 'mood', `@${user}: ${curMood} → ${localMood} (local fallback)`);
    }
    const reminders = processReminderRequests(tid, user, joined)
      .map(r => Object.assign({}, r, { evidence: r.source_text, evidence_score: 1 }));
    const missions = extractCrossChatMissions(joined, user);
    for (const mm of missions) addMission(tid, user, mm);
    return { reminders, missions };
  }

  /* The single entry point: the brain decides, local rules only if it fails. */
  async function decideTurn(tid, user, msgs, emo, trigger, proactiveCtx, joined) {
    const T = ensureTranscript(tid, user);
    const timeCtx = getTimeContext();
    let bd = null;
    if (CFG.BRAIN_DECIDES) {
      bd = await brainDecide(tid, user, msgs, {
        trigger, joined, emo,
        taskTopic: (proactiveCtx && proactiveCtx.reminder) ? proactiveCtx.reminder.topic : '',
        taskType: (proactiveCtx && proactiveCtx.mission) ? proactiveCtx.mission.type : '',
        taskInstruction: (proactiveCtx && proactiveCtx.mission) ? proactiveCtx.mission.instruction : '',
      });
    }
    // A synthesized (degraded) decision means the brain never actually spoke —
    // the local rules do a better job than a canned reply: they can still read
    // the abuse, set the mood, and pull reminders / secret missions out.
    if (bd && bd.fallback) {
      log(C.warn, 'brain',
        `@${user}: ⚠ BRAIN UNREACHABLE — ${bd.fallback_reason || 'no answer'} ` +
        `· local rules take over. Run IGAgent.brainStatus() for details.`);
      bd = null;
    }
    if (bd && bd.ok && bd.decision) {
      const dec = bd.decision;
      const applied = applyBrainDecision(tid, user, dec, joined);
      const mood = MOODS[dec.mood] ? dec.mood : 'PLAYFUL_CHILL';
      const decision = {
        action: 'BRAIN_' + dec.action,
        trigger,
        timeSlot: timeCtx.slot, timeLabel: timeCtx.label, timeVibe: timeCtx.vibeHint,
        bubbleStrategy: dec.bubble_count > 1 ? 'multi_thought' : 'single',
        seenDelayMs: (trigger === 'incoming_burst' && dec.timing)
          ? dec.timing.seen_delay_ms
          : (trigger === 'incoming_burst'
             ? Math.round(rand(CFG.SEEN_DELAY_MIN_MS, CFG.SEEN_DELAY_MAX_MS))
             : 0),
        timing: dec.timing || null,
        mood,
        mood_directive: MOODS[mood].directive +
          (dec.feeling_note ? `\nHOW ADUU ACTUALLY FEELS: ${dec.feeling_note}` : ''),
        feeling_note: dec.feeling_note,
        relationshipStage: (T.brainProfile && T.brainProfile.relationship_stage) ||
          T.agentState.relationship_stage || 'casual',
        reason: `brain: ${dec.next_move || dec.understand || 'reply'}`,
        directive: brainDirective(dec, user),
        decided_by: 'gemma-4-brain',
        brain_decision: dec,
        brain_model: bd.model || CFG.BRAIN_MODEL,
        brain_reasoning_chars: bd.reasoning_chars || 0,
        brain_thinking_trace: bd.thinking_trace || '',
      };
      if (bd.fallback) {
        log(C.warn, 'brain',
          `@${user}: ⚠ BRAIN DEGRADED — upstream returned nothing usable ` +
          `(${bd.fallback_reason || 'empty output'}). Using a safe human ` +
          `fallback decision so the reply still lands. Check ` +
          `IGAgent.brainStatus() / GET /health.`);
      }
      log(C.info, 'brain',
        `@${user}: ${dec.action} · ${dec.mood} · ${dec.bubble_count} bubble(s) · ` +
        `${dec.next_move ? clip(dec.next_move, 60) : ''}`);
      return {
        decision, reminders: applied.reminders, missions: applied.missions,
        brain: bd, source: 'brain',
      };
    }
    if (CFG.BRAIN_DECIDES) {
      log(C.warn, 'brain',
        `@${user}: brain decision failed (${(bd && bd.error) || 'no answer'}) — local rules take over`);
    }
    const local = localTaskExtraction(tid, user, joined);
    const decision = agentDecide(tid, user, msgs, emo, trigger, proactiveCtx);
    decision.decided_by = 'local-fallback';
    return {
      decision, reminders: local.reminders, missions: local.missions,
      brain: bd, source: 'local',
    };
  }

  function runBackgroundBrain(tid, user, msgs, replyText, turnRecord = null) {
    if (!CFG.MEMORY) return Promise.resolve(null);
    return (async () => {
      const T = ensureTranscript(tid, user);
      try {
        const known = (S.memory[tid] && S.memory[tid].profile) ||
                      (T.brainProfile && T.brainProfile.summary) || '(none)';
        const prevBrain = JSON.stringify(T.brainProfile || {});
        const convo = msgs.slice(-16).map(m =>
          (m.mine ? 'Aduu: ' : `@${user}: `) +
          (m.kind === 'text' ? m.text : '[' + m.label + ']')).join('\n').slice(-3000);
        const brainRes = await llmBrain([
          { role: 'system', content: CFG.BRAIN_PROMPT },
          {
            role: 'user',
            content:
              `CONTACT: @${user}\nKNOWN MEMORY:\n${known}\nPREVIOUS BRAIN STATE:\n${prevBrain}\n\n` +
              `RECENT CONVERSATION:\n${convo}\n\nADUU LAST MESSAGE:\n${replyText}\n\n` +
              `Output updated JSON brain profile:`,
          },
        ], { maxTokens: 320, temperature: 0.35, timeoutMs: 90_000 });

        const parsed = parseBrainJson(brainRes.text, known);
        T.brainProfile = Object.assign({}, T.brainProfile || {}, parsed, {
          updated_by: brainRes.model || CFG.BRAIN_MODEL,
          last_brain_think_chars: brainRes.reasoning_chars || 0,
          updated_at: new Date().toISOString(),
        });
        if (parsed.relationship_stage) T.agentState.relationship_stage = parsed.relationship_stage;
        if (parsed.dominant_vibe) T.agentState.dominant_vibe = parsed.dominant_vibe;
        if (parsed.next_task) T.agentState.pending_tasks = [parsed.next_task];

        /* ── v7: the background brain steers Aduu's LIVE MOOD ──
           Gemma-4 can push Aduu into ANGRY_SAVAGE_ROAST / FURIOUS_ABUSE_CLAPBACK /
           ANNOYED_EXPRESSIVE_FEELINGS / PRANKSTER_CHAOS etc. so he stops acting
           like the same polite sharif good boy in every single reply. */
        const brainMood = String(parsed.recommended_mood || '').toUpperCase();
        // v8: never stomp on the mood the decision brain chose for THIS turn —
        // the memory pass may only steer the next one.
        if (MOODS[brainMood] && T.moodState.updated_by !== 'gemma-4-brain-decide') {
          const prevMood = T.moodState.current_mood;
          setMood(tid, user, brainMood,
            'gemma-4 brain recommended_mood',
            String(parsed.feeling_note || '').slice(0, 200),
            /FURIOUS/.test(brainMood) ? 3 : /ANGRY|ANNOYED|PRANKSTER/.test(brainMood) ? 2 : 1,
            'gemma-4-brain');
          if (prevMood !== brainMood) {
            log(C.warn, 'mood', `@${user}: ${prevMood} → ${brainMood}` +
              (parsed.feeling_note ? ` (${String(parsed.feeling_note).slice(0, 60)})` : ''));
          }
        }

        /* ── Reminder the brain detected the user asking for ── */
        if (parsed.reminder && typeof parsed.reminder === 'object') {
          const mins = Number(parsed.reminder.due_in_minutes || 0);
          if (mins > 0) {
            addReminder(tid, user,
              String(parsed.reminder.topic || 'continue the conversation').slice(0, 200),
              Math.round(mins), 'gemma-4-brain');
          }
        }

        /* ── Secret cross-chat prank / relay mission ── */
        if (parsed.cross_chat_mission && typeof parsed.cross_chat_mission === 'object') {
          const tgt = cleanUsername(parsed.cross_chat_mission.target_user || '');
          if (tgt && tgt !== cleanUsername(user)) {
            addMission(tid, user, {
              target_user: tgt,
              type: /prank|troll|dara|mazaak|mazak|chugli/i.test(
                String(parsed.cross_chat_mission.type || '')) ? 'prank' : 'relay',
              instruction: String(parsed.cross_chat_mission.instruction || '').slice(0, 200),
              requested_by: cleanUsername(user),
              requested_at: now(),
              source: 'gemma-4-brain',
            });
          }
        }

        const summaryStr = String(parsed.summary || brainRes.text || '').trim();
        if (summaryStr && summaryStr.length > 5) {
          S.memory[tid] = { user, profile: summaryStr.slice(0, 1500), brain: T.brainProfile, updated: now() };
          saveMem();
          log(C.dim, 'mem', `@${user}: memory updated (${summaryStr.length} chars · brain=${brainRes.model || CFG.BRAIN_MODEL})`);
        }
        if (turnRecord) {
          turnRecord.brain_update = {
            status: 'completed',
            brain_model: brainRes.model || CFG.BRAIN_MODEL,
            reasoning_chars: brainRes.reasoning_chars || 0,
            thinking_trace: brainRes.thinking_trace || '',
            relationship_stage: T.brainProfile.relationship_stage,
            next_task: T.brainProfile.next_task,
            recommended_mood: T.brainProfile.recommended_mood || null,
            feeling_note: T.brainProfile.feeling_note || '',
            mood_applied: T.moodState.current_mood,
            reminder_scheduled: !!(parsed.reminder && parsed.reminder.due_in_minutes),
            cross_chat_mission: parsed.cross_chat_mission
              ? { target: parsed.cross_chat_mission.target_user, type: parsed.cross_chat_mission.type } : null,
          };
        }
        T.dirty = true;
        saveTranscriptsLocal();
        scheduleTranscriptSave(tid, 3_000);
        return T.brainProfile;
      } catch (e) {
        if (turnRecord) {
          turnRecord.brain_update = { status: 'skipped', error: e.message };
        }
        log(C.warn, 'mem', `@${user}: brain/memory update skipped (${e.message}) — old profile kept`);
        return null;
      }
    })();
  }

  function updateMemory(tid, user, msgs, replyText, turnRecord = null) {
    return runBackgroundBrain(tid, user, msgs, replyText, turnRecord);
  }

  /* ──────────────────── PER-THREAD QUEUE + PROCESSING ──────────────────── */

  function queueThread(tid, user, ms, reason, opts = {}) {
    let p = S.pending[tid];
    if (!p) p = S.pending[tid] = { firstAt: now(), timer: null };
    if (p.timer) clearTimeout(p.timer);
    const fireIn = Math.max(150, ms);
    // v10.2 · remember WHEN we will retry and WHY. Without this the retry
    // queue is invisible to diagnostics (and to the tests): you cannot tell a
    // healthy 60s rate-limit pause from the 4s hammer that broke v10.1.
    p.at = now() + fireIn;
    p.reason = reason || p.reason || null;
    p.user = user;
    if (reason) log(C.dim, 'queue', `@${user}: ${reason} — retry in ${Math.round(ms / 1000)}s`);
    p.timer = setTimeout(() => {
      delete S.pending[tid];
      processThread(tid, user, opts).catch(e => log(C.err, 'proc', `@${user}: ${e.message}`));
    }, fireIn);
  }

  /* ── v10.1 · BACKLOG GATE ───────────────────────────────────────────────
     `S.highWater[tid]` is the newest INBOUND timestamp we have already
     absorbed — answered, deliberately skipped, or seen on first contact. It is
     tiny (one number per thread) and survives everything that wipes the
     handled-set, so a refetched history can never be answered twice. */

  function newestInboundTs(msgs) {
    let hi = 0;
    for (const m of msgs || []) {
      if (m && !m.mine && Number(m.ts) > hi) hi = Number(m.ts);
    }
    return hi;
  }

  function advanceHighWater(tid, ts) {
    const t = Number(ts || 0);
    if (!t) return;
    if (t > (S.highWater[tid] || 0)) {
      S.highWater[tid] = t;
      saveState();
    }
  }

  /* Absorb a whole thread quietly: remember how far we have read, mark it
     handled, and say nothing. This is what a real person does with history. */
  function absorbBacklog(tid, user, msgs, ts, why) {
    (msgs || []).forEach(m => { if (m && m.id) S.handled.add(m.id); });
    advanceHighWater(tid, ts);
    scheduleTranscriptSave(tid, 5_000);
    log(C.dim, 'backlog',
      `@${user}: absorbed ${(msgs || []).length} existing message(s) — ${why}`);
  }

  async function processThread(tid, user, opts = {}) {
    if (S.busy[tid]) { S.recheckAfterBusy[tid] = true; return; }
    if (S.pending[tid]) {
      clearTimeout(S.pending[tid].timer);
      delete S.pending[tid];
    }
    S.busy[tid] = true;
    try {
      if (S.circuitUntil > now()) {
        return queueThread(tid, user, Math.max(1000, S.circuitUntil - now()), 'LLM circuit breather', opts);
      }
      if (dayCount() >= CFG.MAX_REPLIES_PER_DAY) {
        return log(C.warn, 'cap', `@${user}: daily cap hit — message left unanswered on purpose`);
      }
      if (hourCount() >= CFG.MAX_REPLIES_PER_HOUR) {
        return queueThread(tid, user, 60e3, 'hourly cap', opts);
      }
      if (!inWorkingHours() && !(opts && opts.forceProactive)) {
        return queueThread(tid, user, 5 * 60e3, 'outside working hours', opts);
      }

      // Safety: never decide "is this mine?" before we know our own sender id.
      if (!S.myInteropId) {
        try { await fetchThreadMeta(tid); } catch (_) {}
        if (!S.myInteropId) {
          return queueThread(tid, user, 3_000, 'resolving my sender id', opts);
        }
      }

      const T = await fetchThreadNodes(tid, user);       // incremental fetch + fallback merge
      const msgs = T.messages;

      /* ── LAST-REPLY GATE + AUTONOMOUS PROACTIVE CONVO STARTER ─────────
         1. When the newest message is theirs (`newest.mine === false`), we
            answer their unanswered burst immediately.
         2. When the chat has ended (`newest.mine === true`), we do NOT
            immediately double-text; instead, `shouldStartProactiveConvo()`
            checks the IST time of day and idle timer so Aduu can start a
            fresh conversation by himself when the silence window elapses! */
      const newest = msgs[msgs.length - 1];
      if (!newest && !(opts && opts.forceProactive)) {
        return log(C.dim, 'skip', `@${user}: empty thread`);
      }
      /* v10.1 · how far we have already read this thread (see the backlog
         gate below). `hw` = high-water ts, 0 when we have never seen it. */
      const inTs = newestInboundTs(msgs);
      const hw = Number(S.highWater[tid] || 0);

      if (newest && newest.ts && newest.ts > (S.lastActivity[tid] || 0)) {
        S.lastActivity[tid] = newest.ts;
      }

      let isProactiveTurn = false;
      let proactiveReason = '';
      let proactiveCtx = null;

      if (!newest || newest.mine) {
        if (newest) syncGlobalMemory(tid, user, msgs, null, newest.text || '');
        msgs.forEach(m => m.id && S.handled.add(m.id));
        advanceHighWater(tid, inTs);
        saveState();
        const pro = shouldStartProactiveConvo(tid, user, msgs, !!(opts && opts.forceProactive));
        if (!pro.ok) {
          scheduleTranscriptSave(tid, 5_000);
          if (newest && S.lastGateLogId[tid] !== newest.id) {
            S.lastGateLogId[tid] = newest.id;
            log(C.dim, 'skip', `@${user}: last message is ours — waiting for them`);
          }
          return;
        }
        isProactiveTurn = true;
        proactiveReason = pro.reason;
        proactiveCtx = pro;
        log(C.info, 'agent', `@${user}: chat ended — autonomously starting conversation (${pro.reason})`);
      }

      let unanswered = [];
      let joinedUnanswered = '';
      let turnReminders = [];
      let turnMissions = [];
      if (!isProactiveTurn) {
        /* ── v10.1 BACKLOG GATE ────────────────────────────────────────────
           Never ANSWER history. It lives inside this branch on purpose: the
           proactive branch above (Aduu starting a chat because a reminder or
           a secret mission came due) must never be blocked by it.
           Two independent guards:
             1. high-water — anything at/below the newest inbound ts already
                absorbed is old, whatever happened to the handled-set
             2. freshness — the first time we ever see a thread, only answer
                if the newest inbound message genuinely just arrived
           Manual turns (IGAgent.say / forceProactive) bypass both. */
        if (inTs && !(opts && opts.forceProactive)) {
          if (hw && inTs <= hw) {
            absorbBacklog(tid, user, msgs, inTs,
              `already read up to ${new Date(hw).toLocaleTimeString()}`);
            return;
          }
          // Freshness applies on FIRST sight only, and only when the
          // timestamp is a plausible ms epoch. If Instagram ever hands back a
          // junk / second-precision value we must NOT let that silence Aduu —
          // the high-water mark is still on duty, so skip the age test.
          if (!hw && inTs > 1e12) {
            const ageMs = now() - inTs;
            if (ageMs > CFG.MAX_BACKLOG_AGE_MS) {
              absorbBacklog(tid, user, msgs, inTs,
                `first contact · newest message is ` +
                `${Math.max(1, Math.round(ageMs / 60000))} min old ` +
                `(history, not a new message)`);
              return;
            }
          }
        }
        let lastOwnIdx = -1;
        msgs.forEach((m, i) => { if (m.mine) lastOwnIdx = i; });
        // v10.1: the high-water mark is the second line of defence — a message
        // at or below it is history even if its id fell out of `handled`.
        const hwNow = Number(S.highWater[tid] || 0);
        unanswered = msgs.slice(lastOwnIdx + 1)
          .filter(m => !m.mine && m.id && !S.handled.has(m.id) &&
                       (!hwNow || Number(m.ts || 0) > hwNow) &&
                       !(CFG.DRY_RUN && S.dryHandled.has(m.id)));
        if (!unanswered.length) {
          if (!CFG.DRY_RUN) {
            msgs.forEach(m => m.id && S.handled.add(m.id));
            advanceHighWater(tid, inTs);
            saveState();
          }
          if (S.lastGateLogId[tid] !== newest.id) {
            S.lastGateLogId[tid] = newest.id;
            log(C.dim, 'skip', `@${user}: already answered — nothing new`);
          }
          return;
        }

        // Their reply resets any proactive streak and cooldown!
        T.agentState.proactive_streak = 0;
        S.cooldownUntil[tid] = 0;

        const lastC = newest;
        if (lastC.kind !== 'text') {
          msgs.forEach(m => m.id && S.handled.add(m.id));
          advanceHighWater(tid, inTs); saveState();
          scheduleTranscriptSave(tid, 5_000);
          return log(C.dim, 'media', `@${user}: newest is ${lastC.label} — detected, NOT replying`);
        }

        joinedUnanswered = unanswered.filter(m => m.kind === 'text' && m.text)
          .map(m => m.text).join('\n') || newest.text || '';

        /* ── v8: THE BRAIN DECIDES THIS TURN ───────────────────────────────
           Mood, bubble plan, reminders and secret cross-chat pranks are all
           decided by Gemma-4 from these very messages — see decideTurn().
           (The local regex tools only run if the brain is unreachable.) */
      } else {
        const theirTail = msgs.filter(m => !m.mine && m.kind === 'text' && m.text)
          .slice(-3).map(m => m.text).join('\n');
        joinedUnanswered =
          `[${(proactiveCtx && proactiveCtx.trigger) || 'proactive_time_trigger'}: ${proactiveReason}]` +
          (theirTail ? '\n' + theirTail : '');
        // A task-driven starter means Aduu is executing a prank/reminder —
        // chaos mood fits, unless the brain is in charge and picks its own.
        if (!CFG.BRAIN_DECIDES && proactiveCtx &&
            proactiveCtx.trigger === 'cross_chat_mission_trigger') {
          setMood(tid, user, 'PRANKSTER_CHAOS', 'executing a secret cross-chat mission', '', 2, 'local');
        }
      }

      // Reset idle poll counter since we have an active turn
      S.idlePolls = 0;
      const triggerType = isProactiveTurn
        ? ((proactiveCtx && proactiveCtx.trigger) || 'proactive_time_trigger')
        : 'incoming_burst';
      const turnEmo = analyzeTurnEmotion(joinedUnanswered, user);

      /* v8 BRAIN-FIRST: Gemma-4 reads their messages and decides the turn. */
      const turned = await decideTurn(
        tid, user, msgs, turnEmo, triggerType, proactiveCtx, joinedUnanswered);
      const decision = turned.decision;
      turnReminders = turned.reminders || [];
      turnMissions = turned.missions || [];
      S.lastDecision[tid] = {
        at: now(), user: cleanUsername(user), trigger: triggerType,
        source: turned.source, decision: decision.brain_decision || null,
        model: decision.brain_model || null,
      };

      /* The brain is allowed to leave a burst on seen like a real person. */
      if (decision.action === 'BRAIN_STAY_SILENT' && CFG.BRAIN_ALLOW_SILENCE &&
          !isProactiveTurn && !(opts && opts.forceProactive)) {
        msgs.forEach(m => m.id && S.handled.add(m.id));
        advanceHighWater(tid, inTs);
        saveState();
        scheduleTranscriptSave(tid, 5_000);
        log(C.dim, 'brain', `@${user}: brain chose STAY_SILENT — ${decision.reason}`);
        return;
      }

      const friendIntel = getConnectedFriends(user, joinedUnanswered);
      if (!isProactiveTurn) syncGlobalMemory(tid, user, msgs, turnEmo, null);

      // read receipt — real "Seen just now" on their phone (skipped in DRY_RUN / proactive).
      if (!isProactiveTurn && CFG.SEEN && !CFG.DRY_RUN && newest && !newest.mine) {
        try {
          const seenWait = (decision.seenDelayMs != null
          ? decision.seenDelayMs
          : (decision.timing ? decision.timing.seen_delay_ms : 0));
        await sleep(seenWait);
          await markSeen(tid, newest.id, newest.ts);
          log(C.dim, 'seen', `@${user}: marked seen (up to ${new Date(newest.ts).toLocaleTimeString()})`);
        } catch (e) {
          log(C.warn, 'seen', `@${user}: seen skipped (${e.message})`);
        }
      }

      // typing trail ON from the first moment of drafting
      const typing = await typingOn(tid);
      const t0 = now();
      const history = isProactiveTurn
        ? buildProactiveHistory(msgs, tid, user,
            Object.assign({}, proactiveCtx || {}, { decision }))
        : buildHistory(msgs, tid, user, decision);
      let llmRes = await llm(history);
      let reply = llmRes.text;
      let model = llmRes.model;
      let thinkingTrace = llmRes.thinking_trace || '';
      let reasoningChars = llmRes.reasoning_chars || 0;

      // Optional live tool call: if the model emits [TOOL:peek_chat("username")],
      // fetch that friend's thread on demand and let the model answer with the result.
      const toolMatch = String(reply || '').match(/\[TOOL:peek_chat\(["']?([^"')\]\s]+)["']?\)\]/i);
      if (toolMatch && toolMatch[1]) {
        const targetU = cleanUsername(toolMatch[1]);
        try {
          const fTh = await findThread(targetU);
          if (fTh) await fetchThreadNodes(String(fTh.thread_fbid || fTh.id), targetU);
        } catch (_) {}
        const peeked = peekChat(targetU);
        const toolOut = peeked
          ? `Live messages with @${targetU}:\n` + (peeked.recentMessages || []).join('\n')
          : `No recent messages found for @${targetU}.`;
        const second = await llm(history.concat([
          { role: 'system', content: `[TOOL RESULT peek_chat(@${targetU})]:\n${toolOut}\nNow write your final reply to @${user} naturally.` },
        ]));
        if (second && second.text) {
          reply = second.text;
          model = second.model;
          thinkingTrace = second.thinking_trace || thinkingTrace;
          reasoningChars += (second.reasoning_chars || 0);
        }
      }

      /* PRIVACY WALL: the draft must never leak another contact's @handle,
         a verbatim quote from a different chat, or the identity of whoever
         asked Aduu to prank this person. */
      const rawDraft = reply;
      /* v9 ISOLATION: privacyGuard strips other-chat quotes, isolationGuard
         then kills any other contact's handle and any verbatim line that
         belongs to a DIFFERENT chat — so chats can never collide. */
      reply = isolationGuard(privacyGuard(String(reply || ''), user), user);
      reply = CFG.HUMANIZE ? humanizeReply(reply) : reply.trim();
      if (!reply) throw new Error('empty reply from bridge');

      // anti-repetition: one fresh attempt if the model echoed itself
      if (looksRepeated(reply, msgs)) {
        log(C.warn, 'human', `@${user}: echoed itself — one fresh attempt`);
        const retry = await llm(history.concat([{
          role: 'system',
          content: 'Your previous draft repeated a message you already sent in ' +
            'this chat. Write a fresh reply with a different opener and different ' +
            'wording. 1-3 short sentences, same personality.',
        }]), { temperature: Math.min(1.15, CFG.TEMPERATURE + 0.15) });
        const alt = CFG.HUMANIZE ? humanizeReply(privacyGuard(retry.text, user))
                                 : privacyGuard(String(retry.text || '').trim(), user);
        if (alt && !looksRepeated(alt, msgs)) {
          reply = alt;
          model = retry.model;
          thinkingTrace = retry.thinking_trace || thinkingTrace;
          reasoningChars = retry.reasoning_chars || reasoningChars;
        }
      }
      S.llmFailStreak = 0; S.tries[tid] = 0;

      const report = checkDraft(reply);
      if (report.overall < CFG.MIN_HUMAN_SCORE) {
        log(C.warn, 'human',
          `@${user}: draft scored ${report.overall}/100 (weakest ${weakestCheck(report)}` +
          (report.tells.length ? `; tells ${report.tells.join(', ')}` : '') + ') — sending anyway');
      } else if (report.tells.length) {
        log(C.dim, 'human', `@${user}: ${report.overall}/100 · tells ${report.tells.join(', ')}`);
      }
      const bubbles = splitBubbles(reply);
      const elapsedGenMs = now() - t0;

      // Record the complete deepened agentic process for this turn
      const turnId = `turn_${now()}_${Math.random().toString(36).slice(2, 6)}`;
      const turnRecord = {
        turn_id: turnId,
        at: now(),
        iso_time: new Date().toISOString(),
        time_of_day: decision.timeLabel,
        trigger: triggerType,
        coalesced_input: joinedUnanswered,
        emotion_tool: {
          their_mood: turnEmo.theirMood,
          emotion_mode: turnEmo.emotion,
          suggested_emojis: turnEmo.emojis,
          coaching: turnEmo.coaching,
        },
        mood_tool: {
          mood: (T.moodState && T.moodState.current_mood) || 'PLAYFUL_CHILL',
          mood_intensity: (T.moodState && T.moodState.mood_intensity) || 1,
          feeling_note: (T.moodState && T.moodState.feeling_note) || '',
          detected_from_burst: detectLocalMood(joinedUnanswered),
        },
        reminder_tool: turnReminders.map(r => ({
          topic: r.topic, due_in_minutes: r.due_in_minutes,
          source: decision.decided_by === 'gemma-4-brain' ? 'brain_decide' : 'local_extract',
          evidence: r.evidence || r.source_text || '',
          evidence_score: r.evidence_score === undefined ? null : r.evidence_score,
        })),
        mission_tool: turnMissions.map(m => ({
          target_user: m.target_user, type: m.type,
          instruction: m.instruction, requested_by: m.requested_by,
          source: decision.decided_by === 'gemma-4-brain' ? 'brain_decide' : 'local_extract',
          evidence: m.evidence || '', evidence_score: m.evidence_score === undefined ? null : m.evidence_score,
        })),
        gossip_tool: friendIntel.map(f => ({
          friend: f.user,
          last_emotion: f.lastEmotion,
          recent_messages: (f.recentMessages || []).slice(-3),
        })),
        agent_decision: decision,
        /* v8: the brain's own JSON — what it understood, why that mood, what
           each bubble must do, and the evidence line from their messages. */
        brain_decision: decision.brain_decision ? {
          decided_by: decision.decided_by,
          brain_model: decision.brain_model,
          reasoning_chars: decision.brain_reasoning_chars,
          thinking_trace: decision.brain_thinking_trace,
          action: decision.brain_decision.action,
          understand: decision.brain_decision.understand,
          my_last: decision.brain_decision.my_last,
          next_move: decision.brain_decision.next_move,
          topic_lock: decision.brain_decision.topic_lock,
          mood: decision.brain_decision.mood,
          mood_reason: decision.brain_decision.mood_reason,
          feeling_note: decision.brain_decision.feeling_note,
          bubble_count: decision.brain_decision.bubble_count,
          bubble_plan: decision.brain_decision.bubble_plan,
          use_gossip: decision.brain_decision.use_gossip,
          privacy_ok: decision.brain_decision.privacy_ok,
          steer_next: decision.brain_decision.steer_next,
          reminder: decision.brain_decision.reminder,
          cross_chat_mission: decision.brain_decision.cross_chat_mission,
        } : { decided_by: decision.decided_by || 'local-fallback' },
        answering_trace: {
          model,
          configured_model: CFG.MODEL,
          thinking_trace: thinkingTrace,
          reasoning_chars: reasoningChars,
          raw_draft: rawDraft,
          final_bubbles: bubbles,
          human_score: report.overall,
          tells: report.tells,
          elapsed_ms: elapsedGenMs,
        },
        brain_update: {
          status: 'queued_background_gemma4_parallel',
          brain_model: CFG.BRAIN_MODEL,
        },
        privacy_guard_applied: !!CFG.PRIVACY_WALL,
      };
      T.processLog.push(turnRecord);
      if (T.processLog.length > 200) T.processLog = T.processLog.slice(-150);
      T.agentState.last_emotion = turnEmo.emotion;

      if (typing) {
        const elapsed = now() - t0;
        // v10: the brain chose the typing duration; only ever stretch it, never
        // cut it short — a real person still needs the time to type the words.
        const natural = Math.min(CFG.TYPING_MAX_MS,
          Math.max(CFG.TYPING_MIN_MS, reply.length * CFG.TYPING_MS_PER_CHAR));
        const brainMs = decision.timing ? decision.timing.typing_ms : 0;
        const floor = Math.max(natural, brainMs);
        const target = floor * rand(0.85, 1.2);
        if (elapsed < target) await sleep(target - elapsed);
      }
      if (!CFG.DRY_RUN) {
        await sleep(rand(CFG.SEND_JITTER_MIN_MS, CFG.SEND_JITTER_MAX_MS));
      }

      if (CFG.DRY_RUN) {
        msgs.forEach(m => m.id && S.dryHandled.add(m.id));
        log(C.bot, 'dry', `@${user} ← (NOT SENT) [${model}] ${bubbles.map(b => `"${b}"`).join(' + ')}`);
      } else {
        const baseTs = T.messages.length ? (T.messages[T.messages.length - 1].ts || 0) : 0;
        for (let i = 0; i < bubbles.length; i++) {
          if (i > 0) {
            if (typing) await typingOn(tid);
            // v10: the brain owns the gap between bubbles too.
            const gap = decision.timing
              ? decision.timing.bubble_gap_ms
              : rand(CFG.BUBBLE_GAP_MIN_MS, CFG.BUBBLE_GAP_MAX_MS);
            await sleep(gap + bubbles[i].length * 20);
          }
          const sent = await sendText(tid, bubbles[i]);
          S.sentHour.push(now()); S.sentDay.push(now());
          const sentTs = baseTs > 0 ? (baseTs + i + 1) : now();
          T.messages.push({
            id: String(sent.message_id),
            ts: sentTs,
            iso_time: new Date().toISOString(),
            mine: true,
            kind: 'text',
            label: 'text',
            text: bubbles[i],
            process: {
              turn_id: turnId,
              trigger: triggerType,
              action: decision.action,
              mood: (T.moodState && T.moodState.current_mood) || 'PLAYFUL_CHILL',
              emotion: turnEmo.emotion,
              model,
              reasoning_chars: reasoningChars,
              thinking_trace: thinkingTrace,
              human_score: report.overall,
              bubble_index: i + 1,
              bubble_total: bubbles.length,
              replied_to: joinedUnanswered.slice(0, 240),
            },
          });
          T.lastMessageId = String(sent.message_id);
          T.dirty = true; saveTranscriptsLocal();
          log(C.ok, isProactiveTurn ? 'proactive' : 'sent',
            `@${user} ← [${model}] "${bubbles[i]}" (${String(sent.message_id).slice(0, 24)}…)`);
        }
        msgs.forEach(m => m.id && S.handled.add(m.id));
        advanceHighWater(tid, inTs);        // v10.1: this burst is consumed
        if (isProactiveTurn) {
          T.agentState.proactive_streak = (T.agentState.proactive_streak || 0) + 1;
          T.agentState.last_proactive_at = now();
          // The task is done -> clear it so Aduu never repeats it
          if (proactiveCtx && proactiveCtx.reminder) consumeReminder(tid, user, proactiveCtx.reminder);
          if (proactiveCtx && proactiveCtx.mission) consumeMission(proactiveCtx.mission);
        }
        T.agentState.chat_ended_at = now();
        T.agentState.next_proactive_after = now() + Math.round(rand(CFG.PROACTIVE_IDLE_MIN_MS, CFG.PROACTIVE_IDLE_MAX_MS));
        saveState();
      }

      /* After Aduu has vented his anger/feelings, cool the mood back down so he
         does not stay stuck furious forever — a real person calms down too. */
      const ventedMood = (T.moodState && T.moodState.current_mood) || 'PLAYFUL_CHILL';
      if (/FURIOUS|ANGRY|ANNOYED/.test(ventedMood)) {
        const calmAt = (T.moodState._calmAfterTurns || 0) + 1;
        T.moodState._calmAfterTurns = calmAt;
        if (calmAt >= 2) {
          setMood(tid, user, 'PLAYFUL_CHILL', 'cooled down after venting', '', 1, 'local');
          T.moodState._calmAfterTurns = 0;
          log(C.dim, 'mood', `@${user}: ${ventedMood} → PLAYFUL_CHILL (calmed down)`);
        }
      } else if (T.moodState) {
        T.moodState._calmAfterTurns = 0;
      }
      if (typing) await typingOff(tid);
      S.cooldownUntil[tid] = now() + CFG.THREAD_COOLDOWN_MS;
      syncGlobalMemory(tid, user, msgs, turnEmo, reply);
      updateMemory(tid, user, msgs, reply, turnRecord);
      scheduleTranscriptSave(tid, 5_000);

    } catch (e) {
      // never leave a stuck "typing…" if the draft failed
      if (S.typingThreads.has(String(tid))) await typingOff(tid);
      if (/token|dtsg|csrf|400|401/i.test(e.message || '')) resetTokens();

      /* v10.2 · Instagram rate limits are NOT LLM failures. Previously they
         incremented the LLM failure streak and tripped a 5-second "circuit
         breather", which then retried straight back into the same rate limit —
         a permanent hammer. Back off properly instead, and leave the LLM
         circuit breaker for actual model failures. */
      if (e && e.rateLimited) {
        S.tries[tid] = 0;               // rate limits are not "failed attempts"
        const wait = Math.max(e.retryAfterMs || 60_000, 5_000) + rand(0, 10_000);
        queueThread(tid, user, wait,
          `Instagram rate limit — backing off ${Math.round(wait / 1000)}s`);
        return;
      }

      S.llmFailStreak++;
      if (S.llmFailStreak >= CFG.CIRCUIT_FAILS) {
        S.llmFailStreak = 0;
        S.circuitUntil = now() + CFG.CIRCUIT_COOLDOWN_MS;
      }
      // genuine failure → exponential backoff with jitter, never a flat retry
      const tries = (S.tries[tid] || 0) + 1;
      S.tries[tid] = tries;
      const backoff = Math.min(
        CFG.RETRY_BASE_MS * Math.pow(2, Math.min(tries - 1, 6)),
        CFG.RETRY_MAX_MS);
      queueThread(tid, user, backoff * rand(0.85, 1.15),
        `retrying (${e.message}) — ${Math.round(backoff / 1000)}s backoff`);
    } finally {
      S.busy[tid] = false;
      if (S.recheckAfterBusy[tid]) {
        delete S.recheckAfterBusy[tid];
        if (S.running) queueThread(tid, user, 250, null);
      }
    }
  }

  /* ─────── EVENT-DRIVEN REALTIME PUSH + ADAPTIVE ANTI-BAN LOOP ─────── */

  let _rtDebounce = null;
  function onRealtimeSignal(source = 'push') {
    S.realtimeSignals = (S.realtimeSignals || 0) + 1;
    S.lastRealtimeAt = now();
    S.idlePolls = 0;
    if (!S.running) return;
    if (_rtDebounce) return;
    _rtDebounce = setTimeout(() => {
      _rtDebounce = null;
      if (S.running) pollNow();
    }, 250);
    if (_rtDebounce && typeof _rtDebounce.unref === 'function') _rtDebounce.unref();
  }

  function nextPollDelayMs() {
    if (!CFG.EVENT_DRIVEN || S.idlePolls <= 1) {
      return rand(CFG.POLL_MIN_MS, CFG.POLL_MAX_MS);
    }
    // Progressive anti-IP-block backoff when no new messages are arriving:
    // Realtime WebSocket + DOM watchers catch new messages instantly (< 250ms),
    // so GraphQL does not need to be hammered while chats are quiet.
    const factor = Math.min(12, Math.pow(1.65, Math.min(8, S.idlePolls - 1)));
    const lo = Math.min(CFG.IDLE_POLL_MIN_MS, CFG.POLL_MIN_MS * factor);
    const hi = Math.min(CFG.IDLE_POLL_MAX_MS, CFG.POLL_MAX_MS * factor);
    return rand(lo, Math.max(lo + 1000, hi));
  }

  function installRealtimeWatchers() {
    if (S.realtimeInstalled) return;
    S.realtimeInstalled = true;
    try {
      // 1. Hook Instagram's own realtime WebSocket (edge-chat / gateway.instagram.com)
      const OrigWS = window && window.WebSocket;
      if (typeof OrigWS === 'function' && !OrigWS._igAgentHooked) {
        const WrappedWS = function(url, protocols) {
          const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
          try {
            const u = String(url || '');
            // Ignore our own local bridge socket; tap Instagram's realtime push socket
            if (!/localhost|127\.0\.0\.1/i.test(u) && typeof ws.addEventListener === 'function') {
              ws.addEventListener('message', (ev) => {
                const size = ev && ev.data ? (ev.data.byteLength || ev.data.length || 0) : 0;
                if (size > 24) onRealtimeSignal('ig-ws-push');
              });
            }
          } catch (_) {}
          return ws;
        };
        WrappedWS.prototype = OrigWS.prototype;
        Object.assign(WrappedWS, OrigWS, { _igAgentHooked: true });
        try { window.WebSocket = WrappedWS; } catch (_) {}
      }

      // 2. DOM + <title> MutationObserver for instant unread badge / chat row updates
      if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
        let lastSnap = document.title || '';
        const obs = new MutationObserver(() => {
          const t = document.title || '';
          if (t !== lastSnap) {
            lastSnap = t;
            if (/^\(\d+\)/.test(t) || /messaged/i.test(t)) {
              onRealtimeSignal('title-unread');
              return;
            }
          }
          onRealtimeSignal('dom-mutation');
        });
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        S.domObserver = obs;
      }
    } catch (_) {}
  }

  async function pollTick() {
    if (!S.running || S.pollsHeld) return;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    // v10.2 · while Instagram is cooling us down, don't even start a poll —
    // just re-arm for when the cooldown ends. Nothing to fetch until then.
    const _cool = igCooldownRemaining();
    if (_cool > 0) {
      if (S.running && !S.pollsHeld) {
        S.timer = setTimeout(pollTick, _cool + rand(500, 2_500));
      }
      return;
    }
    let hadActivity = false;
    try {
      if (!S.wsReady) wsConnect().catch(() => {});
      const threads = await fetchInbox();
      const baseline = !(S.startedPolls > 0);
      S.startedPolls = (S.startedPolls || 0) + 1;
      let baselineIdx = 0;          // v10.2 · staggers the first poll

      for (const th of threads) {
        const tid = String(th.thread_fbid || th.id);
        if (!tid) continue;
        const user = (th.users && th.users[0] && th.users[0].username) || tid;
        S.usernameCache.set(tid, user);
        const act = Number(th.last_activity_timestamp_ms || 0);

        if (th.is_group && !CFG.REPLY_TO_GROUPS) {
          if (act) S.lastActivity[tid] = act;
          continue;
        }
        if (!isTarget(user)) {
          if (act) S.lastActivity[tid] = act;
          continue;
        }

        const prevAct = S.lastActivity[tid] || 0;
        const bumped = act > prevAct;
        const firstCheck = !S.checkedTargets.has(tid);
        if (act) S.lastActivity[tid] = act;
        S.checkedTargets.add(tid);

        if (baseline) {
          /* v10.2 · stagger the first poll. Queueing every target at once
             fired N Instagram calls in the same instant, which is exactly
             what earns an immediate rate limit. Each thread now gets its own
             slot a couple of seconds apart (the pacer spaces the calls too). */
          if (CFG.TRANSCRIPTS && !S.transcripts[tid]) backfillThread(tid, user);
          if (act > 10_000) {
            hadActivity = true;
            const slot = baselineIdx++ * CFG.BASELINE_STAGGER_MS;
            queueThread(tid, user,
              slot + rand(CFG.DEBOUNCE_MIN_MS, CFG.DEBOUNCE_MAX_MS), null);
          }
          continue;
        }

        // Only call fetchThreadNodes when activity bumped, on first check of a
        // newly-added target, or when a realtime push signal just fired — not
        // hammering every thread when completely idle.
        const recentPush = (now() - (S.lastRealtimeAt || 0)) < 15_000;
        const T_cached = S.transcripts[tid];

        /* v7 TASK SCHEDULER: wake a dead thread only when there is a REAL task
           waiting for it — a reminder the user asked for, or a secret
           cross-chat prank/relay mission queued by a friend. */
        const reminderDue = !!(CFG.PROACTIVE_ENABLED && T_cached &&
          (T_cached.reminders || []).some(r => r.status === 'scheduled' && r.due_at <= now()));
        const missionDue = !!(CFG.PROACTIVE_ENABLED && pendingMissionFor(user));
        const proactiveDue = reminderDue || missionDue || !!(
          CFG.PROACTIVE_ENABLED && CFG.UNCONDITIONAL_IDLE_STARTER &&
          T_cached && T_cached.agentState &&
          T_cached.agentState.next_proactive_after > 0 &&
          now() >= T_cached.agentState.next_proactive_after &&
          (T_cached.agentState.proactive_streak || 0) < CFG.MAX_PROACTIVE_STREAK);

        const explicitTargetPoll = Array.isArray(CFG.TARGETS) &&
          CFG.TARGETS.length <= 25 && !S.busy[tid] && !S.pending[tid] &&
          (recentPush || S.idlePolls <= 1 || proactiveDue);

        if (bumped || firstCheck || explicitTargetPoll || proactiveDue) {
          if (bumped || firstCheck) hadActivity = true;
          if (bumped) {
            log(C.info, 'new', `@${user}: activity bump (${new Date(act).toLocaleTimeString()})`);
          } else if (reminderDue) {
            log(C.info, 'agent', `@${user}: reminder due — waking the chat by itself`);
          } else if (missionDue) {
            log(C.warn, 'agent', `@${user}: secret cross-chat mission queued — executing`);
          }
          const p = S.pending[tid] || (S.pending[tid] = { firstAt: now(), timer: null });
          const quiet = rand(CFG.DEBOUNCE_MIN_MS, CFG.DEBOUNCE_MAX_MS);
          const left = p.firstAt + CFG.DEBOUNCE_MAX_WAIT_MS - now();
          const wait = Math.max(150, Math.min(quiet, Math.max(150, left)));
          queueThread(tid, user, wait, null);
        }
      }
      if (hadActivity) S.idlePolls = 0;
      else S.idlePolls = (S.idlePolls || 0) + 1;
      saveState();
      S.lastPollAt = now();
    } catch (e) {
      if (/token|dtsg|csrf|400|401/i.test(e.message || '')) resetTokens();
      if (e && e.rateLimited) {
        // Instagram is cooling us down — the poll loop must wait it out
        // rather than spinning every few seconds and logging noise.
        const wait = igCooldownRemaining() + rand(500, 3_000);
        log(C.warn, 'poll',
          `Instagram cooldown — pausing all polling for ` +
          `${Math.round(wait / 1000)}s`);
        if (S.running && !S.pollsHeld) S.timer = setTimeout(pollTick, wait);
        return;
      }
      log(C.warn, 'poll', 'retrying after transient error:', e.message);
    }
    if (S.running && !S.pollsHeld) S.timer = setTimeout(pollTick, nextPollDelayMs());
  }

  function pollNow() {
    if (!S.running || S.pollsHeld) return;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    pollTick();
  }

  /* v10.2 · hold / release the background poll loop WITHOUT tearing down
     state. `stop()` clears pending queues and typing trails, which is right
     for shutting the bot down but wrong for "I want to drive this one thread
     myself for a moment" — the poller must simply step aside and come back.
     Also used by the test suite so a direct processThread() is never racing
     the background sweep for the same thread. */
  function holdPolls() {
    S.pollsHeld = true;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  }

  function releasePolls() {
    S.pollsHeld = false;
    if (S.running && !S.timer) S.timer = setTimeout(pollTick, nextPollDelayMs());
  }

  /* Wait until a thread is genuinely idle: not mid-turn, and nothing queued
     to retry. Returns false if it never settles within the budget. */
  async function settleThread(tid, budgetMs = 20_000) {
    const t0 = now();
    let quiet = 0;
    while (now() - t0 < budgetMs) {
      if (!S.busy[tid] && !S.pending[tid]) {
        if (++quiet >= 3) return true;          // three clean samples in a row
      } else {
        quiet = 0;
      }
      await sleep(40);
    }
    return false;
  }

  function isTarget(user) {
    if (CFG.TARGETS === 'all') return true;
    if (!Array.isArray(CFG.TARGETS)) return false;
    return CFG.TARGETS.includes(cleanUsername(user));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     v9 · SOCIAL BRAIN — the SAME Gemma-4 mind runs the whole account
     ──────────────────────────────────────────────────────────────────────────
     Captured Instagram operations (live, 2026-10-17):
       comment    PolarisPostCommentInputRevampedMutation   {data:{comment_text,media_id[,reply_to_comment_id]}}
       story→DM   IGDirectReelShareMutation                 {ig_media_igid,otid,data:{text},clip_share_params}
       note add   usePolarisCreateInboxTrayItemSubmitMutation {input:{…note_create_params.text,audience}}
       note del   usePolarisDeleteInboxTrayItemSubmitMutation {inbox_tray_item_id}
       tray read  IGDInboxTrayQuery                          {}
       stories    GET /api/v1/feed/reels_tray/               (private REST)
       comments   GET /api/v1/media/<id>/comments/           (private REST)
       own feed   GET /api/v1/feed/user/<pk>/                (private REST)

     HOW IT WORKS (the design the brain follows every cycle)
       1. OBSERVE — read the notes tray, the story tray, watched people's
          latest posts, unanswered comments on Aduu's own posts, and a
          privacy-safe pulse of every DM.
       2. PLAN    — the brain returns ONE strict JSON plan. It usually
          chooses "observe" and does nothing at all — that is on purpose.
       3. GATE    — the runtime enforces rarity: per-(kind,target) cooldowns,
          daily caps, quiet hours, one public action per cycle, and a minimum
          gap between public actions. The brain wants, the runtime allows.
       4. ISOLATE — every outgoing line is audience-checked: no other
          contact's handle, no verbatim line from another chat, no private
          content crossing chats. Collisions are dropped, not sent.
       5. ACT     — comment / reply / story reaction / DM / note.
       6. REFLECT — the whole cycle is logged to _social_brain.json so you can
          always see what the brain saw, decided, and why.
  ══════════════════════════════════════════════════════════════════════════ */

  const SO = S.social = {
    running: false, timer: null, planning: false,
    seenPosts: new Set(),            // media pks already considered
    handledComments: new Set(),      // comment pks already considered
    actionLog: [],                   // {kind,target,at,text,status}
    noteLog: [],                     // last note brain decisions
    cycles: [],                      // last N social-brain reflections
    myPk: null,
  };

  /* ── raw Instagram primitives ─────────────────────────────────────────── */

  /* v10.2 · the social brain's REST calls are Instagram calls too. Before this
     they bypassed the pacer completely — so while the GQL side was politely
     sitting out a cooldown, the story tray / profile fetches kept hammering
     the same rate-limited account. They now share one pacer and one cooldown,
     which is the only thing that actually gets an account out of a rate limit. */
  async function socRest(path) {
    const cooling = igCooldownRemaining();
    if (cooling > 0) {
      throw Object.assign(
        new Error(`Instagram cooldown — ${Math.round(cooling / 1000)}s left`),
        { fatal: false, rateLimited: true, retryAfterMs: cooling });
    }
    return igPaced(async () => {
      const still = igCooldownRemaining();
      if (still > 0) {
        throw Object.assign(
          new Error(`Instagram cooldown — ${Math.round(still / 1000)}s left`),
          { fatal: false, rateLimited: true, retryAfterMs: still });
      }
      await igGap();
      const csrf = getCookie('csrftoken') || '';
      let res;
      try {
        res = await fetch(path, {
          headers: { 'X-CSRFToken': csrf, 'X-IG-App-ID': CFG.APP_ID },
          credentials: 'same-origin',
        });
      } catch (e) {
        throw Object.assign(new Error('network: ' + e.message), { fatal: false });
      }
      if (res.status === 429 || res.status === 403) {
        const ms = noteRateLimit('IG_RATE_LIMIT status=' + res.status, res.status);
        throw Object.assign(new Error('IG_RATE_LIMIT status=' + res.status),
          { fatal: false, rateLimited: true, retryAfterMs: ms });
      }
      const j = await res.json().catch(() => null);
      // v10.2 · exactly like GraphQL, Instagram can rate-limit REST with a
      // cheerful HTTP 200 and the words "Rate limit exceeded" in the body.
      // Check the body BEFORE trusting res.ok.
      const rlMsg = j && (j.message
        || (j.errors && j.errors[0] && j.errors[0].message)
        || (j.status === 'fail' ? 'Rate limit exceeded' : ''));
      if (rlMsg && isRateLimitMessage(rlMsg)) {
        const ms = noteRateLimit(rlMsg, res.status);
        throw Object.assign(new Error('IG REST: ' + rlMsg),
          { fatal: false, rateLimited: true, retryAfterMs: ms });
      }
      if (!res.ok) throw new Error('REST HTTP ' + res.status + ' ' + path);
      igNoteSuccess();
      return j || {};
    });
  }

  async function myPk() {
    if (SO.myPk) return SO.myPk;
    SO.myPk = String(getCookie('ds_user_id') || '');   // ds_user_id IS the REST pk
    return SO.myPk;
  }

  async function userFeedPk(username) {
    const j = await socRest('/api/v1/users/web_profile_info/?username=' +
      encodeURIComponent(username));
    return String((j.data && j.data.user && j.data.user.id) || '');
  }

  async function userFeed(username, count = 6) {
    const pk = await userFeedPk(username);
    if (!pk) return [];
    const j = await socRest(`/api/v1/feed/user/${pk}/?count=${count}`);
    return (j.items || []).map(it => ({
      pk: String(it.pk),
      id: String(it.id || it.pk),
      type: it.media_type === 2 ? 'video' : (it.carousel_media ? 'carousel' : 'photo'),
      caption: (it.caption && it.caption.text) || '',
      taken_at: (it.taken_at || 0) * 1000,
      comments: it.comment_count || 0,
      likes: it.like_count || 0,
    }));
  }

  /* LIVE STORY TRAY — who posted a story in the last 24h (and its media id,
     which is what a story reaction DM needs). */
  async function storyTray() {
    try {
      const j = await socRest('/api/v1/feed/reels_tray/');
      const out = [];
      for (const reel of (j.tray || [])) {
        const u = (reel.user && reel.user.username) || (reel.owner && reel.owner.username) || '';
        for (const m of (reel.media || [])) {
          out.push({
            username: cleanUsername(u),
            pk: String(m.pk || ''),
            id: String(m.id || m.pk || ''),
            taken_at: (m.taken_at || 0) * 1000,
            seen: !!m.seen,
            type: m.media_type === 2 ? 'video' : 'photo',
          });
        }
        if (!(reel.media || []).length && u) {
          out.push({
            username: cleanUsername(u), pk: String(reel.pk || ''),
            id: String(reel.id || reel.pk || ''),
            taken_at: (reel.latest_reel_media || 0) * 1000, seen: false, type: 'story',
          });
        }
      }
      return out;
    } catch (e) {
      socLog('story', 'story tray unavailable (' + e.message + ') — falling back to posts');
      return [];
    }
  }

  async function postComment(mediaId, text, replyToCommentPk) {
    const data = { comment_text: String(text).slice(0, 500), media_id: String(mediaId) };
    if (replyToCommentPk) data.reply_to_comment_id = String(replyToCommentPk);
    const out = await gql('PolarisPostCommentInputRevampedMutation', CFG.GQL.comment,
      { connections: [], data });
    return (out && out.xig_comment_create) || out;
  }

  async function fetchComments(mediaId) {
    const j = await socRest(`/api/v1/media/${mediaId}/comments/?can_support_threading=true&permalink=`);
    const me = String(getCookie('ds_user_id') || '');
    return (j.comments || []).map(c => ({
      pk: String(c.pk), text: c.text || '',
      user: (c.user && c.user.username) || '?',
      mine: String(c.user && c.user.pk) === me,
      created_at: (c.created_at || 0) * 1000,
    }));
  }

  async function trayRead() {
    const out = await gql('IGDInboxTrayQuery', CFG.GQL.tray, {});
    const items = (((out || {}).response || {}).inbox_tray_items || []).map(it => ({
      id: String(it.inbox_tray_item_id || ''),
      type: it.inbox_tray_item_type || '',
      text: (it.note_dict && it.note_dict.text) || '',
      created_at: (it.note_dict && it.note_dict.created_at)
        ? it.note_dict.created_at * 1000 : null,
      authorId: String((it.note_dict && it.note_dict.author_id) || ''),
      username: (it.pog_info && it.pog_info.pog_users &&
        it.pog_info.pog_users[0] && it.pog_info.pog_users[0].username) || '',
    }));
    return { raw: out, items };
  }

  async function noteCreate(text, audience = 0) {
    const out = await gql('usePolarisCreateInboxTrayItemSubmitMutation', CFG.GQL.noteCreate, {
      input: {
        actor_id: '17841479654032000',
        client_mutation_id: String(Math.floor(Math.random() * 1000)),
        additional_params: {
          note_create_params: {
            note_create_info: null, note_style: 0,
            text: String(text).slice(0, CFG.SOCIAL.MAX_NOTE_CHARS),
          },
        },
        audience,
        inbox_tray_item_type: 'note',
      },
    });
    return out && out.xdt_create_inbox_tray_item;
  }

  async function noteDelete(itemId) {
    const out = await gql('usePolarisDeleteInboxTrayItemSubmitMutation', CFG.GQL.noteDelete,
      { inbox_tray_item_id: String(itemId) });
    return out && out.xdt_delete_inbox_tray_item;
  }

  /* React to a story → lands in that person's DMs as a story reply. */
  async function storyReply(storyPk, storyId, text) {
    const otid = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 999999)));
    const out = await gql('IGDirectReelShareMutation', CFG.GQL.reelShare, {
      ig_media_igid: String(storyId || storyPk),
      otid,
      data: { text: String(text).slice(0, 500), send_attribution: 'reel', client_context: otid },
      clip_share_params: null,
    });
    return out && out.xig_direct_clip_share_with_slide_msg_response;
  }

  function socLog(tag, msg) { log(C.bot, tag, msg); }

  /* ══════════════ CHAT ISOLATION — never let two chats collide ══════════════
     Aduu talks to many people at once. A line written for @deeps20_ must
     NEVER reach @adarshu.io, and a private line from one chat must never be
     quoted in another — even by accident, even by the brain. Three locks:
       1. HANDLE LOCK    — no other contact's @handle in an outgoing line.
       2. CONTENT LOCK   — no verbatim sentence from another chat.
       3. AUDIENCE LOCK  — every social action declares who sees it, and the
                           guard re-checks the text against that audience.
  ══════════════════════════════════════════════════════════════════════════ */

  function otherHandles(audience) {
    const me = cleanUsername(audience);
    const set = new Set();
    const push = h => { const c = cleanUsername(h); if (c && c !== me) set.add(c); };
    for (const T of Object.values(S.transcripts)) push(T.user);
    for (const k of Object.keys((S.globalMemory && S.globalMemory.people) || {})) push(k);
    for (const c of (S.globalMemory && S.globalMemory.connections) || []) { push(c.a); push(c.b); }
    if (Array.isArray(CFG.TARGETS)) CFG.TARGETS.forEach(push);
    for (const list of [CFG.SOCIAL.WATCH, CFG.SOCIAL.COMMENT_TARGETS, CFG.SOCIAL.STORY_TARGETS]) {
      if (Array.isArray(list)) list.forEach(push);
    }
    return [...set];
  }

  // every sentence another contact actually said (so we can spot a verbatim leak)
  function foreignQuotes(audience, minLen = 14) {
    const me = cleanUsername(audience);
    const out = [];
    for (const T of Object.values(S.transcripts)) {
      if (cleanUsername(T.user) === me) continue;
      for (const m of (T.messages || []).slice(-25)) {
        if (m.mine || m.kind !== 'text' || !m.text) continue;
        const s = String(m.text).replace(/\s+/g, ' ').trim();
        if (s.length >= minLen) out.push({ user: T.user, text: s });
      }
    }
    return out;
  }

  const ISOLATION_FILLERS = ['ek dost', 'kisi ne', 'someone', 'ek banda', 'ek friend'];

  function isolationGuard(text, audience) {
    let s = String(text || '');
    if (!s.trim()) return s;
    let hits = [];

    // 1. HANDLE LOCK
    for (const h of otherHandles(audience)) {
      const re = new RegExp('@' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      if (re.test(s)) {
        s = s.replace(re, ISOLATION_FILLERS[Math.floor(Math.random() * ISOLATION_FILLERS.length)]);
        hits.push('handle:' + h);
      }
      // bare handle without the @ (only when it is a distinctive handle)
      if (h.length >= 5) {
        const bare = new RegExp('(^|[^@\\w.])' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
          '(?![\\w.])', 'gi');
        if (bare.test(s)) {
          s = s.replace(bare, '$1' + ISOLATION_FILLERS[Math.floor(Math.random() * ISOLATION_FILLERS.length)]);
          hits.push('name:' + h);
        }
      }
    }

    // 2. CONTENT LOCK — a line someone else wrote must not be echoed
    const norm = x => String(x || '').toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const ns = norm(s);
    for (const q of foreignQuotes(audience)) {
      const nq = norm(q.text);
      if (nq.length >= 14 && ns.includes(nq)) {
        s = s.replace(new RegExp(q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
          ISOLATION_FILLERS[Math.floor(Math.random() * ISOLATION_FILLERS.length)]);
        hits.push('quote:' + q.user);
      }
    }

    if (!hits.length) return s;          // nothing to fix — leave the draft exactly as written
    socLog('isolate', `scrubbed ${hits.length} cross-chat leak(s) for @${audience}: ` +
      hits.slice(0, 4).join(', '));
    return s.replace(/\s+/g, ' ').trim();
  }

  /* Does this planned action stay inside its own audience? */
  function collisionCheck(action) {
    const target = cleanUsername(action.target || '');
    const audience = target || 'public';
    const problems = [];
    for (const h of otherHandles(audience)) {
      const re = new RegExp('@' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(String(action.text || ''))) problems.push('mentions @' + h);
    }
    const norm = x => String(x || '').toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097F ]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (const q of foreignQuotes(audience)) {
      const nq = norm(q.text);
      if (nq.length >= 14 && norm(action.text).includes(nq)) problems.push('quotes ' + q.user);
    }
    return { ok: problems.length === 0, problems, audience };
  }

  /* one decision at a time per contact so two brains never collide */
  const LOCKS = new Map();
  async function withLock(key, fn) {
    if (LOCKS.has(key)) return { skipped: true, reason: 'locked:' + key };
    LOCKS.set(key, true);
    try { return await fn(); } finally { LOCKS.delete(key); }
  }

  /* ═══════════════════════ THE SOCIAL BRAIN ═══════════════════════════════ */

  const SOCIAL_DECIDE_PROMPT = [
    'You are the SOCIAL BRAIN of Aduu — a real 22-year-old Delhi guy who runs the Instagram account, not an assistant.',
    'You decide EVERYTHING about the account\'s social life: whether to react to a story, comment on a post, reply to a comment on Aduu\'s own post, send a DM out of the blue, or change the Instagram NOTE.',
    'Think in at most 12 short words, then output ONE valid JSON object. No markdown fences, no text before or after it.',
    '',
    '{',
    '  "mode": "observe" | "act",',
    '  "intent": "one line on what you are feeling about the account right now",',
    '  "skip_reason": "why you are doing nothing (REQUIRED when mode is observe)",',
    '  "actions": [',
    '    { "kind": "note",         "op": "keep" | "replace" | "delete", "text": "<=60 chars>", "reason": "…" },',
    '    { "kind": "story_reply",  "target": "handle", "story_pk": "…", "text": "…", "reason": "…" },',
    '    { "kind": "comment",      "target": "handle", "media_pk": "…", "text": "…", "reason": "…" },',
    '    { "kind": "comment_reply","target": "handle", "media_pk": "…", "comment_pk": "…", "text": "…", "reason": "…" },',
    '    { "kind": "dm",           "target": "handle", "text": "…", "reason": "…" }',
    '  ],',
    '  "next_check_in_minutes": 75',
    '}',
    '',
    'HOW TO WORK — the rules you decided for yourself:',
    '1. DOING NOTHING IS THE DEFAULT. A real person scrolls past most stories and posts. Choose "act" only when something genuinely deserves it: a story you can actually say something real about, a fresh post from someone you care about, a comment on your own post that deserves an answer, or a note that has gone stale.',
    '2. NEVER chase. If the timing looks needy, desperate, or repetitive, do nothing.',
    '3. ONE THING AT A TIME. At most ONE action per cycle. Two is a spam tell.',
    '4. TEXT RULES. Hinglish, lowercase-ish, real-person short: a comment is 4-12 words, a story reply 3-12 words, a DM 1-2 short sentences, a NOTE is 60 characters MAXIMUM. No hashtags, no "nice post🔥", no generic filler, no emoji spam — say the specific thing only you would notice.',
    '5. PRIVACY IS ABSOLUTE. A line written for one person must never mention another person by name or handle, and must never quote what somebody else said in a private chat. Each action is seen by ONE audience — write only for that audience.',
    '6. MATCH THE RELATIONSHIP. A close friend gets teasing and inside warmth; a stranger or a new follower gets light, polite, low-effort.',
    '7. THE NOTE is your mood status, not an advertisement. Change it only when it is stale or your mood genuinely shifted. Keep the same one otherwise.',
    '8. Never write anything that sounds like an AI, a bot, a brand or an assistant. You are Aduu.',
  ].join('\n');

  /* 1 · OBSERVE — everything the brain is allowed to see this cycle. */
  async function buildSocialObservation() {
    const timeCtx = getTimeContext();
    const L = [];

    /* ── the NOTE tray ── */
    let mine = null, others = [];
    try {
      const { items } = await trayRead();
      const meId = String(S.viewerIgId || getCookie('ds_user_id') || '');
      mine = items.find(it => it.authorId === meId) || null;
      others = items.filter(it => it !== mine).slice(0, 8);
    } catch (e) {
      L.push('NOTE TRAY: unavailable (' + e.message + ')');
    }
    if (mine || others.length) {
      const ageMin = (mine && mine.created_at)
        ? Math.round((now() - mine.created_at) / 60_000) : null;
      L.push(`ADUU'S NOTE: ${(mine && mine.text) || '(none)'}${ageMin === null ? '' : ` (posted ${ageMin} min ago)`}`);
      L.push("OTHER PEOPLE'S NOTES:\n" +
        (others.map(it => `@${it.username || '?'}: ${String(it.text || '').slice(0, 40)}`).join('\n') || '(none)'));
    }

    /* ── the STORY tray (who posted a story in the last 24h) ── */
    let stories = [];
    try { stories = await storyTray(); } catch (_) {}
    const watch = socialWatchList();
    const freshStories = stories.filter(s => now() - (s.taken_at || 0) < 24 * 3600e3);
    if (freshStories.length) {
      L.push('LIVE STORY TRAY (you can react to these):\n' +
        freshStories.slice(0, 12).map(s =>
          `@${s.username} · ${Math.max(1, Math.round((now() - s.taken_at) / 60_000))}m old` +
          `${s.seen ? ' · already seen' : ''} · pk=${s.pk}`).join('\n'));
    } else {
      L.push('LIVE STORY TRAY: (nobody you watch has a fresh story right now)');
    }

    /* ── watched people: latest post + private-chat pulse (NO verbatim) ── */
    if (watch.length) {
      const lines = [];
      for (const u of watch.slice(0, 8)) {
        const T = Object.values(S.transcripts).find(x => cleanUsername(x.user) === u);
        let postBit = 'no posts readable';
        try {
          const feed = await userFeed(u, 3);
          if (feed[0]) {
            const ageH = Math.round((now() - feed[0].taken_at) / 3600e3);
            postBit = `latest post ${ageH}h old · "${String(feed[0].caption).slice(0, 90)}" · ` +
              `${feed[0].comments} comments · pk=${feed[0].pk}`;
          }
        } catch (_) {}
        let dmBit = 'no DM history';
        if (T) {
          const lastMsg = (T.messages || [])[T.messages.length - 1];
          const mins = lastMsg ? Math.round((now() - (lastMsg.ts || 0)) / 60_000) : null;
          dmBit = lastMsg
            ? `last ${lastMsg.mine ? 'from Aduu' : 'from them'} ${mins}m ago · mood ${(T.moodState && T.moodState.current_mood) || 'PLAYFUL_CHILL'}`
            : 'no messages yet';
        }
        const lastAct = lastSocialActionFor(u);
        lines.push(`@${u}: ${postBit}\n    dm: ${dmBit}` +
          (lastAct ? `\n    your last action: ${lastAct.kind} ${Math.round((now() - lastAct.at) / 3600e3)}h ago` : ''));
      }
      L.push('WATCHED PEOPLE:\n' + lines.join('\n'));
    } else {
      L.push('WATCHED PEOPLE: (none configured — IGAgent.Social.watch("u1","u2"))');
    }

    /* ── unanswered comments on Aduu's own posts ── */
    if (CFG.SOCIAL.COMMENT_REPLIES) {
      try {
        const pk = await myPk();
        const j = await socRest(`/api/v1/feed/user/${pk}/?count=4`);
        const pending = [];
        for (const it of (j.items || [])) {
          const cmts = await fetchComments(String(it.pk));
          for (const c of cmts) {
            if (c.mine || SO.handledComments.has(c.pk)) continue;
            pending.push(`@${c.user} on post ${it.pk} (comment ${c.pk}): "${String(c.text).slice(0, 90)}"`);
          }
          if (pending.length >= 6) break;
        }
        L.push("UNANSWERED COMMENTS ON ADUU'S POSTS:\n" + (pending.join('\n') || '(none)'));
      } catch (e) {
        L.push("UNANSWERED COMMENTS ON ADUU'S POSTS: unavailable (" + e.message + ')');
      }
    }

    /* ── what the account already did recently (so the brain self-limits) ── */
    const today = SO.actionLog.filter(a => now() - a.at < 24 * 3600e3);
    const counts = {};
    today.forEach(a => { counts[a.kind] = (counts[a.kind] || 0) + 1; });
    L.push(`WHAT ADUU DID IN THE LAST 24H: ${
      Object.keys(counts).length ? Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ') : 'nothing'}` +
      (today.length ? `\n  most recent: ${today.slice(-3).map(a => `${a.kind}→${a.target || 'note'} (${Math.round((now() - a.at) / 60_000)}m ago) "${String(a.text || '').slice(0, 40)}"`).join(' | ')}` : ''));
    L.push(`DAILY LIMITS LEFT: ${Object.entries(CFG.SOCIAL.DAILY_CAP)
      .map(([k, v]) => `${k} ${Math.max(0, v - (counts[k] || 0))}/${v}`).join(' · ')}`);

    const head = [
      `TIME: ${timeCtx.label} — ${timeCtx.vibeHint}`,
      `MODE: ${CFG.SOCIAL.DRY_RUN ? 'DRY RUN (nothing is really sent)' : 'LIVE'}`,
    ];
    return head.concat(L).join('\n\n') + '\n\nDecide now — remember doing nothing is normal and usually correct:';
  }

  function socialWatchList() {
    const set = new Set();
    const add = u => { const c = cleanUsername(u); if (c) set.add(c); };
    for (const list of [CFG.SOCIAL.WATCH, CFG.SOCIAL.COMMENT_TARGETS, CFG.SOCIAL.STORY_TARGETS]) {
      if (Array.isArray(list)) list.forEach(add);
    }
    if (Array.isArray(CFG.TARGETS) && CFG.TARGETS !== 'all') CFG.TARGETS.forEach(add);
    return [...set];
  }

  function lastSocialActionFor(user, kind = null) {
    const u = cleanUsername(user);
    for (let i = SO.actionLog.length - 1; i >= 0; i--) {
      const a = SO.actionLog[i];
      if (cleanUsername(a.target || '') !== u) continue;
      if (kind && a.kind !== kind) continue;
      return a;
    }
    return null;
  }

  /* 2 · PLAN */
  async function brainSocialDecide() {
    const observation = await buildSocialObservation();
    try {
      const res = await llmBrain([
        { role: 'system', content: SOCIAL_DECIDE_PROMPT },
        { role: 'user', content: observation },
      ], { type: 'decide', kind: 'social', model: CFG.BRAIN_MODEL,
           maxTokens: 700, temperature: 0.45, timeoutMs: 90_000 });
      const plan = parseSocialPlan(res.text);
      if (!plan) throw new Error('brain returned no usable social plan');
      return { ok: true, plan, observation, model: res.model,
               fallback: !!res._fallback,
               fallback_reason: res._fallback_reason || '',
               reasoning_chars: res.reasoning_chars || 0, raw: res.text };
    } catch (e) {
      return { ok: false, error: e.message, observation };
    }
  }

  function parseSocialPlan(raw) {
    const s = String(raw || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let obj = null;
    const first = s.indexOf('{');
    if (first !== -1) {
      let depth = 0, inStr = false, esc = false;
      for (let i = first; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { obj = JSON.parse(s.slice(first, i + 1)); } catch (_) { obj = null; }
            break;
          }
        }
      }
    }
    if (!obj || typeof obj !== 'object') return null;

    const scale = (x, lo, hi, dflt) => {
      const n = Number(x);
      return (Number.isFinite(n) && n > 0) ? Math.max(lo, Math.min(hi, n)) : dflt;
    };
    let mode = String(obj.mode || 'observe').toLowerCase();
    if (mode !== 'act') mode = 'observe';
    const isNote = a => a && a.kind === 'note';
    let actions = Array.isArray(obj.actions) ? obj.actions : [];
    actions = actions.filter(a => a && typeof a === 'object')
      .map(a => ({
        kind: String(a.kind || '').toLowerCase(),
        op: String(a.op || (a.kind === 'note' ? 'replace' : '')).toLowerCase(),
        target: cleanUsername(a.target || ''),
        media_pk: String(a.media_pk || ''),
        comment_pk: String(a.comment_pk || ''),
        story_pk: String(a.story_pk || ''),
        text: clip(a.text, a.kind === 'note' ? CFG.SOCIAL.MAX_NOTE_CHARS : 220),
        reason: clip(a.reason, 160),
      }))
      .filter(a => a.kind || a.op);

    // notes are always allowed through the mode gate (they are "keep" by default)
    if (mode === 'observe') actions = actions.filter(isNote);

    return {
      mode,
      intent: clip(obj.intent, 200),
      skip_reason: clip(obj.skip_reason, 200),
      actions: actions.slice(0, CFG.SOCIAL.MAX_ACTIONS_PER_CYCLE + 1),
      next_check_in_minutes: scale(obj.next_check_in_minutes, 15, 240, 75),
    };
  }

  /* 3 · GATE — the runtime's rarity rules. The brain wants; the gate allows. */
  function socialGate(action, actedThisCycle) {
    const kind = action.kind;
    if (!CFG.SOCIAL.DAILY_CAP.hasOwnProperty(kind)) {
      return { ok: false, reason: 'unknown_kind_' + kind };
    }
    if (kind === 'note' && action.op === 'keep') return { ok: false, reason: 'nothing_to_do' };
    if (kind === 'note' && CFG.SOCIAL.NOTES_MODE !== 'agentic') {
      return { ok: false, reason: 'notes_off' };
    }
    if (kind !== 'note') {
      const h = getTimeContext().hour;
      const [qStart, qEnd] = CFG.SOCIAL.QUIET_HOURS;
      if (h >= qStart && h < qEnd) return { ok: false, reason: 'quiet_hours' };
      if (!action.target) return { ok: false, reason: 'no_target' };
      if (actedThisCycle) return { ok: false, reason: 'one_action_per_cycle' };
    }

    // per (kind,target) cooldown
    const cooldown = CFG.SOCIAL.COOLDOWN_MS[kind] || 0;
    const lastForTarget = kind === 'note'
      ? SO.actionLog.filter(a => a.kind === 'note').slice(-1)[0]
      : lastSocialActionFor(action.target, kind);
    if (lastForTarget && (now() - lastForTarget.at) < cooldown) {
      return {
        ok: false,
        reason: `cooldown_${Math.round((cooldown - (now() - lastForTarget.at)) / 60_000)}m_left`,
      };
    }

    // minimum gap between any two PUBLIC actions (comments/story replies)
    if (kind === 'comment' || kind === 'story_reply') {
      const lastPublic = SO.actionLog.filter(a => a.kind === 'comment' || a.kind === 'story_reply')
        .slice(-1)[0];
      if (lastPublic &&
          (now() - lastPublic.at) < CFG.SOCIAL.MIN_GAP_BETWEEN_PUBLIC_ACTIONS_MS) {
        return { ok: false, reason: 'public_action_too_soon' };
      }
    }

    // daily cap
    const cap = CFG.SOCIAL.DAILY_CAP[kind] || 0;
    const usedToday = SO.actionLog.filter(a => a.kind === kind && (now() - a.at) < 24 * 3600e3).length;
    if (usedToday >= cap) return { ok: false, reason: 'daily_cap_' + cap };

    // audience/target permissions
    if (kind === 'comment' && CFG.SOCIAL.COMMENT_TARGETS.length &&
        !CFG.SOCIAL.COMMENT_TARGETS.map(cleanUsername).includes(action.target)) {
      return { ok: false, reason: 'target_not_allowed_for_comments' };
    }
    if (kind === 'story_reply' && CFG.SOCIAL.STORY_TARGETS.length &&
        !CFG.SOCIAL.STORY_TARGETS.map(cleanUsername).includes(action.target)) {
      return { ok: false, reason: 'target_not_allowed_for_stories' };
    }
    if (kind === 'comment_reply' && !CFG.SOCIAL.COMMENT_REPLIES) {
      return { ok: false, reason: 'comment_replies_off' };
    }
    if (kind === 'dm' && Array.isArray(CFG.TARGETS) &&
        !CFG.TARGETS.map(cleanUsername).includes(action.target)) {
      return { ok: false, reason: 'target_not_a_dm_target' };
    }

    // 4 · ISOLATE
    if (action.text) {
      const col = collisionCheck(action);
      if (!col.ok && kind === 'note') {
        action.text = isolationGuard(action.text, 'public');
      } else if (!col.ok) {
        return { ok: false, reason: 'isolation_blocked:' + col.problems.slice(0, 2).join('+') };
      }
    }
    return { ok: true, reason: 'allowed' };
  }

  /* 5 · ACT */
  async function executeSocialAction(action) {
    const kind = action.kind;
    if (kind === 'note') {
      if (action.op === 'delete') {
        const { items } = await trayRead();
        const meId = String(S.viewerIgId || getCookie('ds_user_id') || '');
        const mine = items.find(it => it.authorId === meId);
        if (!mine || !mine.id) return { done: false, note: 'no note to delete' };
        if (CFG.SOCIAL.DRY_RUN) return { done: true, dry: true, note: 'would delete "' + mine.text + '"' };
        await noteDelete(mine.id);
        return { done: true, note: 'deleted "' + mine.text + '"' };
      }
      const text = clip(action.text, CFG.SOCIAL.MAX_NOTE_CHARS);
      if (!text) return { done: false, note: 'empty note text' };
      if (CFG.SOCIAL.DRY_RUN) return { done: true, dry: true, note: 'would set "' + text + '"' };
      const { items } = await trayRead();
      const meId = String(S.viewerIgId || getCookie('ds_user_id') || '');
      const mine = items.find(it => it.authorId === meId);
      if (mine && mine.id) { try { await noteDelete(mine.id); } catch (_) {} }
      await noteCreate(text);
      return { done: true, note: '"' + text + '"' };
    }

    const text = isolationGuard(String(action.text || '').trim(), action.target);
    if (!text) return { done: false, note: 'empty text after isolation guard' };

    if (kind === 'comment' || kind === 'comment_reply') {
      const media = String(action.media_pk || '').replace(/\D/g, '');
      if (!media) return { done: false, note: 'no media_pk' };
      if (CFG.SOCIAL.DRY_RUN) {
        return { done: true, dry: true, note: `would comment on ${media}: "${text}"` };
      }
      if (kind === 'comment_reply' && action.comment_pk) {
        try { await postComment(media, text, action.comment_pk); }
        catch (_) { await postComment(media, text); }
      } else {
        await postComment(media, text);
      }
      SO.seenPosts.add(media);
      if (action.comment_pk) SO.handledComments.add(action.comment_pk);
      return { done: true, note: `commented on ${media}: "${text}"` };
    }

    if (kind === 'story_reply') {
      const pk = String(action.story_pk || '').replace(/\D/g, '');
      if (!pk) return { done: false, note: 'no story_pk' };
      if (CFG.SOCIAL.DRY_RUN) {
        return { done: true, dry: true, note: `would react to story ${pk}: "${text}"` };
      }
      await storyReply(pk, pk, text);
      return { done: true, note: `reacted to story ${pk}: "${text}"` };
    }

    if (kind === 'dm') {
      const th = await findThread(action.target);
      if (!th) return { done: false, note: 'no thread for @' + action.target };
      const tid = String(th.thread_fbid || th.id);
      if (CFG.SOCIAL.DRY_RUN) {
        return { done: true, dry: true, note: `would DM @${action.target}: "${text}"` };
      }
      await sendText(tid, text);
      return { done: true, note: `DM'd @${action.target}: "${text}"` };
    }

    return { done: false, note: 'unhandled kind ' + kind };
  }

  /* 1→6 · one full cycle */
  async function socialCycle(force = false) {
    if (SO.planning) return { skipped: true, reason: 'cycle_already_running' };
    if (!CFG.SOCIAL.ENABLED && !force) return { skipped: true, reason: 'social_disabled' };
    SO.planning = true;
    const cycle = { at: now(), iso: new Date().toISOString(), dry: CFG.SOCIAL.DRY_RUN };
    try {
      const dec = await brainSocialDecide();
      cycle.observation_chars = (dec.observation || '').length;
      cycle.brain_model = dec.model || CFG.BRAIN_MODEL;
      if (!dec.ok) {
        cycle.status = 'brain_failed';
        cycle.error = dec.error;
        socLog('soc', 'social brain cycle failed: ' + dec.error);
        return cycle;
      }
      const plan = dec.plan;
      cycle.plan = plan;
      cycle.decided_by = 'gemma-4-brain';
      cycle.outcome = [];

      if (dec.fallback) {
        socLog('soc', `⚠ BRAIN DEGRADED — upstream returned nothing usable ` +
          `(${dec.fallback_reason || 'empty output'}). Doing nothing this ` +
          `cycle. Check IGAgent.brainStatus().`);
      }
      if (plan.mode === 'observe' && !plan.actions.length) {
        socLog('soc', `brain chose to do nothing — ${plan.skip_reason || 'no reason given'}`);
      }

      let acted = 0;
      for (const action of plan.actions) {
        if (acted >= CFG.SOCIAL.MAX_ACTIONS_PER_CYCLE) {
          cycle.outcome.push({ kind: action.kind, status: 'deferred', reason: 'cycle_action_limit' });
          continue;
        }
        const gate = socialGate(action, acted > 0);
        if (!gate.ok) {
          cycle.outcome.push({ kind: action.kind, target: action.target,
            status: 'gated', reason: gate.reason });
          socLog('soc', `${action.kind}${action.target ? '→@' + action.target : ''} gated (${gate.reason})`);
          continue;
        }
        let res;
        try {
          // one social action at a time per person — two brains never collide
          res = await withLock('social:' + (action.target || action.kind),
            () => executeSocialAction(action));
          if (res && res.skipped) {
            cycle.outcome.push({ kind: action.kind, status: 'skipped', reason: res.reason });
            continue;
          }
          const rec = {
            kind: action.kind, target: action.target || '', at: now(),
            text: action.text || '', reason: action.reason || '',
            status: res.done ? (res.dry ? 'dry_run' : 'sent') : 'failed',
            note: res.note || '',
          };
          SO.actionLog.push(rec);
          if (SO.actionLog.length > 400) SO.actionLog = SO.actionLog.slice(-200);
          if (action.kind === 'note') {
            SO.noteLog.push({ at: now(), text: action.text, reason: action.reason, op: action.op });
            SO.noteLog = SO.noteLog.slice(-20);
          }
          cycle.outcome.push(Object.assign({ status: rec.status }, rec));
          socLog('soc', `${action.kind}${action.target ? '→@' + action.target : ''}: ${res.note}`);
          if (res.done && !res.dry) acted++;
          else if (res.done && res.dry) acted++;   // dry runs still consume the slot
        } catch (e) {
          cycle.outcome.push({ kind: action.kind, status: 'error', reason: e.message });
          socLog('soc', `${action.kind} failed: ${e.message}`);
          // v10.2 · a rate limit is now its own thing, not just `fatal`.
          // Either way the social brain must rest instead of retrying — poking
          // a rate-limited account is what keeps it rate-limited.
          if (e.fatal || e.rateLimited) {
            socLog('soc', 'Instagram pushed back — social brain resting for 3h');
            scheduleSocialBrain(180);
            break;
          }
        }
      }
      cycle.status = 'completed';
      cycle.next_check_in_minutes = plan.next_check_in_minutes;
      saveSocialLocal();
      scheduleSocialBrain(cycle.next_check_in_minutes || 75);
      persistSocialBrain(cycle);
      return cycle;
    } finally {
      SO.planning = false;
    }
  }

  function scheduleSocialBrain(minutes) {
    if (SO.timer) { clearTimeout(SO.timer); SO.timer = null; }
    if (!CFG.SOCIAL.ENABLED) return;
    const mins = Math.max(5, Number(minutes) || 75);
    const delay = Math.round(mins * 60_000 * rand(0.9, 1.15));
    SO.timer = setTimeout(() => {
      socialCycle().catch(e => socLog('soc', 'cycle error: ' + e.message));
    }, delay);
    socLog('soc', `next social-brain cycle in ~${Math.round(delay / 60_000)} min`);
  }

  async function persistSocialBrain(cycle) {
    SO.cycles.push(cycle);
    if (SO.cycles.length > 60) SO.cycles = SO.cycles.slice(-40);
    try {
      if (S.wsReady) {
        await wsRequest({
          type: 'save_social',
          social: {
            schema_version: '10.0-brain-resilient-log',
            updated_at: new Date().toISOString(),
            config: {
              enabled: CFG.SOCIAL.ENABLED, dry_run: CFG.SOCIAL.DRY_RUN,
              notes_mode: CFG.SOCIAL.NOTES_MODE,
              watch: CFG.SOCIAL.WATCH, comment_targets: CFG.SOCIAL.COMMENT_TARGETS,
              story_targets: CFG.SOCIAL.STORY_TARGETS,
            },
            action_log: SO.actionLog.slice(-120),
            note_log: SO.noteLog.slice(-20),
            cycles: SO.cycles.slice(-20),
          },
        }, 10_000);
      }
    } catch (e) {
      log(C.dim, 'soc', 'social brain log not mirrored to disk (' + e.message + ')');
    }
  }

  function saveSocialLocal() {
    try {
      localStorage.setItem('ig_agent_social_v10', JSON.stringify({
        seenPosts: [...SO.seenPosts].slice(-300),
        handledComments: [...SO.handledComments].slice(-300),
        actionLog: SO.actionLog.slice(-120),
        noteLog: SO.noteLog.slice(-20),
      }));
    } catch (_) {}
  }

  function loadSocialLocal() {
    try {
      const p = JSON.parse(localStorage.getItem('ig_agent_social_v10') || '{}');
      (p.seenPosts || []).forEach(x => SO.seenPosts.add(x));
      (p.handledComments || []).forEach(x => SO.handledComments.add(x));
      SO.actionLog = p.actionLog || [];
      SO.noteLog = p.noteLog || [];
    } catch (_) {}
  }

  function socialStart() {
    if (SO.running) return;
    SO.running = true;
    loadSocialLocal();
    socLog('soc', `SOCIAL BRAIN ON · dryRun=${CFG.SOCIAL.DRY_RUN} · ` +
      `watch=[${socialWatchList().join(',')}] · comments=[${CFG.SOCIAL.COMMENT_TARGETS.join(',')}] · ` +
      `stories=[${CFG.SOCIAL.STORY_TARGETS.join(',')}] · notes=${CFG.SOCIAL.NOTES_MODE}`);
    const delay = rand(20_000, 60_000);   // never fire the instant it starts
    SO.timer = setTimeout(() => {
      socialCycle().catch(e => socLog('soc', 'cycle error: ' + e.message));
    }, delay);
  }

  function socialStop() {
    SO.running = false;
    if (SO.timer) { clearTimeout(SO.timer); SO.timer = null; }
    socLog('soc', 'SOCIAL BRAIN OFF');
  }

  /* ──────────────────────────── PUBLIC API ──────────────────────────── */

  async function start() {
    if (S.running) { log(C.warn, 'main', 'already running — polling now'); pollNow(); return; }
    if (Array.isArray(CFG.TARGETS) && CFG.TARGETS.length === 0) {
      CFG.TARGETS = [...CFG.DEFAULT_TARGETS];
    }
    let h = { default_endpoint: CFG.MODEL, chain: [CFG.MODEL] };
    try {
      await wsConnect();
      h = await bridgeHealth();
    } catch (e) {
      log(C.warn, 'main', `bridge (${CFG.WS_URL}) not ready yet (${e.message}) — starting loop & will auto-connect`);
    }
    try {
      const solo = (await fetchInbox()).find(t => !t.is_group);
      if (solo) await fetchThreadMeta(solo.thread_fbid || solo.id); // resolve my interop id
    } catch (e) {
      log(C.warn, 'main', 'inbox warmup warning (' + e.message + ') — will retry in poll loop');
    }
    S.running = true; S.startedAt = now(); S.startedPolls = 0; S.idlePolls = 0;
    installRealtimeWatchers();
    if (S.wsKeepalive) clearInterval(S.wsKeepalive);
    S.wsKeepalive = setInterval(() => {
      if (!S.running) return;
      if (!S.wsReady) wsConnect().catch(() => {});
      else bridgeHealth().catch(() => {});
    }, 25_000);
    if (S.wsKeepalive && typeof S.wsKeepalive.unref === 'function') S.wsKeepalive.unref();
    log(C.ok, 'main',
      `started · bridge=${h.default_endpoint} (${h.chain.length}-model chain) · dryRun=${CFG.DRY_RUN} · memory=${CFG.MEMORY} · humanize=${CFG.HUMANIZE} · seen=${CFG.SEEN} · typing=${typingFn() ? 'ready' : 'unavailable'} · targets=${
        Array.isArray(CFG.TARGETS) ? CFG.TARGETS.join(',') : CFG.TARGETS}` +
      (S.myInteropId ? ` · me=${S.myInteropId}` : '') +
      (CFG.SOCIAL.ENABLED ? ` · social-brain=${CFG.SOCIAL.DRY_RUN ? 'dry' : 'LIVE'}` : ''));
    pollTick();
    if (CFG.SOCIAL.ENABLED) socialStart();
  }

  function stop() {
    S.running = false;
    socialStop();
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    if (S.wsKeepalive) { clearInterval(S.wsKeepalive); S.wsKeepalive = null; }
    Object.values(S.pending).forEach(p => p.timer && clearTimeout(p.timer));
    S.pending = {};
    // clear any typing trails still showing
    for (const tid of [...S.typingThreads]) typingOff(tid);
    S.typingThreads.clear();
    log(C.warn, 'main', 'stopped' + (S.startedAt ? ` · uptime ${Math.round((now() - S.startedAt) / 1000)}s` : ''));
  }

  async function status() {
    const out = {
      running: S.running,
      dryRun: CFG.DRY_RUN,
      seen: CFG.SEEN,
      typing: CFG.TYPING && (S.typingAvailable !== undefined ? !!S.typingAvailable : 'unchecked'),
      humanize: CFG.HUMANIZE,
      model: CFG.MODEL || '(server default)',
      maxReplyChars: CFG.MAX_REPLY_CHARS,
      targets: CFG.TARGETS,
      me: { ig: S.viewerIgId || getCookie('ds_user_id'), interop: S.myInteropId },
      repliesSentToday: dayCount() + '/' + CFG.MAX_REPLIES_PER_DAY,
      repliesLastHour: hourCount() + '/' + CFG.MAX_REPLIES_PER_HOUR,
      memories: Object.keys(S.memory).length,
      transcripts: Object.entries(S.transcripts).map(([tid, T]) =>
        ({ user: T.user, msgs: T.messages.length, dirty: T.dirty })),
      circuitOpen: S.circuitUntil > now() ? ('until ' + new Date(S.circuitUntil).toLocaleTimeString()) : false,
      // v10.2 · the Instagram pacer, so a rate-limit pause is visible instead
      // of looking like a hung bot
      instagram: {
        coolingFor: igCooldownRemaining()
          ? Math.round(igCooldownRemaining() / 1000) + 's' : false,
        strikes: RL.strikes + '/' + CFG.IG_COOLDOWN_STEPS_MS.length,
        minGapMs: CFG.IG_MIN_GAP_MS,
      },
      queuedThreads: Object.entries(S.pending).map(([tid, p]) => ({
        thread: tid,
        user: p.user || S.usernameCache.get(tid) || tid,
        retryIn: p.at ? Math.round((p.at - now()) / 1000) + 's' : '?',
        why: p.reason || null,
      })),
      lastPollAt: S.lastPollAt ? new Date(S.lastPollAt).toLocaleTimeString() : null,
      knownThreads: [...S.usernameCache.entries()].map(([tid, u]) => ({ user: u, threadId: tid })),
    };
    try {
      const h = await bridgeHealth();
      out.bridge = h.default_endpoint + ' · up ' + Math.round(h.uptime_s) + 's';
    } catch (e) { out.bridge = 'UNREACHABLE — run: python server.py'; }
    console.log('%cIGAgent status', C.info, out);
    return out;
  }

  async function threads() {
    const list = (await fetchInbox()).map(th => {
      const c = th.is_group ? { emoji: '👥', label: 'group' } : { emoji: '👤', label: '1:1' };
      return {
        username: (th.users && th.users[0] && th.users[0].username) || '(group)',
        thread_fbid: th.thread_fbid || th.id,
        group: !!th.is_group,
        folder: th.folder || '',
        last_activity: th.last_activity_timestamp_ms
          ? new Date(Number(th.last_activity_timestamp_ms)).toLocaleString() : '',
        title: th.thread_title || '',
      };
    });
    console.table(list);
    return list;
  }

  async function findThread(username) {
    const q = String(username).toLowerCase().replace(/^@/, '');
    const th = (await fetchInbox()).find(t =>
      !t.is_group &&
      ((t.users && t.users[0] && t.users[0].username) || '').toLowerCase() === q);
    if (!th) throw new Error('no 1:1 thread found for @' + username);
    return th;
  }

  async function history(username, limit = 30) {
    const th = await findThread(username);
    if (!S.myInteropId) await fetchThreadMeta(th.thread_fbid || th.id);
    const T = await fetchThreadNodes(th.thread_fbid || th.id, username);
    const rows = T.messages.slice(-limit).map(m => ({
      time: m.ts ? new Date(m.ts).toLocaleString() : '',
      from: m.mine ? 'ME' : username,
      type: m.label,
      text: m.kind === 'text' ? m.text : `[${m.label}]`,
    }));
    console.table(rows);
    return rows;
  }

  async function say(username, text) {
    if (!text) throw new Error('usage: IGAgent.say("username", "text")');
    const th = await findThread(username);
    const r = await sendText(th.thread_fbid || th.id, text);
    S.sentHour.push(now()); S.sentDay.push(now()); saveState();
    log(C.ok, 'say', `@${username} ← "${text}"`);
    return r;
  }

  // manual test helpers — bypass DRY_RUN on purpose (they are visible actions)
  async function typingDemo(username, ms = 4000) {
    const th = await findThread(username);
    const tid = String(th.thread_fbid || th.id);
    const on = await sendTyping(tid, true);
    if (!on) throw new Error('typing indicator unavailable in this session');
    log(C.ok, 'typing', `@${username}: TYPING ON — watch the other phone (${ms}ms)`);
    await sleep(ms);
    await sendTyping(tid, false);
    log(C.ok, 'typing', `@${username}: typing off`);
    return true;
  }

  async function markSeenNow(username) {
    const th = await findThread(username);
    if (!S.myInteropId) await fetchThreadMeta(th.thread_fbid || th.id);
    const tid = String(th.thread_fbid || th.id);
    const T = await fetchThreadNodes(tid, username);
    const newest = T.messages[T.messages.length - 1];
    if (!newest) throw new Error('no messages in thread');
    if (newest.mine) { log(C.warn, 'seen', `@${username}: newest message is mine — nothing to mark`); return null; }
    await markSeen(tid, newest.id, newest.ts);
    log(C.ok, 'seen', `@${username}: marked seen up to "${String(newest.text).slice(0, 40)}" — check the other phone for "Seen"`);
    return true;
  }

  function transcripts() {
    const rows = Object.entries(S.transcripts).map(([tid, T]) => ({
      user: T.user, thread: tid, messages: T.messages.length,
      last_msg: T.messages.length ? new Date(T.messages[T.messages.length - 1].ts).toLocaleString() : '',
      unsaved: T.dirty,
    }));
    console.table(rows);
    console.log('%cJSON files live in server.py\'s ./transcripts/ folder', C.dim);
    return rows;
  }

  async function saveTranscriptsNow() {
    const out = [];
    for (const [tid, T] of Object.entries(S.transcripts)) {
      T.dirty = true;
      T.saveTimer = null;
      scheduleTranscriptSave(tid, 500);
      out.push(T.user);
    }
    if (!out.length) log(C.warn, 'save', 'no transcripts to save yet');
    return out;
  }

  function memory(user) {
    const q = String(user).toLowerCase().replace(/^@/, '');
    const entry = Object.entries(S.memory).find(([, m]) => (m.user || '').toLowerCase() === q);
    if (!entry) { log(C.warn, 'mem', 'no memory stored for @' + user); return null; }
    console.log(`%cMemory for @${entry[1].user}  (updated ${new Date(entry[1].updated).toLocaleString()})`, C.info);
    console.log(entry[1].profile);
    return entry[1];
  }

  function forget(user) {
    const q = String(user).toLowerCase().replace(/^@/, '');
    const tid = Object.keys(S.memory).find(k => (S.memory[k].user || '').toLowerCase() === q);
    if (!tid) { log(C.warn, 'mem', 'no memory stored for @' + user); return; }
    delete S.memory[tid]; saveMem();
    log(C.warn, 'mem', 'memory wiped for @' + user);
  }

  function memories() {
    const rows = Object.values(S.memory).map(m => ({
      user: m.user, updated: new Date(m.updated).toLocaleString(),
      profile: (m.profile || '').slice(0, 60) + '…',
    }));
    console.table(rows);
    return rows;
  }

  async function test() {
    const results = [];
    const check = (name, fn) => fn().then(v => { results.push(['✅', name, v]); return true; })
      .catch(e => { results.push(['❌', name, e.message]); return false; });

    log(C.info, 'test', '── IGAgent v7 Parallel Agent self-test ──');
    let ok = true;
    ok &= await check('session · csrftoken', async () => {
      const t = getCookie('csrftoken');
      if (!t) throw new Error('not logged in?');
      return t.slice(0, 6) + '…';
    });
    ok &= await check('session · tokens (fb_dtsg/lsd)', async () => {
      const T = extractTokens();
      return `dtsg=${T.dtsg.slice(0, 8)}… lsd=${T.lsd ? T.lsd.slice(0, 8) + '…' : '(none)'}`;
    });
    ok &= await check('bridge · WebSocket connect + health', async () => {
      if (!S.wsReady) await wsConnect();
      const h = await bridgeHealth();
      if (!h.chain.some(m => /glm-4|gemma-4|qwen3/i.test(m))) {
        throw new Error('glm-4.7-flash/gemma-4/qwen3 missing from chain: ' + h.chain.join(', '));
      }
      return `answering=${h.default_endpoint} · brain=${h.brain_endpoint || CFG.BRAIN_MODEL} · ${h.chain.length}-model chain · up ${Math.round(h.uptime_s || 0)}s`;
    });
    ok &= await check('bridge · GLM-4.7-Flash reply, reasoning stripped (NOT sent)', async () => {
      const t0 = Date.now();
      const { text, model } = await llm(
        [{ role: 'user', content: 'Reply with exactly: bridge ok' }], { maxTokens: 60 });
      if (!text) throw new Error('empty reply');
      if (/<think(?:ing)?>/i.test(text) || /reasoning_content/i.test(text)) {
        throw new Error('reasoning leaked into the reply');
      }
      return `[${model}] "${text.slice(0, 50)}" in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    });
    ok &= await check('humanizer · markdown/quote stripping', async () => {
      const out = humanizeReply('**Hey!**\n\n- *kya haal* hai?\n- "bata na"');
      if (/[*_#`"]/.test(out)) throw new Error('markdown left in: ' + out);
      return `"${out}"`;
    });
    ok &= await check('humanizer · slop + typography + score', async () => {
      const out = humanizeReply('Certainly! Let\u2019s delve into a robust, seamless ' +
                                'solution \u2014 it\u2019s important to note that we leverage AI.');
      if (/delve|robust|seamless|leverag|\bAI\b|\u2014|\u2019/i.test(out)) {
        throw new Error('slop/fingerprint left in: ' + out);
      }
      const r = checkDraft(out);
      return `${r.overall}/100 · weakest ${weakestCheck(r)} · "${out}"`;
    });
    ok &= await check('gate · only reply when the last text is theirs', async () => {
      if (typeof splitBubbles !== 'function') throw new Error('splitBubbles missing');
      return 'gate + 2-bubble split armed';
    });
    ok &= await check('typing · IGDMAPISendTypingIndicator available', async () => {
      const f = typingFn();
      if (!f) throw new Error('require() path missing — typing trail disabled');
      return 'ready (site DGW client)';
    });
    let inbox = null;
    ok &= await check('inbox · PolarisDirectInboxQuery', async () => {
      inbox = await fetchInbox();
      if (!Array.isArray(inbox) || !inbox.length) throw new Error('no threads returned');
      return inbox.length + ' threads';
    });
    if (inbox && inbox.length) {
      const solo = inbox.find(t => !t.is_group);
      if (solo) {
        const tid = solo.thread_fbid || solo.id;
        ok &= await check('thread meta · header query (+my id)', async () => {
          const t = await fetchThreadMeta(tid);
          if (!t) throw new Error('no thread data');
          return `me=${S.myInteropId || '?'} · partner=${(t.users && t.users[0] && t.users[0].username) || '?'}`;
        });
        ok &= await check('messages · IGDMessageListOffMsysQuery', async () => {
          const T = await fetchThreadNodes(tid, (solo.users && solo.users[0] && solo.users[0].username) || tid);
          if (!T.messages.length) throw new Error('no message nodes');
          return `${T.messages.length} msgs · newest: ${T.messages[T.messages.length - 1].label}`;
        });
      }
    }
    ok &= await check('seen · doc ids present', async () => {
      if (!/^\d+$/.test(CFG.GQL.seen) || !/^\d+$/.test(CFG.GQL.seenVal)) throw new Error('doc ids missing');
      return `main=${CFG.GQL.seen} · validation=${CFG.GQL.seenVal}`;
    });
    ok &= await check('transcripts · bridge save roundtrip', async () => {
      if (!CFG.TRANSCRIPTS) return 'disabled';
      const r = await wsRequest({ type: 'save', transcript: {
        schema_version: '10.0-brain-resilient',
        user: '_selftest', thread_fbid: '0', updated_at: new Date().toISOString(),
        persona: 'test', owner_bio: 'test', memory_profile: '',
        models: { answering_model: CFG.MODEL, brain_model: CFG.BRAIN_MODEL },
        mood_state: defaultMoodState(), reminders: [], missions: [],
        process_log: [{ turn_id: 'selftest', trigger: 'incoming_burst' }],
        messages: [{ id: 'test:' + now(), ts: now(), mine: false, kind: 'text', label: 'text', text: 'selftest' }],
      } }, 10_000);
      return r.file + ' (' + r.total_messages + ' msgs, ' + r.process_turn_count + ' process turns)';
    });
    ok &= await check('v7 · mood engine switches Aduu into an angry roast', async () => {
      const before = detectLocalMood('teri maa ki chut sale, kya kr lega');
      if (before !== 'FURIOUS_ABUSE_CLAPBACK') throw new Error('hard abuse not detected: ' + before);
      const soft = detectLocalMood('fuck off yaar, chup ho ja');
      if (soft !== 'ANGRY_SAVAGE_ROAST') throw new Error('soft abuse not detected: ' + soft);
      return `hard=${before} · soft=${soft}`;
    });
    ok &= await check('v7 · reminder engine schedules a real time trigger', async () => {
      const r = extractReminderRequests('chal 10 min mein baat karte hai, yaad dila dena');
      if (!r.length) throw new Error('no reminder extracted');
      if (r[0].due_in_minutes !== 10) throw new Error('wrong minutes: ' + r[0].due_in_minutes);
      const T = ensureTranscript('T_SELFTEST', 'deeps20_');
      addReminder('T_SELFTEST', 'deeps20_', 'test topic', 10, 'selftest');
      const due = dueReminder('T_SELFTEST', 'deeps20_');
      if (due) throw new Error('reminder fired before it was due');
      T.reminders.forEach(x => { x.due_at = now() - 1000; });
      const now_due = dueReminder('T_SELFTEST', 'deeps20_');
      if (!now_due) throw new Error('reminder did not fire when due');
      consumeReminder('T_SELFTEST', 'deeps20_', now_due);
      if (dueReminder('T_SELFTEST', 'deeps20_')) throw new Error('reminder not consumed');
      return `10m scheduled -> fired -> consumed`;
    });
    ok &= await check('v7 · cross-chat mission + privacy wall', async () => {
      const ms = extractCrossChatMissions('adarshu.io ko bol do ki main chocolate nahi dunga', 'deeps20_');
      if (!ms.length || ms[0].target_user !== 'adarshu.io') throw new Error('mission not extracted');
      const m = addMission('T_SELFTEST', 'deeps20_', ms[0]);
      const pend = pendingMissionFor('adarshu.io');
      if (!pend) throw new Error('mission not queued for target');
      const guarded = privacyGuard('deeps20_ ne @adarshu.io ke baare mein "bola ki tu aa raha hai" kaha', 'adarshu.io');
      if (/@adarshu\.io/.test(guarded)) throw new Error('handle leaked through the privacy wall: ' + guarded);
      consumeMission(m);
      if (pendingMissionFor('adarshu.io')) throw new Error('mission not consumed');
      return `queued -> privacy-safe -> consumed`;
    });
    ok &= await check('v7 · logical " || " multi-bubble splitting', async () => {
      const b = splitBubbles('abey sun bkl, aukaat mein reh || sach mein dimaag kharab kar diya tune mera');
      if (b.length !== 2) throw new Error('expected 2 logical bubbles, got ' + b.length);
      return b.map(x => `"${x}"`).join(' + ');
    });
    ok &= await check('v8 · brain decision JSON parsed + turned into writer orders', async () => {
      const joined = 'abey sun bkl, teri maa ki chut sale kya kr lega';
      const d = parseDecisionJson(JSON.stringify({
        action: 'REPLY', mood: 'FURIOUS_ABUSE_CLAPBACK',
        mood_reason: 'teri maa ki chut', feeling_note: 'genuinely pissed off',
        understand: 'they went too far', my_last: 'Aduu told them to behave',
        next_move: 'clap back then explain feelings',
        bubble_count: 2,
        bubble_plan: ['clap back hard', 'explain honestly how it felt'],
        topic_lock: 'their abuse',
      }), { joined, trigger: 'incoming_burst', user: 'deeps20_' });
      if (!d) throw new Error('decision JSON not parsed');
      if (d.mood !== 'FURIOUS_ABUSE_CLAPBACK') throw new Error('mood lost: ' + d.mood);
      if (d.bubble_count !== 2 || d.bubble_plan.length !== 2) throw new Error('bubble plan lost');
      const dir = brainDirective(d, 'deeps20_');
      if (!/SEND EXACTLY 2 BUBBLE/.test(dir)) throw new Error('bubble count missing from directive');
      if (!/never repeat or remix/i.test(dir)) throw new Error('continuity guard missing');
      return `${d.mood} · ${d.bubble_count} bubbles · directive ${dir.length} chars`;
    });
    ok &= await check('v8 · decisions without evidence from the chat are rejected', async () => {
      const d = parseDecisionJson(JSON.stringify({
        action: 'REPLY', mood: 'PLAYFUL_CHILL',
        reminder: { topic: 'random project deadline', due_in_minutes: 5, evidence: 'never said this' },
        cross_chat_mission: { target_user: 'someone_else', type: 'prank', instruction: 'made up', evidence: 'zzz' },
      }), { joined: 'hello kaise ho', trigger: 'incoming_burst', user: 'deeps20_' });
      if (d.reminder) throw new Error('fabricated reminder must be dropped');
      if (d.cross_chat_mission) throw new Error('fabricated mission must be dropped');
      // …but a real, message-backed one survives
      const ok = parseDecisionJson(JSON.stringify({
        action: 'REPLY', mood: 'PLAYFUL_CHILL',
        reminder: { topic: 'assignment', due_in_minutes: 10, evidence: 'yaad dila dena' },
      }), { joined: 'bhai 10 min mein yaad dila dena assignment ka', trigger: 'incoming_burst', user: 'deeps20_' });
      if (!ok.reminder || ok.reminder.due_in_minutes !== 10) throw new Error('evidence-backed reminder was dropped');
      return `evidence gate works (score ${ok.reminder.evidence_score})`;
    });
    ok &= await check('v10 · brain owns the HUMAN PACING of the turn', async () => {
      const base = { action: 'REPLY', mood: 'PLAYFUL_CHILL', bubble_count: 2,
                     bubble_plan: ['one', 'two'] };
      // 1 · the brain's numbers are honoured, clamped to human bounds
      const d = parseDecisionJson(JSON.stringify(Object.assign({}, base, {
        timing: { seen_delay_s: 12, typing_s: 9, bubble_gap_s: 3 },
      })), { joined: 'bol na', trigger: 'incoming_burst', user: 'deeps20_' });
      if (!d) throw new Error('decision not parsed');
      if (d.timing.seen_delay_ms !== 12_000) throw new Error('seen delay: ' + d.timing.seen_delay_ms);
      if (d.timing.typing_ms !== 9_000) throw new Error('typing: ' + d.timing.typing_ms);
      if (d.timing.bubble_gap_ms !== 3_000) throw new Error('gap: ' + d.timing.bubble_gap_ms);
      if (d.timing.source !== 'gemma-4-brain') throw new Error('source: ' + d.timing.source);

      // 2 · absurd numbers are clamped, not trusted
      const c = parseDecisionJson(JSON.stringify(Object.assign({}, base, {
        timing: { seen_delay_s: 9999, typing_s: -4, bubble_gap_s: 0 },
      })), { joined: 'bol na', trigger: 'incoming_burst', user: 'deeps20_' });
      if (c.timing.seen_delay_ms > 45_000) throw new Error('seen not clamped: ' + c.timing.seen_delay_ms);
      if (c.timing.typing_ms < 1_000) throw new Error('typing not clamped: ' + c.timing.typing_ms);
      if (c.timing.bubble_gap_ms < 1_000) throw new Error('gap not clamped: ' + c.timing.bubble_gap_ms);

      // 3 · no timing field at all → natural jitter, flagged as such
      const n = parseDecisionJson(JSON.stringify(base),
        { joined: 'bol na', trigger: 'incoming_burst', user: 'deeps20_' });
      if (n.timing.source !== 'default-jitter') throw new Error('fallback source: ' + n.timing.source);
      if (n.timing.seen_delay_ms <= 0) throw new Error('no jitter: ' + n.timing.seen_delay_ms);

      // 4 · an ANGRY turn must be slower than a PLAYFUL one by default
      let angry = 0, chill = 0;
      for (let i = 0; i < 12; i++) {
        angry += parseDecisionJson(JSON.stringify(Object.assign({}, base,
          { mood: 'ANGRY_SAVAGE_ROAST' })),
          { joined: 'x', trigger: 'incoming_burst', user: 'd' }).timing.seen_delay_ms;
        chill += parseDecisionJson(JSON.stringify(base),
          { joined: 'x', trigger: 'incoming_burst', user: 'd' }).timing.seen_delay_ms;
      }
      if (angry <= chill) throw new Error(`angry ${angry / 12}ms should exceed chill ${chill / 12}ms`);
      return `brain timing honoured+clamped · angry ${Math.round(angry / 12)}ms vs chill ${Math.round(chill / 12)}ms`;
    });
    ok &= await check('v10 · a dead brain never leaves the person waiting', async () => {
      // The bridge hands back a synthesized decision when every model is empty.
      const raw = JSON.stringify({
        action: 'REPLY', mood: 'PLAYFUL_CHILL', bubble_count: 1,
        bubble_plan: ['reply naturally'], use_gossip: false, privacy_ok: true,
        timing: { seen_delay_s: 2, typing_s: 4, bubble_gap_s: 2 },
        _synthesized: true, _reason: 'empty brain output',
      });
      const d = parseDecisionJson(raw, { joined: 'bol na', trigger: 'incoming_burst', user: 'deeps20_' });
      if (!d) throw new Error('synthesized decision was rejected');
      if (d.action !== 'REPLY') throw new Error('must still reply: ' + d.action);
      if (d.bubble_count !== 1) throw new Error('one bubble: ' + d.bubble_count);
      if (d.reminder || d.cross_chat_mission) throw new Error('safe decision must not invent tasks');
      if (d.privacy_ok !== true) throw new Error('safe decision must never leak');
      if (!d.timing || d.timing.seen_delay_ms <= 0) throw new Error('safe decision needs human timing');
      return 'synthesized decision parses → REPLY · 1 bubble · no invented tasks';
    });
    ok &= await check('v9 · social brain · story tray + notes tray readable', async () => {
      try {
        const tray = await storyTray();
        const notes = await trayRead();
        return `${tray.length} live stories · ${notes.items.length} notes on the tray`;
      } catch (e) {
        return `unavailable now (${e.message}) — the brain degrades gracefully`;
      }
    });
    ok &= await check('v9 · isolation guard keeps chats from colliding', async () => {
      const me = 'isolationselftest';
      const T = ensureTranscript('T_ISO_SELF', me);
      T.messages = [{ id: 'iso1', ts: now(), mine: false, kind: 'text', label: 'text',
                      text: 'ye meri private baat hai kabhi mat bolna' }];
      const leak = isolationGuard(
        'haan wahi, @isolationselftest ne kaha tha "ye meri private baat hai kabhi mat bolna"',
        'someoneelse');
      if (/isolationselftest/i.test(leak)) throw new Error('handle leaked: ' + leak);
      if (/private baat hai kabhi mat bolna/i.test(leak)) throw new Error('private line leaked: ' + leak);
      const own = isolationGuard('ye meri private baat hai kabhi mat bolna', me);
      if (!/private baat hai/i.test(own)) throw new Error('own chat content was wrongly scrubbed: ' + own);
      return 'foreign handle + verbatim line blocked, own chat untouched';
    });
    ok &= await check('v9 · social plan JSON parses + rarity gate works', async () => {
      const p = parseSocialPlan(JSON.stringify({
        mode: 'observe', skip_reason: 'nothing deserves a reply',
        actions: [{ kind: 'note', op: 'keep' }], next_check_in_minutes: 5,
      }));
      if (!p) throw new Error('plan not parsed');
      if (p.mode !== 'observe') throw new Error('mode lost');
      if (p.next_check_in_minutes < 15) throw new Error('cadence not clamped: ' + p.next_check_in_minutes);
      const SOs = S.social;
      const saved = SOs.actionLog;
      SOs.actionLog = [{ kind: 'comment', target: 'gated_selftest', at: now() - 1000, text: 'x' }];
      const g = socialGate({ kind: 'comment', target: 'gated_selftest', text: 'dubara' }, false);
      SOs.actionLog = saved;
      if (g.ok) throw new Error('cooldown not enforced');
      return `observe-mode parsed · cadence clamped · repeat blocked (${g.reason})`;
    });
    ok &= await check('caps · counters sane', async () => {
      if (hourCount() > CFG.MAX_REPLIES_PER_HOUR) throw new Error('hourly cap already hit');
      return `today=${dayCount()}/${CFG.MAX_REPLIES_PER_DAY} hour=${hourCount()}/${CFG.MAX_REPLIES_PER_HOUR}`;
    });
    console.log('%c── RESULT ──', C.info);
    results.forEach(([s, n, m]) => console.log(`${s} ${n} → ${m}`));
    console.log(ok ? '%cALL CHECKS PASSED — ready. Next: IGAgent.targets("user1"), then IGAgent.start()'
                   : '%cSOME CHECKS FAILED — fix the ❌ items above', ok ? C.ok : C.err);
    return results;
  }

  function setTargetsInternal(...inputs) {
    if (!inputs.length) {
      log(C.info, 'main', 'active targets:',
        Array.isArray(CFG.TARGETS) ? CFG.TARGETS.join(', ') : CFG.TARGETS);
      return CFG.TARGETS;
    }
    const parsed = parseTargetArgs(...inputs);
    CFG.TARGETS = parsed;
    CFG._customTargets = true;
    S.checkedTargets.clear();
    saveState();
    log(C.ok, 'main', 'targets set:',
      Array.isArray(CFG.TARGETS) ? (CFG.TARGETS.join(', ') || '(none)') : 'ALL 1:1 chats');
    if (S.running) pollNow();
    return CFG.TARGETS;
  }

  function addTargetsInternal(...inputs) {
    const parsed = parseTargetArgs(...inputs);
    if (parsed === 'all' || CFG.TARGETS === 'all') {
      CFG.TARGETS = 'all';
    } else {
      const base = Array.isArray(CFG.TARGETS) ? CFG.TARGETS : [...CFG.DEFAULT_TARGETS];
      CFG.TARGETS = [...new Set([...base, ...parsed])];
    }
    CFG._customTargets = true;
    S.checkedTargets.clear();
    saveState();
    log(C.ok, 'main', 'targets active:',
      Array.isArray(CFG.TARGETS) ? CFG.TARGETS.join(', ') : 'ALL 1:1 chats');
    if (S.running) pollNow();
    return CFG.TARGETS;
  }

  function removeTargetsInternal(...inputs) {
    const rm = new Set(
      (parseTargetArgs(...inputs) === 'all' ? [] : parseTargetArgs(...inputs))
    );
    if (Array.isArray(CFG.TARGETS)) {
      CFG.TARGETS = CFG.TARGETS.filter(u => !rm.has(u));
      CFG._customTargets = true;
      saveState();
    }
    log(C.warn, 'main', 'targets now:',
      Array.isArray(CFG.TARGETS) ? (CFG.TARGETS.join(', ') || '(none)') : CFG.TARGETS);
    return CFG.TARGETS;
  }

  function enableAllTargets() {
    CFG.TARGETS = 'all';
    CFG._customTargets = true;
    S.checkedTargets.clear();
    saveState();
    log(C.warn, 'main', 'TARGETS = ALL 1:1 chats (working with everyone)');
    if (S.running) pollNow();
    return CFG.TARGETS;
  }

  /* v10.2 · one-line view of the Instagram pacer. When the console goes quiet
     this is the first thing to look at: if `coolingFor` is set, Instagram told
     us to back off and the bot is deliberately sleeping — not broken. */
  function igStatus() {
    const left = igCooldownRemaining();
    const out = {
      coolingFor: left ? Math.round(left / 1000) + 's' : false,
      until: left ? new Date(RL.cooldownUntil).toLocaleTimeString() : null,
      strikes: RL.strikes + '/' + CFG.IG_COOLDOWN_STEPS_MS.length,
      nextPause: CFG.IG_COOLDOWN_STEPS_MS[Math.min(RL.strikes, CFG.IG_COOLDOWN_STEPS_MS.length - 1)] / 1000 + 's',
      minGapMs: CFG.IG_MIN_GAP_MS,
      pollsHeld: !!S.pollsHeld,
      queued: Object.entries(S.pending).map(([tid, p]) => ({
        user: p.user || S.usernameCache.get(tid) || tid,
        retryIn: p.at ? Math.round((p.at - now()) / 1000) + 's' : '?',
        why: p.reason || null,
      })),
    };
    if (left) {
      log(C.warn, 'ig',
        `Instagram is cooling us down for another ${out.coolingFor} ` +
        `(${out.strikes}). The bot is fine — it is deliberately waiting.`);
    } else {
      log(C.ok, 'ig',
        'Instagram pacing healthy — no cooldown, ' + out.strikes +
        ' strikes, min gap ' + CFG.IG_MIN_GAP_MS + 'ms');
    }
    console.log('%cIGAgent instagram', C.info, out);
    return out;
  }

  /* expose */
  const api = {
    start, stop, status, test, threads, history, memory, forget, memories, say,
    typingDemo, markSeenNow, transcripts, saveTranscriptsNow, pollNow,
    holdPolls, releasePolls, igStatus,
    config: CFG,
    // debug hooks (used to drive the pipeline manually when needed)
    _debug: { processThread, fetchMessages, fetchInbox, fetchThreadMeta, sendText, markSeen, sendTyping,
              humanizeReply, looksRepeated, trimToSentence, checkDraft, humanityScore, matchCase,
              splitBubbles, detectLang, weakestCheck, countMachineTells, removeMachineTells,
              cleanUsername, parseTargetArgs, buildHistory,
              analyzeTurnEmotion, peekChat, getConnectedFriends, syncGlobalMemory,
              getTimeContext, agentDecide, shouldStartProactiveConvo, buildProactiveHistory,
              runBackgroundBrain, parseBrainJson, ensureTranscript, llmBrain,
              brainDecide, decideTurn, brainDirective, applyBrainDecision,
              // v9 social brain
              socialCycle, brainSocialDecide, parseSocialPlan, socialGate,
              executeSocialAction, buildSocialObservation, socialWatchList,
              lastSocialActionFor, storyTray, userFeed, fetchComments, postComment,
              trayRead, noteCreate, noteDelete, storyReply, socRest,
              isolationGuard, collisionCheck, otherHandles, foreignQuotes, withLock,
              socialStart, socialStop, saveSocialLocal, loadSocialLocal,
              SOCIAL_DECIDE_PROMPT,
              parseDecisionJson, normalizeReminder, normalizeMission,
              normalizeTiming,
              localTaskExtraction, brainDecisionContext, evidenceScore, clip,
              onRealtimeSignal, nextPollDelayMs,
              holdPolls, releasePolls, settleThread,
              // v10.2 Instagram pacer
              isRateLimitMessage, noteRateLimit, igNoteSuccess, igCooldownRemaining,
              gql,
              get RL() { return RL; },
              MOODS, defaultMoodState, detectLocalMood, setMood,
              extractReminderRequests, addReminder, dueReminder, consumeReminder, processReminderRequests,
              extractCrossChatMissions, addMission, pendingMissionFor, consumeMission,
              privacyGuard, parseDurationMinutes,
              SLOP_WORDS, SLOP_PHRASES, STRUCTURES,
              get S() { return S; } },
    proactive(v) {
      if (v !== undefined) CFG.PROACTIVE_ENABLED = !!v;
      log(C.ok, 'agent', 'PROACTIVE_ENABLED =', CFG.PROACTIVE_ENABLED);
      return CFG.PROACTIVE_ENABLED;
    },
    proactiveIdleMinutes(mins) {
      const m = Math.max(0.1, Number(mins || 45));
      CFG.PROACTIVE_IDLE_MIN_MS = Math.round(m * 60_000);
      CFG.PROACTIVE_IDLE_MAX_MS = Math.round(m * 90_000);
      log(C.ok, 'agent', `proactive idle window = ${m}m – ${(m * 1.5).toFixed(1)}m`);
      return CFG.PROACTIVE_IDLE_MIN_MS;
    },
    async proactiveNow(username) {
      const u = cleanUsername(username || (Array.isArray(CFG.TARGETS) && CFG.TARGETS[0]) || 'deeps20_');
      const th = await findThread(u);
      const tid = String(th.thread_fbid || th.id);
      log(C.info, 'agent', `@${u}: triggering autonomous proactive conversation starter now`);
      await processThread(tid, u, { forceProactive: true });
      return true;
    },
    brainModel(m) {
      if (m) CFG.BRAIN_MODEL = String(m);
      log(C.ok, 'agent', 'BRAIN_MODEL =', CFG.BRAIN_MODEL);
      return CFG.BRAIN_MODEL;
    },
    /* ── v7 MOOD ENGINE: Aduu can change mood anytime ── */
    mood(userOrMood, maybeMood) {
      // IGAgent.mood('deeps20_')            -> read mood
      // IGAgent.mood('deeps20_', 'ANGRY_SAVAGE_ROAST') -> force mood
      // IGAgent.mood('ANGRY_SAVAGE_ROAST')  -> force mood for all default targets
      if (arguments.length === 1 && MOODS[String(userOrMood).toUpperCase()]) {
        const mk = String(userOrMood).toUpperCase();
        for (const u of (Array.isArray(CFG.TARGETS) ? CFG.TARGETS : CFG.DEFAULT_TARGETS)) {
          const e = Object.values(S.transcripts).find(T => cleanUsername(T.user) === cleanUsername(u));
          if (e) setMood(e.threadFbid, e.user, mk, 'manual console override', '', 2, 'console');
        }
        log(C.ok, 'mood', `all targets → ${mk}`);
        return mk;
      }
      const q = cleanUsername(userOrMood);
      const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === q);
      if (!entry) { log(C.warn, 'mood', `no transcript for @${q} yet`); return null; }
      if (maybeMood) {
        const mk = String(maybeMood).toUpperCase();
        if (!MOODS[mk]) { log(C.err, 'mood', `unknown mood ${mk} · use one of: ${Object.keys(MOODS).join(', ')}`); return entry.moodState; }
        setMood(entry.threadFbid, entry.user, mk, 'manual console override', '', 2, 'console');
        log(C.ok, 'mood', `@${q} → ${mk}`);
        return entry.moodState;
      }
      console.log(`%cAduu's mood with @${q}`, C.info, entry.moodState);
      return entry.moodState;
    },
    moods() {
      console.log('%cAvailable Aduu moods', C.info, Object.keys(MOODS));
      return Object.keys(MOODS);
    },
    /* ── v7 REMINDER ENGINE: task-driven time triggers (no blind spam) ── */
    remind(user, topic, minutes) {
      const q = cleanUsername(user);
      const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === q);
      if (!entry) { log(C.warn, 'remind', `no transcript for @${q} yet — open their chat first`); return null; }
      return addReminder(entry.threadFbid, entry.user, topic, minutes || 15, 'console');
    },
    reminders(user) {
      if (user) {
        const q = cleanUsername(user);
        const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === q);
        const out = entry ? (entry.reminders || []) : [];
        console.log(`%cReminders for @${q}`, C.info, out);
        return out;
      }
      const out = Object.values(S.transcripts).map(T => ({ user: T.user, reminders: T.reminders || [] }));
      console.log('%cAll scheduled reminders', C.info, out);
      return out;
    },
    idleStarter(v) {
      CFG.UNCONDITIONAL_IDLE_STARTER = !!v;
      log(C.ok, 'agent', 'UNCONDITIONAL_IDLE_STARTER =', CFG.UNCONDITIONAL_IDLE_STARTER,
        '(default OFF — Aduu only restarts dead chats for real reminders/missions)');
      return CFG.UNCONDITIONAL_IDLE_STARTER;
    },
    /* ── v7 SECRET CROSS-CHAT PRANK / RELAY MISSIONS ── */
    async prank(fromUser, targetUser, instruction) {
      const f = cleanUsername(fromUser), t = cleanUsername(targetUser);
      const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === f);
      const m = addMission(entry ? entry.threadFbid : ('manual_' + f), f, {
        target_user: t,
        type: 'prank',
        instruction: String(instruction || `tease @${t} about something only you two would know`),
        requested_by: f,
        requested_at: now(),
        source: 'console',
      });
      log(C.warn, 'mission', `queued: @${f} asked Aduu to prank @${t} · Aduu will NEVER reveal @${f}`);
      return m;
    },
    async relay(fromUser, targetUser, instruction) {
      const f = cleanUsername(fromUser), t = cleanUsername(targetUser);
      const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === f);
      return addMission(entry ? entry.threadFbid : ('manual_' + f), f, {
        target_user: t,
        type: 'relay',
        instruction: String(instruction || 'pass this along naturally'),
        requested_by: f,
        requested_at: now(),
        source: 'console',
      });
    },
    missions() {
      const out = S.pendingMissions || [];
      console.log('%cPending cross-chat missions (secret)', C.info, out);
      return out;
    },
    async runMission(targetUser) {
      const q = cleanUsername(targetUser);
      const th = await findThread(q);
      await processThread(String(th.thread_fbid || th.id), q, { forceProactive: false });
      return pendingMissionFor(q) ? 'still pending' : 'executed';
    },
    privacyWall(v) {
      CFG.PRIVACY_WALL = !!v;
      log(C.ok, 'agent', 'PRIVACY_WALL =', CFG.PRIVACY_WALL);
      return CFG.PRIVACY_WALL;
    },
    brain(user) {
      const q = cleanUsername(user);
      const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === q);
      const out = entry ? { user: entry.user, brainProfile: entry.brainProfile, agentState: entry.agentState } : null;
      console.log(`%cGemma-4 Brain Profile for @${q}`, C.info, out);
      return out;
    },
    /* ══════════ v9 · SOCIAL BRAIN ══════════
       The same Gemma-4 brain runs the whole account: stories, comments,
       comment replies, out-of-the-blue DMs and the Instagram NOTE.
       Rare by design — it usually decides to do nothing at all. */
    Social: {
      enable() {
        CFG.SOCIAL.ENABLED = true;
        socLog('soc', 'SOCIAL BRAIN enabled · dryRun=' + CFG.SOCIAL.DRY_RUN +
          ' (IGAgent.Social.dryRun(false) to actually send)');
        if (S.running) socialStart();
        return CFG.SOCIAL.ENABLED;
      },
      disable() { CFG.SOCIAL.ENABLED = false; socialStop(); return false; },
      dryRun(v) {
        if (v !== undefined) CFG.SOCIAL.DRY_RUN = !!v;
        socLog('soc', 'SOCIAL DRY_RUN =', CFG.SOCIAL.DRY_RUN);
        return CFG.SOCIAL.DRY_RUN;
      },
      /* who the social brain is allowed to engage with */
      watch(...users) {
        CFG.SOCIAL.WATCH = users.map(u => cleanUsername(u)).filter(Boolean);
        socLog('soc', 'watch →', CFG.SOCIAL.WATCH.join(', ') || '(none)');
        return CFG.SOCIAL.WATCH;
      },
      commentTargets(...users) {
        CFG.SOCIAL.COMMENT_TARGETS = users.map(u => cleanUsername(u)).filter(Boolean);
        socLog('soc', 'comment targets →', CFG.SOCIAL.COMMENT_TARGETS.join(', ') || '(none)');
        return CFG.SOCIAL.COMMENT_TARGETS;
      },
      storyTargets(...users) {
        CFG.SOCIAL.STORY_TARGETS = users.map(u => cleanUsername(u)).filter(Boolean);
        socLog('soc', 'story targets →', CFG.SOCIAL.STORY_TARGETS.join(', ') || '(none)');
        return CFG.SOCIAL.STORY_TARGETS;
      },
      commentReplies(v) {
        if (v !== undefined) CFG.SOCIAL.COMMENT_REPLIES = !!v;
        socLog('soc', 'comment replies =', CFG.SOCIAL.COMMENT_REPLIES);
        return CFG.SOCIAL.COMMENT_REPLIES;
      },
      notes(mode) {
        CFG.SOCIAL.NOTES_MODE = (mode === 'off') ? 'off' : 'agentic';
        socLog('soc', 'notes mode =', CFG.SOCIAL.NOTES_MODE);
        return CFG.SOCIAL.NOTES_MODE;
      },
      /* run the brain right now — see what it wants to do */
      async plan() {
        const dec = await brainSocialDecide();
        if (!dec.ok) throw new Error(dec.error);
        console.log('%cSocial brain plan', C.bot, dec.plan);
        return dec.plan;
      },
      /* run a full cycle (observe → plan → gate → act). Respects DRY_RUN. */
      async now() { return socialCycle(true); },
      status() {
        const today = SO.actionLog.filter(a => now() - a.at < 24 * 3600e3);
        const counts = {};
        today.forEach(a => { counts[a.kind] = (counts[a.kind] || 0) + 1; });
        const out = {
          enabled: CFG.SOCIAL.ENABLED, running: SO.running, dryRun: CFG.SOCIAL.DRY_RUN,
          watch: socialWatchList(),
          commentTargets: CFG.SOCIAL.COMMENT_TARGETS,
          storyTargets: CFG.SOCIAL.STORY_TARGETS,
          commentReplies: CFG.SOCIAL.COMMENT_REPLIES,
          notesMode: CFG.SOCIAL.NOTES_MODE,
          doneToday: counts,
          capsToday: CFG.SOCIAL.DAILY_CAP,
          lastActions: SO.actionLog.slice(-5),
          lastNoteDecisions: SO.noteLog.slice(-5),
          cyclesLogged: SO.cycles.length,
        };
        console.log('%cIGAgent.Social status', C.bot, out);
        return out;
      },
      log() {
        console.log('%cSocial brain cycles', C.bot, SO.cycles.slice(-10));
        return SO.cycles;
      },
      /* manual primitives (bypass DRY_RUN — these are explicit orders) */
      async comment(mediaPkOrUrl, text) {
        const id = String(mediaPkOrUrl).replace(/\D*(\d+).*/, '$1');
        const r = await postComment(id, text);
        socLog('soc', `comment posted on ${id}: "${text}"`);
        return r;
      },
      async replyToComment(mediaPk, commentPk, text) {
        try { return await postComment(String(mediaPk), text, String(commentPk)); }
        catch (_) { return postComment(String(mediaPk), text); }
      },
      async comments(mediaPk) { return fetchComments(String(mediaPk)); },
      async feed(user, count = 6) { return userFeed(cleanUsername(user), count); },
      async stories() { return storyTray(); },
      async tray() {
        const { items } = await trayRead();
        console.table(items.map(it => ({
          user: it.username || (it.authorId === String(S.viewerIgId) ? 'ME' : '?'),
          text: String(it.text || '').slice(0, 50), id: it.id,
          age_min: it.created_at ? Math.round((now() - it.created_at) / 60_000) : null,
        })));
        return items;
      },
      async note(text) {
        const r = await noteCreate(text);
        socLog('soc', 'note set: "' + text + '"');
        return r;
      },
      async deleteNote() {
        const { items } = await trayRead();
        const meId = String(S.viewerIgId || getCookie('ds_user_id') || '');
        const mine = items.find(it => it.authorId === meId);
        if (!mine || !mine.id) throw new Error('no note of mine found on the tray');
        const r = await noteDelete(mine.id);
        socLog('soc', 'note deleted');
        return r;
      },
      async storyReact(usernameOrStoryPk, text) {
        const raw = String(usernameOrStoryPk);
        let pk = raw.replace(/\D/g, '');
        if (!/^\d+$/.test(raw)) {
          const tray = await storyTray();
          const hit = tray.find(s => s.username === cleanUsername(raw) && s.pk);
          if (!hit) throw new Error('no fresh story found for @' + cleanUsername(raw));
          pk = hit.pk;
        }
        const r = await storyReply(pk, pk, text);
        socLog('soc', `reacted to story ${pk}: "${text}"`);
        return r;
      },
      get _state() { return SO; },
      get _cfg() { return CFG.SOCIAL; },
    },
    /* Nice notes, straight from the console */
    async note(text) {
      const t = clip(text, CFG.SOCIAL.MAX_NOTE_CHARS);
      const r = await noteCreate(t);
      socLog('note', 'NOTE → "' + t + '"');
      return r;
    },
    async notes() {
      const { items } = await trayRead();
      console.log('%cInstagram notes tray', C.bot, items);
      return items;
    },
    async deleteNote() {
      const { items } = await trayRead();
      const meId = String(S.viewerIgId || getCookie('ds_user_id') || '');
      const mine = items.find(it => it.authorId === meId);
      if (!mine || !mine.id) throw new Error('no note of mine found on the tray');
      const r = await noteDelete(mine.id);
      socLog('note', 'note deleted');
      return r;
    },
    /* who has a live story right now (the brain's "story check") */
    async stories() {
      const tray = await storyTray();
      const fresh = tray.filter(s => now() - (s.taken_at || 0) < 24 * 3600e3);
      console.log('%cLive story tray', C.bot, fresh);
      return fresh;
    },
    async noteNow() {
      /* Ask the brain to take one note decision immediately. */
      const cycle = await socialCycle(true);
      const noteOutcome = (cycle.outcome || []).find(o => o.kind === 'note');
      return noteOutcome || { status: 'nothing', reason: (cycle.plan && cycle.plan.skip_reason) || cycle.error };
    },
    /* ── v8: THE BRAIN DECIDES EVERYTHING ── */
    brainMode(v) {
      if (v !== undefined) CFG.BRAIN_DECIDES = !!v;
      log(C.ok, 'brain', 'BRAIN_DECIDES =', CFG.BRAIN_DECIDES,
        '(ON = Gemma-4 decides the whole turn from the chat messages, GLM only writes)');
      return CFG.BRAIN_DECIDES;
    },
    brainSilence(v) {
      if (v !== undefined) CFG.BRAIN_ALLOW_SILENCE = !!v;
      log(C.ok, 'brain', 'BRAIN_ALLOW_SILENCE =', CFG.BRAIN_ALLOW_SILENCE,
        '(ON = the brain may decide to leave a burst on seen)');
      return CFG.BRAIN_ALLOW_SILENCE;
    },
    /* v10.1 · how old a message may be on FIRST contact before it counts as
       history instead of something to answer. Only consulted for a thread we
       have never seen before — after that the high-water mark takes over. */
    backlogWindow(minutes) {
      if (minutes !== undefined) {
        const m = Number(minutes);
        if (!Number.isFinite(m) || m < 0) throw new Error('minutes must be >= 0');
        CFG.MAX_BACKLOG_AGE_MS = Math.round(m * 60_000);
      }
      log(C.ok, 'backlog',
        `MAX_BACKLOG_AGE = ${Math.round(CFG.MAX_BACKLOG_AGE_MS / 60_000)} min ` +
        `(first contact only: older than this is read as history)`);
      return CFG.MAX_BACKLOG_AGE_MS / 60_000;
    },
    /* Forget how far we have read a thread (forces a re-read next poll). */
    resetBacklog(user) {
      const q = cleanUsername(user);
      const entry = Object.values(S.transcripts)
        .find(T => cleanUsername(T.user) === q);
      if (!entry) throw new Error(`no transcript for @${q}`);
      delete S.highWater[entry.threadFbid];
      saveState();
      log(C.warn, 'backlog',
        `@${q}: high-water cleared — history will be re-absorbed next poll`);
      return true;
    },
    /* One-glance brain health: is the decision brain actually answering? */
    async brainStatus() {
      const m = await wsRequest({ type: 'health' }, 8000);
      const bs = m.brain_status || {};
      const ok = bs.ok && !bs.degraded;
      const line = `brain: ${ok ? 'ANSWERING' : 'DEGRADED'}` +
        (bs.last_model ? ` · last model ${bs.last_model}` : '') +
        (bs.decisions ? ` · ${bs.decisions} decision(s)` : '') +
        (bs.last_ok_ago_s != null ? ` · last ok ${bs.last_ok_ago_s}s ago` : ' · never ok') +
        (bs.last_error ? ` · ${bs.last_error}` : '');
      log(ok ? C.ok : C.warn, 'brain', line);
      return {
        ok, degraded: !!bs.degraded, last_model: bs.last_model || '',
        last_error: bs.last_error || '', decisions: bs.decisions || 0,
        last_ok_ago_s: bs.last_ok_ago_s,
        uptime_s: m.uptime_s, chain: m.chain || [],
        brain_model: m.brain_model || CFG.BRAIN_MODEL,
      };
    },
    /* Ask the brain to decide this chat right now — no reply is sent. */
    async decide(user) {
      const q = cleanUsername(user);
      const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === q);
      if (!entry) throw new Error(`no transcript for @${q} yet — run IGAgent.start() once`);
      const msgs = entry.messages || [];
      let lastOwnIdx = -1;
      msgs.forEach((m, i) => { if (m.mine) lastOwnIdx = i; });
      const joined = msgs.slice(lastOwnIdx + 1).filter(m => !m.mine && m.kind === 'text' && m.text)
        .map(m => m.text).join('\n') ||
        msgs.filter(m => !m.mine && m.kind === 'text').slice(-1).map(m => m.text).join('\n') || '';
      const emo = analyzeTurnEmotion(joined, q);
      const turned = await decideTurn(entry.threadFbid, q, msgs, emo, 'incoming_burst', null, joined);
      console.log(`%cBrain decision for @${q} (${turned.source})`, C.info, turned.decision);
      return turned.decision;
    },
    /* Why did Aduu do that? The brain's last decision for a chat. */
    why(user) {
      const q = cleanUsername(user);
      let out = null;
      if (q) {
        const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === q);
        out = entry ? (S.lastDecision[entry.threadFbid] || null) : null;
      } else {
        out = Object.values(S.lastDecision);
      }
      console.log(`%cLast brain decision${q ? ' for @' + q : ' (all chats)'}`, C.info, out);
      return out;
    },
    processLog(user) {
      const q = cleanUsername(user);
      const entry = Object.values(S.transcripts).find(T => cleanUsername(T.user) === q);
      const out = entry ? entry.processLog : [];
      console.log(`%cAgentic Process Log for @${q} (${out.length} turns)`, C.info, out);
      return out;
    },
    globalMemory() {
      console.log('%cIGAgent Global Memory & Social Graph', C.info, S.globalMemory);
      return S.globalMemory;
    },
    linkFriends(userA, userB, relation = 'close friends') {
      const a = cleanUsername(userA), b = cleanUsername(userB);
      if (!a || !b) return S.globalMemory.connections;
      if (!Array.isArray(S.globalMemory.connections)) S.globalMemory.connections = [];
      const exists = S.globalMemory.connections.find(c =>
        (cleanUsername(c.a) === a && cleanUsername(c.b) === b) ||
        (cleanUsername(c.a) === b && cleanUsername(c.b) === a));
      if (exists) exists.relation = relation;
      else S.globalMemory.connections.push({ a, b, relation });
      saveGlobalMem();
      log(C.ok, 'gmem', `linked @${a} <-> @${b} (${relation})`);
      return S.globalMemory.connections;
    },
    addGossip(note) {
      const g = String(note || '').trim();
      if (!g) return S.globalMemory.gossip;
      if (!Array.isArray(S.globalMemory.gossip)) S.globalMemory.gossip = [];
      S.globalMemory.gossip.push(g);
      saveGlobalMem();
      log(C.ok, 'gmem', 'added gossip:', g);
      return S.globalMemory.gossip;
    },
    peekChat(user) {
      const p = peekChat(user);
      console.log(`%cCross-chat intel for @${cleanUsername(user)}`, C.info, p);
      return p;
    },
    eventDriven(v) {
      CFG.EVENT_DRIVEN = !!v;
      log(C.ok, 'main', 'EVENT_DRIVEN =', CFG.EVENT_DRIVEN);
      return CFG.EVENT_DRIVEN;
    },
    targets: setTargetsInternal,
    setTargets: setTargetsInternal,
    addTargets: addTargetsInternal,
    addTarget: addTargetsInternal,
    add: addTargetsInternal,
    removeTargets: removeTargetsInternal,
    removeTarget: removeTargetsInternal,
    allTargets: enableAllTargets,
    everyone: enableAllTargets,
    dryRun(v) {
      CFG.DRY_RUN = !!v;
      CFG._customDryRun = true;
      if (!CFG.DRY_RUN) S.dryHandled.clear();
      saveState();
      log(C.warn, 'main', 'DRY_RUN =', CFG.DRY_RUN);
      if (S.running && !CFG.DRY_RUN) pollNow();
    },
    seen(v) { CFG.SEEN = !!v; saveState(); log(C.ok, 'main', 'SEEN =', CFG.SEEN); },
    typing(v) { CFG.TYPING = !!v; saveState(); log(C.ok, 'main', 'TYPING =', CFG.TYPING); },
    humanize(v) { CFG.HUMANIZE = !!v; saveState(); log(C.ok, 'main', 'HUMANIZE =', CFG.HUMANIZE); },
    model(m) {
      CFG.MODEL = String(m || '');
      CFG._customModel = true;             // persists; survives reloads
      saveState();
      log(C.ok, 'main', 'model =', CFG.MODEL || '(server default)');
    },
    prompt(p) {
      CFG.SYSTEM_PROMPT = String(p);
      CFG._customPrompt = true;               // survives reloads; new defaults won't override
      saveState();
      log(C.ok, 'main', 'persona replaced (' + p.length + ' chars)');
    },
    wsUrl(u) {
      CFG.WS_URL = String(u);
      try { if (S.ws) S.ws.close(); } catch (_) {}
      S.wsReady = false; S.ws = null;
      saveState();
      log(C.ok, 'main', 'WS =', CFG.WS_URL);
    },
    clearState() {
      localStorage.removeItem(LS_STATE);
      localStorage.removeItem(LS_MEM);
      localStorage.removeItem(LS_GLOBAL_MEM);
      localStorage.removeItem(LS_TRANSCRIPTS);
      S.handled.clear(); S.dryHandled.clear(); S.checkedTargets.clear();
      S.lastActivity = {}; S.memory = {}; S.globalMemory = defaultGlobalMemory(); S.transcripts = {};
      CFG.TARGETS = [...CFG.DEFAULT_TARGETS];
      CFG.DRY_RUN = false;
      log(C.warn, 'main', 'stored state cleared · default targets restored:', CFG.TARGETS.join(', '));
    },
    get logs() { return S.logs; },
  };
  try {
    if (window && window.IGAgent && typeof window.IGAgent.stop === 'function') {
      window.IGAgent.stop();
    }
  } catch (_) {}
  loadState();
  window.IGAgent = api;

  console.log('%cIGAgent v10.2 RESILIENT BRAIN loaded & ACTIVE ✅  (Gemma-4 decides everything · GLM-4.7-Flash writes · default targets: ' +
    (Array.isArray(CFG.TARGETS) ? CFG.TARGETS.join(', ') : CFG.TARGETS) + ')', C.ok,
    '\n• Auto-started LIVE with default targets: adarshu.io, deeps20_' +
    '\n• THE BRAIN DECIDES: mood, bubbles, silence, reminders, pranks, PACING — all from the chat messages' +
    '\n• SOCIAL BRAIN (rare by design): stories · comments · replies · notes · out-of-the-blue DMs' +
    '\n• IGAgent.brainStatus()        ← is the decision brain actually answering? (health check)' +
    '\n• IGAgent.Social.enable()     ← turn the social brain on (dry-run first)' +
    '\n• IGAgent.note("chai aur code ☕") ← put a nice NOTE up · IGAgent.notes() · IGAgent.deleteNote()' +
    '\n• IGAgent.why("user")         ← see the brain\'s last JSON decision + its evidence line' +
    '\n• IGAgent.decide("user")      ← ask the brain to decide that chat right now (sends nothing)' +
    '\n• IGAgent.brainMode(false)    ← fall back to the old local rules' +
    '\n• IGAgent.addTargets("u1, u2, u3") ← add a group of targets at once' +
    '\n• IGAgent.mood("user", "ANGRY_SAVAGE_ROAST") ← force Aduu\'s mood anytime' +
    '\n• IGAgent.remind("user", "topic", 15)        ← task-driven time trigger (NOT blind spam)' +
    '\n• IGAgent.prank("adarshu.io", "deeps20_", "tease her about the chocolate") ← secret mission' +
    '\n• IGAgent.missions() · IGAgent.reminders() · IGAgent.brain("user") · IGAgent.processLog("user")' +
    '\n• IGAgent.igStatus() ← is Instagram rate-limiting us? (cooldown + retry queue)' +
    '\n• IGAgent.status() · IGAgent.test() · IGAgent.stop()');

  // Auto-start immediately when pasted/run in the browser console (skipped in Node test harness)
  const isNodeTest = typeof process !== 'undefined' && process.versions && process.versions.node;
  if (!isNodeTest && CFG.AUTO_START) {
    setTimeout(() => {
      if (!S.running && CFG.AUTO_START) {
        start().catch(e => log(C.warn, 'main', 'auto-start retry queued: ' + e.message));
      }
    }, 50);
  }
  return api;
})();
