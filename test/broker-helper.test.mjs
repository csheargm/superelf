// PA.req — the one request function to the broker · 与外壳通信的唯一入口
//
// The Matrix Conf app (2026-10-28) wrote its own reply listener as `m => m.pa === 'res'`, reading
// the EVENT instead of e.data, so its first read never resolved and the page stayed blank. Twenty-one
// apps carried their own copy of that code. web/broker.inline.html is the one copy now, placed on
// EVERY served app page by web.mjs. This file: the helper itself (run), the scar as a mutation,
// every committed page carrying it (real web.mjs), and two guards on the apps: no NEW hand-written
// broker (a pinned census), and no listener anywhere that reads `.pa` off the event.
// R11 — searched: "PA.req", "PA_BROKER", "broker.inline", "pa:'req'" — the twenty-one hand-written
//   copies are the census below; no shared one existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-app.mjs';
import { committedApps, execScripts, SYNTHETIC, withServedPages } from './helpers-every-page.mjs';

const FILE = fs.readFileSync(path.join(ROOT, 'web', 'broker.inline.html'), 'utf8');
const HELPER = /<script>([\s\S]*)<\/script>/.exec(FILE)[1];
const MARKER = '<!--PA_BROKER_UI-->';

// The helper alone, with the shell played by the test: `reply(id, r)` is what the shell posts back;
// `event(data)` is any message the page's window receives.
function boot(src = HELPER) {
  const listeners = [], sent = [];
  const ctx = vm.createContext({
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    parent: { postMessage: (m, origin) => sent.push({ ...m, origin }) },
  });
  vm.runInContext(src, ctx);
  const event = (data) => { for (const fn of listeners) fn({ data }); };
  return { PA: ctx.PA, sent, event, reply: (id, r) => event({ pa: 'res', id, ...r }) };
}
const tick = () => new Promise((r) => setImmediate(r));

test('req posts {pa:req, id, kind, …data} to the parent and resolves with the reply that carries its id', async () => {
  const { PA, sent, reply } = boot();
  const p = PA.req('data', { path: 'starred.json' });
  assert.deepEqual(sent, [{ pa: 'req', id: 'pa1', kind: 'data', path: 'starred.json', origin: '*' }]);
  reply('other', { ok: true, text: 'not mine' });
  reply('pa1', { ok: false, code: 'not-found', error: 'not found', text: 'Not found · 未找到' });
  assert.deepEqual(await p, { pa: 'res', id: 'pa1', ok: false, code: 'not-found', error: 'not found', text: 'Not found · 未找到' });
});

test('two requests in flight resolve each with its own reply, in any order; a reply with no waiter is ignored', async () => {
  const { PA, reply, event } = boot();
  const a = PA.req('data', { path: 'a' }), b = PA.req('data', { path: 'b' });
  event({ pa: 'prefs', fontScale: 1.2 });                         // the shell's other messages pass by
  event(null); event('x');
  reply('pa2', { ok: true, text: 'B' });
  reply('pa1', { ok: true, text: 'A' });
  reply('pa1', { ok: true, text: 'again' });                      // already answered: nothing to resolve
  assert.equal((await a).text, 'A'); assert.equal((await b).text, 'B');
});

test('a streaming kind: onEvent per event, resolved on done; without onEvent the events are simply waited through', async () => {
  const { PA, reply } = boot();
  const evs = [];
  const p = PA.req('chat', { message: 'hi' }, (ev) => evs.push(ev));
  reply('pa1', { ok: true, ev: { d: 'he' } }); reply('pa1', { ok: true, ev: { d: 'llo' } });
  let settled = false; p.then(() => { settled = true; }); await tick();
  assert.equal(settled, false, 'not done yet');
  reply('pa1', { ok: true, ev: { d: '' }, done: true });
  assert.equal((await p).done, true);
  assert.deepEqual(evs, [{ d: 'he' }, { d: 'llo' }, { d: '' }]);
  const q = PA.req('chat', { message: 'again' });
  reply('pa2', { ok: true, ev: { d: 'x' } }); reply('pa2', { ok: true, done: true, ev: { d: '' } });
  assert.equal((await q).done, true);
});

test('MUTATION: read the reply off the EVENT (the Matrix Conf bug) and the first test above goes red', async () => {
  const from = 'const m = e.data;';
  assert.ok(HELPER.includes(from), 'mutation target present');
  const { PA, reply } = boot(HELPER.replace(from, 'const m = e;'));
  let settled = false; PA.req('data', { path: 'x' }).then(() => { settled = true; });
  reply('pa1', { ok: true, text: 'A' }); await tick();
  assert.equal(settled, false, 'with the bug the request never resolves: that is the blank page');
});

