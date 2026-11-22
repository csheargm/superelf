// The shell under an open app is inert · 应用打开时外壳下层不可交互
//
// Device evidence (owner's iPad, Journal, swipe-to-flip off): the Pencil stopped inking for 2-5 s
// while the app's own recorder — listening on its window, document, pad and stage — saw NO event
// at all. The strokes were taken by something OUTSIDE the app's document. #frame is fixed over the
// whole shell, but the home view stays laid out under it: the header, the transcript and the
// composer's <input id="box">. iPadOS Scribble asks the page for editable elements in a rect and
// need not account for the iframe covering them. While an app is open those containers carry
// `inert`: no hit-testing, no focus, invisible to Scribble and assistive discovery.
//
// What this file pins, against the SHIPPED markup and the SHIPPED shellBehindApp:
//   1. the map — every body-level element is classified BEHIND (made inert) or USABLE (never);
//   2. open sets inert on exactly the behind containers, and nothing usable sits inside one;
//   3. close removes it; a focused #box is blurred on open;
//   4. the shell-event relay exists only while an app is open, and reports kind + #id/.class only;
//   5. every path that opens or closes the frame goes through the ONE function (R3);
//   6. mutations of each of those are caught (R14: a guard that cannot fail proves nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL } from './helpers-app.mjs';
import { runShell, runShellNav, all, inertAncestor } from './helpers-shell-dom.mjs';

// ── 1. the map ───────────────────────────────────────────────────────────────────────────────
// BEHIND: laid out under #frame, unusable while an app is open. USABLE: on top of or beside an app
// (or hidden until shown on top of one), so an inert ancestor would break it.
const BEHIND = ['header', 'main', 'form#f', 'button#scrollBtn'];
const USABLE = {
  'div#frame': 'the app, its bar (Back, title, A-/A+) and the grabber',
  'aside#drawer': 'off-screen while an app is open; kept live so a drawer over apps would work',
  'div#backdrop': 'the drawer\'s backdrop',
  'span#fsToast': 'answers the app bar\'s A-/A+ too',
  'span#updBar': 'the "Update ready" line (web/update.js): tappable while an app is open',
  'span#offLine': 'the offline state line (web/offline-client.js): read while an app is open',
  'div#lightbox': 'image viewer, fixed above everything',
  'input#filein-photo': 'hidden file input (never laid out)',
  'dialog#cfg': 'settings — top layer', 'dialog#actConfirm': 'app approval prompts — top layer',
  'dialog#updateSheet': 'app updates — top layer', 'dialog#setup': 'first run — top layer',
  'dialog#login': 'sign-in, incl. a session that expires while an app is open — top layer',
};
const label = (el) => el.nodeName.toLowerCase() + (el.id ? '#' + el.id : '');
// By label, never the node: a failing assert would print the whole circular tree.
const inertOf = (el) => { const a = inertAncestor(el); return a ? label(a) : null; };

test('MAP: every body-level element is classified — a new one must be placed BEHIND or USABLE', () => {
  const s = runShell();
  const kids = s.body.children.map(label).sort();
  assert.deepEqual(kids, [...BEHIND, ...Object.keys(USABLE)].sort());
});

test('the dynamic shell surfaces are appended to <body>, never into a behind container', () => {
  // Menus, the print root, the copy fallback and #scrollBtn are created at run time.
  for (const re of [/scrollBtn\.id='scrollBtn'[^\n]*document\.body\.appendChild\(scrollBtn\)/,
    /root\.id='printRoot'; document\.body\.appendChild\(root\)/,
    /m\.id='appMenu'[\s\S]{0,400}?document\.body\.appendChild\(m\)/,
    /m\.id='convoMenu'[\s\S]{0,400}?document\.body\.appendChild\(m\)/]) assert.match(SHELL, re);
});

