// The Pencil recorder's witnesses OUTSIDE the app document · 笔迹记录：应用之外
//
// On the owner's iPad the Pencil stopped inking for 2-5 s and the recorder logged NOTHING in those
// seconds — no pointer, touch, scroll or viewport event. The input went outside the app document.
// The recorder can see two things that would say where:
//   · focus leaving the app's window (d win-blur / win-focus) and document.hasFocus() on every
//     entry (hf). hf 0 alone proves nothing: PANote prevents its touches, so the app may never get
//     focus at all (then every entry is hf 0 and no win-blur fires). Only a 1 -> 0 change or a
//     win-blur is a signal; the header's focus {mount, ever} says which case a log is in;
//   · the shell's own report (web/index.html shellEventsToApp) of a touch or focus on ITS elements
//     while the app is open, logged as tg 'shell'.
// Same rules as the recorder's own tests (test/note-pencil-log.test.mjs): every field is in KEYS,
// no text, logging never prevents or stops anything. Runs the SHIPPED recorder through runPad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECORDER, runPad, dispatch, makeNode } from './helpers-panote-routing.mjs';
import { runShell } from './helpers-shell-dom.mjs';

const KEYS = Object.keys(new Function(`${RECORDER.match(/const KEYS=\{[\s\S]*?\};/)[0]}\nreturn KEYS;`)());   // eslint-disable-line no-new-func
const PEN = { id: 2, pt: 'pen' };
const plain = (type, extra = {}) => ({ type, preventDefault() {}, stopPropagation() {}, ...extra });
// The app's parent window. The stub's `parent` doubles as the DOM-tree parent, so the shell window
// is a node too (no listeners: it is only an identity to compare e.source against).
function framedPad(o) {
  const pad = runPad(o);
  pad.win.parent = makeNode('shellWindow', null, { _notElement: true });
  return pad;
}
const fromShell = (pad, data, source = pad.win.parent) => dispatch(pad.win, plain('message', { data, source }));
const documented = (events) => { for (const e of events) for (const k of Object.keys(e)) assert.ok(KEYS.includes(k), `undocumented field "${k}"`); };

test('window blur and focus are logged as tg win, d win-blur / win-focus; an element blur is not', () => {
  const pad = framedPad();
  pad.down(pad.ink, { ...PEN, x: 1, y: 1 });
  dispatch(pad.win, plain('blur'));
  dispatch(pad.textLayer, plain('blur'));                 // an element's blur: not the window losing focus
  dispatch(pad.win, plain('focus'));
  const w = pad.pencilLog().events.filter((e) => /^win-/.test(e.d || ''));
  assert.deepEqual(w.map((e) => [e.type, e.tg, e.d]), [['blur', 'win', 'win-blur'], ['focus', 'win', 'win-focus']]);
  documented(pad.pencilLog().events);
});

test('every entry carries hf — document.hasFocus() as 1/0 — so a 1 -> 0 change while the Pencil is down stands out', () => {
  const pad = framedPad();
  let focused = true;
  pad.doc.hasFocus = () => focused;
  pad.down(pad.ink, { ...PEN, x: 1, y: 1 });
  focused = false;
  pad.move(pad.ink, { ...PEN, x: 5, y: 1 });
  assert.deepEqual(pad.pencilLog().events.map((e) => e.hf), [1, 0]);
});

test('focus baseline: an app that never had focus logs hf 0 everywhere, and the header says so (focus.ever 0)', () => {
  // The iPad's normal state in Journal (Chromium probe on the full shell: hasFocus false before
  // any tap, every prevented tap hf 0, no win-blur). The header keeps that from reading as "taken".
  const pad = framedPad({ hasFocus: () => false });
  pad.down(pad.ink, { ...PEN, x: 1, y: 1 }); pad.move(pad.ink, { ...PEN, x: 5, y: 1 });
  const log = pad.pencilLog();
  assert.deepEqual(log.events.map((e) => e.hf), [0, 0]);
  assert.deepEqual(log.focus, { mount: 0, ever: 0 });
  assert.ok(!log.events.some((e) => /^win-/.test(e.d || '')), 'and no win-blur: not observed, not "did not happen"');
});
test('focus baseline: mount is hf at attach, ever turns 1 at the first entry with focus and stays', () => {
  let focused = true;
  const pad = framedPad({ hasFocus: () => focused });
  focused = false;
  pad.down(pad.ink, { ...PEN, x: 1, y: 1 });
  assert.deepEqual(pad.pencilLog().focus, { mount: 1, ever: 0 }, 'focus at mount alone does not count as an entry with focus');
  focused = true; pad.move(pad.ink, { ...PEN, x: 5, y: 1 });
  focused = false; pad.up(pad.ink, { ...PEN, x: 5, y: 1 });
  const log = pad.pencilLog();
  assert.deepEqual(log.events.map((e) => e.hf), [0, 1, 0], 'the 1 -> 0 change is the signal');
  assert.deepEqual(log.focus, { mount: 1, ever: 1 });
  assert.deepEqual(framedPad().pencilLog().focus, { mount: null, ever: 0 }, 'no hasFocus: mount is null, not 0');
});
test('the KEYS legend says hf 0 is normal without focus, and names the real signals', () => {
  const hf = RECORDER.match(/hf:'([^']*)'/)[1];
  assert.match(hf, /never got focus/); assert.match(hf, /1 then 0/); assert.match(hf, /win-blur/); assert.match(hf, /focus\.ever/);
});
test('MUTATION: a recorder that never sets ever, or fakes mount — caught', () => {
  const ever = (m) => framedPad({ hasFocus: () => true, mutateRecorder: m }).pencilLog();
  const run = (m) => { const p = framedPad({ hasFocus: () => true, mutateRecorder: m }); p.down(p.ink, { ...PEN, x: 1, y: 1 }); return p.pencilLog().focus; };
  assert.throws(() => assert.deepEqual(run((s) => s.replace('if(o.hf) hfEver=1;', '')), { mount: 1, ever: 1 }), assert.AssertionError);
  assert.throws(() => assert.deepEqual(ever((s) => s.replace('document.hasFocus()?1:0):null', '0):null')).focus.mount, 1), assert.AssertionError);
  assert.deepEqual(run(), { mount: 1, ever: 1 }, 'control: the shipped recorder passes');
});