test('the helper runs once even if its marker appears twice, and keeps the first instance', () => {
  const { PA, sent } = boot(HELPER + '\n' + HELPER);
  PA.req('data', {});
  assert.equal(sent.length, 1); assert.equal(sent[0].id, 'pa1');
});

// ── Served: every committed app page carries it, ahead of the app's own script ─────────────
test('every committed app page gets PA once, ahead of its own script, after PALeave (real web.mjs)', async () => {
  const committed = committedApps();
  await withServedPages([...committed, ...SYNTHETIC('typeof PA.req')], async (served) => {
    for (const { slug } of committed) {
      const html = await served(slug);
      assert.equal(html.includes(MARKER), false, `${slug}: no marker survives`);
      assert.equal(html.split('var PA = PA ||').length - 1, 1, `${slug}: exactly one PA`);
      const scripts = execScripts(html);
      assert.match(scripts[2], /var PALeave = PALeave \|\|/, `${slug}: CONTROL: PALeave third`);
      assert.match(scripts[3], /var PA = PA \|\|/, `${slug}: then PA, before any script of the page's own`);
    }
    for (const slug of ['syn-head-script', 'syn-no-head']) {
      const html = await served(slug);
      const ctx = vm.createContext({ setTimeout, clearTimeout, addEventListener() {}, parent: { postMessage() {} } });
      for (const s of execScripts(html)) vm.runInContext(s, ctx);
      assert.equal(ctx.early, 'function', `${slug}: the page's own script can use it at top level`);
    }
    assert.equal((await served('syn-static')).includes('var PA = PA'), false, 'a page with no script of its own gets nothing');
  });
});

// ── The apps: no new hand-written broker, and no listener that reads the event as the reply ──
// The scripts of a page, comments removed, so a rule is not tripped by prose about it.
const codeOnly = (html) => execScripts(html).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const HAND_WRITTEN = /postMessage\(\s*(?:Object\.assign\(\s*)?\{\s*pa\s*:\s*['"]req['"]/;
// The twenty-one that predate PA.req (TODO: move each to PA.req and shrink this list; an app's own
// copy is the defect). A slug added here needs that reason; a NEW app uses PA.req.
const CENSUS = [
  'ex-bible', 'ex-diabetes', 'ex-longevity', 'ex-notes', 'ex-tasks',
  'sh-bible', 'sh-notes', 'sh-productivity-hub',
  'ws-allergy', 'ws-bible', 'ws-bible-values', 'ws-brainstorm', 'ws-daily-digest', 'ws-diabetes', 'ws-family',
  'ws-longevity', 'ws-matrix-conf', 'ws-notes', 'ws-productivity-hub', 'ws-rental-hunt', 'ws-tasks',
];
test('no app beyond the pinned census posts to the broker itself: a new app uses PA.req', () => {
  const found = committedApps().filter(({ html }) => HAND_WRITTEN.test(codeOnly(html))).map(({ slug }) => slug).sort();
  const extra = found.filter((s) => !CENSUS.includes(s));
  assert.deepEqual(extra, [], `these apps write their own broker call — use PA.req (superelf.md "Broker API"): ${extra.join(', ')}`);
  assert.ok(found.length >= 10, `CONTROL: the census is real, not vacuous (R14): ${found.length} found`);
});

// A 'message' handler whose parameter is read as the reply: `m => { if (m.pa` or `function h(m){ if(m.pa`.
// The parameter is the EVENT; only `.data` is the reply.
const EVENT_AS_REPLY = /(?:\(\s*(\w+)\s*\)|(\w+))\s*=>\s*\{?\s*(?:const|let|var)?[^;{}]*?\bif\s*\(\s*(?:\1|\2)\s*(?:&&\s*(?:\1|\2))?\.pa\b|function\s*\w*\s*\(\s*(\w+)\s*\)\s*\{\s*if\s*\(\s*\3\.pa\b/;
test('no app reads the reply off the message EVENT (the Matrix Conf bug), in any listener', () => {
  const bad = committedApps().filter(({ html }) => EVENT_AS_REPLY.test(codeOnly(html))).map(({ slug }) => slug);
  assert.deepEqual(bad, [], 'a listener parameter is the event; the reply is e.data');
  // CONTROL (R14): the rule catches the line as Matrix Conf shipped it, and lets the fixed line by.
  assert.match("const handler = m => { if (m.pa==='res'&&m.id===id) { res(m); } };", EVENT_AS_REPLY);
  assert.doesNotMatch("const handler = e => { const m = e.data; if (m && m.pa==='res' && m.id===id) { res(m); } };", EVENT_AS_REPLY);
  assert.doesNotMatch("window.addEventListener('message',e=>{ const m=e.data; if(m&&m.pa==='res'&&_wait[m.id]){ _wait[m.id](m); } });", EVENT_AS_REPLY);
});
