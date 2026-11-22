// The 信纸 studio under load · busy guard, run token, bounded AI wait, cancel, picture memory
// (web/stationery-picker.inline.html + web/stationery-studio.inline.html, loaded from the SHIPPED files)
//
// Each test here is a defect a review found by driving the real Journal page in Chromium:
//   · a second Design tap started a second AI turn, and the last answer to arrive overwrote the draft;
//   · an answer that never ended left "Working…" up for good;
//   · "Use as background" kept a ~34 MB and a ~50 MB canvas alive and read 8.4M pixels in one copy.
// And one measured with the real CLI (2026-10-12): the 5-minute give-up was a Promise.race that
// cancelled nothing, so the model ran on (and retries piled up) after the page had stopped waiting.
// Every turn now hands the channel an AbortSignal that the timeout, reset, a newer run and Cancel abort.
// Fidelity (R14): the picker runs against a minimal DOM (FakeEl) whose disabled buttons ignore
// clicks, as a browser's do; the AI is a fake channel with the host's signature; time is node:test's
// mock clock (setTimeout, setInterval, Date), so minutes pass without waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadStationery, loadStudio, mountStudio, loadComplete, fakePhoto, fakeCanvasDoc, svg } from './helpers-stationery.mjs';

const GOOD = svg('<rect width="816" height="1056" fill="#fffaf2"/><circle cx="60" cy="60" r="30" fill="#f2b8c6"/>');
const studio = (opts) => { const S = loadStationery(); return { S, ST: loadStudio(S, opts) }; };