// ── 2/3. open and close ──────────────────────────────────────────────────────────────────────
function openChecks(src = SHELL) {
  const s = runShell(src);
  const box = s.byId('box');
  s.focus(box);
  s.shellBehindApp(true);
  const inert = s.body.children.filter((e) => e.hasAttribute('inert')).map(label).sort();
  assert.deepEqual(inert, [...BEHIND].sort(), 'inert on exactly the behind containers');
  for (const id of ['frame', 'back', 'ftitle', 'fs-dn', 'fs-up', 'barpeek', 'fr', 'drawer', 'backdrop', 'csInp', 'fsToast', 'updBar', 'offLine',
    'lightbox', 'cfg', 'actConfirm', 'acOk', 'updateSheet', 'login', 'luser', 'lpin', 'setup']) {
    const el = s.byId(id); assert.ok(el, `#${id} exists`);
    assert.equal(inertOf(el), null, `#${id} must stay usable over an app`);
  }
  // Every editable field laid out under the frame is covered — enumerated, not listed.
  const editable = all(s.body).filter((e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.nodeName) && !e.attrs.hidden && e.id !== 'filein-photo');
  const underFrame = editable.filter((e) => !all(s.body).some((d) => (d.nodeName === 'DIALOG' || d.id === 'drawer') && d.contains(e)));
  assert.ok(underFrame.some((e) => e.id === 'box'), 'the composer is among them');
  for (const e of underFrame) assert.ok(inertOf(e), `#${e.id || e.nodeName} is under the frame and must be inert`);
  assert.equal(box._blurred, 1, 'a focused #box is blurred: it would keep the keyboard and Scribble on it');
  return s;
}
test('opening an app makes exactly the covered shell inert, and nothing usable', () => { openChecks(); });

function closeChecks(src = SHELL) {
  const s = runShell(src);
  s.shellBehindApp(true); s.shellBehindApp(false);
  assert.deepEqual(all(s.body).filter((e) => e.hasAttribute('inert')).map(label), [], 'closing removes every inert');
  assert.equal(s.listeners.length, 0, 'and the shell-event listeners');
  s.fire(s.byId('box'), 'pointerdown');
  assert.equal(s.posted.length, 0, 'nothing is reported once the app is closed');
  return s;
}
test('closing the app removes inert and the relay — Home works as before', () => { closeChecks(); });

test('a focused field that is NOT behind the frame is left alone (sign-in over an app)', () => {
  const s = runShell();
  const pin = s.byId('lpin');
  s.focus(pin);
  s.shellBehindApp(true);
  assert.equal(pin._blurred, undefined);
  assert.ok(s.doc.activeElement === pin, 'focus stays on the sign-in field');
});

// ── 4. the shell-event relay ─────────────────────────────────────────────────────────────────
function relayChecks(src = SHELL) {
  const s = runShell(src);
  s.shellBehindApp(true); s.shellBehindApp(true);                  // opened twice: still one set
  assert.deepEqual(s.listeners.map((l) => [l.type, l.capture, l.passive]).sort(),
    [['focusin', true, true], ['pointerdown', true, true], ['touchstart', true, true]], 'capture, passive, one each');
  const box = s.byId('box'); box.value = 'SECRET typed words'; box.textContent = 'SECRET';
  s.fire(box, 'pointerdown');
  s.fire(s.byId('back'), 'touchstart');
  const msg = all(s.body).find((e) => e.className === 'dsec-head');
  s.fire(msg, 'focusin');
  s.fire(s.fr, 'focusin');                                          // focus moving INTO the app: not a shell event
  assert.deepEqual(s.posted.map((p) => [p.m.pa, p.m.type, p.m.tag]),
    [['shell-event', 'pointerdown', '#box'], ['shell-event', 'touchstart', '#back'], ['shell-event', 'focusin', '.dsec-head']]);
  for (const p of s.posted) {
    assert.deepEqual(Object.keys(p.m).sort(), ['pa', 't', 'tag', 'type'], 'kind, tag and time only');
    assert.equal(typeof p.m.t, 'number');
    assert.equal(p.origin, '*', 'the app is an opaque-origin sandbox, as sendAppPrefs posts');
  }
  assert.ok(!JSON.stringify(s.posted).includes('SECRET'), 'never a value or text');
  return s;
}
test('while an app is open, a touch or focus on a SHELL element is reported to the app — kind and #id/.class only', () => { relayChecks(); });

