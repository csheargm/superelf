// PASettingsRows — the tick-box rows atop the app ⚙ Settings dialog. Owner 2026-11-12: looking for
// "Open AI notes with the note" the owner opened ⚙ Settings and did not find it; one place for a
// setting, on the account. Driven over the REAL settings-ui + settings-rows scripts, answered by the
// REAL shell app-settings block (loadShellAppSettings), so a tick + Save is checked all the way to
// what lands in ME.appPrefs and the PUT body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { loadShellAppSettings } from './helpers-shell-broker.mjs';

const read = (f) => fs.readFileSync(path.join(ROOT, 'web', f), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const SETTINGS = read('settings-ui.inline.html'), ROWS = read('settings-rows.inline.html');
const jsOf = (src) => /<script[^>]*>([\s\S]*?)<\/script>/.exec(src)[1];
const LABEL = '打开笔记时显示 AI 对话 · Open AI notes with the note';
const HINT = '关闭时笔记单独打开；✨ 打开 AI · Off: a note opens alone; ✨ opens its AI';
const tick = () => new Promise((r) => queueMicrotask(r));

function mkDom() {
  const made = [];
  const el = (tag) => {
    const cls = new Set();
    const node = { tag, textContent: '', value: '', type: '', checked: false, disabled: false, rows: 0, title: '', children: [], attrs: {}, _h: {},
      classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c),
        toggle: (c, on) => { const w = on === undefined ? !cls.has(c) : !!on; if (w) cls.add(c); else cls.delete(c); return w; } },
      appendChild(c) { node.children.push(c); return c; }, setAttribute(k, v) { node.attrs[k] = String(v); },
      addEventListener(t, f) { (node._h[t] = node._h[t] || []).push(f); },
      fire(t) { const e = { target: node }; (node._h[t] || []).slice().forEach((f) => f(e)); if (typeof node['on' + t] === 'function') node['on' + t](e); } };
    Object.defineProperty(node, 'className', { get: () => [...cls].join(' '), set: (v) => { cls.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); } });
    made.push(node); return node;
  };
  const posted = [], on = [];
  const win = { addEventListener: (t, f) => { if (t === 'message') on.push(f); }, parent: { postMessage: (m) => posted.push(m) } };
  const doc = { body: el('body'), createElement: el, addEventListener() {}, removeEventListener() {} };
  return { made, posted, win, doc, find: (c) => made.find((n) => n.classList.contains(c)), reply: (m) => on.forEach((f) => f({ data: { pa: 'res', id: posted[posted.length - 1].id, ...m } })) };
}

// A page the way web.mjs serves it: PANote (when the app mounts notes), then settings-ui, whose
// PA_SETTINGS_ROWS marker inlines settings-rows right after it; then the app attaches its ⚙.
function page({ withNotes = true, withRows = true, me } = {}) {
  const dom = mkDom();
  if (withNotes) dom.win.PANote = { prefs: () => ({ openAi: false }) };
  const run = (js) => new Function('window', 'document', 'parent', js)(dom.win, dom.doc, dom.win.parent);   // eslint-disable-line no-new-func
  run(jsOf(SETTINGS)); if (withRows) run(jsOf(ROWS));
  const host = dom.doc.createElement('div');
  const h = dom.win.PASettings.attach({ host, appPrompt: 'app own' });
  const shell = loadShellAppSettings({ me });
  return { dom, h, shell,
    cb: () => dom.made.find((n) => n.tag === 'input' && n.type === 'checkbox'),
    json: () => dom.find('pag-mono'),
    async open() { h.el.fire('click'); await tick(); dom.reply({ ok: true, ...shell.appSettingsOf('notes', 'app own') }); await tick(); },
    async save() { dom.find('pag-go').fire('click'); await tick(); const m = dom.posted[dom.posted.length - 1];
      assert.equal(m.kind, 'set-app-settings'); dom.reply(await shell.saveAppSettings('notes', m.prefs, m.systemPrompt, m.appPrompt)); await tick(); return m; } };
}
const ME = () => ({ appPrefs: { notes: { noteSort: 'created' } }, systemPrompts: { apps: { notes: 'my override' } }, systemPromptDefaults: { apps: {} } });

