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
let PASS = 0, FAILN = 0;
const check = (name, fn) => {
  try { fn(); PASS++; console.log(`  ✅ ${name}`); }
  catch (e) { FAILN++; console.log(`  ❌ ${name} — ${e.message}`); }
};

console.log('\nIG-Agent humanizer / config tests\n');

check('config · Gemma-4 brain decides + GLM-4.7-Flash writes', () => {
  assert.strictEqual(api.config.MODEL, '@cf/zai-org/glm-4.7-flash');
  assert.strictEqual(api.config.BRAIN_MODEL, '@cf/google/gemma-4-26b-a4b-it');
  assert.strictEqual(api.config.BRAIN_DECIDES, true, 'v8: the brain must be the decision maker');
  assert.strictEqual(api.config.FAST_THINK, true);          // minimal thinking
  assert.strictEqual(api.config.PROACTIVE_ENABLED, true);
  assert.strictEqual(api.config.UNCONDITIONAL_IDLE_STARTER, false, 'must NOT blind-spam a dead chat');
  assert.strictEqual(api.config.PRIVACY_WALL, true);
  assert.strictEqual(api.config.HUMANIZE, true);
  assert.strictEqual(api.config.MAX_REPLY_CHARS, 300);
  assert.strictEqual(api.config.PERSONA_VERSION, 9);
});

check('config · v9 SOCIAL BRAIN is off, dry-run, rare and note-aware', () => {
  const S = api.config.SOCIAL;
  assert(S, 'CFG.SOCIAL missing');
  assert.strictEqual(S.ENABLED, false, 'nothing social runs until you enable it');
  assert.strictEqual(S.DRY_RUN, true, 'social actions must be dry-run first');
  assert.strictEqual(S.BRAIN_AUTOPILOT, true, 'the brain must decide by itself');
  assert.strictEqual(S.NOTES_MODE, 'agentic');
  assert.strictEqual(S.MAX_NOTE_CHARS, 60, 'Instagram note limit');
  assert.strictEqual(S.MAX_ACTIONS_PER_CYCLE, 1, 'one thing at a time');
  assert(S.CYCLE_MIN_MS >= 30 * 60_000, 'cycles must be slow (not always)');
  assert(S.DAILY_CAP.comment <= 3 && S.DAILY_CAP.story_reply <= 2, 'public actions capped hard');
  assert(S.COOLDOWN_MS.story_reply >= 12 * 3600_000, 'story replies must be rare');
  assert(Array.isArray(S.QUIET_HOURS));
  return 'off · dry · 1 action/cycle · 45-120min cycles · capped · 60-char notes';
});

check('config · v9 social GraphQL ops are wired', () => {
  assert.strictEqual(api.config.GQL.tray, '29231580869776032');
  assert.strictEqual(api.config.GQL.noteCreate, '28592645767037889');
  assert.strictEqual(api.config.GQL.noteDelete, '28419182984337833');
  assert.strictEqual(api.config.GQL.comment, '27261905640092552');
  assert.strictEqual(api.config.GQL.reelShare, '26212720875066239');
  return 'notes tray · create · delete · comment · story→DM';
});

check('state · stale persona + llama model ignored; default targets active', () => {
  assert(!/OLD STALE PERSONA/.test(api.config.SYSTEM_PROMPT),
    'old cached persona overrode the new default');
  assert.strictEqual(api.config.MODEL, '@cf/zai-org/glm-4.7-flash');
  assert.strictEqual(api.config.BRAIN_MODEL, '@cf/google/gemma-4-26b-a4b-it');
  assert.deepStrictEqual(api.config.DEFAULT_TARGETS, ['adarshu.io', 'deeps20_']);
  assert.deepStrictEqual(api.config.TARGETS, ['adarshu.io', 'deeps20_']);
  assert.strictEqual(api.config.DRY_RUN, false);
});

check('persona · Aduu voice anchors present', () => {
  const p = api.config.SYSTEM_PROMPT;
  assert(/Aduu/.test(p));
  assert(/Hinglish/.test(p));
  assert(/VOICE ANCHORS/.test(p));
  assert(/NEVER/.test(p));
  assert(!/meta-llama|llama-3/i.test(p), 'persona mentions the old model');
});

check('persona · zero AI in the personality', () => {
  const p = api.config.SYSTEM_PROMPT;
  assert(!/\bAI\b/i.test(p), 'persona still contains the word AI');
  assert(!/language model|chatbot|assistant/i.test(p));
  assert(/never break character/i.test(p), 'no stay-in-character rule');
  assert(/never explain what you are/i.test(p), 'no no-self-explanation rule');
  assert(/never talk about how you are made/i.test(p), 'no no-origin rule');
});

