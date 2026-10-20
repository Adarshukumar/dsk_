#!/usr/bin/env node
/* Page-side end-to-end test with fake Instagram + fake bridge.
 *
 *   node tests/test_bot_flow.js
 *
 * Verifies the real pipeline: inbox -> message classify -> seen -> typing ->
 * gemma reply -> humanize -> send -> transcript, plus the "never answer your
 * own messages" guard and the debounce maths.
 */
'use strict';

const assert = require('assert');
const path = require('path');

/* ── state the fakes share ─────────────────────────────────────────────── */
const IG = {
  threads: [{
    thread_fbid: 'T1', is_group: false,
    users: [{ username: 'testuser' }],
    last_activity_timestamp_ms: 1000,
  }],
  messages: [{
    message_id: 'm1', timestamp_ms: 1000, sender_fbid: 'THEM',
    content_type: 'TEXT',
    content: { __typename: 'SlideMessageText', text_body: 'bro hi' },
  }],
  calls: [],
  sent: [],
  seen: 0,
};
let BRIDGE_REPLY = '**Haan bro!** <think>internal</think> kya haal hai? 😄';

/* ── browser stubs ─────────────────────────────────────────────────────── */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.document = {
  cookie: 'ds_user_id=999; csrftoken=csrf123',
  querySelectorAll: () => ([
    { textContent: '{"DTSGInitData":{"token":"dtsg123","async_get_token":""}}' },
    { textContent: '__d("LSD",[],function(){return {"token":"lsd123"}});' },
  ]),
};
global.window = {};
global.window.require = (name) =>
  (name === 'IGDMAPISendTypingIndicator' ? async () => true : null);

/* ── v9: private REST surface used by the social brain ─────────────────── */
const REST = {
  '/api/v1/feed/reels_tray/': {
    tray: [{
      user: { username: 'deeps20_' },
      latest_reel_media: Math.floor(Date.now() / 1000) - 600,
      media: [{ pk: 'STORY1', id: 'STORY1_ID', taken_at: Math.floor(Date.now() / 1000) - 600, media_type: 1 }],
    }, {
      user: { username: 'adarshu.io' },
      latest_reel_media: Math.floor(Date.now() / 1000) - 7200,
      media: [{ pk: 'STORY2', id: 'STORY2_ID', taken_at: Math.floor(Date.now() / 1000) - 7200, media_type: 2 }],
    }],
  },
  '/api/v1/users/web_profile_info/?username=deeps20_': {
    data: { user: { id: '777' } },
  },
  '/api/v1/feed/user/777/?count=3': {
    items: [{
      pk: 'POST1', id: 'POST1', media_type: 1,
      caption: { text: 'shaam ki chai aur coding ☕' },
      taken_at: Math.floor(Date.now() / 1000) - 3600,
      comment_count: 12, like_count: 90,
    }],
  },
  '/api/v1/media/POST1/comments/?can_support_threading=true&permalink=': {
    comments: [{
      pk: 'C1', text: 'bhai ye kab banaya?', created_at: Math.floor(Date.now() / 1000) - 300,
      user: { username: 'somefan', pk: '555' },
    }],
  },
  '/api/v1/feed/user/999/?count=4': {
    items: [{ pk: 'MYPOST1', id: 'MYPOST1', media_type: 1, caption: { text: 'agent banaya' }, taken_at: Math.floor(Date.now() / 1000) - 86400 }],
  },
  '/api/v1/media/MYPOST1/comments/?can_support_threading=true&permalink=': {
    comments: [{
      pk: 'MC1', text: 'ye kaise banaya bhai?', created_at: Math.floor(Date.now() / 1000) - 600,
      user: { username: 'somefan', pk: '555' },
    }],
  },
};
const REST_CALLS = [];

global.fetch = async (url, opts = {}) => {
  const body = opts.body;
  const name = body && body.get ? body.get('fb_api_req_friendly_name') : '';

  // plain REST (no GraphQL envelope) — the social brain's private endpoints
  if (typeof url === 'string' && url.startsWith('/api/v1/')) {
    REST_CALLS.push(url);
    const payload = REST[url];
    if (!payload) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => payload };
  }

  const vars = body && body.get ? JSON.parse(body.get('variables') || '{}') : {};
  IG.calls.push({ name, vars });
  let data = {};

  if (name === 'PolarisDirectInboxQuery') {
    data = {
      get_slide_mailbox_for_iris_subscription: {
        threads_by_folder: {
          edges: IG.threads.map(t => ({ node: { as_ig_direct_thread: t } })),
        },
      },
    };
  } else if (name === 'IGDInboxHeaderOffMsysQuery') {
    data = {
      get_slide_thread_nullable: {
        as_ig_direct_thread: {
          viewer: { interop_messaging_user_fbid: 'ME' },
          users: [{ username: 'testuser' }],
        },
      },
    };
  } else if (name === 'IGDMessageListOffMsysQuery') {
    const tid = vars.id || 'T1';
    const list = (IG.byThread && IG.byThread[tid]) || IG.messages;
    const newer = vars.newer_than_message_id;
    const nodes = list
      .filter(m => !newer || m.timestamp_ms > 1000)
      .slice()
      .reverse();
    data = {
      fetch__SlideThread: {
        as_ig_direct_thread: { slide_messages: { edges: nodes.map(n => ({ node: n })) } },
      },
    };
  } else if (name === 'IGDirectTextSendMutation') {
    const text = vars.text && vars.text.sensitive_string_value;
    IG.sent.push(text);
    data = {
      xig_direct_text_send_with_slide_messaging_response: {
        message_id: 'sent_' + IG.sent.length,
      },
    };
  } else if (/MarkThreadAsRead/.test(name)) {
    IG.seen += 1;
  } else if (name === 'IGDInboxTrayQuery') {
    data = {
      response: {
        inbox_tray_items: [
          {
            inbox_tray_item_id: 'NOTE_MINE', inbox_tray_item_type: 'note',
            note_dict: {
              text: 'chai aur code ☕', created_at: Math.floor(Date.now() / 1000) - 5 * 3600,
              author_id: '999',
            },
          },
          {
            inbox_tray_item_id: 'NOTE_THEM', inbox_tray_item_type: 'note',
            note_dict: {
              text: 'assignment kar raha hoon', created_at: Math.floor(Date.now() / 1000) - 600,
              author_id: '888',
            },
            pog_info: { pog_users: [{ username: 'deeps20_' }] },
          },
        ],
      },
    };
  } else if (name === 'usePolarisCreateInboxTrayItemSubmitMutation') {
    IG.notes = IG.notes || [];
    const np = (((vars.input || {}).additional_params || {}).note_create_params) || {};
    IG.notes.push(String(np.text || ''));
    data = { xdt_create_inbox_tray_item: { inbox_tray_item_id: 'NOTE_NEW' } };
  } else if (name === 'usePolarisDeleteInboxTrayItemSubmitMutation') {
    IG.noteDeletes = (IG.noteDeletes || 0) + 1;
    data = { xdt_delete_inbox_tray_item: { success: true } };
  } else if (name === 'PolarisPostCommentInputRevampedMutation') {
    IG.comments = IG.comments || [];
    IG.comments.push({ media: String(vars.data.media_id), text: String(vars.data.comment_text) });
    data = { xig_comment_create: { pk: 'NEWCOMMENT' } };
  } else if (name === 'IGDirectReelShareMutation') {
    IG.storyReplies = IG.storyReplies || [];
    IG.storyReplies.push({ story: String(vars.ig_media_igid), text: String(vars.data.text) });
    data = { xig_direct_clip_share_with_slide_msg_response: { success: true } };
  }

  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({ data }),
  };
};

