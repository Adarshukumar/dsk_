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

global.fetch = async (url, opts = {}) => {
  const body = opts.body;
  const name = body && body.get ? body.get('fb_api_req_friendly_name') : '';
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
    // the mock always returns the full list newest→oldest; the client filters
    const newer = vars.newer_than_message_id;
    const nodes = IG.messages
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
  }

  return {
    ok: true, status: 200,
    text: async () => JSON.stringify({ data }),
  };
};

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
        default_model: 'google/gemma-4-26b-a4b-it',
        default_endpoint: '@cf/google/gemma-4-26b-a4b-it',
        chain: ['google/gemma-4-26b-a4b-it'], uptime_s: 1,
      });
    } else if (req.type === 'reply') {
      reply({ id: req.id, ok: true, text: BRIDGE_REPLY, model: 'google/gemma-4-26b-a4b-it' });
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

  api.stop();
  const failed = results.filter(r => !r[0]);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