test('a shell-event from the parent is logged as tg shell, d shell-<type>, el = the #id/.class', () => {
  const pad = framedPad();
  fromShell(pad, { pa: 'shell-event', type: 'pointerdown', tag: '#box', t: Date.now() - 3 });
  fromShell(pad, { pa: 'shell-event', type: 'focusin', tag: '.dsec-head', t: Date.now() });
  const s = pad.pencilLog().events.filter((e) => e.tg === 'shell');
  assert.deepEqual(s.map((e) => [e.d, e.el]), [['shell-pointerdown', '#box'], ['shell-focusin', '.dsec-head']]);
  assert.ok(s.every((e) => typeof e.lag === 'number' && e.lag >= 0 && e.lag < 1000), 'with its delivery lag');
  documented(pad.pencilLog().events);
});

function untrusted(mutateRecorder) {
  const pad = framedPad({ mutateRecorder });
  fromShell(pad, { pa: 'shell-event', type: 'pointerdown', tag: '#box' }, makeNode('otherWindow', null));   // not the parent
  fromShell(pad, { pa: 'shell-event', type: 'pointerdown', tag: '#box' }, null);
  fromShell(pad, { pa: 'res', id: 1 });                                                                  // a broker reply: not ours
  fromShell(pad, { pa: 'shell-event', type: 'pointer down SECRET', tag: '#box' });
  fromShell(pad, { pa: 'shell-event', type: 'focusin', tag: 'SECRET journal words 秘密' });
  return pad.pencilLog().events;
}
test('only the parent window, only a short kind, and a tag that cannot carry text', () => {
  const ev = untrusted();
  assert.deepEqual(ev.map((e) => [e.d, e.el]), [['shell-focusin', '']], 'one accepted, its free-text tag dropped');
  assert.ok(!JSON.stringify(ev).includes('SECRET') && !JSON.stringify(ev).includes('秘密'));
});
test('MUTATION: a recorder that trusts any sender, or keeps the tag as sent — caught', () => {
  assert.throws(() => { assert.equal(untrusted((s) => s.replace('||e.source!==window.parent', '')).length, 1); }, assert.AssertionError);
  assert.throws(() => { assert.ok(!JSON.stringify(untrusted((s) => s.replace("el:/^[#.]?[\\w-]{1,25}$/.test(m.tag)?m.tag:''", 'el:m.tag'))).includes('SECRET')); }, assert.AssertionError);
});

test('logging these never prevents or stops the event', () => {
  const pad = framedPad();
  const evs = [dispatch(pad.win, plain('blur', { defaultPrevented: false, _stopCalls: 0 })),
    fromShell(pad, { pa: 'shell-event', type: 'touchstart', tag: '#back' })];
  for (const e of evs) { assert.ok(!e.defaultPrevented); assert.ok(!e._stopped); }
});

test('USER FLOW: a Pencil touch that lands on the shell while the app is open reaches the app\'s Pencil log', () => {
  // The real shell relay feeding the real recorder: what the shell posts is what the log keeps.
  const shell = runShell(), pad = framedPad();
  shell.fr.contentWindow = { postMessage: (m) => fromShell(pad, m) };
  shell.shellBehindApp(true);
  pad.down(pad.ink, { ...PEN, x: 100, y: 100 }); pad.move(pad.ink, { ...PEN, x: 110, y: 100 });
  shell.byId('box').value = 'SECRET draft';
  shell.fire(shell.byId('box'), 'touchstart');            // the stroke went to the composer under the frame
  shell.fire(shell.byId('barpeek'), 'pointerdown');       // or to the grabber on top of the app
  dispatch(pad.win, plain('blur'));
  const ev = pad.pencilLog().events;
  assert.deepEqual(ev.filter((e) => e.tg === 'shell' || e.tg === 'win').map((e) => [e.d, e.el ?? null]),
    [['shell-touchstart', '#box'], ['shell-pointerdown', '#barpeek'], ['win-blur', null]]);
  assert.ok(!JSON.stringify(ev).includes('SECRET'));
  shell.shellBehindApp(false);
  shell.fire(shell.byId('box'), 'touchstart');
  assert.equal(pad.pencilLog().events.filter((e) => e.tg === 'shell').length, 2, 'nothing after the app closed');
});