test('a webp/gif is scanned for transparency in BANDS: alpha -> PNG, opaque -> JPEG; canvases released', async () => {
  const doc = fakeCanvasDoc({ alpha: true }), photo = fakePhoto(); const { ST } = studio({ document: doc, photo });
  const ok = async () => ({ ok: true, path: 'uploads/w' });
  const r = await ST.importPicture(ok, { name: 's.webp', type: 'image/webp', w: 3000, h: 4000 });
  assert.equal(r.png, true, 'the transparent pixel at the very end was found');
  const reads = doc.made[0].reads;
  assert.ok(reads.length > 1 && reads.every(([, h]) => h * 2550 <= (1 << 20)), 'many reads of <= 1M px, never one 8.4M-px copy');
  assert.equal(reads.reduce((n, [, h]) => n + h, 0), 3300, 'together they cover every row');
  assert.equal(doc.made[0].width, 0);
  const doc2 = fakeCanvasDoc(); const { ST: ST2 } = studio({ document: doc2 });
  assert.equal((await ST2.importPicture(ok, { name: 's.webp', type: 'image/webp', w: 900, h: 1200 })).png, false);
  assert.equal(doc2.made[0].encoded.type, 'image/jpeg');
  // the encode itself fails (Safari out of canvas memory): a named reason, and the canvases still released
  const doc3 = fakeCanvasDoc(); const make = doc3.createElement;
  doc3.createElement = (t) => { const c = make(t); c.toDataURL = () => { throw new Error('encode failed'); }; return c; };
  const photo3 = fakePhoto(); const { ST: ST3 } = studio({ document: doc3, photo: photo3 });
  const r3 = await ST3.importPicture(ok, { name: 'p.jpg', type: 'image/jpeg', w: 900, h: 1200 });
  assert.equal(r3.ok, false); assert.match(r3.reason, /encode failed/);
  assert.deepEqual([doc3.made[0].width, photo3.sources[0].width], [0, 0], 'released on the failure path too');
});
test('MUTATION: without the release, the 2550x3300 canvas stays allocated after the import', async () => {
  const doc = fakeCanvasDoc(); const { ST } = studio({ document: doc, mutate: (s) => s.replace('}finally{ c.width=0; if(src.canvas) src.canvas.width=0; }', '}finally{ }') });
  await ST.importPicture(async () => ({ ok: true, path: 'u' }), { name: 'p.png', type: 'image/png', w: 3000, h: 4000 });
  assert.equal(doc.made[0].width, 2550);
});
test('an AI answer that never ends becomes a NAMED failure, not an endless "Working…"', async () => {
  const ST = loadStudio(loadStationery(), { mutate: (s) => s.replace('const AI_WAIT_MS=5*60*1000;', 'const AI_WAIT_MS=30;') });
  const r = await ST.design(() => new Promise(() => {}), 'dots');
  assert.equal(r.ok, false); assert.match(r.reason, /AI request failed/); assert.match(r.reason, /no answer after/);
});
// ── The picker's user flow: one Design tap = one AI turn ────────────────────────────────────
// Probe (Chromium, the real Journal page) before the fix: the Design button stayed ENABLED while
// "Working…" showed, so a second tap started a second AI turn and the last answer to arrive won.
// The fixture is mountStudio (test/helpers-stationery.mjs): the picker mounted with its studio.
test('picker: while a design is in flight every studio control is off — a double tap is ONE AI turn', async () => {
  const { host, pending, btn } = mountStudio();
  btn('✨').click(); btn('Design ·').click(); btn('Design ·').click();
  assert.equal(pending.length, 1, 'the second tap did nothing');
  for (const t of ['Design ·', '✨', '🖼', 'Recreate']) assert.equal(btn(t).disabled, true, `${t} is disabled while working`);
  pending[0].res({ ok: true, text: GOOD, convoId: 'c1' }); await new Promise((r) => setTimeout(r, 5));
  assert.equal(btn('Design ·').disabled, false, 'and back on once the answer is in');
  assert.ok(host.querySelectorAll('canvas').some((c) => c.classList.contains('pst-prev') && c.classList.contains('on')), 'the draft is shown');
});
test('MUTATION: without guarding the panels, the second tap starts a second AI turn', () => {
  const { pending, btn } = mountStudio((s) => s.replace(' d.guard(tools,ai,pic);', ''));
  btn('✨').click(); btn('Design ·').click(); btn('Design ·').click();
  assert.equal(pending.length, 2);
  for (const p of pending) p.res({ ok: false, error: 'done' });   // answered: no 5-minute wait timer left behind
});
// ── Stopping a turn: the timeout, reset, a newer run and Cancel ABORT the channel's signal ────
const WAIT = 5 * 60 * 1000;   // the studio's AI_WAIT_MS, unmutated: the mock clock makes 5 minutes free
const CANCELLED = 'Cancelled · 已取消';
const TIMED_OUT = 'AI request failed · AI 请求失败 — no answer after 5 minutes · 超时未回答';
const flush = () => new Promise((r) => setImmediate(r));   // setImmediate is not mocked: it drains the promises
const clock = (t, apis = ['setTimeout', 'setInterval', 'Date']) => t.mock.timers.enable({ apis, now: 0 });
const never = (seen) => (m, o) => { seen.push(o.signal); return new Promise(() => {}); };

