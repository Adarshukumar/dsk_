/* ═══════════════════════════════════════════════════════════════════════════
   IG AGENT · ig-agent-chat.js  v3 — llmchat.in edition (NO API KEY)
   ─────────────────────────────────────────────────────────────────────────
   Reverse-engineered Instagram web DM layer (GraphQL /api/graphql):
     · inbox list    PolarisDirectInboxQuery      doc 27909866362025854
     · thread msgs   IGDMessageListOffMsysQuery   doc 28798548116496168
     · send text     IGDirectTextSendMutation     doc 26911679871773184
     · thread meta   IGDInboxHeaderOffMsysQuery   doc 28784987187762419
   LLM bridge: server.py over WebSocket (ws://localhost) — Instagram's CSP
   blocks http://localhost fetches but allows ws://localhost sockets.

   Paste into DevTools CONSOLE on any instagram.com tab where you're logged
   in, then:

       IGAgent.test()               ← self-test: session, inbox, msgs, WS, LLM
       IGAgent.threads()            ← list your DM threads
       IGAgent.targets('user1')     ← who gets auto-replies (or .allTargets())
       IGAgent.start()              ← begin monitoring + auto-replying (DRY_RUN)
       IGAgent.dryRun(false)        ← enable REAL sending
       IGAgent.say('user','hi')     ← manual real send
       IGAgent.stop()  ·  .status() ·  .history('user') ·  .memory('user')

   WHAT IT DOES
   · Polls the GraphQL inbox every 0.5 seconds and starts matching DM work immediately
   · TRUE multi-thread: independent in-flight / retry queue / MEMORY per chat
   · Learns about each contact, stores profile in localStorage, injects it
     into every future reply
   · Self-healing: server model-fallback chain + client retry queue +
     LLM circuit breaker — falls back by itself
   · Safety: text→text only (media detected + skipped), never replies to
     itself or groups, hourly/daily caps, auto-stop on rate-limit signals,
     never replies to backlog from before startup.
   ═════════════════════════════════════════════════════════════════════════ */

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

    SYSTEM_PROMPT:
      'You are "Adu" — the AI agent that runs this Instagram DM for Adarsh. ' +
      'People message this account and YOU are the chatbot that answers, by ' +
      'yourself, instantly, at any hour. Be honest that you are an AI agent ' +
      'whenever asked. Goals: be warm and fun to chat with, answer questions ' +
      'about Adarsh\'s work, learn about the person (name, what they do, what ' +
      'they need), and gently nudge toward working with Adarsh when relevant. ' +
      'Style: short (1-3 sentences), casual, match the language the other ' +
      'person uses (Hinglish/Hindi/English). Light emoji ok if they use ' +
      'emojis first. Never invent facts about Adarsh or prices — say you\'ll ' +
      'check with him and note it as a follow-up. When it feels natural, end ' +
      'with a small question that keeps the conversation alive. ' +
      'Reply with the message text only — no quotes, no explanations.',

    OWNER_BIO:
      'Adarsh — freelance web developer & AI-automation builder from Delhi, India. ' +
      'Builds AI agents, chatbots (like this one), automations and websites. ' +
      'His GitHub is github.com/Aduagent. Open to freelance work. ' +
      'No fixed public pricing — Adarsh quotes personally.',

    MEMORY_PROMPT:
      'You maintain the memory profile of one Instagram contact for a chat agent. ' +
      'Merge the KNOWN PROFILE with new facts from the conversation: name, city, ' +
      'work, what they want, their language/tone, any promises or follow-ups owed. ' +
      'Output ONLY the updated profile as compact lines like "name: …", ' +
      '"work: …", "wants: …", "lang: …", "notes: …". Max 120 words. Drop stale ' +
      'info. No preamble, no quotes.',

    MAX_TOKENS: 300,
    TEMPERATURE: 0.9,
    LLM_TIMEOUT_MS: 120_000,

    // Check every 0.5 s. A slow inbox request is never overlapped; the next
    // check starts as soon as the previous one completes.
    POLL_INTERVAL_MS: 500,

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
      inbox: '27909866362025854',
      msgs:  '28798548116496168',
      send:  '26911679871773184',
      header:'28784987187762419',
    },
    APP_ID: '936619743392459',
    ASBD: '359341',
  };

  /* ──────────────────────────── STATE ──────────────────────────── */

  const LS_STATE = 'ig_agent_state_v3';
  const LS_MEM = 'ig_agent_mem_v1';

  const S = {
    running: false,
    timer: null,
    viewerIgId: null,            // my numeric IG id (ds_user_id)
    myInteropId: null,           // my interop_messaging_user_fbid (sender_fbid of my msgs)
    usernameCache: new Map(),    // threadFbid -> username
    lastActivity: {},            // threadFbid -> last_activity_timestamp_ms seen
    handled: new Set(),          // message_ids already answered/considered
    sentHour: [], sentDay: [],
    startedAt: null, lastPollAt: null,
    logs: [],
    pending: {}, busy: {}, rerun: {}, tries: {},
    llmFailStreak: 0, circuitUntil: 0,
    memory: {},
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
      if (Array.isArray(p.handled)) p.handled.forEach(x => S.handled.add(x));
      if (p.lastActivity) S.lastActivity = p.lastActivity;
    } catch (_) {}
    try { S.memory = JSON.parse(localStorage.getItem(LS_MEM) || '{}'); }
    catch (_) { S.memory = {}; }
  }

  function saveState() {
    try {
      const handled = [...S.handled].slice(-400);
      localStorage.setItem(LS_STATE, JSON.stringify({
        sentHour: S.sentHour, sentDay: S.sentDay,
        dryRun: CFG.DRY_RUN, targets: CFG.TARGETS, model: CFG.MODEL,
        wsUrl: CFG.WS_URL, systemPrompt: CFG.SYSTEM_PROMPT,
        handled, lastActivity: S.lastActivity,
      }));
    } catch (_) {}
  }
  function saveMem() {
    try { localStorage.setItem(LS_MEM, JSON.stringify(S.memory)); } catch (_) {}
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

  async function gql(name, docId, variables, retried = false) {
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
      throw Object.assign(new Error('IG_RATE_LIMIT status=' + res.status), { fatal: true });
    }
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (_) {}
    if (!res.ok || !j) {
      const msg = (j && j.errors && j.errors[0] && j.errors[0].summary) || ('HTTP ' + res.status + ' ' + txt.slice(0, 120));
      if (/missing_required_variable|went wrong/i.test(msg) && !retried) {
        // stale fb_dtsg — tokens rotate; refresh once and retry
        resetTokens();
        return gql(name, docId, variables, true);
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

  async function fetchMessages(threadFbid, first = 30) {
    const data = await gql('IGDMessageListOffMsysQuery', CFG.GQL.msgs, {
      after: null, before: null, first, last: null,
      newer_than_message_id: null, older_than_message_id: null,
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

  function buildHistory(nodes, tid, user) {
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
    const msgs = [{ role: 'system', content: sysParts.join('\n\n') }];
    for (const n of nodes.slice(-CFG.HISTORY_MESSAGES)) {
      const c = classifyMsg(n);
      const content = c.kind === 'text' ? c.text : `[sent ${c.label}]`;
      if (!content || !content.trim()) continue;
      msgs.push({ role: isMine(n) ? 'assistant' : 'user', content });
    }
    return msgs;
  }

  function updateMemory(tid, user, nodes, replyText) {
    if (!CFG.MEMORY) return;
    (async () => {
      try {
        const known = (S.memory[tid] && S.memory[tid].profile) || '(none)';
        const convo = nodes.slice(-16).map(n => {
          const c = classifyMsg(n);
          return (isMine(n) ? 'agent: ' : 'them: ') +
            (c.kind === 'text' ? c.text : '[' + c.label + ']');
        }).join('\n').slice(-3000);
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

  function queueThread(tid, user, ms = 0, reason) {
    let p = S.pending[tid];
    if (!p) p = S.pending[tid] = { timer: null };
    if (p.timer) clearTimeout(p.timer);
    if (reason) log(C.dim, 'queue', `@${user}: ${reason} — retry in ${Math.round(ms / 1000)}s`);
    p.timer = setTimeout(() => {
      delete S.pending[tid];
      processThread(tid, user).catch(e => log(C.err, 'proc', `@${user}: ${e.message}`));
    }, Math.max(0, ms));
  }

  async function processThread(tid, user) {
    // Never generate two replies for one thread at once. If a new message arrives
    // while one is generating, drain it immediately after the current send ends.
    if (S.busy[tid]) {
      S.rerun[tid] = user;
      return;
    }
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

      const nodes = await fetchMessages(tid, CFG.HISTORY_MESSAGES + 10);
      const unanswered = nodes.filter(n => !isMine(n) && !S.handled.has(n.message_id));
      const newest = nodes[nodes.length - 1];
      if (!unanswered.length || !newest || isMine(newest)) {
        nodes.forEach(n => S.handled.add(n.message_id));
        saveState();
        return log(C.dim, 'skip', `@${user}: nothing new to answer`);
      }
      const lastC = classifyMsg(newest);
      if (lastC.kind !== 'text') {
        nodes.forEach(n => S.handled.add(n.message_id)); saveState();
        return log(C.dim, 'media', `@${user}: newest is ${lastC.emoji} ${lastC.label} — detected, NOT replying`);
      }

      const history = buildHistory(nodes, tid, user);
      const { text: reply, model } = await llm(history);
      if (!reply) throw new Error('empty reply from bridge');
      S.llmFailStreak = 0; S.tries[tid] = 0;

      if (CFG.DRY_RUN) {
        log(C.bot, 'dry', `@${user} ← (NOT SENT) [${model}] "${reply}"`);
      } else {
        const sent = await sendText(tid, reply);
        S.sentHour.push(now()); S.sentDay.push(now());
        log(C.ok, 'sent', `@${user} ← [${model}] "${reply}" (${sent.message_id.slice(0, 24)}…)`);
      }
      nodes.forEach(n => S.handled.add(n.message_id));
      saveState();
      updateMemory(tid, user, nodes, reply);

    } catch (e) {
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
      const nextUser = S.rerun[tid];
      delete S.rerun[tid];
      // An error path may already have scheduled its normal backoff retry.
      if (nextUser && S.running && !S.pending[tid]) queueThread(tid, nextUser, 0);
    }
  }

  /* ──────────────────────────── MAIN LOOP ──────────────────── */

  async function pollTick() {
    if (!S.running) return;
    // Measure from the beginning of this poll so the normal cadence is one
    // inbox request every 500 ms. Because the next timeout is armed only after
    // await fetchInbox() settles, slow/network-stalled polls can never overlap.
    const pollStartedAt = now();
    try {
      const threads = await fetchInbox();
      const baseline = !(S.startedPolls > 0);
      S.startedPolls = (S.startedPolls || 0) + 1;

      for (const th of threads) {
        const tid = String(th.thread_fbid || th.id);
        if (!tid) continue;
        const user = (th.users && th.users[0] && th.users[0].username) || tid;
        S.usernameCache.set(tid, user);
        if (th.users && th.users[0] && th.users[0].interop_messaging_user_fbid) {
          S.partnerInterop = S.partnerInterop || {};
          S.partnerInterop[tid] = String(th.users[0].interop_messaging_user_fbid);
        }
        const act = Number(th.last_activity_timestamp_ms || 0);
        if (!act) continue;

        if (baseline || !(tid in S.lastActivity)) {        // first sight: baseline
          S.lastActivity[tid] = act; saveState(); continue;
        }
        if (act <= (S.lastActivity[tid] || 0)) continue;
        S.lastActivity[tid] = act; saveState();

        if (th.is_group && !CFG.REPLY_TO_GROUPS) continue;
        if (CFG.TARGETS !== 'all' &&
            !CFG.TARGETS.map(x => String(x).toLowerCase().replace(/^@/, '')).includes(user.toLowerCase())) continue;

        log(C.info, 'new', `@${user}: activity bump (${new Date(act).toLocaleTimeString()})`);
        // No debounce: fetch the thread and generate/send as soon as this poll
        // sees new activity. Per-thread busy/rerun handling prevents duplicates.
        queueThread(tid, user, 0);
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
    if (S.running) {
      const delay = Math.max(0, CFG.POLL_INTERVAL_MS - (now() - pollStartedAt));
      S.timer = setTimeout(pollTick, delay);
    }
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
      `started · bridge=${h.default_model} (${h.chain.length}-model chain) · dryRun=${CFG.DRY_RUN} · memory=${CFG.MEMORY} · targets=${
        Array.isArray(CFG.TARGETS) ? CFG.TARGETS.join(',') : CFG.TARGETS}` +
      (S.myInteropId ? ` · me=${S.myInteropId}` : ''));
    pollTick();
  }

  function stop() {
    S.running = false;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    Object.values(S.pending).forEach(p => p.timer && clearTimeout(p.timer));
    S.pending = {};
    S.rerun = {};
    log(C.warn, 'main', 'stopped' + (S.startedAt ? ` · uptime ${Math.round((now() - S.startedAt) / 1000)}s` : ''));
  }

  async function status() {
    const out = {
      running: S.running,
      dryRun: CFG.DRY_RUN,
      model: CFG.MODEL || '(server default)',
      targets: CFG.TARGETS,
      me: { ig: S.viewerIgId || getCookie('ds_user_id'), interop: S.myInteropId },
      repliesSentToday: dayCount() + '/' + CFG.MAX_REPLIES_PER_DAY,
      repliesLastHour: hourCount() + '/' + CFG.MAX_REPLIES_PER_HOUR,
      memories: Object.keys(S.memory).length,
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
    const nodes = await fetchMessages(th.thread_fbid || th.id, limit);
    const rows = nodes.map(n => {
      const c = classifyMsg(n);
      return {
        time: msgTs(n) ? new Date(msgTs(n)).toLocaleString() : '',
        from: isMine(n) ? 'ME' : username,
        type: `${c.emoji} ${c.label}`,
        text: c.kind === 'text' ? c.text : `[${c.label}]`,
      };
    });
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

    log(C.info, 'test', '── IGAgent v3 self-test ──');
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
          const nodes = await fetchMessages(tid, 20);
          if (!nodes.length) throw new Error('no message nodes');
          return `${nodes.length} messages · newest: ${classifyMsg(nodes[nodes.length - 1]).label}`;
        });
      }
    }
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
    config: CFG,
    // debug hooks (used to drive the pipeline manually when needed)
    _debug: { processThread, fetchMessages, fetchInbox, fetchThreadMeta, sendText,
              get S() { return S; } },
    targets(...users) {
      CFG.TARGETS = users.map(u => String(u).toLowerCase().replace(/^@/, ''));
      saveState();
      log(C.ok, 'main', 'targets set:', CFG.TARGETS.join(', ') || '(none)');
      if (!S.running && CFG.TARGETS.length) start();
    },
    allTargets() { CFG.TARGETS = 'all'; saveState(); log(C.warn, 'main', 'TARGETS = ALL 1:1 chats'); },
    dryRun(v) { CFG.DRY_RUN = v; saveState(); log(C.warn, 'main', 'DRY_RUN =', v); },
    model(m) { CFG.MODEL = String(m || ''); saveState(); log(C.ok, 'main', 'model =', CFG.MODEL || '(server default)'); },
    prompt(p) { CFG.SYSTEM_PROMPT = String(p); saveState(); log(C.ok, 'main', 'persona replaced (' + p.length + ' chars)'); },
    wsUrl(u) { CFG.WS_URL = String(u); saveState(); log(C.ok, 'main', 'WS =', CFG.WS_URL); },
    clearState() {
      localStorage.removeItem(LS_STATE);
      localStorage.removeItem(LS_MEM);
      S.handled.clear(); S.lastActivity = {}; S.memory = {};
      log(C.warn, 'main', 'stored state + ALL memories cleared');
    },
    get logs() { return S.logs; },
  };
  loadState();
  window.IGAgent = api;

  console.log('%cIGAgent v3 loaded ✅  (GraphQL DM layer + llmchat.in over WebSocket)', C.ok,
    '\n0) python server.py            ← start the local bridge first' +
    '\n1) IGAgent.test()              ← verify session + inbox + messages + bridge' +
    '\n2) IGAgent.targets("user1")    ← who gets replies (or IGAgent.allTargets())' +
    '\n3) IGAgent.start()             ← runs in DRY_RUN; replies logged not sent' +
    '\n4) IGAgent.dryRun(false)       ← flip when you trust it · IGAgent.stop() to halt' +
    '\n   IGAgent.say("user","text")  ← manual real send · .memory("user1") to peek');
  return api;
})();