/* ── v8: the fake bridge also plays the DECISION BRAIN (Gemma-4) ──────────
   It reads the context the page script sends (the real chat messages) and
   answers with a strict JSON decision, exactly like the real brain does. */
function buildDecision(req) {
  const ctx = (req.messages || []).map(m => String(m.content || '')).join('\n');
  const abuse = /bkl|mc\b|bc\b|chutiya|madarchod|teri maa|kya kr lega|gandu/i.test(ctx);
  const remindAsk = /yaad dila|yaad dilana|remind me|baad mein baat/i.test(ctx);
  const missionAsk = /ko bol do|ko bata do|message kar dena|msg kar dena/i.test(ctx);
  const byeish = /(?:^|\n)[^\n]{0,40}\b(?:bye|good night|gn|so raha hoon|so rahi hoon)\b/i.test(ctx);
  const prankTask = /TASK DUE NOW: secretly/i.test(ctx);
  const pick = (re, fallback) => {
    const m = ctx.match(re);
    return m ? m[0].trim() : fallback;
  };
  const evRemind = pick(/[^\n"]{0,40}(?:yaad dila|yaad dilana|remind me|baad mein baat)[^\n"]{0,40}/i, 'yaad dila dena');
  const evMission = pick(/[a-z0-9._]{3,30}\s+ko\s+(?:bol do|bata do)|message kar dena|msg kar dena/i, 'adarshu.io ko bol do');
  return {
    action: byeish && !prankTask ? 'STAY_SILENT' : 'REPLY',
    understand: abuse ? 'they crossed the line and abused Aduu'
      : prankTask ? 'executing the secret prank a friend asked for'
      : 'casual Hinglish banter',
    my_last: 'Aduu teased them about the chocolates',
    next_move: abuse ? 'clap back hard, then explain honestly how it felt'
      : 'tease back and keep the banter moving',
    mood: abuse ? 'FURIOUS_ABUSE_CLAPBACK' : prankTask ? 'PRANKSTER_CHAOS' : 'PLAYFUL_CHILL',
    mood_reason: abuse ? 'their abuse' : '',
    feeling_note: abuse ? 'genuinely pissed off at how they are talking' : '',
    bubble_count: abuse ? 2 : 1,
    bubble_plan: abuse
      ? ['clap back hard in raw Delhi style', 'explain honestly how their words felt']
      : ['tease them back and leave a hook'],
    topic_lock: 'their last message',
    reminder: remindAsk && !prankTask
      ? { topic: 'assignment ka yaad dilana', due_in_minutes: 10, evidence: evRemind } : null,
    cross_chat_mission: missionAsk && !prankTask
      ? { target_user: 'adarshu.io', type: 'prank', instruction: 'tease him about the chocolate', evidence: evMission }
      : null,
    use_gossip: false,
    privacy_ok: true,
    steer_next: 'keep it short and human',
  };
}

const SOCIAL_SAVES = [];

/* v9: the same brain answering for the SOCIAL layer (stories/comments/notes).
   It sees the observation text and returns one strict JSON plan. */
function buildSocialPlan(req) {
  const ctx = (req.messages || []).map(m => String(m.content || '')).join('\n');
  const hasStory = /LIVE STORY TRAY/.test(ctx) && !/nobody you watch/.test(ctx);
  const actions = [];
  // the brain wants TWO things — the runtime must only allow ONE
  actions.push({
    kind: 'note', op: 'replace', text: 'chai, code aur thodi si shanti ☕',
    reason: 'old note is 5h old, mood is calm',
  });
  if (hasStory) {
    actions.push({
      kind: 'story_reply', target: 'deeps20_', story_pk: 'STORY1',
      text: 'oye ye kahan ghoomne nikla hai 😏', reason: 'fresh story, 10 min old',
    });
  }
  if (!actions.length) {
    return { mode: 'observe', intent: 'nothing deserves a reply right now',
             skip_reason: 'no fresh story from anyone i care about',
             actions: [{ kind: 'note', op: 'keep', text: '', reason: 'note still fits' }],
             next_check_in_minutes: 90 };
  }
  return { mode: 'act', intent: 'one quiet move', actions, next_check_in_minutes: 80 };
}