test('served: settings-ui carries the rows marker and web.mjs registers settings-rows after settings-ui (only PATips and PAPaneChrome follow)', () => {
  assert.ok(SETTINGS.trimEnd().endsWith('<!--PA_SETTINGS_ROWS-->'), 'settings-ui carries the marker, after its script');
  const list = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('\n];', WEB.indexOf('const PA_COMPONENTS = [')));
  const files = [...list.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(files.slice(-7), ['settings-rows.inline.html', 'tips.inline.html', 'pane-chrome.inline.html', 'app-bar.inline.html', 'bar-handle.css', 'reading-history.inline.html', 'ink-frame.inline.html']);
  assert.ok(files.indexOf('settings-ui.inline.html') < files.length - 1);
  assert.equal(ROWS.split(LABEL).length, 2, 'the label is written once (R3)');
});

test('Journal (PANote on the page): ONE row at the top, bilingual, unticked by default', async () => {
  const p = page({ me: ME() });
  await p.open();
  const boxes = p.dom.made.filter((n) => n.tag === 'input' && n.type === 'checkbox');
  assert.equal(boxes.length, 1, 'one tick box');
  assert.ok(p.dom.made.some((n) => n.textContent === LABEL) && p.dom.made.some((n) => n.textContent === HINT), 'label + hint');
  const bd = p.dom.find('pag-bd');
  assert.ok(bd.children[0].children.some((n) => n.children && n.children.includes(boxes[0])), 'the first section of the dialog');
  assert.equal(boxes[0].checked, false, 'off by default');
});

test('an app without notes (no PANote) shows no row — and the R14 control: no rows script, no row either', async () => {
  const p = page({ withNotes: false, me: ME() }); await p.open();
  assert.equal(p.cb(), undefined, 'food-helper style app: no row');
  assert.equal(p.dom.made.some((n) => n.textContent === LABEL), false);
  const q = page({ withRows: false, me: ME() }); await q.open();
  assert.equal(q.cb(), undefined, 'the row comes from settings-rows: without it the Journal assertion above would fail');
});

test('tick + Save stores appPrefs.notes.openAi=true through the real shell save, keeping noteSort and the prompt override', async () => {
  const me = ME(); const p = page({ me }); await p.open();
  assert.deepEqual(JSON.parse(p.json().value), { noteSort: 'created' });
  p.cb().checked = true; p.cb().fire('change');
  assert.deepEqual(JSON.parse(p.json().value), { noteSort: 'created', openAi: true }, 'the tick writes the JSON box');
  const sent = await p.save();
  assert.equal(p.dom.posted.filter((m) => m.kind === 'set-app-settings').length, 1, 'Save writes once');
  assert.equal(sent.systemPrompt, 'my override');
  assert.deepEqual(me.appPrefs.notes, { noteSort: 'created', openAi: true }, 'stored on the account');
  assert.equal(me.systemPrompts.apps.notes, 'my override', 'the override survives');
  assert.deepEqual(p.shell.calls[0].body.appPrefs.notes, { noteSort: 'created', openAi: true }, 'the PUT body');
  // Untick + Save: the key goes (false is the default), the rest stays.
  await p.open(); assert.equal(p.cb().checked, true, 'reopened: painted from the stored value');
  p.cb().checked = false; p.cb().fire('change'); await p.save();
  assert.deepEqual(me.appPrefs.notes, { noteSort: 'created' });
});

test('the JSON box drives the tick; a tick over invalid JSON is undone, not written', async () => {
  const p = page({ me: ME() }); await p.open();
  p.json().value = '{"openAi": true}'; p.json().fire('input');
  assert.equal(p.cb().checked, true, 'typing openAi:true ticks');
  p.json().value = '{"openAi": false}'; p.json().fire('input');
  assert.equal(p.cb().checked, false, 'false unticks');
  p.json().value = '{"openAi": "yes"}'; p.json().fire('input');
  assert.equal(p.cb().checked, false, 'only true ticks');
  p.json().value = '{"openAi": tr'; p.json().fire('input');
  p.cb().checked = true; p.cb().fire('change');
  assert.equal(p.cb().checked, false, 'undone');
  assert.equal(p.json().value, '{"openAi": tr', 'the half-typed text is kept');
  assert.ok(p.dom.find('pag-msg').classList.contains('pag-err'), 'and the parse error stays on screen (R5)');
});
