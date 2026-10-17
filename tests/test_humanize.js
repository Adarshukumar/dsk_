#!/usr/bin/env node
/* Offline tests for the page-side bot: humanizer, config, state migration.
 *
 *   node tests/test_humanize.js
 *
 * The bot is a DevTools console script, so we boot it with tiny browser stubs.
 */
'use strict';

const assert = require('assert');
const path = require('path');

/* ── browser stubs ─────────────────────────────────────────────────────── */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
/* an install from the llama era: old persona + old model must NOT win */
store.ig_agent_state_v3 = JSON.stringify({
  systemPrompt: 'OLD STALE PERSONA — you are a customer support bot',
  model: 'meta/llama-3.3-70b-instruct-fp8-fast',
  targets: ['someone'],
  dryRun: true,
});
global.document = { cookie: '', querySelectorAll: () => [] };
global.window = {};

require(path.join(__dirname, '..', 'ig-agent-chat.js'));
const api = global.window.IGAgent;
assert(api, 'IGAgent failed to load');

const h = api._debug.humanizeReply;
const check = (name, fn) => {
  fn();
  console.log(`  ✅ ${name}`);
};

console.log('\nIG-Agent humanizer / config tests\n');

check('config · gemma-4 is the model', () => {
  assert.strictEqual(api.config.MODEL, 'google/gemma-4-26b-a4b-it');
  assert.strictEqual(api.config.HUMANIZE, true);
  assert.strictEqual(api.config.MAX_REPLY_CHARS, 300);
});

check('state · stale persona + llama model ignored', () => {
  assert(!/OLD STALE PERSONA/.test(api.config.SYSTEM_PROMPT),
    'old cached persona overrode the new default');
  assert.strictEqual(api.config.MODEL, 'google/gemma-4-26b-a4b-it');
  // targets/dryRun are still restored — only persona/model are versioned
  assert.deepStrictEqual(api.config.TARGETS, ['someone']);
  assert.strictEqual(api.config.DRY_RUN, true);
});

check('persona · Aduu voice anchors present', () => {
  const p = api.config.SYSTEM_PROMPT;
  assert(/Aduu/.test(p));
  assert(/Hinglish/.test(p));
  assert(/VOICE ANCHORS/.test(p));
  assert(/never claim to be human/i.test(p));
  assert(!/meta-llama|llama-3/i.test(p), 'persona mentions the old model');
});

check('humanize · markdown, bullets, quotes', () => {
  const out = h('**Hey!**\n\n- *kya haal* hai?\n- "bata na"');
  assert.strictEqual(out, 'Hey! kya haal hai? bata na');
});

check('humanize · strips reasoning leak + label', () => {
  assert.strictEqual(h('Aduu: <think>internal notes</think> haan bro 😄'), 'haan bro 😄');
  assert.strictEqual(h('<thinking>x</thinking> arre sun'), 'arre sun');
});

check('humanize · one paragraph, no code fences', () => {
  const out = h('```\nhaan bhai\n```\nphir batao');
  assert(!out.includes('`') && !out.includes('\n'), out);
});

check('humanize · long reply cut at a sentence', () => {
  const out = h('Arre waah, ye toh mast hai bhai. '.repeat(20));
  assert(out.length <= 300, 'length ' + out.length);
  assert(/[.!?…]$/.test(out), 'cut mid-sentence: ' + out.slice(-20));
});

check('humanize · Devanagari untouched', () => {
  const out = h('अरे भाई, क्या हाल है? 😄');
  assert.strictEqual(out, 'अरे भाई, क्या हाल है? 😄');
});

check('humanize · stutter de-duplication', () => {
  assert.strictEqual(h('haan haan haan bro'), 'haan bro');
});

check('repeat detector · catches an echo', () => {
  const msgs = [{ mine: true, kind: 'text', text: 'haan bro' }];
  assert.strictEqual(api._debug.looksRepeated('Haan bro!', msgs), true);
  assert.strictEqual(api._debug.looksRepeated('naya line hai', msgs), false);
});

check('targets() · no silent auto-start', () => {
  api.targets('someone_else');
  assert.strictEqual(api._debug.S.running, false);
  assert.deepStrictEqual(api.config.TARGETS, ['someone_else']);
});

check('prompt() · custom persona persists', () => {
  api.prompt('my custom persona');
  const saved = JSON.parse(store.ig_agent_state_v3);
  assert.strictEqual(saved.customPrompt, true);
  assert.strictEqual(saved.systemPrompt, 'my custom persona');
});

console.log('\n12 passed, 0 failed\n');