// ── 5. every open/close path ─────────────────────────────────────────────────────────────────
const JS = SHELL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function pathChecks(js = JS) {
  // Enumerate every statement that opens or closes the frame, find its function, and require the
  // switch in it with the matching argument. A third path added later fails here until it does.
  const sites = [...js.matchAll(/\$\('#frame'\)\.classList\.(add|remove)\('peek'/g)];
  assert.ok(sites.some((m) => m[1] === 'add') && sites.some((m) => m[1] === 'remove'), 'the open and close sites were found');
  for (const m of sites) {
    const start = js.lastIndexOf('\nfunction ', m.index) + 1;
    const line = js.slice(start, js.indexOf('\n', start));
    const oneLiner = line.split('{').length === line.split('}').length;   // e.g. openApp: the whole function on one line
    const fn = oneLiner ? line : js.slice(start, js.indexOf('\n}', start) + 2);
    assert.ok(fn.includes(m[0]), 'the enclosing function was found');
    const name = /function (\w+)/.exec(fn)[1];
    assert.match(fn, new RegExp(`shellBehindApp\\(${m[1] === 'add'}\\)`), `${name} ${m[1] === 'add' ? 'opens' : 'closes'} the frame without shellBehindApp(${m[1] === 'add'})`);
  }
  const calls = (js.match(/shellBehindApp\((true|false)\)/g) || []).length;
  assert.equal(calls, sites.length, 'one switch call per open/close site — no stray callers');
}
test('R3: every path that opens or closes an app goes through shellBehindApp', () => { pathChecks(); });

test('USER FLOW: open an app from the shelf, then ← Home — the real openApp and goHome', () => {
  const s = runShellNav();   // with the app-frame block they leave through (test/app-leave.test.mjs pins that)
  const run = s;
  s.focus(s.byId('box'));
  run.openApp('u1', 'notes', 'Journal');
  assert.equal(s.$('#frame').classList.contains('peek'), true);
  assert.equal(inertOf(s.byId('box')), 'form#f', 'the composer is inert under the open app');
  assert.equal(inertOf(s.byId('back')), null, '← Home itself is not');
  run.goHome();
  assert.equal(s.$('#frame').classList.contains('peek'), false);
  assert.equal(inertOf(s.byId('box')), null, 'home: the composer is usable again');
  assert.equal(s.listeners.length, 0);
});

// ── 6. mutations ─────────────────────────────────────────────────────────────────────────────
const mutate = (from, to) => { assert.ok(SHELL.includes(from), `mutation target present: ${from}`); return SHELL.replace(from, to); };
test('MUTATION: inert never set — caught', () => {
  assert.throws(() => openChecks(mutate("for(const el of behind) el.toggleAttribute('inert',open);", '')), assert.AssertionError);
});
test('MUTATION: inert on the wrong container — caught (on the frame; on too little)', () => {
  const list = "const SHELL_BEHIND_APP='header,main,form#f,#scrollBtn';";
  assert.throws(() => openChecks(mutate(list, "const SHELL_BEHIND_APP='header,main,form#f,#scrollBtn,#frame';")), assert.AssertionError);
  assert.throws(() => openChecks(mutate(list, "const SHELL_BEHIND_APP='header,main';")), assert.AssertionError);
  assert.throws(() => openChecks(mutate('<span id="fsToast" class="fs-toast"></span>\n<main>', '<main><span id="fsToast" class="fs-toast"></span>')), assert.AssertionError,
    'the toast moved back under an inert container');
});
test('MUTATION: listener not removed on close — caught', () => {
  assert.throws(() => closeChecks(mutate('if(_shellEventsOff){ _shellEventsOff(); _shellEventsOff=null; }', '')), assert.AssertionError);
});
test('MUTATION: no blur, a leaked value, a close path that skips the switch — caught', () => {
  assert.throws(() => openChecks(mutate('if(open&&a&&behind.some((el)=>el.contains(a))) a.blur();', '')), assert.AssertionError);
  assert.throws(() => relayChecks(mutate('tag:shellTag(t),', 'tag:shellTag(t),v:t.value,')), assert.AssertionError);
  assert.throws(() => pathChecks(JS.replace('barHide(); shellBehindApp(false);', 'barHide();')), assert.AssertionError);
});
test('CONTROL: the unmutated shell passes every check above', () => {
  openChecks(); closeChecks(); relayChecks(); pathChecks();
});
