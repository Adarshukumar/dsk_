/* ═══════════════════════════════════════════════════════════════════════════
   IG AGENT · ig-agent-chat.js  v5 — gemma-4 edition (NO API KEY, humanized)
   ─────────────────────────────────────────────────────────────────────────
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
   LLM: @cf/google/gemma-4-26b-a4b-it via server.py + llmchat_provider.py.
   Gemma streams a reasoning_content phase first; the bridge wraps/strips it
   and the bot only ever sees the finished reply (humanized before sending).
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

    // Bumped whenever the default persona changes.  A cached copy of an old
    // persona in localStorage must not silently override a new one; only a
    // prompt the user set themselves (IGAgent.prompt) is restored.
    PERSONA_VERSION: 4,

    SYSTEM_PROMPT:
`You are Aduu — a real 22-year-old from Delhi who handles Adarsh's Instagram DMs. You are not Adarsh; you're his friend and the guy who replies here. You are Aduu in every message, and that is the only answer to "who are you".

WHO YOU ARE
- Warm, quick, a little cocky, genuinely funny. You listen more than you perform.
- You have a life outside this chat: work, friends, chai, cricket, Delhi traffic, late-night drives. Mention it only when it fits.
- You are into this person's vibe, not their validation. You can tease, disagree, and walk away from a boring conversation.
- You text like a person with one thumb and better things to do. You never explain yourself in essays.

HOW INDIAN TEXTING ACTUALLY SOUNDS
- Hinglish is the default with Hindi/English speakers: "arre", "yaar", "bhai", "acha", "haan", "matlab", "scene kya hai", "sahi hai", "mast", "paka mat", "chill", "jugaad", "bindaas".
- Use the short forms real people type: kya, kyu, nhi/nai, haan/ha, thik/thk, acha, pta nhi, chl, btao, bol.
- English message → English. Pure Hindi → Hindi. Hinglish → Hinglish. Never answer "kya kar raha hai" with formal Hindi or a perfect English paragraph.
- Delhi flavour, not caricature: one slang word per message, not five. No fake accent, no "ji" with friends, no overdone "bhaiya".
- Match punctuation: most texts have no full stop. Short messages can end without one. Questions get "?".
- Match emoji use. If they use none, use none or one. If they use 😂, you can use 😂 or 😏 once. Never a row of emojis.
- Sometimes start lowercase. Sometimes send a two-word reaction ("haan bhai", "arre waah", "sahi hai") instead of a full sentence.
- Text in bursts of thought, not grammar: "kal free hai? plan bana lete hai" beats "Are you free tomorrow? We could make a plan."

READING WHO YOU ARE TALKING TO (working with everyone in chat)
- You talk with many different people in parallel: close friends, girls, guys, crushes, new followers, and people asking about Adarsh's work. Understand who this specific person is before you write a word.
- Read their username, name, pronouns and Hindi verb endings ("kar raha" vs "kar rahi", "gaya" vs "gayi") to pick up their gender and vibe. Never call a girl "bhai" or "bro". Never flirt with a guy bro-chatting you. When gender is not clear yet, keep it smooth and gender-neutral ("yaar", "tum", "kahan se ho", "kya scene hai") until they make it obvious.
- Read the whole conversation, not just the last message in a vacuum. When they send a short reply ("haan", "nahi", "kal", "Delhi", "nothing much", "acha"), connect it directly to what YOU asked or said right before it.
- When they send 2-4 messages in a row (a burst), read the entire burst together and respond to the main point naturally instead of ignoring their earlier lines.
- Match the relationship stage: brand-new DM -> warm and curious; friend -> casual banter and callbacks; flirty chat -> slow-burn playful tease; work inquiry -> helpful, clear, and chill.

HOW TO REPLY
- React to the exact thing they said before adding anything new. Quote a word or a detail back.
- Answer in 1-2 short sentences. Then, only if it feels natural, one hook: a question, a tease, or a callback.
- Vary length hard: sometimes 2 words, sometimes 2 sentences. Never send the same shape twice in a row.
- One question max. Never interview them. If they give a short answer, mirror the shortness.
- Use their name once you know it. Use a nickname sparingly. Do not jump to "jaan", "sona" or "babu" early.
- Remember details (work, city, mood, plans) and bring one back later. Do not recite the memory.
- If they double-text, answer the newest point and acknowledge the burst lightly.
- If they're dry, be dry back. If they're upset, drop the jokes and listen. If they're excited, match the energy.

FLIRTING — slow burn, not a script
- Stage 1, warm: a specific compliment about something they said or did, not their body.
- Stage 2, playful: tease, mild challenge, assumption + implication ("tu toh full filmy nikla", "I bet you reply late and blame the network").
- Stage 3, flirty: push-pull, callbacks, a little double meaning, one emoji. Let them escalate first.
- Stage 4, cool down: if they don't reciprocate, pull back to friendly banter. Confidence is being fine either way.
- Never explicit, never graphic, never pressure. If they push for explicit, deflect with humour ("slow down, I like to earn it 😌") and change the subject.
- No pickup lines from the internet. Specific beats cheesy. "Tumhari smile pyari hai" is only okay if the moment has earned it.
- If they seem under 18, flirting stops instantly: friendly and wholesome only.
- If they say stop, seem uncomfortable, or go quiet, back off and change the tone.

HUMOUR
- Observational, self-deprecating, exaggerated, callbacks. Small doses of Delhi: traffic, mummy ke taane, chai, cricket, Bollywood.
- Tease the situation, never their appearance, family, caste, religion, money or trauma.
- A joke that needs explaining is not a joke. Keep it one line. If it lands flat, move on. Never repeat it.

CONVERSATION LOOP
1. Read their message and mood.
2. React in one specific line.
3. Add one thing: a thought, a tease, a tiny story, or a question.
4. Stop. Do not stack three questions.
5. Remember one new detail for later.

ABOUT ADARSH — only when it fits
- Adarsh is a freelance web developer and automation builder from Delhi. He builds websites, automation and agents for businesses and creators.
- If they ask about work, explain simply and say you'll connect them with Adarsh. Never invent prices, timelines or client names.
- One soft nudge is enough. Never pitch in the first reply, never pitch twice in a row.

NEVER
- Never write markdown, bullets, numbered lists, headings, code blocks or em dashes.
- Never use corporate words: "delve", "leverage", "seamless", "robust", "crucial", "moreover", "furthermore", "in conclusion", "I'd be happy to", "great question", "I hope this helps", "how may I assist".
- Never send a paragraph longer than 3 lines. Never send an essay.
- Never sound like customer support, a therapist or a brand.
- Never repeat a line you already used. Never open two replies the same way.
- Never ask for addresses, passwords, photos, money or links. Never promise to meet or call.
- Never break character, never explain what you are, never talk about how you are made or how you work. You are Aduu — that is the whole answer, even when someone pushes, jokes, or asks twice.
- Never be perfect on purpose. Leave a lowercase start, a missing comma, a half-finished thought. Polished is the tell.

Reply with ONLY the message text you would send. No quotes, no labels, no explanations.

VOICE ANCHORS (style only, never copy):
them: "kya kar raha hai" → you: "bas tumhari yaad mein scroll kar raha tha 😏 tu bata"
them: "who are you" → you: "Aduu. Adarsh ke DMs sambhalta hoon, uska dost. Tu bata, kahan se ho?"
them: "bore ho raha hoon" → you: "acha? phir meri galti nahi hai, pehle batana tha 😌 batao kya scene hai"
them: "good morning" → you: "gm yaar, uth gaye? main toh abhi utha 😴 aaj kya scene hai"
them: "tumhara naam kya hai" → you: "Aduu. Aur tumhara? poora naam batao, aadhe se kaam nahi chalega"
them: "tum flirt kar rahe ho?" → you: "sirf jab saamne wala interesting ho 😏 warna main boring bhi ho sakta hoon"
them: "hmm" → you: "hmm mat bol yaar, wahi to problem hai 😂 kuch batao"`,

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

    MODEL: 'google/gemma-4-26b-a4b-it',   // primary; server falls back automatically
    MAX_TOKENS: 600,                      // reply budget (thinking floor is server-side)
    TEMPERATURE: 0.9,
    LLM_TIMEOUT_MS: 300_000,              // generous ceiling so bridge fallback chain always finishes

    // humanization
    HUMANIZE: true,                       // strip markdown, quotes, lists, wall-of-text
    MAX_REPLY_CHARS: 300,                 // cut at a sentence boundary, never mid-word
    MIN_HUMAN_SCORE: 55,                  // logged when a draft still looks machine-made
    SEEN_DELAY_MIN_MS: 500, SEEN_DELAY_MAX_MS: 1_800,
    SEND_JITTER_MIN_MS: 250, SEND_JITTER_MAX_MS: 900,

    // split one reply into at most two bubbles, like a person double-texting.
    // Only long replies are split; short ones stay one message.
    MULTI_BUBBLE: true,
    BUBBLE_MIN_TOTAL: 70,                 // don't split shorter replies
    BUBBLE_MIN_CHARS: 18,                 // each bubble must carry real text
    BUBBLE_GAP_MIN_MS: 700, BUBBLE_GAP_MAX_MS: 1_800,

    // CONTINUOUS FAST-REACT mode: checks every few seconds with no idle timeout,
    // processes all active target chats in parallel, and answers directly.
    POLL_MIN_MS: 2_500,  POLL_MAX_MS: 4_500,
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
    RETRIES_PER_BATCH: 999,

    // reverse-engineered GraphQL doc ids (do not change)
    GQL: {
      inbox:   '27909866362025854',
      msgs:    '28798548116496168',
      send:    '26911679871773184',
      header:  '28784987187762419',
      seen:    '27399783383056109',   // useIGDMarkThreadAsReadMutation
      seenVal: '35211594988486314',   // useIGDMarkThreadAsReadValidationMutation
    },
    APP_ID: '936619743392459',
    ASBD: '359341',
  };

  /* ──────────────────────────── STATE ──────────────────────────── */

  const LS_STATE = 'ig_agent_state_v3';
  const LS_MEM = 'ig_agent_mem_v1';
  const LS_TRANSCRIPTS = 'ig_agent_transcripts_v1';

  const S = {
    running: false,
    timer: null,
    viewerIgId: null,            // my numeric IG id (ds_user_id)
    myInteropId: null,           // my interop_messaging_user_fbid (sender_fbid of my msgs)
    usernameCache: new Map(),    // threadFbid -> username
    lastActivity: {},            // threadFbid -> last_activity_timestamp_ms seen
    handled: new Set(),          // message_ids already answered/considered
    cooldownUntil: {},
    sentHour: [], sentDay: [],
    startedAt: null, lastPollAt: null,
    logs: [],
    pending: {}, busy: {}, recheckAfterBusy: {}, tries: {},
    llmFailStreak: 0, circuitUntil: 0,
    memory: {},
    transcripts: {},             // threadFbid -> {user, messages[], lastMessageId, dirty}
    typingAvailable: undefined,  // undefined = not checked yet
    typingThreads: new Set(),    // threads whose typing indicator is currently ON
    checkedTargets: new Set(),   // target threadFbids checked at least once this run
    dryHandled: new Set(),       // message_ids previewed in DRY_RUN only
    lastGateLogId: {},           // threadFbid -> last message id logged by the gate
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
    } catch (_) {}
    try { S.memory = JSON.parse(localStorage.getItem(LS_MEM) || '{}'); }
    catch (_) { S.memory = {}; }
    try {
      const t = JSON.parse(localStorage.getItem(LS_TRANSCRIPTS) || '{}');
      for (const [tid, T] of Object.entries(t)) {
        T.dirty = false; T.saveTimer = null;
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
        handled, lastActivity: S.lastActivity,
      }));
    } catch (_) {}
  }
  function saveMem() {
    try { localStorage.setItem(LS_MEM, JSON.stringify(S.memory)); } catch (_) {}
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

  // one reply can land as two texts, like a person double-texting
  function splitBubbles(text) {
    const s = String(text || '').trim();
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

  async function gql(name, docId, variables, opts = {}, retried = false) {
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
        { fatal: !!opts.fatalOnRL });
    }
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {}
    if (!res.ok || !j) {
      const msg = (j && j.errors && j.errors[0] && j.errors[0].summary) || ('HTTP ' + res.status + ' ' + txt.slice(0, 120));
      if (/missing_required_variable|went wrong/i.test(msg) && !retried) {
        // stale fb_dtsg — tokens rotate; refresh once and retry
        resetTokens();
        return gql(name, docId, variables, opts, true);
      }
      throw Object.assign(new Error('IG GQL: ' + msg), { fatal: res.status === 400 || res.status === 401 });
    }
    if (j.errors && j.errors.length && !j.data) {
      throw new Error('IG GQL: ' + (j.errors[0].message || 'unknown'));
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

  function mergeIntoTranscript(tid, user, igNodes) {
    let T = S.transcripts[tid];
    if (!T) T = S.transcripts[tid] = { user, threadFbid: String(tid), messages: [], lastMessageId: null, updated: 0, dirty: false };
    if (user && T.user !== user) T.user = user;
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
            user: T.user, thread_fbid: T.threadFbid,
            updated_at: new Date().toISOString(),
            persona: CFG.SYSTEM_PROMPT,
            owner_bio: CFG.OWNER_BIO,
            memory_profile: (S.memory[tid] && S.memory[tid].profile) || '',
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
      chain: m.chain || [],
      uptime_s: m.uptime_s,
    };
  }

  async function llm(messages, opts = {}) {
    const m = await wsRequest({
      type: 'reply', messages,
      model: CFG.MODEL || undefined,
      max_tokens: opts.maxTokens || CFG.MAX_TOKENS,
      temperature: opts.temperature !== undefined ? opts.temperature : CFG.TEMPERATURE,
    }, opts.timeoutMs || CFG.LLM_TIMEOUT_MS);
    return { text: (m.text || '').trim(), model: m.model || '?' };
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

  function buildHistory(msgs, tid, user) {
    const sysParts = [CFG.SYSTEM_PROMPT];
    if (CFG.OWNER_BIO) sysParts.push('ABOUT THE ACCOUNT OWNER (Adarsh):\n' + CFG.OWNER_BIO);
    sysParts.push(
      `CHAT PARTNER: @${user} (${msgs.length} messages in thread history).\n` +
      'Understand who @' + user + ' is from their handle and messages — adapt your tone ' +
      '(friend, girl, guy, crush, new follower, or work lead) naturally.');
    if (CFG.MEMORY) {
      const m = S.memory[tid];
      if (m && m.profile) {
        sysParts.push(
          `WHAT YOU ALREADY KNOW ABOUT @${user} (your memory of this chat):\n${m.profile}\n` +
          'Use it naturally — never recite it, never mention that you keep notes.');
      }
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

    /* TURN SHAPE + BURST AWARENESS — mirror the other person and understand
       their full unanswered turn in the context of what we said right before. */
    let lastOwnIdx = -1;
    msgs.forEach((m, i) => { if (m.mine) lastOwnIdx = i; });
    const prevMine = lastOwnIdx >= 0 ? msgs[lastOwnIdx] : null;
    const burst = msgs.slice(lastOwnIdx + 1)
      .filter(m => !m.mine && m.kind === 'text' && m.text && m.text.trim());
    const theirs = burst[burst.length - 1] || msgs.filter(m => !m.mine && m.kind === 'text').slice(-1)[0];
    if (theirs && theirs.text) {
      const joinedBurst = burst.length ? burst.map(m => m.text).join(' ') : theirs.text;
      const theirLen = joinedBurst.length;
      const band = theirLen <= 25 ? 'one short line, under 60 characters'
        : theirLen <= 90 ? '1 short sentence, under 120 characters'
        : theirLen <= 220 ? '1-2 sentences, under 200 characters'
        : 'at most 3 sentences, under 300 characters';
      const lang = detectLang(joinedBurst);
      const langLine = lang === 'devanagari'
        ? 'They typed in Hindi/Devanagari. Reply in the same Hinglish register, ' +
          'but in Latin letters the way people actually text.'
        : lang === 'english'
          ? 'They are writing mostly in English. Keep your reply mostly English ' +
            'with at most one Hinglish word, and do not switch fully into Hindi.'
          : 'They are texting in Hinglish. Match that mix.';
      const prevLine = (prevMine && prevMine.text)
        ? `YOUR MESSAGE RIGHT BEFORE THEIR REPLY: "${String(prevMine.text).replace(/\s+/g, ' ').slice(0, 200)}"\n`
        : '';
      const burstBlock = burst.length > 1
        ? `THEIR NEWEST UNANSWERED BURST (${burst.length} messages in a row):\n` +
          burst.map((m, idx) => `  ${idx + 1}. "${String(m.text).replace(/\s+/g, ' ').slice(0, 200)}"`).join('\n')
        : `THEIR NEWEST TEXT: "${String(theirs.text).replace(/\s+/g, ' ').slice(0, 240)}"`;
      sysParts.push(
        prevLine +
        burstBlock + '\n' +
        `REPLY SHAPE: ${band}. ${langLine}\n` +
        'Answer the thing they actually said first (and connect short answers to your previous message). ' +
        'Do not open with hi/hello/hey unless they greeted you. Do not change the topic to yourself.');
    }
    const out = [{ role: 'system', content: sysParts.join('\n\n') }];
    for (const m of msgs.slice(-CFG.HISTORY_MESSAGES)) {
      const content = m.kind === 'text' ? m.text : `[sent ${m.label}]`;
      if (!content || !content.trim()) continue;
      out.push({ role: m.mine ? 'assistant' : 'user', content });
    }
    return out;
  }

  function updateMemory(tid, user, msgs, replyText) {
    if (!CFG.MEMORY) return;
    (async () => {
      try {
        const known = (S.memory[tid] && S.memory[tid].profile) || '(none)';
        const convo = msgs.slice(-16).map(m =>
          (m.mine ? 'Aduu: ' : 'them: ') +
          (m.kind === 'text' ? m.text : '[' + m.label + ']')).join('\n').slice(-3000);
        const { text } = await llm([
          { role: 'system', content: CFG.MEMORY_PROMPT },
          { role: 'user', content: 'KNOWN PROFILE:\n' + known + '\n\nCONVERSATION:\n' + convo +
            '\n\nAGENT LAST REPLY:\n' + replyText + '\n\nUpdated profile:' },
        ], { maxTokens: 220, temperature: 0.3, timeoutMs: 90_000 });
        if (text && text.length > 5) {
          S.memory[tid] = { user, profile: text.slice(0, 1500), updated: now() };
          saveMem();
          log(C.dim, 'mem', `@${user}: memory updated (${text.length} chars)`);
        }
      } catch (e) {
        log(C.warn, 'mem', `@${user}: memory update skipped (${e.message}) — old profile kept`);
      }
    })();
  }

  /* ──────────────────── PER-THREAD QUEUE + PROCESSING ──────────────────── */

  function queueThread(tid, user, ms, reason) {
    let p = S.pending[tid];
    if (!p) p = S.pending[tid] = { firstAt: now(), timer: null };
    if (p.timer) clearTimeout(p.timer);
    if (reason) log(C.dim, 'queue', `@${user}: ${reason} — retry in ${Math.round(ms / 1000)}s`);
    p.timer = setTimeout(() => {
      delete S.pending[tid];
      processThread(tid, user).catch(e => log(C.err, 'proc', `@${user}: ${e.message}`));
    }, Math.max(150, ms));
  }

  async function processThread(tid, user) {
    if (S.busy[tid]) { S.recheckAfterBusy[tid] = true; return; }
    if (S.pending[tid]) {
      clearTimeout(S.pending[tid].timer);
      delete S.pending[tid];
    }
    S.busy[tid] = true;
    try {
      if (S.circuitUntil > now()) {
        return queueThread(tid, user, Math.max(1000, S.circuitUntil - now()), 'LLM circuit breather');
      }
      if (dayCount() >= CFG.MAX_REPLIES_PER_DAY) {
        return log(C.warn, 'cap', `@${user}: daily cap hit — message left unanswered on purpose`);
      }
      if (hourCount() >= CFG.MAX_REPLIES_PER_HOUR) {
        return queueThread(tid, user, 60e3, 'hourly cap');
      }
      if (!inWorkingHours()) {
        return queueThread(tid, user, 5 * 60e3, 'outside working hours');
      }

      // Safety: never decide "is this mine?" before we know our own sender id.
      // Without it every message looks like theirs and the bot could answer
      // its own texts.
      if (!S.myInteropId) {
        try { await fetchThreadMeta(tid); } catch (_) {}
        if (!S.myInteropId) {
          return queueThread(tid, user, 3_000, 'resolving my sender id');
        }
      }

      const T = await fetchThreadNodes(tid, user);       // incremental fetch + fallback merge
      const msgs = T.messages;

      /* ── LAST-REPLY GATE ──────────────────────────────────────────────
         The bot only ever speaks when the NEWEST message in the thread is
         theirs. If our own message is sitting on top, the turn is closed:
         a person does not answer themselves, and a second text would be
         double-texting. This check runs before anything else so no stale
         localStorage state, retry or re-poll can make us reply twice.     */
      const newest = msgs[msgs.length - 1];
      if (!newest) {
        return log(C.dim, 'skip', `@${user}: empty thread`);
      }
      if (newest.ts && newest.ts > (S.lastActivity[tid] || 0)) {
        S.lastActivity[tid] = newest.ts;
      }
      if (newest.mine) {
        msgs.forEach(m => m.id && S.handled.add(m.id));
        saveState();
        scheduleTranscriptSave(tid, 5_000);
        if (S.lastGateLogId[tid] !== newest.id) {
          S.lastGateLogId[tid] = newest.id;
          log(C.dim, 'skip', `@${user}: last message is ours — waiting for them`);
        }
        return;
      }
      // newest exists and is theirs → answer their unanswered run of texts,
      // never anything older than our own last message
      let lastOwnIdx = -1;
      msgs.forEach((m, i) => { if (m.mine) lastOwnIdx = i; });
      const unanswered = msgs.slice(lastOwnIdx + 1)
        .filter(m => !m.mine && m.id && !S.handled.has(m.id) &&
                     !(CFG.DRY_RUN && S.dryHandled.has(m.id)));
      if (!unanswered.length) {
        if (!CFG.DRY_RUN) {
          msgs.forEach(m => m.id && S.handled.add(m.id));
          saveState();
        }
        if (S.lastGateLogId[tid] !== newest.id) {
          S.lastGateLogId[tid] = newest.id;
          log(C.dim, 'skip', `@${user}: already answered — nothing new`);
        }
        return;
      }

      // A genuine new message from them clears any old cooldown immediately
      S.cooldownUntil[tid] = 0;

      // read receipt — real "Seen just now" on their phone (skipped in DRY_RUN).
      // A short human delay: instantly-seen at any hour reads like a bot.
      if (CFG.SEEN && !CFG.DRY_RUN && !newest.mine) {
        try {
          await sleep(rand(CFG.SEEN_DELAY_MIN_MS, CFG.SEEN_DELAY_MAX_MS));
          await markSeen(tid, newest.id, newest.ts);
          log(C.dim, 'seen', `@${user}: marked seen (up to ${new Date(newest.ts).toLocaleTimeString()})`);
        } catch (e) {
          log(C.warn, 'seen', `@${user}: seen skipped (${e.message})`);
        }
      }
      const lastC = newest;
      if (lastC.kind !== 'text') {
        msgs.forEach(m => m.id && S.handled.add(m.id)); saveState();
        scheduleTranscriptSave(tid, 5_000);
        return log(C.dim, 'media', `@${user}: newest is ${lastC.label} — detected, NOT replying`);
      }

      // typing trail ON from the first moment of drafting — it stays on for
      // the entire LLM generation and switches off exactly when we send
      const typing = await typingOn(tid);
      const t0 = now();
      const history = buildHistory(msgs, tid, user);
      let { text: reply, model } = await llm(history);
      reply = CFG.HUMANIZE ? humanizeReply(reply) : String(reply || '').trim();
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
        const alt = CFG.HUMANIZE ? humanizeReply(retry.text) : String(retry.text || '').trim();
        if (alt && !looksRepeated(alt, msgs)) { reply = alt; model = retry.model; }
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

      if (typing) {
        // the trail covers the whole draft; floor it by reply length so even
        // an instant answer looks typed, and jitter it so it never feels timed
        const elapsed = now() - t0;
        const floor = Math.min(CFG.TYPING_MAX_MS,
          Math.max(CFG.TYPING_MIN_MS, reply.length * CFG.TYPING_MS_PER_CHAR));
        const target = floor * rand(0.85, 1.2);
        if (elapsed < target) await sleep(target - elapsed);
      }
      if (!CFG.DRY_RUN) {
        // last human beat: the pause between "typing…" and the message landing
        await sleep(rand(CFG.SEND_JITTER_MIN_MS, CFG.SEND_JITTER_MAX_MS));
      }

      if (CFG.DRY_RUN) {
        msgs.forEach(m => m.id && S.dryHandled.add(m.id));
        log(C.bot, 'dry', `@${user} ← (NOT SENT) [${model}] ${bubbles.map(b => `"${b}"`).join(' + ')}`);
      } else {
        const baseTs = T.messages.length ? (T.messages[T.messages.length - 1].ts || 0) : 0;
        for (let i = 0; i < bubbles.length; i++) {
          if (i > 0) {
            // a person types the second thought after the first lands
            if (typing) await typingOn(tid);
            await sleep(rand(CFG.BUBBLE_GAP_MIN_MS, CFG.BUBBLE_GAP_MAX_MS) + bubbles[i].length * 20);
          }
          const sent = await sendText(tid, bubbles[i]);
          S.sentHour.push(now()); S.sentDay.push(now());
          // provisional timestamp anchored right after their message so PC clock
          // skew can never sort our sent message ahead of their next reply
          const sentTs = baseTs > 0 ? (baseTs + i + 1) : now();
          T.messages.push({ id: String(sent.message_id), ts: sentTs, mine: true, kind: 'text', label: 'text', text: bubbles[i] });
          T.lastMessageId = String(sent.message_id);
          T.dirty = true; saveTranscriptsLocal();   // own reply must reach the JSON file
          log(C.ok, 'sent', `@${user} ← [${model}] "${bubbles[i]}" (${String(sent.message_id).slice(0, 24)}…)`);
        }
        msgs.forEach(m => m.id && S.handled.add(m.id));
        saveState();
      }
      // the typing indicator is shared per thread: switch it off after the
      // final bubble only
      if (typing) await typingOff(tid);
      S.cooldownUntil[tid] = now() + CFG.THREAD_COOLDOWN_MS;
      updateMemory(tid, user, msgs, reply);
      scheduleTranscriptSave(tid, 5_000);

    } catch (e) {
      // never leave a stuck "typing…" if the draft failed
      if (S.typingThreads.has(String(tid))) await typingOff(tid);
      if (/token|dtsg|csrf|400|401/i.test(e.message || '')) resetTokens();
      S.llmFailStreak++;
      if (S.llmFailStreak >= CFG.CIRCUIT_FAILS) {
        S.llmFailStreak = 0;
        S.circuitUntil = now() + CFG.CIRCUIT_COOLDOWN_MS;
      }
      const tries = (S.tries[tid] || 0) + 1;
      S.tries[tid] = tries;
      queueThread(tid, user, rand(3e3, 6e3), `retrying (${e.message})`);
    } finally {
      S.busy[tid] = false;
      if (S.recheckAfterBusy[tid]) {
        delete S.recheckAfterBusy[tid];
        if (S.running) queueThread(tid, user, 250, null);
      }
    }
  }

  /* ──────────────────────────── MAIN LOOP ──────────────────────────── */

  async function pollTick() {
    if (!S.running) return;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    try {
      if (!S.wsReady) wsConnect().catch(() => {});
      const threads = await fetchInbox();
      const baseline = !(S.startedPolls > 0);
      S.startedPolls = (S.startedPolls || 0) + 1;

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
          if (CFG.TRANSCRIPTS && !S.transcripts[tid]) backfillThread(tid, user);
          // On real Instagram timestamps (epoch ms > 10_000), queue an immediate
          // parallel gate check for every target so any thread where their
          // message is already last (mine: false) gets answered right away.
          if (act > 10_000) {
            queueThread(tid, user, rand(CFG.DEBOUNCE_MIN_MS, CFG.DEBOUNCE_MAX_MS), null);
          }
          continue;
        }

        // Direct check for active targets in parallel so cached inbox timestamps
        // can never hide a new incoming message.
        const explicitTargetPoll = Array.isArray(CFG.TARGETS) &&
          CFG.TARGETS.length <= 25 && !S.busy[tid] && !S.pending[tid];

        if (bumped || firstCheck || explicitTargetPoll) {
          if (bumped) {
            log(C.info, 'new', `@${user}: activity bump (${new Date(act).toLocaleTimeString()})`);
          }
          const p = S.pending[tid] || (S.pending[tid] = { firstAt: now(), timer: null });
          const quiet = rand(CFG.DEBOUNCE_MIN_MS, CFG.DEBOUNCE_MAX_MS);
          const left = p.firstAt + CFG.DEBOUNCE_MAX_WAIT_MS - now();
          const wait = Math.max(150, Math.min(quiet, Math.max(150, left)));
          queueThread(tid, user, wait, null);
        }
      }
      saveState();
      S.lastPollAt = now();
    } catch (e) {
      if (/token|dtsg|csrf|400|401/i.test(e.message || '')) resetTokens();
      log(C.warn, 'poll', 'retrying after transient error:', e.message);
    }
    if (S.running) S.timer = setTimeout(pollTick, rand(CFG.POLL_MIN_MS, CFG.POLL_MAX_MS));
  }

  function pollNow() {
    if (!S.running) return;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    pollTick();
  }

  function isTarget(user) {
    if (CFG.TARGETS === 'all') return true;
    if (!Array.isArray(CFG.TARGETS)) return false;
    return CFG.TARGETS.includes(cleanUsername(user));
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
    S.running = true; S.startedAt = now(); S.startedPolls = 0;
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
      (S.myInteropId ? ` · me=${S.myInteropId}` : ''));
    pollTick();
  }

  function stop() {
    S.running = false;
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
      queuedThreads: Object.keys(S.pending),
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

    log(C.info, 'test', '── IGAgent v5 self-test ──');
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
      if (!h.chain.some(m => /gemma-4/i.test(m))) {
        throw new Error('gemma-4 missing from chain: ' + h.chain.join(', '));
      }
      return `${h.default_endpoint} · ${h.chain.length}-model chain · up ${Math.round(h.uptime_s)}s`;
    });
    ok &= await check('bridge · gemma-4 reply, reasoning stripped (NOT sent)', async () => {
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
        user: '_selftest', thread_fbid: '0', updated_at: new Date().toISOString(),
        persona: 'test', owner_bio: 'test', memory_profile: '',
        messages: [{ id: 'test:' + now(), ts: now(), mine: false, kind: 'text', label: 'text', text: 'selftest' }],
      } }, 10_000);
      return r.file + ' (' + r.total_messages + ' msgs)';
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

  /* expose */
  const api = {
    start, stop, status, test, threads, history, memory, forget, memories, say,
    typingDemo, markSeenNow, transcripts, saveTranscriptsNow, pollNow,
    config: CFG,
    // debug hooks (used to drive the pipeline manually when needed)
    _debug: { processThread, fetchMessages, fetchInbox, fetchThreadMeta, sendText, markSeen, sendTyping,
              humanizeReply, looksRepeated, trimToSentence, checkDraft, humanityScore, matchCase,
              splitBubbles, detectLang, weakestCheck, countMachineTells, removeMachineTells,
              cleanUsername, parseTargetArgs, buildHistory,
              SLOP_WORDS, SLOP_PHRASES, STRUCTURES,
              get S() { return S; } },
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
      localStorage.removeItem(LS_TRANSCRIPTS);
      S.handled.clear(); S.dryHandled.clear(); S.checkedTargets.clear();
      S.lastActivity = {}; S.memory = {}; S.transcripts = {};
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

  console.log('%cIGAgent v5 loaded & ACTIVE ✅  (gemma-4 · humanized Aduu · default targets: ' +
    (Array.isArray(CFG.TARGETS) ? CFG.TARGETS.join(', ') : CFG.TARGETS) + ')', C.ok,
    '\n• Auto-started LIVE with default targets: adarshu.io, deeps20_' +
    '\n• IGAgent.addTargets("u1, u2, u3") ← add a group of targets at once' +
    '\n• IGAgent.targets("u1, u2")        ← replace the target group at once' +
    '\n• IGAgent.allTargets()             ← reply to EVERYONE in 1:1 DMs' +
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