check('humanize · slop lexicon stripped', () => {
  const out = h("Certainly! Let's delve into this robust and seamless solution. " +
                "It's important to note that we leverage cutting-edge tools.");
  assert(!/delve|robust|seamless|leverag|cutting-edge|important to note|^Certainly/i.test(out), out);
});

check('humanize · typographic fingerprint normalised', () => {
  const out = h('haan\u2014bilkul \u201cscene kya hai\u201d\u2026 mast');
  assert(!/[\u2014\u2013\u201c\u201d\u2018\u2019\u2026]/.test(out), out);
  assert.strictEqual(out, 'haan, bilkul scene kya hai... mast');
});

check('humanize · invisible + bidi characters removed', () => {
  const out = h('haan\u200b bro\u200f, chal\uFEFFta hai');
  assert(!/[\u200B-\u200F\uFEFF]/.test(out), JSON.stringify(out));
  assert.strictEqual(out, 'haan bro, chalta hai');
});

check('humanize · hashtags and markdown links do not survive', () => {
  assert.strictEqual(h('dekh [yahan](https://x.com) #mood #delhi #vibes'), 'dekh yahan');
});

check('humanize · short reply loses its full stop', () => {
  assert.strictEqual(h('haan bro.'), 'haan bro');
  assert.strictEqual(h('kal milte hai.'), 'kal milte hai');
  assert.strictEqual(h('sach?'), 'sach?');
});

check('score · clean Hinglish beats corporate slop', () => {
  const d = api._debug;
  const human = d.checkDraft('arre yaar, kal milte hai. 7 baje?'),
        robot = d.checkDraft('Certainly! It is a seamless and robust solution — ' +
                             'leveraging cutting-edge paradigms to elevate your journey.');
  assert(human.overall >= 80, 'human draft scored ' + human.overall);
  assert(robot.overall < 55, 'robot draft scored ' + robot.overall);
  assert(robot.tells.includes('em-dash'), robot.tells.join(','));
  assert.deepStrictEqual(Object.keys(human.checks).sort(),
    ['burstiness', 'fingerprint', 'slop', 'specificity', 'voice']);
});

check('bubbles · long reply splits once, short stays whole', () => {
  const d = api._debug;
  assert.deepStrictEqual(d.splitBubbles('haan bro'), ['haan bro']);
  const long = 'arre waah, ye toh mast scene hai bhai. kal milte hai pakka. ' +
               'tab tak tu bata, kya plan hai?';
  const b = d.splitBubbles(long);
  assert.strictEqual(b.length, 2);
  assert(b.every(x => x.length >= 18), JSON.stringify(b));
  assert.strictEqual(b.join(' '), long);
});

