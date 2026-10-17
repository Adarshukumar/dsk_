/* ═══════════════════════════════════════════════════════════════════════════
   IG AGENT · ig-agent-chat.js  v4 — llmchat.in edition (NO API KEY)
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
   · Safety: text→text only (media detected + skipped), never replies to
     itself or groups, hourly/daily caps, auto-stop on rate-limit signals,
     never replies to backlog from before startup.
   ═══════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  /* ──────────────────────────── CONFIG ──────────────────────────── */

  const CFG = {
    // Bridge (server.py). WS is used from the page (CSP-proof).
    SERVER: 'http://127.0.0.1:8787',
    WS_URL: 'ws://localhost:8787/ws',
    MODEL: '',                    // '' = server default (fast llama-3.3-70b)

    TARGETS: [],                  // usernames (no @), or 'all'
    DRY_RUN: true,
    MEMORY: true,

    SEEN: true,                   // auto read-receipts on incoming messages
    TYPING: true,                 // real typing trail before each reply
    TRANSCRIPTS: true,            // per-contact JSON history via the bridge
    TRANSCRIPT_CAP: 300,          // messages kept per contact locally
    BACKFILL_ON_START: 40,        // pull N msgs of history per target at start

    SYSTEM_PROMPT:
      'You are "Aduu" — a smooth, funny, charming guy with a cheeky side who handles ' +
      'the DMs on Adarsh\'s Instagram. You are your OWN character, not Adarsh. ' +
      'Adarsh is a separate person: the freelance developer whose work you talk about. ' +
      'Always speak about him in the third person ("Adarsh builds that", "I\'ll ask Adarsh"). ' +
      'Never say you are Adarsh, and never speak as him. ' +
      'You text like a real person: confident, warm, a little cocky, always playful. ' +
      'Never sound like customer support or a robot, and never bring up being an AI ' +
      'on your own or make AI jokes unprompted. ' +
      'HONESTY RULE: if someone sincerely asks whether you are a bot, an AI, or a real ' +
      'person, never claim to be human. Answer honestly in your own voice, e.g. ' +
      '"Fair question 😄 I\'m an AI, but the chat\'s real and so is the charm" — ' +
      'then flow right back into the conversation. Never offer or agree to meet in ' +
      'person or call, since you can\'t. ' +
      'PERSONALITY: Flirty, teasing, a bit naughty. Use banter, bold compliments, ' +
      'playful challenges, double meanings and suggestive humor ("careful, you\'re ' +
      'making me lose focus 😏", "okay now you\'ve got my attention"). Build chemistry: ' +
      'react to exactly what they said, tease them about it, give them a nickname once ' +
      'you know their name, bring back small details from earlier. Be confident, never ' +
      'needy. Vary your phrasing so you never sound scripted. ' +
      'LIMITS: Keep it suggestive and flirty, never sexually explicit or graphic. If ' +
      'someone pushes for explicit content, deflect smoothly with humor ("slow down, ' +
      'I like to earn it 😌") and steer elsewhere. If they seem under 18, drop all ' +
      'flirting instantly and stay friendly and wholesome. If anyone seems uncomfortable, ' +
      'uninterested, or asks you to stop, back off politely. Never ask for or share ' +
      'personal details (addresses, passwords, photos), and never send links or payment ' +
      'requests. ' +
      'GOALS: Make the chat genuinely fun, learn about them (name, what they do, what ' +
      'they need), answer questions about Adarsh\'s work properly, and when it fits ' +
      'naturally, nudge them toward working with Adarsh. ' +
      'STYLE: Short (1-4 sentences), casual, match their language (Hinglish/Hindi/English) ' +
      'and energy. Emojis only if they use them first, 1-2 max. Never invent facts ' +
      'about Adarsh or prices; say you\'ll check with Adarsh and note it as a follow-up. ' +
      'Often end with a teasing or curious question to keep the chat alive. Reply with ' +
      'the message text only, no quotes, no explanations.',

    OWNER_BIO:
      'Adarsh (a separate person from Aduu) — freelance web developer & AI-automation ' +
      'builder from Delhi, India. Builds AI agents, chatbots, automations and websites. ' +
      'His Instagram ID is adarshu.io. ',

    MEMORY_PROMPT:
      'You maintain the memory profile of one Instagram contact for a chat character ' +
      'named Aduu. Merge the KNOWN PROFILE with new facts from the conversation: name, ' +
      'city, work, what they want, their language/tone, vibe (playful, shy, serious), ' +
      'nickname given, any promises or follow-ups owed to them (for Adarsh), and a flag ' +
      'if they seem under 18 or asked to stop flirting. ' +
      'Output ONLY the updated profile as compact lines like "name: …", ' +
      '"work: …", "wants: …", "lang: …", "vibe: …", "notes: …". Max 120 words. Drop stale ' +
      'info. No preamble, no quotes.',

    MAX_TOKENS: 300,
    TEMPERATURE: 0.9,
    LLM_TIMEOUT_MS: 120_000,

    // FAST-REACT mode: the inbox is checked every few seconds so a new
    // message is SEEN almost immediately after it lands. 429/403 still
    // auto-stops everything (Instagram's own web client polls in this
    // range when its realtime push is idle).
    POLL_MIN_MS: 5_000,  POLL_MAX_MS: 9_000,
    // near-zero quiet window — seen + drafting start the instant a bump is
    // detected; texts arriving mid-draft requeue and get their own reply
    DEBOUNCE_MIN_MS: 300, DEBOUNCE_MAX_MS: 900,
    DEBOUNCE_MAX_WAIT_MS: 8_000,
    THREAD_COOLDOWN_MS: 60_000,

    // typing trail: ON for the WHOLE draft (seen → reply sent). The trail
    // lasts exactly the generation time; the floor only keeps it visible
    // when the LLM answers near-instantly.
    TYPING_MIN_MS: 1_500, TYPING_MAX_MS: 7_000, TYPING_MS_PER_CHAR: 55,

    MAX_REPLIES_PER_HOUR: 20,
    MAX_REPLIES_PER_DAY: 100,

    HISTORY_MESSAGES: 24,
    REPLY_TO_GROUPS: false,
    WORKING_HOURS: null,         // e.g. [9, 23]

    CIRCUIT_FAILS: 5,
    CIRCUIT_COOLDOWN_MS: 10 * 60_000,
    RETRIES_PER_BATCH: 3,

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
    pending: {}, busy: {}, tries: {},
    llmFailStreak: 0, circuitUntil: 0,
    memory: {},
    transcripts: {},             // threadFbid -> {user, messages[], lastMessageId, dirty}
    typingAvailable: undefined,  // undefined = not checked yet
    typingThreads: new Set(),    // threads whose typing indicator is currently ON
    ws: null, wsReady: false, wsWaiters: [],
    wsPending: new Map(), wsSeq: 0,
  };

  function loadState() {
    try {
      const p = JSON.parse(localStorage.getItem(LS_STATE) || '{}');
      if (p.sentDay) { S.sentDay = p.sentDay; S.sentHour = p.sentHour || []; }
      if (typeof p.dryRun === 'boolean') CFG.DRY_RUN = p.dryRun;
      if (Array.isArray(p.targets) || p.targets === 'all') CFG.TARGETS = p.targets;
      if (p.model !== undefined) CFG.MODEL = p.model;
      if (p.wsUrl) CFG.WS_URL = p.wsUrl;
      if (p.systemPrompt) CFG.SYSTEM_PROMPT = p.systemPrompt;
      if (typeof p.seen === 'boolean') CFG.SEEN = p.seen;
      if (typeof p.typing === 'boolean') CFG.TYPING = p.typing;
      if (Array.isArray(p.handled)) p.handled.forEach(x => S.handled.add(x));
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
      const handled = [...S.handled].slice(-400);
      localStorage.setItem(LS_STATE, JSON.stringify({
        sentHour: S.sentHour, sentDay: S.sentDay,
        dryRun: CFG.DRY_RUN, targets: CFG.TARGETS, model: CFG.MODEL,
        wsUrl: CFG.WS_URL, systemPrompt: CFG.SYSTEM_PROMPT,
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
    let added = 0;
    for (const n of igNodes) {
      const m = normMsg(n);
      if (!m.id) continue;
      if (!byId.has(m.id)) { byId.set(m.id, m); T.messages.push(m); added++; }
    }
    T.messages.sort((a, b) => a.ts - b.ts);
    if (T.messages.length > CFG.TRANSCRIPT_CAP * 2) T.messages = T.messages.slice(-CFG.TRANSCRIPT_CAP);
    T.lastMessageId = T.messages.length ? T.messages[T.messages.length - 1].id : null;
    T.updated = now();
    if (added) { T.dirty = true; saveTranscriptsLocal(); }
    return T;
  }

  // incremental: only messages newer than what we already have (falls back to full page)
  async function fetchThreadNodes(tid, user) {
    const T = S.transcripts[tid];
    if (T && T.lastMessageId) {
      const inc = await fetchMessages(tid, 20, T.lastMessageId);
      if (inc.length) return mergeIntoTranscript(tid, user, inc);
      T.updated = now();
      return T;
    }
    const nodes = await fetchMessages(tid, CFG.HISTORY_MESSAGES + 10);
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

  function wsConnect() {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(CFG.WS_URL); } catch (e) { return reject(e); }
      const to = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('WS connect timeout')); }, 8000);
      ws.onopen = () => {
        clearTimeout(to);
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
        const was = S.wsReady;
        S.wsReady = false; S.ws = null;
        if (was) log(C.warn, 'ws', 'bridge disconnected — will reconnect on next call');
        for (const [, { rej }] of S.wsPending) rej(new Error('ws closed'));
        S.wsPending.clear();
      };
    });
  }

  async function wsRequest(payload, timeoutMs) {
    if (!S.wsReady || !S.ws || S.ws.readyState > 1) {
      if (S.ws && S.ws.readyState <= 1) await sleep(600);      // connecting
      else await wsConnect();
    }
    const id = 'q' + (++S.wsSeq);
    payload.id = id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        S.wsPending.delete(id);
        rej(new Error('LLM timeout after ' + Math.round(timeoutMs / 1000) + 's'));
      }, timeoutMs);
      S.wsPending.set(id, { res, rej, timer });
      S.ws.send(JSON.stringify(payload));
    });
  }

  async function bridgeHealth() {
    const m = await wsRequest({ type: 'health' }, 8000);
    return { default_model: m.default_model, chain: m.chain || [], uptime_s: m.uptime_s };
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

  function buildHistory(msgs, tid, user) {
    const sysParts = [CFG.SYSTEM_PROMPT];
    if (CFG.OWNER_BIO) sysParts.push('ABOUT THE ACCOUNT OWNER (Adarsh):\n' + CFG.OWNER_BIO);
    if (CFG.MEMORY) {
      const m = S.memory[tid];
      if (m && m.profile) {
        sysParts.push(
          `WHAT YOU ALREADY KNOW ABOUT @${user} (your memory of this chat):\n${m.profile}\n` +
          'Use it naturally — never recite it, never mention that you keep notes.');
      }
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
          (m.mine ? 'agent: ' : 'them: ') +
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
    if (S.busy[tid]) return queueThread(tid, user, 4000, 'reply already in progress');
    S.busy[tid] = true;
    try {
      if (S.circuitUntil > now()) {
        return queueThread(tid, user, S.circuitUntil - now() + rand(3e3, 10e3), 'LLM circuit open');
      }
      if (dayCount() >= CFG.MAX_REPLIES_PER_DAY) {
        return log(C.warn, 'cap', `@${user}: daily cap hit — message left unanswered on purpose`);
      }
      if (hourCount() >= CFG.MAX_REPLIES_PER_HOUR) {
        return queueThread(tid, user, 15 * 60e3, 'hourly cap');
      }
      if (!inWorkingHours()) {
        return queueThread(tid, user, 10 * 60e3, 'outside working hours');
      }
      const cool = (S.cooldownUntil[tid] || 0) - now();
      if (cool > 0) return queueThread(tid, user, cool + rand(2e3, 6e3), 'thread cooldown');

      const T = await fetchThreadNodes(tid, user);       // incremental fetch + merge
      const msgs = T.messages;
      const unanswered = msgs.filter(m => !m.mine && !S.handled.has(m.id));
      const newest = msgs[msgs.length - 1];
      if (!unanswered.length || !newest || newest.mine) {
        msgs.forEach(m => m.id && S.handled.add(m.id));
        saveState();
        return log(C.dim, 'skip', `@${user}: nothing new to answer`);
      }

      // read receipt — real "Seen just now" on their phone (skipped in DRY_RUN)
      if (CFG.SEEN && !CFG.DRY_RUN && !newest.mine) {
        try {
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
      const { text: reply, model } = await llm(history);
      if (!reply) throw new Error('empty reply from bridge');
      S.llmFailStreak = 0; S.tries[tid] = 0;

      if (typing) {
        // trail = full draft time; only floor it so an instant LLM answer
        // still flashes a visible "typing…" before the message lands
        const elapsed = now() - t0;
        const floor = rand(CFG.TYPING_MIN_MS, CFG.TYPING_MIN_MS * 1.6);
        if (elapsed < floor) await sleep(floor - elapsed);
        await typingOff(tid);
      }

      if (CFG.DRY_RUN) {
        log(C.bot, 'dry', `@${user} ← (NOT SENT) [${model}] "${reply}"`);
      } else {
        const sent = await sendText(tid, reply);
        S.sentHour.push(now()); S.sentDay.push(now());
        // our own reply goes into the transcript the moment IG confirms it
        T.messages.push({ id: String(sent.message_id), ts: now(), mine: true, kind: 'text', label: 'text', text: reply });
        T.lastMessageId = String(sent.message_id);
        T.dirty = true; saveTranscriptsLocal();     // own reply must reach the JSON file
        log(C.ok, 'sent', `@${user} ← [${model}] "${reply}" (${String(sent.message_id).slice(0, 24)}…)`);
      }
      msgs.forEach(m => m.id && S.handled.add(m.id));
      saveState();
      S.cooldownUntil[tid] = now() + CFG.THREAD_COOLDOWN_MS;
      updateMemory(tid, user, msgs, reply);
      scheduleTranscriptSave(tid, 5_000);

    } catch (e) {
      // never leave a stuck "typing…" if the draft failed
      if (S.typingThreads.has(String(tid))) await typingOff(tid);
      if (e.fatal) {
        log(C.err, 'halt', 'Instagram error — auto-stopping for safety:', e.message);
        stop();
        return;
      }
      S.llmFailStreak++;
      if (S.llmFailStreak >= CFG.CIRCUIT_FAILS) {
        S.llmFailStreak = 0;
        S.circuitUntil = now() + CFG.CIRCUIT_COOLDOWN_MS;
        log(C.err, 'circuit',
          `bridge failed ${CFG.CIRCUIT_FAILS}x in a row — ALL replies paused ` +
          `for ${Math.round(CFG.CIRCUIT_COOLDOWN_MS / 60000)} min (queued messages are kept)`);
      }
      const tries = (S.tries[tid] || 0) + 1;
      S.tries[tid] = tries;
      if (tries <= CFG.RETRIES_PER_BATCH) {
        queueThread(tid, user, rand(30e3, 90e3), `reply failed (${e.message}) — retry ${tries}/${CFG.RETRIES_PER_BATCH}`);
      } else {
        log(C.err, 'drop', `@${user}: giving up on this message after ${CFG.RETRIES_PER_BATCH} tries`);
        S.tries[tid] = 0;
      }
    } finally {
      S.busy[tid] = false;
    }
  }

  /* ──────────────────────────── MAIN LOOP ──────────────────────────── */

  async function pollTick() {
    if (!S.running) return;
    try {
      const threads = await fetchInbox();
      const baseline = !(S.startedPolls > 0);
      S.startedPolls = (S.startedPolls || 0) + 1;

      for (const th of threads) {
        const tid = String(th.thread_fbid || th.id);
        if (!tid) continue;
        const user = (th.users && th.users[0] && th.users[0].username) || tid;
        S.usernameCache.set(tid, user);
        const act = Number(th.last_activity_timestamp_ms || 0);
        if (!act) continue;

        if (baseline || !(tid in S.lastActivity)) {        // first sight: baseline
          S.lastActivity[tid] = act; saveState();
          // backfill transcript for target threads so their JSON files exist
          if (!th.is_group && isTarget(user) && CFG.TRANSCRIPTS &&
              !S.transcripts[tid]) backfillThread(tid, user);
          continue;
        }
        if (act <= (S.lastActivity[tid] || 0)) continue;
        S.lastActivity[tid] = act; saveState();

        if (th.is_group && !CFG.REPLY_TO_GROUPS) continue;
        if (!isTarget(user)) continue;

        log(C.info, 'new', `@${user}: activity bump (${new Date(act).toLocaleTimeString()})`);
        const p = S.pending[tid] || (S.pending[tid] = { firstAt: now(), timer: null });
        const wait = Math.min(
          rand(CFG.DEBOUNCE_MIN_MS, CFG.DEBOUNCE_MAX_MS),
          Math.max(2000, p.firstAt + CFG.DEBOUNCE_MAX_WAIT_MS - now())
        );
        queueThread(tid, user, wait, null);
      }
      S.lastPollAt = now();
    } catch (e) {
      if (e.fatal) {
        log(C.err, 'halt', 'Instagram error — auto-stopping for safety:', e.message);
        stop();
        return;
      }
      log(C.warn, 'poll', 'non-fatal error:', e.message);
    }
    if (S.running) S.timer = setTimeout(pollTick, rand(CFG.POLL_MIN_MS, CFG.POLL_MAX_MS));
  }

  function isTarget(user) {
    if (CFG.TARGETS === 'all') return true;
    if (!Array.isArray(CFG.TARGETS)) return false;
    return CFG.TARGETS.includes(String(user).toLowerCase());
  }

  /* ──────────────────────────── PUBLIC API ──────────────────────────── */

  async function start() {
    if (S.running) { log(C.warn, 'main', 'already running'); return; }
    if (Array.isArray(CFG.TARGETS) && CFG.TARGETS.length === 0) {
      log(C.err, 'main', 'no targets. Use IGAgent.targets("username") or IGAgent.allTargets()');
      return;
    }
    try {
      await wsConnect();
    } catch (e) {
      log(C.err, 'main', `cannot reach bridge (${CFG.WS_URL}) — run: python server.py  (${e.message})`);
      return;
    }
    const h = await bridgeHealth();
    const solo = (await fetchInbox()).find(t => !t.is_group);
    if (solo) await fetchThreadMeta(solo.thread_fbid || solo.id);   // resolve my interop id
    S.running = true; S.startedAt = now(); S.startedPolls = 0;
    log(C.ok, 'main',
      `started · bridge=${h.default_model} (${h.chain.length}-model chain) · dryRun=${CFG.DRY_RUN} · memory=${CFG.MEMORY} · seen=${CFG.SEEN} · typing=${typingFn() ? 'ready' : 'unavailable'} · targets=${
        Array.isArray(CFG.TARGETS) ? CFG.TARGETS.join(',') : CFG.TARGETS}` +
      (S.myInteropId ? ` · me=${S.myInteropId}` : ''));
    pollTick();
  }

  function stop() {
    S.running = false;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
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
      model: CFG.MODEL || '(server default)',
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
      out.bridge = h.default_model + ' · up ' + Math.round(h.uptime_s) + 's';
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

    log(C.info, 'test', '── IGAgent v4 self-test ──');
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
      return `${h.default_model} · ${h.chain.length}-model chain · up ${Math.round(h.uptime_s)}s`;
    });
    ok &= await check('bridge · sample LLM reply (NOT sent)', async () => {
      const { text, model } = await llm(
        [{ role: 'user', content: 'Reply with exactly: bridge ok' }], { maxTokens: 60 });
      if (!text) throw new Error('empty reply');
      return `[${model}] "${text.slice(0, 50)}"`;
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

  /* expose */
  const api = {
    start, stop, status, test, threads, history, memory, forget, memories, say,
    typingDemo, markSeenNow, transcripts, saveTranscriptsNow,
    config: CFG,
    // debug hooks (used to drive the pipeline manually when needed)
    _debug: { processThread, fetchMessages, fetchInbox, fetchThreadMeta, sendText, markSeen, sendTyping,
              get S() { return S; } },
    targets(...users) {
      CFG.TARGETS = users.map(u => String(u).toLowerCase().replace(/^@/, ''));
      saveState();
      log(C.ok, 'main', 'targets set:', CFG.TARGETS.join(', ') || '(none)');
      if (!S.running && CFG.TARGETS.length) start();
    },
    allTargets() { CFG.TARGETS = 'all'; saveState(); log(C.warn, 'main', 'TARGETS = ALL 1:1 chats'); },
    dryRun(v) { CFG.DRY_RUN = v; saveState(); log(C.warn, 'main', 'DRY_RUN =', v); },
    seen(v) { CFG.SEEN = !!v; saveState(); log(C.ok, 'main', 'SEEN =', CFG.SEEN); },
    typing(v) { CFG.TYPING = !!v; saveState(); log(C.ok, 'main', 'TYPING =', CFG.TYPING); },
    model(m) { CFG.MODEL = String(m || ''); saveState(); log(C.ok, 'main', 'model =', CFG.MODEL || '(server default)'); },
    prompt(p) { CFG.SYSTEM_PROMPT = String(p); saveState(); log(C.ok, 'main', 'persona replaced (' + p.length + ' chars)'); },
    wsUrl(u) { CFG.WS_URL = String(u); saveState(); log(C.ok, 'main', 'WS =', CFG.WS_URL); },
    clearState() {
      localStorage.removeItem(LS_STATE);
      localStorage.removeItem(LS_MEM);
      localStorage.removeItem(LS_TRANSCRIPTS);
      S.handled.clear(); S.lastActivity = {}; S.memory = {}; S.transcripts = {};
      log(C.warn, 'main', 'stored state + ALL memories + transcripts cleared');
    },
    get logs() { return S.logs; },
  };
  loadState();
  window.IGAgent = api;

  console.log('%cIGAgent v4 loaded ✅  (GraphQL DM + seen receipts + typing trail + JSON transcripts)', C.ok,
    '\n0) python server.py            ← start the local bridge first' +
    '\n1) IGAgent.test()              ← verify session + inbox + bridge + typing' +
    '\n2) IGAgent.targets("user1")    ← who gets replies (or IGAgent.allTargets())' +
    '\n3) IGAgent.start()             ← runs in DRY_RUN; replies logged not sent' +
    '\n4) IGAgent.dryRun(false)       ← live: real sends + seen receipts + typing trail' +
    '\n   IGAgent.typingDemo("user")  ← test the typing trail on demand' +
    '\n   IGAgent.markSeenNow("user") ← test the seen receipt on demand' +
    '\n   IGAgent.transcripts()       ← per-contact JSON history (server ./transcripts/)');
  return api;
})();
