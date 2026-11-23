// Boots one plain app's script AS SERVED (PATwoTap, PAStore first) in a vm, as the sandbox runs it: the
// real relay and a real node:http server come from helpers-app.mjs; only the DOM, the clock, the
// native modals and FileReader are stubbed. Moved here from test/sandbox-modal-flows.test.mjs so test/app-read-guard.test.mjs runs
// the apps the same way rather than through a second copy (R3).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, servedScriptOf, fakeEl, settle, startHarness, until, deferred } from './helpers-app.mjs';

export const htmlOf = (dir, slug) => fs.readFileSync(path.join(ROOT, dir, slug, 'index.html'), 'utf8');
export const srcOf = (dir, slug) => servedScriptOf(htmlOf(dir, slug));   // with what every page runs first
// Saves the app sent for `name`, as the test server recorded them.
export const writesTo = (h, name) => h.state.puts.filter((p) => p.endsWith(name)).length;

// ── The failed-read kit (test/app-read-guard*.test.mjs) ─────────────────────────────────────
// A fault fails only the READ (`on:'get'`), so a save the app wrongly sends WOULD land and overwrite
// the file. A fault that also refused writes would make every "the file survived" check vacuous (R14).
export const readFails = (file) => ({ status: 500, only: file, on: 'get' });
export const saveFails = (file) => ({ status: 500, only: file, on: 'put' });
// What a user is shown for those two faults: the sentence the shell's relayFail renders for a 500 on
// kind 'data' (noun 'content') and on a PAStore save (kind 'save-data', what 'data'). The relay
// attaches it as the real shell does, so an app that dropped it for its own words, or for the bare
// error, fails here. A failed save is shown as the shell words it, so that one is anchored; a failed
// read is wrapped.
export const SHELL_READ_FAILED = /服务器错误 · Server error — Content not loaded · 未加载/;
const shellSaveFailed = (noun) => new RegExp(`^服务器错误 · Server error — ${noun} not saved · 未保存`);
export const SHELL_SAVE_FAILED = shellSaveFailed('Data');
// A save-data request that names no `what` gets the shell's default noun, 'note': right for a PANote
// host (Notes, Bible), wrong for an app's own raw save of anything else (Allergy, until it says 'data').
export const SHELL_NOTE_SAVE_FAILED = shellSaveFailed('Note');
export const NOT_JSON = '{not json';
export const textOf = (app, id) => app.els[id]?.textContent || '';
export const fileText = (h, rel) => fs.readFileSync(h.file(rel), 'utf8');
// The two ways a saved file can fail to come back. Each prepares a real file first. The third entry
// is the shell's sentence the screen must carry; a file that does not parse is reported in the app's
// own words instead (no shell sentence: the read itself succeeded).
export const unreadable = (file, saved) => [
  ['the read fails', (h) => { h.put(file, saved); h.state.fault = readFails(file); }, SHELL_READ_FAILED],
  ['the file does not parse', (h) => h.put(file, NOT_JSON), null],
];

export async function withHarness(slug, fn) {
  const h = await startHarness(slug);
  try { await fn(h); } finally { await h.stop(); }
}

// Reads the test releases by hand: the window in which a user can act before the data is in.
export function heldReads(relay) {
  const { promise: held, resolve: release } = deferred();
  return { release, relay: (m) => (m.kind === 'data' ? held.then(() => relay(m)) : relay(m)) };
}

// Waits until the app has refused the save on screen (in element `where`) OR sent it, so "no write
// was sent" is never asserted before a write could have arrived.
export const refusedOrSent = (app, h, file, where = 'status') => until(
  () => /not saved/.test(textOf(app, where)) || writesTo(h, file) > 0, 'the save is refused on screen or sent');

// A clock the test moves by hand, so "the arm expires after 3 s" is checked without waiting 3 s.
export function fakeClock() {
  let now = 0, seq = 0;
  const due = new Map();
  return {
    setTimeout: (fn, ms = 0) => { due.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimeout: (id) => { due.delete(id); },
    advance(ms) { now += ms; for (const [id, t] of [...due]) if (t.at <= now) { due.delete(id); t.fn(); } },
  };
}

// fakeEl plus the few element methods these apps call that the shared stub does not carry. Listeners
// are kept in `on`, so a test fires a handler the way a tap does: `await app.els['save-btn'].on.click()`.
// querySelector finds a child only when the element's own HTML holds it: an app that wires a button
// inside a card it just built gets one, and a selector that matches nothing still answers null.
export const el = (id) => {
  const e = Object.assign(fakeEl(id), { click() {}, removeAttribute() {}, before() {}, style: { setProperty() {} }, on: {} });
  e.addEventListener = (type, fn) => { e.on[type] = fn; };
  e.querySelector = (sel) => (String(e.innerHTML).includes(sel.replace(/^[.#]/, '')) ? el(`${id}>${sel}`) : null);
  return e;
};

// The user picks a file for an app's import: boot the app with { FileReader: FakeFileReader }, then
// pickFile runs the app's own importData() and hands its file input the text.
export class FakeFileReader { readAsText(f) { Promise.resolve().then(() => this.onload({ target: { result: f.text } })); } }
export async function pickFile(app, text) {
  app.run('importData()');
  await app.created.at(-1).onchange({ target: { files: [{ text }] } });
  await settle();
}

export function boot(src, relay, extra = {}) {
  const els = {}, created = [], clock = fakeClock();
  // Every 'message' listener hears every reply, as in a browser: PAStore keeps its own broker beside
  // the app's, and each answers only its own ids. Keeping one listener would starve all but the last.
  const onMessage = [];
  const make = (tag) => { const e = el(tag); created.push(e); return e; };
  const listen = (type, fn) => { if (type === 'message') onMessage.push(fn); };   // window IS the global
  const ctx = vm.createContext({
    document: {
      getElementById: (id) => (els[id] ||= el(id)), querySelector: () => null, querySelectorAll: () => [],
      createElement: make, createElementNS: (_ns, tag) => make(tag), documentElement: el('html'), body: el('body'),
      addEventListener() {},
    },
    window: { addEventListener: listen }, addEventListener: listen,
    // Only a request is answered, as the shell's broker answers only pa:'req' (PALeave's hello is not one).
    parent: { postMessage: (m) => { if (m && m.pa === 'req') relay(m).then((r) => { const e = { data: { pa: 'res', id: m.id, ...r } }; for (const fn of onMessage) fn(e); }); } },
    console: { log() {}, error() {}, warn() {} },
    // The sandbox's own answers (no allow-modals), so code that still calls one fails here as it does
    // on the phone, quietly, rather than with a ReferenceError the phone never shows.
    confirm: () => false, alert: () => {}, prompt: () => null,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: () => 0, clearInterval() {},
    ...extra,
  });
  vm.runInContext(src, ctx);
  return { els, created, clock, run: (code) => vm.runInContext(code, ctx) };
}