test('every AI turn hands the channel an AbortSignal: design, tweak and recreate', async () => {
  const ST = loadStudio(loadStationery(), { document: fakeCanvasDoc() }); const seen = [];
  const ai = async (m, o) => { seen.push(o.signal); return { ok: true, text: GOOD, convoId: 'c1' }; };
  await ST.design(ai, 'dots'); await ST.tweak(ai, GOOD, 'bluer', { convoId: 'c1' });
  await ST.recreate(ai, async () => ({ ok: true, path: 'uploads/p' }), { name: 'p.png', type: 'image/png', w: 900, h: 1200 }, '');
  assert.equal(seen.length, 3);
  for (const sig of seen) { assert.ok(sig instanceof AbortSignal); assert.equal(sig.aborted, false, 'a turn that answered is never aborted'); }
  assert.equal(new Set(seen).size, 3, 'each turn has its own');
});
test("the caller's signal reaches the channel: aborting it ends the turn as Cancelled; already aborted = no turn", async () => {
  const { ST } = studio(); const seen = []; const ac = new AbortController();
  const p = ST.design(never(seen), 'dots', { signal: ac.signal });
  assert.notEqual(seen[0], ac.signal, 'the channel gets the studio’s own signal, which the timeout can abort too');
  ac.abort();
  assert.equal(seen[0].aborted, true, 'the caller’s abort reached the channel');
  assert.deepEqual(await p, { ok: false, convoId: null, reason: CANCELLED }, 'Cancelled — not "AI request failed"');
  let asked = 0;
  assert.equal((await ST.design(() => { asked++; }, 'dots', { signal: ac.signal })).reason, CANCELLED);
  assert.equal(asked, 0, 'an already-aborted turn never reaches the channel');
});
test('AI_WAIT_MS ABORTS the channel’s signal — the server job stops — and names the timeout', async (t) => {
  clock(t, ['setTimeout']);
  const { ST } = studio(); const seen = [];
  const p = ST.design(never(seen), 'dots');
  t.mock.timers.tick(WAIT - 1); await flush();
  assert.equal(seen[0].aborted, false, 'not one millisecond early');
  t.mock.timers.tick(1);
  assert.equal(seen[0].aborted, true);
  assert.equal((await p).reason, TIMED_OUT);
});
test('MUTATION: without the abort, the timeout and the caller only stop WAITING — the channel’s turn runs on', async (t) => {
  clock(t, ['setTimeout']);
  const ST = loadStudio(loadStationery(), { mutate: (s) => s.replace('no(new Error(why)); ac.abort();', 'no(new Error(why));') });
  const seen = [], ac = new AbortController();
  const p1 = ST.design(never(seen), 'dots'), p2 = ST.design(never(seen), 'dots', { signal: ac.signal });
  ac.abort(); await flush(); t.mock.timers.tick(WAIT);
  assert.equal((await p1).reason, TIMED_OUT, 'the page still gives up on time …');
  assert.equal((await p2).reason, CANCELLED);
  assert.deepEqual(seen.map((sig) => sig.aborted), [false, false], '… but nothing tells the server to stop');
});