check('language · mirroring hint detects the script', () => {
  const d = api._debug;
  assert.strictEqual(d.detectLang('अरे भाई क्या हाल है'), 'devanagari');
  assert.strictEqual(d.detectLang('haan bhai, kal milte hai'), 'hinglish');
  assert.strictEqual(d.detectLang('sure, that sounds good to me'), 'english');
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

check('targets() · batch group set + addTargets + everyone', () => {
  api.targets('http://adarshu.io, @deeps20_  user3', ['user4', 'https://instagram.com/user5/']);
  assert.strictEqual(api._debug.S.running, false);
  assert.deepStrictEqual(api.config.TARGETS, ['adarshu.io', 'deeps20_', 'user3', 'user4', 'user5']);
  // no-arg call returns current targets without wiping
  assert.deepStrictEqual(api.targets(), ['adarshu.io', 'deeps20_', 'user3', 'user4', 'user5']);
  // addTargets appends a group at once without losing existing targets
  api.addTargets('user6, user7', ['user8']);
  assert.deepStrictEqual(api.config.TARGETS,
    ['adarshu.io', 'deeps20_', 'user3', 'user4', 'user5', 'user6', 'user7', 'user8']);
  api.removeTargets('user3, user4, user5, user6, user7, user8');
  assert.deepStrictEqual(api.config.TARGETS, ['adarshu.io', 'deeps20_']);
  api.everyone();
  assert.strictEqual(api.config.TARGETS, 'all');
  api.clearState();
  assert.deepStrictEqual(api.config.TARGETS, ['adarshu.io', 'deeps20_']);
});

check('buildHistory · coalesces consecutive user messages into ONE newline-joined turn', () => {
  const msgs = [
    { id: '1', ts: 1000, mine: true, kind: 'text', label: 'text', text: 'poora naam batao' },
    { id: '2', ts: 2000, mine: false, kind: 'text', label: 'text', text: 'Hyy babyy🌚🌚' },
    { id: '3', ts: 2100, mine: false, kind: 'text', label: 'text', text: 'Itne din se kahan gayab ho' },
    { id: '4', ts: 2200, mine: false, kind: 'text', label: 'text', text: 'Yaad nhi aati meri🤡🤡' },
    { id: '5', ts: 2300, mine: false, kind: 'text', label: 'text', text: 'Jaldi se sorry ka gift bhej with chocolates' },
    { id: '6', ts: 2400, mine: false, kind: 'text', label: 'text', text: 'Hiluuuu biluuu' },
    { id: '7', ts: 2500, mine: false, kind: 'text', label: 'text', text: 'Khaale thoda sa goo' },
  ];
  const hist = api._debug.buildHistory(msgs, 'T_DEEPS', 'deeps20_');
  const sys = hist[0].content;
  assert(sys.includes('CHAT PARTNER: @deeps20_'), 'partner missing');
  assert(sys.includes('YOUR MESSAGE RIGHT BEFORE THEIR REPLY: "poora naam batao"'), 'prev own msg missing');
  assert(sys.includes('THEIR NEWEST UNANSWERED BURST (6 messages merged into one turn):'), 'burst block missing');
  // Roles must strictly be: system, assistant ("poora naam batao"), user (all 6 joined by \n)
  assert.strictEqual(hist.length, 3, 'all 6 user messages must coalesce into 1 user turn');
  assert.strictEqual(hist[1].role, 'assistant');
  assert.strictEqual(hist[1].content, 'poora naam batao');
  assert.strictEqual(hist[2].role, 'user');
  assert.strictEqual(
    hist[2].content,
    'Hyy babyy🌚🌚\n' +
    'Itne din se kahan gayab ho\n' +
    'Yaad nhi aati meri🤡🤡\n' +
    'Jaldi se sorry ka gift bhej with chocolates\n' +
    'Hiluuuu biluuu\n' +
    'Khaale thoda sa goo'
  );
});

check('agent tool · emotion & emoji analyzer + naughty->good-boy coaching', () => {
  const burst =
    'Hyy babyy🌚🌚\nItne din se kahan gayab ho\nYaad nhi aati meri🤡🤡\n' +
    'Jaldi se sorry ka gift bhej with chocolates\nHiluuuu biluuu\nKhaale thoda sa goo';
  const emo = api._debug.analyzeTurnEmotion(burst, 'deeps20_');
  assert(emo.theirMood.includes('flirty-sweet'), 'flirty mood detected');
  assert(emo.theirMood.includes('nakhre-drama'), 'nakhre mood detected');
  assert(emo.theirMood.includes('desi-bakchodi-abuse'), 'desi abuse mood detected');
  assert(emo.emotion.includes('good-boy'), 'good-boy flip in emotion mode');
  assert(emo.emojis.includes('🌚') && emo.emojis.includes('😌'), 'suggested emojis present');
});

check('global memory + cross-chat gossip tool (adarshu.io <-> deeps20_)', () => {
  const gm = api.globalMemory();
  assert(gm.connections.some(c => c.a === 'adarshu.io' && c.b === 'deeps20_'), 'adarshu.io <-> deeps20_ linked by default');
  // Simulate deeps20_ having sent a dramatic message
  const deepsMsgs = [
    { id: 'd1', ts: 3000, mine: false, kind: 'text', label: 'text', text: 'adarsh ko bolna mujhe chocolate chahiye 🍫' },
  ];
  api._debug.syncGlobalMemory('T_DEEPS', 'deeps20_', deepsMsgs, api._debug.analyzeTurnEmotion(deepsMsgs[0].text, 'deeps20_'), 'pakka bol dunga 😌');
  // Now build history for adarshu.io asking what deeps20_ is up to
  const adarshMsgs = [
    { id: 'a1', ts: 4000, mine: false, kind: 'text', label: 'text', text: 'aur bata deeps kya bol rahi thi aaj?' },
  ];
  const hist = api._debug.buildHistory(adarshMsgs, 'T_ADARSH', 'adarshu.io');
  const sys = hist[0].content;
  assert(sys.includes('[GLOBAL MEMORY & SOCIAL GRAPH]'), 'global memory block present');
  assert(sys.includes('[TOOL: cross_chat_gossip_intel]'), 'cross-chat gossip tool block present');
  assert(sys.includes('chocolate chahiye'), 'deeps20_ message surfaced to adarshu.io via gossip tool');
});

check('event-driven anti-ban polling · adaptive idle backoff + instant realtime wake', () => {
  const S = api._debug.S;
  S.idlePolls = 0;
  const activeDelay = api._debug.nextPollDelayMs();
  assert(activeDelay >= 3000 && activeDelay <= 5000, `active delay in 3-5s (got ${activeDelay})`);
  S.idlePolls = 6;
  const idleDelay = api._debug.nextPollDelayMs();
  assert(idleDelay >= 20000, `idle delay backs off to prevent IP block (got ${idleDelay})`);
  api._debug.onRealtimeSignal('ig-ws-push');
  assert.strictEqual(S.idlePolls, 0, 'realtime push signal resets idlePolls immediately');
});

check('agentic engine · time context + autonomous decision + proactive starter', () => {
  const tMorning = api._debug.getTimeContext('2026-10-18T04:00:00Z'); // 9:30 AM IST
  assert.strictEqual(tMorning.slot, 'morning');
  const tNight = api._debug.getTimeContext('2026-10-18T18:00:00Z'); // 11:30 PM IST
  assert.strictEqual(tNight.slot, 'late_night');

  const msgs = [
    { id: '1', ts: 1000, mine: false, kind: 'text', label: 'text', text: 'hmm' },
  ];
  const emo = api._debug.analyzeTurnEmotion('hmm', 'deeps20_');
  const dec = api._debug.agentDecide('T_DEEPS', 'deeps20_', msgs, emo, 'incoming_burst');
  assert.strictEqual(dec.action, 'HARD_TO_GET_TEASE');

  // Ended chat: proactive starter check
  const endedMsgs = [
    { id: '1', ts: 1000, mine: false, kind: 'text', label: 'text', text: 'achha chalo baad mein baat karte' },
    { id: '2', ts: 2000, mine: true, kind: 'text', label: 'text', text: 'chal thik hai, gayab mat ho jana 😌' },
  ];
  // TASK-DRIVEN: an idle timer alone must NOT start a conversation (no blind 30m spam)
  const T = api._debug.ensureTranscript('T_PRO', 'deeps20_');
  T.reminders = [];
  T.agentState.chat_ended_at = Date.now() - 60 * 60_000;
  T.agentState.next_proactive_after = Date.now() - 1000;
  const idleOnly = api._debug.shouldStartProactiveConvo('T_PRO', 'deeps20_', endedMsgs, false);
  assert.strictEqual(idleOnly.ok, false,
    'Aduu must NOT restart a dead chat just because time passed — needs a reminder or mission');

  // A DUE REMINDER must start it
  api._debug.addReminder('T_PRO', 'deeps20_', 'baat karte hai', 10, 'test');
  T.reminders.forEach(r => { r.due_at = Date.now() - 1000; });
  const pro = api._debug.shouldStartProactiveConvo('T_PRO', 'deeps20_', endedMsgs, false);
  assert.strictEqual(pro.ok, true, 'a due reminder must trigger the starter');
  assert.strictEqual(pro.trigger, 'reminder_due_trigger');
  const proHist = api._debug.buildProactiveHistory(endedMsgs, 'T_PRO', 'deeps20_', pro);
  assert(proHist[0].content.includes('[TASK: REMINDER DUE NOW]'), 'reminder task block missing');
  api._debug.consumeReminder('T_PRO', 'deeps20_', pro.reminder);

  // A SECRET CROSS-CHAT MISSION must start it
  api._debug.addMission('T_OTHER', 'deeps20_', {
    target_user: 'deeps20_', type: 'prank',
    instruction: 'tease them', requested_by: 'adarshu.io', requested_at: Date.now(),
  });
  const msnPro = api._debug.shouldStartProactiveConvo('T_PRO', 'deeps20_', endedMsgs, false);
  assert.strictEqual(msnPro.ok, true, 'a pending mission must trigger the starter');
  assert.strictEqual(msnPro.trigger, 'cross_chat_mission_trigger');
  const msnHist = api._debug.buildProactiveHistory(endedMsgs, 'T_PRO', 'deeps20_', msnPro);
  assert(msnHist[0].content.includes('PRIVACY WALL'), 'mission privacy wall missing');
  assert(msnHist[0].content.includes('[TASK: SECRET CROSS-CHAT PRANK MISSION]'), 'prank task block missing');
  api._debug.consumeMission(msnPro.mission);
});

check('v7 · mood engine · Aduu gets angry when abused (no more always-sharif)', () => {
  const d = api._debug;
  assert.strictEqual(d.detectLocalMood('teri maa ki chut sale, kya kr lega'), 'FURIOUS_ABUSE_CLAPBACK');
  assert.strictEqual(d.detectLocalMood('fuck off, chup ho ja'), 'ANGRY_SAVAGE_ROAST');
  assert.strictEqual(d.detectLocalMood('hi baby 🌚 miss you'), 'NAUGHTY_FLIRT_SHARIF');
  assert.strictEqual(d.detectLocalMood('kya haal hai bhai'), 'PLAYFUL_CHILL');
  assert(d.MOODS.FURIOUS_ABUSE_CLAPBACK.directive.includes('DROP'), 'furious mood must drop the sharif act');
  assert(d.MOODS.ANNOYED_EXPRESSIVE_FEELINGS.directive.includes('feeling'), 'annoyed mood must express feelings');
  const T = d.ensureTranscript('T_MOOD', 'saroj_priyanshu7');
  d.setMood('T_MOOD', 'saroj_priyanshu7', 'FURIOUS_ABUSE_CLAPBACK', 'test', 'genuinely pissed off', 3, 'test');
  assert.strictEqual(T.moodState.current_mood, 'FURIOUS_ABUSE_CLAPBACK');
  assert.strictEqual(T.moodState.mood_intensity, 3);
  assert.strictEqual(T.moodState.feeling_note, 'genuinely pissed off');
});

check('v7 · reminder engine · "10 min mein baat karte hai" schedules a real trigger', () => {
  const d = api._debug;
  const r1 = d.extractReminderRequests('chal 10 min mein baat karte hai, yaad dila dena');
  assert.strictEqual(r1.length, 1, 'reminder not extracted');
  assert.strictEqual(r1[0].due_in_minutes, 10);
  const r2 = d.extractReminderRequests('baad mein baat karte hai');
  assert(r2.length >= 1, 'open-ended "baad mein" must still schedule the default window');
  const r3 = d.extractReminderRequests('kya haal hai bhai');
  assert.strictEqual(r3.length, 0, 'a normal message must NOT schedule a reminder');
});

check('v7 · cross-chat prank/relay mission + privacy wall', () => {
  const d = api._debug;
  const ms = d.extractCrossChatMissions('adarshu.io ko bol do ki main chocolate nahi dunga', 'deeps20_');
  assert.strictEqual(ms.length, 1, 'mission not extracted');
  assert.strictEqual(ms[0].target_user, 'adarshu.io');
  assert.strictEqual(ms[0].requested_by, 'deeps20_');
  const m = d.addMission('T_DEEPS', 'deeps20_', ms[0]);
  assert(d.pendingMissionFor('adarshu.io'), 'mission not queued for the target');
  // talking to a third person: every other handle + private quote must be scrubbed
  const guarded = d.privacyGuard(
    '@deeps20_ ne @adarshu.io ke baare mein "bola ki tu aa raha hai" kaha', 'saroj_priyanshu7');
  assert(!/@adarshu\.io/.test(guarded), 'handle leaked: ' + guarded);
  assert(!/@deeps20_/.test(guarded), 'handle leaked: ' + guarded);
  assert(!/bola ki tu aa raha hai/.test(guarded), 'private quote leaked: ' + guarded);
  // but the person we are ACTUALLY talking to may be named normally
  const ok = d.privacyGuard('haan @saroj_priyanshu7 sun', 'saroj_priyanshu7');
  assert(/@saroj_priyanshu7/.test(ok), 'own chat partner should not be scrubbed: ' + ok);
  d.consumeMission(m);
  assert(!d.pendingMissionFor('adarshu.io'), 'mission not consumed');
});

check('v7 · logical 2-3 bubble continuity (no blind appending)', () => {
  const b = api._debug.splitBubbles(
    'abey sun, aukaat mein reh ke baat kar || sach mein dimaag kharab kar diya tune mera');
  assert.strictEqual(b.length, 2, 'expected 2 logical bubbles, got ' + b.length);
  assert(/aukaat/.test(b[0]) && /dimaag kharab/.test(b[1]), JSON.stringify(b));
  // a single short reply stays ONE bubble
  const one = api._debug.splitBubbles('haan bhai, thik hai');
  assert.strictEqual(one.length, 1);
});

check('prompt() · custom persona persists', () => {
  api.prompt('my custom persona');
  const saved = JSON.parse(store.ig_agent_state_v3);
  assert.strictEqual(saved.customPrompt, true);
  assert.strictEqual(saved.systemPrompt, 'my custom persona');
});

console.log(`\n${PASS} passed, ${FAILN} failed\n`);
process.exit(FAILN ? 1 : 0);