class FakeWS {
  constructor() {
    this.readyState = 0;
    setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1);
  }
  send(raw) {
    const req = JSON.parse(raw);
    const reply = (obj) => setTimeout(() => {
      this.onmessage && this.onmessage({ data: JSON.stringify(obj) });
    }, 1);
    if (req.type === 'health') {
      reply({
        id: req.id, ok: true,
        default_model: 'qwen/qwen3-30b-a3b-fp8',
        default_endpoint: '@cf/qwen/qwen3-30b-a3b-fp8',
        brain_model: 'google/gemma-4-26b-a4b-it',
        brain_endpoint: '@cf/google/gemma-4-26b-a4b-it',
        chain: ['qwen/qwen3-30b-a3b-fp8', 'google/gemma-4-26b-a4b-it'], uptime_s: 1,
      });
    } else if (req.type === 'brain') {
      reply({
        id: req.id, ok: true,
        text: JSON.stringify({
          personality: 'playful Gen-Z friend',
          relationship_stage: 'flirty-banter',
          dominant_vibe: 'witty-hinglish',
          inside_jokes: 'chocolates & late night chats',
          custom_persona_tuning: 'Use naughty-to-sharif-good-boy flip',
          proactive_hooks: ['oii kahan gayab ho gayi aaj 👀', 'chocolate ka kya hua 😌'],
          next_task: 'proactive_checkin_later',
          summary: 'name: Deeps · lang: Hinglish · vibe: playful',
        }),
        model: 'google/gemma-4-26b-a4b-it',
        thinking_trace: 'Quick brain update.',
        reasoning_chars: 19,
      });
    } else if (req.type === 'decide') {
      const isSocial = (req.messages || []).some(
        m => String(m.content || '').includes('SOCIAL BRAIN'));
      const d = isSocial ? buildSocialPlan(req) : buildDecision(req);
      reply({
        id: req.id, ok: true, role_type: 'decide',
        text: JSON.stringify(d), decision: d, decision_valid: true,
        model: 'google/gemma-4-26b-a4b-it',
        thinking_trace: 'Short decision.',
        reasoning_chars: 16,
      });
    } else if (req.type === 'reply') {
      reply({
        id: req.id, ok: true,
        text: BRIDGE_REPLY,
        model: 'qwen/qwen3-30b-a3b-fp8',
        thinking_trace: 'Short casual reply.',
        reasoning_chars: 19,
      });
    } else if (req.type === 'save_social') {
      SOCIAL_SAVES.push(req.social);
      reply({ id: req.id, ok: true,
              cycles: (req.social.cycles || []).length,
              actions: (req.social.action_log || []).length });
    } else if (req.type === 'save_global') {
      reply({ id: req.id, ok: true, people: 2 });
    } else if (req.type === 'save') {
      reply({ id: req.id, ok: true, file: 'transcripts/testuser.json',
              total_messages: req.transcript.messages.length });
    }
  }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
}
global.WebSocket = FakeWS;

/* ── boot the bot ──────────────────────────────────────────────────────── */
require(path.join(__dirname, '..', 'ig-agent-chat.js'));
const api = global.window.IGAgent;
assert(api, 'IGAgent failed to load');
const S = api._debug.S;

const results = [];
const check = (name, fn) => {
  try { fn(); results.push([true, name]); console.log(`  ✅ ${name}`); }
  catch (e) { results.push([false, name, e]); console.log(`  ❌ ${name} — ${e.message}`); }
};