test('picker: while the AI works the message counts the time, and Cancel is the one control left on', async (t) => {
  clock(t);
  const { pending, btn, say, drawn } = mountStudio();
  btn('✨').click();
  assert.equal(btn('Cancel ·').style.display, 'none', 'no Cancel while nothing is in flight');
  btn('Design ·').click();
  assert.equal(say(), 'Working… 0:00 · 处理中…');
  t.mock.timers.tick(72000);
  assert.equal(say(), 'Working… 1:12 · 处理中…', 'it advances each second');
  assert.equal(btn('Cancel ·').style.display, ''); assert.equal(btn('Cancel ·').disabled, false, 'the busy guard leaves Cancel on');
  assert.equal(btn('Design ·').disabled, true);
  pending[0].res({ ok: true, text: GOOD, convoId: 'c1' }); await flush();
  assert.equal(drawn(), true); assert.equal(say(), '', 'the answer ends the count');
  t.mock.timers.tick(5000);
  assert.equal(say(), '', 'and the ticker stopped with it');
  assert.equal(btn('Cancel ·').style.display, 'none');
});
test('picker: Cancel aborts the turn, ends busy, says Cancelled, offers Try again; a late answer paints nothing', async (t) => {
  clock(t);
  const { pending, btn, msg, say, drawn } = mountStudio();
  btn('✨').click(); btn('Design ·').click(); t.mock.timers.tick(3000);
  const sig = pending[0].o.signal;
  assert.ok(sig instanceof AbortSignal); assert.equal(sig.aborted, false);
  btn('Cancel ·').click(); await flush();
  assert.equal(sig.aborted, true, 'the channel saw it: PAChat.complete sends chat-cancel, the server kills the model');
  assert.equal(say(), CANCELLED); assert.equal(msg.classList.contains('err'), true);
  assert.equal(btn('Design ·').disabled, false, 'busy is over');
  assert.equal(btn('Try again ·').style.display, ''); assert.equal(btn('Cancel ·').style.display, 'none');
  t.mock.timers.tick(5000);
  assert.equal(say(), CANCELLED, 'the clock stopped: it does not paint over the reason');
  pending[0].res({ ok: true, text: GOOD, convoId: 'c1' }); await flush();
  assert.equal(drawn(), false, 'the late answer paints nothing'); assert.equal(say(), CANCELLED);
  btn('Try again ·').click();
  assert.equal(pending.length, 2); assert.equal(pending[1].o.signal.aborted, false, 'Try again is a fresh turn with a live signal');
  assert.equal(say(), 'Working… 0:00 · 处理中…', 'counted from its own start');
  pending[1].res({ ok: true, text: GOOD, convoId: 'c2' }); await flush();
  assert.equal(drawn(), true);
});
test('picker: after AI_WAIT_MS the turn is aborted and the timeout is the message, with Try again', async (t) => {
  clock(t);
  const { pending, btn, say } = mountStudio();
  btn('✨').click(); btn('Design ·').click();
  t.mock.timers.tick(WAIT - 1000); await flush();
  assert.equal(pending[0].o.signal.aborted, false); assert.equal(say(), 'Working… 4:59 · 处理中…');
  t.mock.timers.tick(1000); await flush();
  assert.equal(pending[0].o.signal.aborted, true, 'the server job is told to stop, not just abandoned');
  assert.equal(say(), TIMED_OUT);
  assert.equal(btn('Try again ·').style.display, ''); assert.equal(btn('Cancel ·').style.display, 'none');
  assert.equal(btn('Design ·').disabled, false);
  t.mock.timers.tick(5000); assert.equal(say(), TIMED_OUT, 'the ticker stopped');
});
test('picker: a reset and a newer run each abort the turn in flight', async (t) => {
  clock(t);
  // reset: the panel's toggle, forced past the busy guard (the guard keeps it off in use)
  const a = mountStudio();
  a.btn('✨').click(); a.btn('Design ·').click();
  a.btn('✨').disabled = false; a.btn('✨').click(); await flush();
  assert.equal(a.pending[0].o.signal.aborted, true, 'reset aborted it');
  // a newer run with no reset in between: a second Tweak, forced past the guard
  const b = mountStudio();
  b.btn('✨').click(); b.btn('Design ·').click(); b.pending[0].res({ ok: true, text: GOOD, convoId: 'c1' }); await flush();
  b.host.querySelectorAll('input').find((i) => String(i.placeholder).startsWith('What to change')).value = 'blue dots';
  b.btn('Tweak ·').click(); b.btn('Tweak ·').disabled = false; b.btn('Tweak ·').click(); await flush();
  assert.equal(b.pending.length, 3);
  assert.deepEqual(b.pending.slice(1).map((p) => p.o.signal.aborted), [true, false], 'the older tweak was aborted, the newer is live');
  assert.equal(b.say(), 'Working… 0:00 · 处理中…', 'and its ticker is the newer run’s');
});
// The whole Journal path, picker -> studio -> PAChat.complete (chat-ui's own source, over the real broker
// head), wired exactly as the Journal's host line is. The shell here never answers: the job runs on.
test('Journal path: Cancel posts ONE chat-cancel naming the one-shot chat request, and the page says Cancelled', async (t) => {
  clock(t);
  const { complete, posted } = loadComplete(() => {});
  const { btn, say } = mountStudio(undefined, undefined, (message, o) => complete(message, o));
  btn('✨').click(); btn('Design ·').click(); await flush();
  assert.deepEqual(posted.map((m) => [m.kind, m.oneShot]), [['chat', true]], 'one turn, sent as oneShot');
  btn('Cancel ·').click(); await flush();
  assert.deepEqual(posted.map((m) => m.kind), ['chat', 'chat-cancel']);
  assert.equal(posted[1].chatId, posted[0].id, 'the cancel names the chat request, not itself');
  assert.equal(say(), CANCELLED);
  btn('Try again ·').click(); btn('Cancel ·').click(); await flush();
  assert.deepEqual(posted.map((m) => m.kind), ['chat', 'chat-cancel', 'chat', 'chat-cancel'], 'each run cancels only itself, once');
  assert.equal(posted[3].chatId, posted[2].id);
});
// R3 by test: the studio and chat-ui are separate inlined parts and cannot import each other, so the
// one sentence a cancelled turn shows is pinned equal across them here.
// Each side is checked to BE a sentence first (R14): a renamed constant or a regex that stops
// matching left undefined on both sides, and undefined === undefined passed.
test('the studio’s Cancelled sentence is chat-ui’s PAC_CANCELLED', () => {
  const chat = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');
  const m = /const PAC_CANCELLED='([^']+)'/.exec(chat);
  assert.ok(m, 'chat-ui still declares PAC_CANCELLED as a quoted literal');
  const studio = loadStudio(loadStationery()).CANCELLED;
  for (const [who, v] of [['studio CANCELLED', studio], ['chat-ui PAC_CANCELLED', m[1]]]) {
    assert.equal(typeof v, 'string', `${who} is a string`);
    assert.ok(v.trim(), `${who} is not empty`);
  }
  assert.equal(studio, m[1]);
});
// The run token, now that a reset ABORTS: the old turn settles (as Cancelled) while the newer one is in
// flight, since Design is reset + run in one tap. Without the token that settle switched the busy guard
// off mid-run and stopped the newer run's clock. Reached here by forcing Design past the guard, so the
// token is defence in depth: in use the guard keeps a second Design tap from happening at all.
test('MUTATION: without the run token, a run that a reset ended writes over the newer run', async (t) => {
  clock(t);
  for (const [mutate, clobbered] of [[undefined, false], [(s) => s.replace('if(my!==tok) return r;', ''), true]]) {
    const { pending, btn, say } = mountStudio(mutate);
    btn('✨').click(); btn('Design ·').click();
    btn('Design ·').disabled = false; btn('Design ·').click(); await flush();
    assert.equal(pending[0].o.signal.aborted, true, 'the reset aborted the first turn');
    assert.equal(btn('Design ·').disabled, !clobbered, clobbered ? 'mutant: the guard is off mid-run' : 'shipped: still guarded');
    assert.equal(say(), clobbered ? CANCELLED : 'Working… 0:00 · 处理中…');
    pending[1].res({ ok: false, error: 'done' }); await flush();
  }
});
// A late answer after Cancel is stopped TWICE: the studio ends the turn on the abort (its race), and
// the picker's token ignores whatever still arrives. Each alone suffices; the control is the double
// mutant, which proves the "paints nothing" assertion above can see a paint.
test('MUTATION: a late answer after Cancel paints only when BOTH the token and the studio’s abort race are gone', async (t) => {
  clock(t);
  const TOKEN = (s) => s.replace('if(my!==tok) return r;', '');
  const RACE = (s) => s.replace("else up.addEventListener('abort',cancel,{once:true});", '');
  for (const [pick, stu, painted] of [[TOKEN, undefined, false], [undefined, RACE, false], [TOKEN, RACE, true]]) {
    const { pending, btn, drawn } = mountStudio(pick, stu);
    btn('✨').click(); btn('Design ·').click(); btn('Cancel ·').click(); await flush();
    pending[0].res({ ok: true, text: GOOD, convoId: 'c1' }); await flush();
    assert.equal(drawn(), painted, `${pick ? 'no token' : 'token'} + ${stu ? 'no race' : 'race'}`);
  }
});
test('MUTATION: without the bounded wait, an answer that never ends never settles', async () => {
  const ST = loadStudio(loadStationery(), { mutate: (s) => s.replace('t=setTimeout(()=>stop(TIMEOUT),AI_WAIT_MS);', 't=0;') });
  const settled = await Promise.race([ST.design(() => new Promise(() => {}), 'dots').then(() => true), new Promise((r) => setTimeout(() => r(false), 100))]);
  assert.equal(settled, false);
});
// CSS, so pinned at the source: probed in Chromium at 390x844, the AI panel's textarea (default 20
// columns) widened the shrink-to-fit popover to right=421 px, 31 px off a phone screen; after: 390.
test('a studio field never sets the popover width (phone: no horizontal overflow)', async () => {
  const { PICKER_HTML } = await import('./helpers-stationery.mjs');
  assert.match(PICKER_HTML, /\.pst-panel textarea,\.pst-panel input\[type=text\]\{[^}]*min-width:0;/);
  assert.match(PICKER_HTML, /\.pst-panel input\[type=text\]\{flex:1 1 96px;width:0\}/);
  assert.match(PICKER_HTML, /ta\.cols=1;/);
});