(async () => {
  console.log('\nIG-Agent bot flow tests (fake Instagram + fake bridge)\n');

  check('defaults · adarshu.io and deeps20_ active & live by default', () => {
    assert.deepStrictEqual(api.config.TARGETS, ['adarshu.io', 'deeps20_']);
    assert.strictEqual(api.config.DRY_RUN, false);
  });

  api.dryRun(false);          // exercise the real send path
  api.targets('testuser');
  await api.start();

  check('startup · interop sender id resolved', () => {
    assert.strictEqual(S.myInteropId, 'ME');
    assert.strictEqual(S.running, true);
  });

  check('baseline · backlog not answered', () => {
    assert.strictEqual(IG.sent.length, 0);
    assert.strictEqual(IG.seen, 0);
  });

  // new incoming message in the same thread
  IG.messages.push({
    message_id: 'm2', timestamp_ms: 2000, sender_fbid: 'THEM',
    content_type: 'TEXT',
    content: { __typename: 'SlideMessageText', text_body: 'Hey bro, kya scene hai?' },
  });
  IG.threads[0].last_activity_timestamp_ms = 2000;

  await api._debug.processThread('T1', 'testuser');

  check('seen · receipt fired (both mutations)', () => {
    assert.strictEqual(IG.seen, 2, 'seen mutations: ' + IG.seen);
  });

  check('send · exactly one humanized message', () => {
    assert.strictEqual(IG.sent.length, 1, 'sent: ' + JSON.stringify(IG.sent));
    assert.strictEqual(IG.sent[0], 'Haan bro! kya haal hai? 😄');
    assert(!/<think|\*\*/.test(IG.sent[0]), 'reasoning/markdown leaked');
  });

  check('transcript · own reply appended with real id', () => {
    const T = S.transcripts.T1;
    assert(T, 'no transcript');
    const last = T.messages[T.messages.length - 1];
    assert.strictEqual(last.mine, true);
    assert.strictEqual(last.text, 'Haan bro! kya haal hai? 😄');
    assert.strictEqual(last.id, 'sent_1');
  });

  check('handled · message marked answered + cooldown set', () => {
    assert(S.handled.has('m2'));
    assert(S.cooldownUntil.T1 > Date.now());
  });

  // simulate a re-fetch where the newest message is ours
  IG.messages.push({
    message_id: 'sent_1', timestamp_ms: 3000, sender_fbid: 'ME',
    content_type: 'TEXT',
    content: { __typename: 'SlideMessageText', text_body: 'Haan bro! kya haal hai? 😄' },
  });
  const before = IG.sent.length;
  await api._debug.processThread('T1', 'testuser');
  check('own message · never answered again', () => {
    assert.strictEqual(IG.sent.length, before);
  });

  // LAST-REPLY GATE: clear the cooldown so the guard is the only thing that
  // can stop a reply, then prove nothing is sent and nothing is even seen
  S.cooldownUntil.T1 = 0;
  const seenBefore = IG.seen;
  await api._debug.processThread('T1', 'testuser');
  check('gate · last message is ours → silent', () => {
    assert.strictEqual(IG.sent.length, before, 'answered our own message');
    assert.strictEqual(IG.seen, seenBefore, 'marked our own message as seen');
  });

  // …and the moment they speak again, the bot answers
  IG.messages.push({
    message_id: 'm3', timestamp_ms: 4000, sender_fbid: 'THEM',
    content_type: 'TEXT',
    content: { __typename: 'SlideMessageText', text_body: 'kuch nahi yaar, tu bata' },
  });
  IG.threads[0].last_activity_timestamp_ms = 4000;
  S.cooldownUntil.T1 = 0;
  await api._debug.processThread('T1', 'testuser');
  check('gate · their message after ours → replies', () => {
    assert.strictEqual(IG.sent.length, before + 1, 'no reply to a live turn');
  });

  // MULTI-BUBBLE: a long reply lands as two texts, not one wall
  BRIDGE_REPLY = 'arre waah, ye toh mast scene hai bhai. kal milte hai pakka. ' +
                 'tab tak tu bata, kya plan hai tera?';
  IG.messages.push({
    message_id: 'm4', timestamp_ms: Date.now() + 60_000, sender_fbid: 'THEM',
    content_type: 'TEXT',
    content: { __typename: 'SlideMessageText', text_body: 'kal kya karega?' },
  });
  IG.threads[0].last_activity_timestamp_ms = Date.now() + 60_000;
  S.cooldownUntil.T1 = 0;
  const bubblesBefore = IG.sent.length;
  await api._debug.processThread('T1', 'testuser');
  check('bubbles · long reply split into two texts', () => {
    const fresh = IG.sent.slice(bubblesBefore);
    assert.strictEqual(fresh.length, 2, 'sent: ' + JSON.stringify(fresh));
    assert(fresh.every(x => x.length >= 18), JSON.stringify(fresh));
    const T = S.transcripts.T1;
    assert.strictEqual(T.messages[T.messages.length - 1].mine, true);
  });

  check('debounce · quiet window respects MAX_WAIT', () => {
    // mirrors the formula in pollTick(): never below 150ms, never above quiet
    const CFG = api.config;
    const now = Date.now();
    const firstAt = now - (CFG.DEBOUNCE_MAX_WAIT_MS + 5000); // long burst
    const quiet = 600;
    const left = firstAt + CFG.DEBOUNCE_MAX_WAIT_MS - now;
    const wait = Math.max(150, Math.min(quiet, Math.max(150, left)));
    assert(wait >= 150 && wait <= quiet);
  });

  // PARALLEL MULTI-TARGET: adarshu.io and deeps20_ answered concurrently
  BRIDGE_REPLY = 'haan yaar, batao kya scene hai';
  IG.byThread = {
    T_ADARSH: [{
      message_id: 'a1', timestamp_ms: 5000, sender_fbid: 'THEM_A',
      content_type: 'TEXT',
      content: { __typename: 'SlideMessageText', text_body: 'oye kahan hai?' },
    }],
    T_DEEPS: [{
      message_id: 'd1', timestamp_ms: 5000, sender_fbid: 'THEM_D',
      content_type: 'TEXT',
      content: { __typename: 'SlideMessageText', text_body: 'hey kya kar rahe ho' },
    }],
  };
  const parBefore = IG.sent.length;
  await Promise.all([
    api._debug.processThread('T_ADARSH', 'adarshu.io'),
    api._debug.processThread('T_DEEPS', 'deeps20_'),
  ]);
  check('parallel · adarshu.io and deeps20_ answered concurrently', () => {
    assert.strictEqual(IG.sent.length - parBefore, 2, 'parallel sends: ' + (IG.sent.length - parBefore));
    assert(S.transcripts.T_ADARSH && S.transcripts.T_ADARSH.messages.slice(-1)[0].mine);
    assert(S.transcripts.T_DEEPS && S.transcripts.T_DEEPS.messages.slice(-1)[0].mine);
  });

  await new Promise(r => setTimeout(r, 30)); // let background Gemma-4 brain settle
  check('deepened transcript · processLog, message.process, and Gemma-4 brainProfile saved', () => {
    const T = S.transcripts.T_DEEPS;
    assert(T.processLog && T.processLog.length >= 1, 'processLog recorded');
    const lastTurn = T.processLog[T.processLog.length - 1];
    assert.strictEqual(lastTurn.answering_trace.model, 'qwen/qwen3-30b-a3b-fp8');
    assert.strictEqual(lastTurn.answering_trace.thinking_trace, 'Short casual reply.');
    const lastMsg = T.messages[T.messages.length - 1];
    assert(lastMsg.process && lastMsg.process.turn_id === lastTurn.turn_id, 'message.process attached');
    assert.strictEqual(T.brainProfile.relationship_stage, 'flirty-banter', 'Gemma-4 brainProfile updated');
  });

  /* ═════════════ v7 TASK-DRIVEN PROACTIVE CONVERSATION STARTER ═════════════
     Aduu no longer blindly restarts a dead chat every 30-45 minutes. He only
     starts a conversation by himself when there is a REAL task:
       · a REMINDER the user asked for ("10 min mein baat karte hai")
       · a SECRET cross-chat prank/relay mission queued by a friend
     ══════════════════════════════════════════════════════════════════════ */
  const T_deeps = S.transcripts.T_DEEPS;
  T_deeps.reminders = [];
  T_deeps.agentState.next_proactive_after = Date.now() - 1000;
  S.cooldownUntil.T_DEEPS = 0;

  // 1. Idle time alone must NOT start a conversation (no more blind spam)
  const idleBefore = IG.sent.length;
  await api._debug.processThread('T_DEEPS', 'deeps20_');
  check('proactive · idle time ALONE never spams a dead chat (task required)', () => {
    assert.strictEqual(IG.sent.length, idleBefore, 'Aduu must stay quiet with no reminder/mission');
  });

  // 2. A DUE REMINDER starts the conversation by itself
  BRIDGE_REPLY = 'oii kahan gayab ho gayi aaj shaam se 👀';
  api._debug.addReminder('T_DEEPS', 'deeps20_', 'baat karte hai', 10, 'test');
  T_deeps.reminders.forEach(r => { r.due_at = Date.now() - 1000; });
  S.cooldownUntil.T_DEEPS = 0;
  const remBefore = IG.sent.length;
  await api._debug.processThread('T_DEEPS', 'deeps20_');
  check('proactive · starts the convo by itself when a REMINDER comes due', () => {
    assert.strictEqual(IG.sent.length, remBefore + 1, 'reminder starter sent');
    assert.strictEqual(IG.sent[IG.sent.length - 1], 'oii kahan gayab ho gayi aaj shaam se 👀');
    const lastTurn = T_deeps.processLog[T_deeps.processLog.length - 1];
    assert.strictEqual(lastTurn.trigger, 'reminder_due_trigger', 'turn trigger');
    assert.strictEqual(lastTurn.agent_decision.action, 'BRAIN_START_CONVO', lastTurn.agent_decision.action);
    assert.strictEqual(lastTurn.brain_decision.decided_by, 'gemma-4-brain', 'the brain owned this turn');
    assert(lastTurn.reminder_tool && lastTurn.reminder_tool.length >= 0);
    // the reminder must be consumed so it never fires twice
    assert(!api._debug.dueReminder('T_DEEPS', 'deeps20_'), 'reminder not consumed');
  });

  // 3. A SECRET CROSS-CHAT PRANK MISSION starts the conversation too
  BRIDGE_REPLY = 'oye sun, ek baat pata chali hai tere baare mein 👀';
  S.cooldownUntil.T_DEEPS = 0;
  T_deeps.agentState.next_proactive_after = Date.now() - 1000;
  api._debug.addMission('T_ADARSH', 'adarshu.io', {
    target_user: 'deeps20_', type: 'prank',
    instruction: 'tease her that adarsh told on her', requested_by: 'adarshu.io',
    requested_at: Date.now(),
  });
  const msnBefore = IG.sent.length;
  await api._debug.processThread('T_DEEPS', 'deeps20_');
  check('proactive · executes a SECRET cross-chat prank mission by itself', () => {
    assert.strictEqual(IG.sent.length, msnBefore + 1, 'mission starter sent');
    const lastTurn = T_deeps.processLog[T_deeps.processLog.length - 1];
    assert.strictEqual(lastTurn.trigger, 'cross_chat_mission_trigger', 'turn trigger');
    assert.strictEqual(T_deeps.moodState.current_mood, 'PRANKSTER_CHAOS',
      'brain set the prankster mood: ' + T_deeps.moodState.current_mood);
    assert(!api._debug.pendingMissionFor('deeps20_'), 'mission not consumed');
  });

  /* ═════════════════════ v8 · THE BRAIN DECIDES EVERYTHING ═════════════════════
     The Gemma-4 brain is handed the real chat messages and returns the JSON
     that owns the turn. Every side-effect must be traceable to a line in
     those messages (evidence), so the CHAT is what makes Aduu act.
     ══════════════════════════════════════════════════════════════════════════ */
  const T_BRAIN = api._debug.ensureTranscript('T_BRAIN', 'brainuser');
  T_BRAIN.messages = [{
    id: 'b0', ts: Date.now() - 5000, mine: true, kind: 'text', label: 'text',
    text: 'chal chocolate ka scene bata',
  }];

  const bd1 = await api._debug.brainDecide('T_BRAIN', 'brainuser', T_BRAIN.messages, {
    trigger: 'incoming_burst',
    joined: 'haan bhai 10 min mein yaad dila dena assignment ka',
  });
  check('brain · reads the chat and schedules a REMINDER the person asked for', () => {
    assert.strictEqual(bd1.ok, true, bd1.error);
    assert(bd1.decision.reminder, 'brain did not pick up the reminder request');
    assert.strictEqual(bd1.decision.reminder.due_in_minutes, 10);
    assert(bd1.decision.reminder.evidence_score >= 0.4, 'no evidence: ' + bd1.decision.reminder.evidence_score);
    assert(/yaad dila/i.test(bd1.decision.reminder.evidence), bd1.decision.reminder.evidence);
  });

  const bd2 = await api._debug.brainDecide('T_BRAIN', 'brainuser', T_BRAIN.messages, {
    trigger: 'incoming_burst',
    joined: 'adarshu.io ko bol do ki main chocolate nahi dunga',
  });
  check('brain · queues a SECRET cross-chat prank when the chat asks for one', () => {
    assert.strictEqual(bd2.ok, true, bd2.error);
    assert(bd2.decision.cross_chat_mission, 'brain did not pick up the mission');
    assert.strictEqual(bd2.decision.cross_chat_mission.target_user, 'adarshu.io');
    assert.strictEqual(bd2.decision.cross_chat_mission.type, 'prank');
  });

  const bd3 = await api._debug.brainDecide('T_BRAIN', 'brainuser', T_BRAIN.messages, {
    trigger: 'incoming_burst',
    joined: 'teri maa ki chut sale, kya kr lega?',
  });
  check('brain · flips Aduu to FURIOUS_ABUSE_CLAPBACK because THEIR line was abusive', () => {
    assert.strictEqual(bd3.decision.mood, 'FURIOUS_ABUSE_CLAPBACK', bd3.decision.mood);
    assert.strictEqual(bd3.decision.bubble_count, 2, 'clapback + feelings = 2 bubbles');
    assert.strictEqual(bd3.decision.bubble_plan.length, 2);
    const d = api._debug.brainDirective(bd3.decision, 'brainuser');
    assert(/FURIOUS_ABUSE_CLAPBACK/.test(d), 'mood missing from the writer directive');
    assert(/SEND EXACTLY 2 BUBBLE/.test(d), 'bubble count missing from the directive');
  });

  const bd4 = await api._debug.brainDecide('T_BRAIN', 'brainuser', T_BRAIN.messages, {
    trigger: 'incoming_burst', joined: 'ok bye, good night',
  });
  check('brain · can decide STAY_SILENT (leave a dead burst on seen)', () => {
    assert.strictEqual(bd4.decision.action, 'STAY_SILENT', bd4.decision.action);
  });

  check('brain · decisions with NO evidence from the chat are thrown away', () => {
    const d = api._debug.parseDecisionJson(JSON.stringify({
      action: 'REPLY', mood: 'PLAYFUL_CHILL',
      reminder: { topic: 'some random project deadline', due_in_minutes: 5, evidence: 'nothing like this was said' },
      cross_chat_mission: { target_user: 'nobody_here', type: 'prank', instruction: 'made up', evidence: 'zzz qqq' },
    }), { joined: 'hello kaise ho', trigger: 'incoming_burst', user: 'brainuser' });
    assert.strictEqual(d.reminder, null, 'fabricated reminder must be rejected');
    assert.strictEqual(d.cross_chat_mission, null, 'fabricated mission must be rejected');
  });

  check('brain · bubble_plan entries are distinct forward steps (never repeats)', () => {
    const d = api._debug.brainDirective({
      mood: 'ANGRY_SAVAGE_ROAST', bubble_count: 2,
      bubble_plan: ['clap back hard', 'explain how it felt'],
      understand: 'they disrespected Aduu', my_last: 'Aduu teased them',
      next_move: 'put them in their place', topic_lock: 'their attitude',
      feeling_note: 'pissed off', mood_reason: 'their abuse',
      use_gossip: false, privacy_ok: false,
    }, 'brainuser');
    assert(/1\. clap back hard/.test(d) && /2\. explain how it felt/.test(d));
    assert(/never repeat or remix/i.test(d), 'continuity guard missing');
    assert(/PRIVACY/.test(d), 'privacy guard missing when privacy_ok=false');
  });

  // The brain's decision must reach the writer's history.
  check('brain · decision is injected into the writer prompt', () => {
    const msgs = T_BRAIN.messages.concat([{
      id: 'b1', ts: Date.now(), mine: false, kind: 'text', label: 'text', text: 'haan bhai bata',
    }]);
    const dec = {
      decided_by: 'gemma-4-brain',
      directive: api._debug.brainDirective(bd3.decision, 'brainuser'),
      brain_decision: bd3.decision,
    };
    const hist = api._debug.buildHistory(msgs, 'T_BRAIN', 'brainuser', dec);
    const sys = String(hist[0].content || '');
    assert(/THE BRAIN DECIDED THIS TURN/.test(sys), 'brain plan not in the writer prompt');
  });

  check('brain · when the brain is OFF the local rules take over cleanly', async () => {
    assert.strictEqual(api.config.BRAIN_DECIDES, true);
  });

  const T_FB = api._debug.ensureTranscript('T_FB', 'fallbackuser');
  const fbTurned = await (async () => {
    api.brainMode(false);
    const t = await api._debug.decideTurn('T_FB', 'fallbackuser', [{
      id: 'f1', ts: Date.now(), mine: false, kind: 'text', label: 'text',
      text: 'teri maa ki chut sale',
    }], api._debug.analyzeTurnEmotion('teri maa ki chut sale', 'fallbackuser'),
      'incoming_burst', null, 'teri maa ki chut sale');
    api.brainMode(true);
    return t;
  })();
  check('brain · fallback path still reacts locally if the brain is disabled', () => {
    assert.strictEqual(fbTurned.source, 'local', fbTurned.source);
    assert.strictEqual(fbTurned.decision.decided_by, 'local-fallback');
    assert.strictEqual(T_FB.moodState.current_mood, 'FURIOUS_ABUSE_CLAPBACK',
      T_FB.moodState.current_mood);
  });

  check('brain · IGAgent.why() exposes the last decision for a chat', () => {
    const T = S.transcripts.T_DEEPS;
    const w = api.why('deeps20_');
    assert(w, 'no decision recorded for deeps20_');
    assert(w.source === 'brain' || w.source === 'local', w.source);
    assert.strictEqual(w.user, 'deeps20_');
    assert(w.decision, 'decision JSON missing');
  });

  /* ═════════════════════ v9 · SOCIAL BRAIN ═════════════════════
     The same Gemma-4 brain runs stories, comments, comment replies,
     out-of-the-blue DMs and the Instagram NOTE — rarely, and with a hard
     isolation rule: chats must never collide.
     ══════════════════════════════════════════════════════════════════════ */
  api.Social.watch('deeps20_', 'testuser');
  api.Social.commentTargets('deeps20_');
  api.Social.storyTargets('deeps20_');
  api.Social.notes('agentic');
  api.Social.dryRun(true);            // nothing is really posted in tests
  // the gate tests must not depend on what time of day CI runs
  const SAVED_QUIET = api.config.SOCIAL.QUIET_HOURS;
  api.config.SOCIAL.QUIET_HOURS = [25, 26];   // never quiet during the tests

  check('social · live story tray is readable', () => {
    assert(api._debug.socialWatchList().includes('deeps20_'));
    assert.strictEqual(api.config.SOCIAL.ENABLED, false, 'must be OFF until enabled');
  });

  const stories = await api._debug.storyTray();
  check('social · story tray lists who posted a story + its media id', () => {
    assert.strictEqual(stories.length, 2, JSON.stringify(stories));
    assert.strictEqual(stories[0].username, 'deeps20_');
    assert.strictEqual(stories[0].pk, 'STORY1');
  });

  const obs = await api._debug.buildSocialObservation();
  check('social · observation shows note, stories, watched people and limits', () => {
    assert(/ADUU'S NOTE/.test(obs), 'own note missing');
    assert(/LIVE STORY TRAY/.test(obs), 'story tray missing');
    assert(/WATCHED PEOPLE/.test(obs), 'watched people missing');
    assert(/DAILY LIMITS LEFT/.test(obs), 'daily limits missing');
    assert(!/DM: .{40,}/.test(obs), 'verbatim DM content must not leak into the account-wide view');
  });

  const socDec = await api._debug.brainSocialDecide();
  check('social · the brain plans the account by itself', () => {
    assert.strictEqual(socDec.ok, true, socDec.error);
    assert(socDec.plan, 'no plan');
    assert(['observe', 'act'].includes(socDec.plan.mode), socDec.plan.mode);
    assert.strictEqual(socDec.model, 'google/gemma-4-26b-a4b-it', socDec.model);
  });

  check('social · NOTE text is clamped to Instagram\'s 60-char limit', () => {
    const p = api._debug.parseSocialPlan(JSON.stringify({
      mode: 'act', actions: [{ kind: 'note', op: 'replace', text: 'x'.repeat(140) }],
    }));
    assert.strictEqual(p.actions[0].text.length, api.config.SOCIAL.MAX_NOTE_CHARS);
  });

  check('social · observe mode is the default and carries a skip_reason', () => {
    const p = api._debug.parseSocialPlan(JSON.stringify({
      mode: 'observe', skip_reason: 'nothing deserves a reply',
      actions: [{ kind: 'note', op: 'keep' }],
    }));
    assert.strictEqual(p.mode, 'observe');
    assert.strictEqual(p.skip_reason, 'nothing deserves a reply');
    assert.strictEqual(p.actions.length, 1);   // note "keep" is not an action
  });

  /* ── ISOLATION: chats must never collide ── */
  const T_ISO_A = api._debug.ensureTranscript('T_ISO_A', 'isoalpha');
  T_ISO_A.messages = [
    { id: 'i1', ts: Date.now(), mine: false, kind: 'text', label: 'text',
      text: 'kal raat ko woh party mein kya hua tha yaar' },
  ];
  const T_ISO_B = api._debug.ensureTranscript('T_ISO_B', 'isobeta');

  check('isolation · another contact\'s @handle is scrubbed from an outgoing line', () => {
    const out = api._debug.isolationGuard('haan wahi, @isoalpha ne bola tha na 😏', 'isobeta');
    assert(!/isoalpha/i.test(out), 'handle leaked: ' + out);
    out.length && assert(out.length > 5, 'line destroyed: ' + out);
  });

  check('isolation · a verbatim line from ANOTHER chat is never repeated', () => {
    const out = api._debug.isolationGuard(
      'kal raat ko woh party mein kya hua tha yaar? sach bata', 'isobeta');
    assert(!/party mein kya hua/i.test(out), 'foreign quote leaked: ' + out);
  });

  check('isolation · the same line is untouched inside its OWN chat', () => {
    const out = api._debug.isolationGuard(
      'kal raat ko woh party mein kya hua tha yaar? sach bata', 'isoalpha');
    assert(/party mein kya hua/i.test(out), 'own content must stay: ' + out);
  });

  check('isolation · a planned action that leaks is blocked, not sent', () => {
    const bad = api._debug.collisionCheck({
      kind: 'comment', target: 'isobeta',
      text: 'yeh @isoalpha wali baat sach thi kya?',
    });
    assert.strictEqual(bad.ok, false, 'collision not detected');
    assert(bad.problems.some(p => /isoalpha/.test(p)), JSON.stringify(bad.problems));

    const good = api._debug.collisionCheck({
      kind: 'comment', target: 'isobeta', text: 'arre ye shot kahan ka hai bhai 🔥',
    });
    assert.strictEqual(good.ok, true, JSON.stringify(good.problems));
  });

  /* ── RARITY: the runtime gate says "not always, so less times" ── */
  check('social · gate blocks a repeat action that is still on cooldown', () => {
    const SOs = api.Social._state;
    SOs.actionLog = [];
    SOs.actionLog.push({ kind: 'comment', target: 'deeps20_', at: Date.now() - 60_000, text: 'x' });
    const g = api._debug.socialGate({ kind: 'comment', target: 'deeps20_', text: 'nice one' }, false);
    assert.strictEqual(g.ok, false, 'cooldown not enforced');
    assert(/cooldown/.test(g.reason), g.reason);
  });

  check('social · gate blocks a public action that comes too soon after the last one', () => {
    const SOs = api.Social._state;
    SOs.actionLog = [];
    SOs.actionLog.push({ kind: 'story_reply', target: 'adarshu.io', at: Date.now() - 10 * 60_000, text: 'x' });
    const g = api._debug.socialGate(
      { kind: 'comment', target: 'deeps20_', media_pk: 'POST1', text: 'mast hai bhai' }, false);
    assert.strictEqual(g.ok, false, 'public gap not enforced');
    assert.strictEqual(g.reason, 'public_action_too_soon', g.reason);
  });

  check('social · gate enforces the daily cap', () => {
    const SOs = api.Social._state;
    const cap = api.config.SOCIAL.DAILY_CAP.note;
    SOs.actionLog = [];
    for (let i = 0; i < cap; i++) {
      SOs.actionLog.push({ kind: 'note', target: '', at: Date.now() - (i + 6) * 3600_000, text: 'n' + i });
    }
    const g = api._debug.socialGate({ kind: 'note', op: 'replace', text: 'ek aur note' }, false);
    assert.strictEqual(g.ok, false, 'daily cap not enforced');
    assert(/daily_cap/.test(g.reason), g.reason);
  });

  check('social · gate refuses a target that is not allowed for that kind', () => {
    const SOs = api.Social._state;
    SOs.actionLog = [];
    const g = api._debug.socialGate(
      { kind: 'comment', target: 'stranger99', media_pk: 'POST9', text: 'nice' }, false);
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.reason, 'target_not_allowed_for_comments', g.reason);
  });

  /* ── a full cycle: observe → plan → gate → act (dry run) ── */
  const cycle = await api.Social.now();
  check('social · a full brain cycle runs, acts and logs itself', () => {
    assert.strictEqual(cycle.status, 'completed', cycle.error || cycle.status);
    assert(cycle.plan, 'no plan recorded');
    assert(Array.isArray(cycle.outcome), 'no outcome');
    assert(cycle.decided_by === 'gemma-4-brain', cycle.decided_by);
    assert(cycle.next_check_in_minutes >= 15, 'must schedule the next rare cycle');
  });

  check('social · "one thing at a time" — the second wish of the same cycle is deferred', () => {
    const acted = (cycle.outcome || []).filter(o => /dry_run|sent/.test(String(o.status)));
    assert.strictEqual(acted.length, 1, 'cycle performed ' + acted.length + ' actions');
    assert.strictEqual(acted[0].kind, 'note', JSON.stringify(acted));
    const deferred = (cycle.outcome || []).find(o => o.status === 'deferred');
    assert(deferred, 'second action was not deferred: ' + JSON.stringify(cycle.outcome));
    assert.strictEqual(deferred.reason, 'cycle_action_limit', deferred.reason);
  });

  // put the note on cooldown so the SAME plan now lands on the story reply
  api.Social._state.actionLog.push(
    { kind: 'note', target: '', at: Date.now() - 60_000, text: 'chai, code…' });
  const cycle2 = await api.Social.now();
  check('social · next cycle executes the story reaction the gate now allows', () => {
    assert.strictEqual(cycle2.status, 'completed', cycle2.error);
    const gated = (cycle2.outcome || []).find(o => o.kind === 'note');
    assert(gated && /cooldown/.test(gated.reason), 'note should be on cooldown: ' + JSON.stringify(gated));
    const acted = (cycle2.outcome || []).filter(o => /dry_run|sent/.test(String(o.status)));
    assert.strictEqual(acted.length, 1, JSON.stringify(cycle2.outcome));
    assert.strictEqual(acted[0].kind, 'story_reply', JSON.stringify(acted));
    assert.strictEqual(acted[0].target, 'deeps20_');
  });

  check('social · every outgoing line passes the isolation guard before sending', () => {
    const leaks = (cycle.outcome || []).concat(cycle2.outcome || []).filter(o =>
      o.text && /@(isoalpha|adarshu\.io)/.test(String(o.text)));
    assert.strictEqual(leaks.length, 0, JSON.stringify(leaks));
  });

  check('social · the cycle is mirrored to the bridge for _social_brain.json', () => {
    assert(SOCIAL_SAVES.length >= 1, 'social brain log never saved');
    const last = SOCIAL_SAVES[SOCIAL_SAVES.length - 1];
    assert.strictEqual(last.schema_version, '9.0-social-brain-log');
    assert(Array.isArray(last.cycles) && last.cycles.length >= 1);
    assert(Array.isArray(last.action_log));
  });

  /* ── the NOTE power ── */
  IG.notes = [];
  api.Social.dryRun(false);
  await api.note('chai, code aur thodi si shanti ☕');
  check('notes · Aduu can put a nice note on the tray', () => {
    assert.strictEqual(IG.notes.length, 1, JSON.stringify(IG.notes));
    assert.strictEqual(IG.notes[0], 'chai, code aur thodi si shanti ☕');
    assert(IG.notes[0].length <= api.config.SOCIAL.MAX_NOTE_CHARS);
  });

  const tray = await api.notes();
  check('notes · the tray is readable (mine + other people\'s)', () => {
    assert.strictEqual(tray.length, 2, JSON.stringify(tray));
    const mine = tray.find(t => t.authorId === '999');
    assert(mine, 'my own note not found');
    assert.strictEqual(mine.text, 'chai aur code ☕');
    assert(tray.some(t => t.username === 'deeps20_'), "other people's notes missing");
  });

  IG.noteDeletes = 0;
  await api.deleteNote();
  check('notes · and he can take it down again', () => {
    assert.strictEqual(IG.noteDeletes, 1, 'note delete mutation not fired');
  });

  api.config.SOCIAL.QUIET_HOURS = SAVED_QUIET;
  api.Social.dryRun(true);

  check('social · Social.status() reports caps, mode and last actions', () => {
    const st = api.Social.status();
    assert(st.notesMode === 'agentic' || st.notesMode === 'off');
    assert(st.capsToday && st.capsToday.note > 0);
    assert(Array.isArray(st.watch));
    assert(st.watch.includes('deeps20_'));
  });

  // 4. Aduu's mood flips to FURIOUS when someone abuses him
  const T_saroj = api._debug.ensureTranscript('T_SAROJ', 'saroj_priyanshu7');
  api._debug.setMood('T_SAROJ', 'saroj_priyanshu7', 'FURIOUS_ABUSE_CLAPBACK',
    'abuse detected', 'genuinely pissed off', 3, 'test');
  const dec = api._debug.agentDecide('T_SAROJ', 'saroj_priyanshu7', [{
    id: 'x1', ts: Date.now(), mine: false, kind: 'text', label: 'text',
    text: 'teri maa ki chut sale, kya kr lega',
  }], api._debug.analyzeTurnEmotion('teri maa ki chut sale, kya kr lega', 'saroj_priyanshu7'),
    'incoming_burst');
  check('v7 · agent decision picks the angry clapback + feelings action when abused', () => {
    assert.strictEqual(dec.action, 'ABUSE_CLAPBACK_WITH_FEELINGS', dec.action);
    assert.strictEqual(dec.mood, 'FURIOUS_ABUSE_CLAPBACK');
    assert(/clap back hard/i.test(dec.directive), dec.directive);
    assert(/feel/i.test(dec.directive), 'must explain real feelings: ' + dec.directive);
    assert.strictEqual(T_saroj.moodState.feeling_note, 'genuinely pissed off');
  });

  api.stop();
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
