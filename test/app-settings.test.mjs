// PASettings — the ⚙ an app puts in its own header, and the panel behind it.
//
// "a per app preference in json format that can be managed on the app UI. It could be a settings
// button on the right side on the header bar. The settings button will allow user to update the
// preferences, also show the app level system prompts."
//
// The component is RUN, not grepped — the same technique test/split-view.test.mjs uses on
// PASplit. A settings panel that is structurally present and saves nothing, or that reports
// success on a refused write, is exactly the failure a source match cannot see.
//
// Three things carry real risk:
//   1. it must touch NO client-side storage — an app runs at an opaque origin where all of it
//      throws (verified 2026-09-02, note-ui.inline.html:2284-2290);
//   2. a refused or failed SAVE must be reported and must keep the user's edits on screen —
//      silently closing on a failed write loses what they typed and tells them it worked;
//   3. invalid JSON must never be sent, and must be said out loud while it is being typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, stripComments } from './helpers-app.mjs';
import { loadShellAppSettings } from './helpers-shell-broker.mjs';

const SRC = fs.readFileSync(path.join(ROOT, 'web', 'settings-ui.inline.html'), 'utf8');
const JS = /<script>([\s\S]*)<\/script>/.exec(SRC)[1];
const CSS = /<style id="pag-style">([\s\S]*?)<\/style>/.exec(SRC)[1];

// ── a DOM just real enough to run the component ──────────────────────────────────────────────
function mkDom() {
  const made = [];
  const el = (tag) => {
    const cls = new Set();
    const node = {
      tag, textContent: '', value: '', type: '', title: '', rows: 0, disabled: false,
      attrs: {}, children: [], _handlers: {}, parentNode: null,
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
        contains: (c) => cls.has(c),
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
      },
      appendChild(c) { node.children.push(c); c.parentNode = node; return c; },
      setAttribute(k, v) { node.attrs[k] = String(v); },
      getAttribute: (k) => (k in node.attrs ? node.attrs[k] : null),
      addEventListener(t, f) { (node._handlers[t] = node._handlers[t] || []).push(f); },
      removeEventListener(t, f) { node._handlers[t] = (node._handlers[t] || []).filter((x) => x !== f); },
      fire(t, ev) {
        const e = { preventDefault() {}, stopPropagation() {}, target: node, ...ev };
        (node._handlers[t] || []).slice().forEach((f) => f(e));
        const prop = node['on' + t];
        if (typeof prop === 'function') prop(e);
      },
    };
    Object.defineProperty(node, 'className', {
      get: () => [...cls].join(' '),
      set: (v) => { cls.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
      enumerable: true,
    });
    made.push(node);
    return node;
  };
  const body = el('body');
  const docKeys = {};
  const posted = [];
  let winMsg = [];
  const win = {
    addEventListener(t, f) { if (t === 'message') winMsg.push(f); },
    // The bridge posts to `parent`. Every request is captured so a test can answer it — and can
    // answer it WRONG, which is what proves the failure paths.
    parent: { postMessage: (m) => posted.push(m) },
  };
  const doc = {
    body, createElement: el,
    addEventListener(t, f) { (docKeys[t] = docKeys[t] || []).push(f); },
    removeEventListener(t, f) { docKeys[t] = (docKeys[t] || []).filter((x) => x !== f); },
  };
  return {
    made, body, posted, win, doc, docKeys,
    find: (cls) => made.find((n) => n.classList.contains(cls)),
    key: (k) => (docKeys.keydown || []).slice().forEach((f) => f({ key: k })),
    // Deliver a broker reply for the LAST request posted, the way the shell does.
    reply: (msg) => { const last = posted[posted.length - 1]; winMsg.forEach((f) => f({ data: { pa: 'res', id: last.id, ...msg } })); },
    replyTo: (id, msg) => winMsg.forEach((f) => f({ data: { pa: 'res', id, ...msg } })),
  };
}

function load(dom) {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'parent', JS)(dom.win, dom.doc, dom.win.parent);
  return dom.win.PASettings;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── 1. R14 CONTROL — prove this file can fail before trusting anything it asserts ────────────
test('R14 control: the component loads, publishes PASettings, and these tests can actually fail', () => {
  const dom = mkDom();
  const PASettings = load(dom);
  assert.ok(PASettings, 'PASettings must be published on window — every test below is vacuous otherwise');
  assert.equal(typeof PASettings.attach, 'function');
  const broken = mkDom();
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'parent', JS.replace('window.PASettings={', 'window.NOPE={'))(broken.win, broken.doc, broken.win.parent);
  assert.equal(broken.win.PASettings, undefined, 'a component that fails to publish must be observable as such');
});

// ── 2. structural guarantees the serve path depends on ───────────────────────────────────────
test('no client-side storage anywhere — it all throws at an opaque origin', () => {
  const code = JS + CSS;
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.ok(!code.includes(api), `${api} throws SecurityError in a sandboxed app (note-ui.inline.html:2284-2290)`);
  }
});

test('the component never writes its own marker in the replaceable form', () => {
  // web.mjs replaces EVERY occurrence, so a literal <!--PA_SETTINGS_UI--> inside this file would
  // be substituted with the file itself. Every other component writes its marker bare too.
  for (const m of ['<!--PA_SETTINGS_UI-->', '<!--PA_CHAT_UI-->', '<!--PA_NOTE_UI-->', '<!--PA_SPLIT_UI-->']) {
    assert.ok(!SRC.includes(m), `settings-ui must not contain the literal marker ${m}`);
  }
  assert.ok(SRC.includes('PA_SETTINGS_UI'), 'but it must still name its marker, bare, for a reader');
});

test('z-index is a literal, above the chat and drawer, below the lightbox and the notice', () => {
  // app-load.test.mjs reads <style> blocks statically: a var()-valued z-index reads as
  // unresolved, scores 0, and sails under every ladder check — a vacuous pass.
  const z = [...CSS.matchAll(/z-index:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(z.length >= 1, 'the panel must declare a z-index');
  for (const v of z) assert.ok(/^\d+$/.test(v), `z-index must be a literal number, got ${v}`);
  const top = Math.max(...z.map(Number));
  assert.ok(top > 60, `settings opens OVER the chat (50) and the ☰ drawer host (60), got ${top}`);
  assert.ok(top < 1000, `but under the lightbox (1000) and the notice (2000), got ${top}`);
  assert.match(CSS, /\.pag-ov\{position:fixed/, 'the overlay is fixed, so the ladder check can resolve it');
});

test('every string that reaches the DOM goes through textContent, never innerHTML', () => {
  // The prompt text, the preferences and the failure reasons are all user- or app-supplied.
  // Comments STRIPPED first: the component carries a comment explaining WHY it uses textContent,
  // and that comment names innerHTML — a bare search matches the explanation and calls the
  // correct code a violation. This trap has bitten this repo before.
  assert.ok(!/innerHTML/.test(stripComments(JS)), 'innerHTML would be an injection seam for app-supplied text');
  assert.match(JS, /textContent/, 'and text really is set the safe way');
});

// ── 3. the button ────────────────────────────────────────────────────────────────────────────
test('attach() puts a ⚙ in the host the app names, and refuses to mount without one', () => {
  const dom = mkDom();
  const PASettings = load(dom);
  assert.throws(() => PASettings.attach({}), /no host/, 'a button with nowhere to sit is never reachable');
  const host = dom.doc.createElement('div');
  const h = PASettings.attach({ host });
  assert.equal(host.children.length, 1, 'it mounts INTO the host it was given');
  assert.equal(host.children[0].textContent, '⚙');
  assert.ok(host.children[0].classList.contains('pag-gear'));
  assert.ok(host.children[0].getAttribute('aria-label'), 'and is labelled for a screen reader');
  assert.equal(h.el, host.children[0], 'the handle exposes it so a host can restyle or move it');
  assert.equal(typeof h.open, 'function');
  assert.equal(h.isOpen(), false, 'it starts closed');
});

test('the ⚙ inherits the host header\'s own look rather than imposing one', () => {
  // It sits in whatever bar the app already has — the Bible's #nav, another app's something
  // else. A colour picked here would clash in the next app, which is the whole reason this is a
  // shared component and not four copies.
  assert.match(CSS, /\.pag-gear\{[^}]*font:inherit/, 'it takes the host bar\'s font');
  assert.match(CSS, /\.pag-gear\{[^}]*color:inherit/, 'and its colour');
  assert.match(CSS, /\.pag-gear\{[^}]*background:none/, 'with no background of its own');
});

// ── 4. opening: it shows what is IN FORCE, and where it came from ────────────────────────────
async function opened(dom, PASettings, settings) {
  const host = dom.doc.createElement('div');
  const h = PASettings.attach({ host });
  h.el.fire('click');
  await tick();
  if (settings !== undefined) { dom.reply(settings); await tick(); }
  return h;
}

test('opening asks the SHELL for this app\'s settings — it stores nothing itself', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  await opened(dom, PASettings);
  assert.equal(dom.posted.length, 1, 'exactly one request');
  assert.equal(dom.posted[0].kind, 'app-settings', 'a read scoped to this app by the shell');
  assert.match(String(dom.posted[0].id), /^pag/, 'with its OWN id prefix, so a reply cannot be stolen from the app\'s broker');
  assert.equal(dom.posted[0].pa, 'req');
});

test('the panel shows the effective app system prompt, its SOURCE, and the override separately', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  await opened(dom, PASettings, {
    ok: true,
    systemPrompt: { effective: 'Answer as a study aid.', override: 'Answer as a study aid.', source: 'profile' },
    prefs: { fontSize: 18 },
  });
  assert.equal(dom.find('pag-eff').textContent, 'Answer as a study aid.', 'what the model is actually told');
  assert.match(dom.find('pag-src').textContent, /your override · 你的覆盖设置/, 'and where it came from');
  const boxes = dom.made.filter((n) => n.tag === 'textarea');
  assert.equal(boxes.length, 2, 'one box for the prompt override, one for the JSON');
  assert.equal(boxes[0].value, 'Answer as a study aid.', 'the override box holds the override');
  assert.equal(boxes[1].value, JSON.stringify({ fontSize: 18 }, null, 2), 'and the JSON is pretty-printed to be edited');
});

test('each provenance is named in plain language, both languages', async () => {
  // "why is it answering like that" is the question this answers. A box of text with no
  // provenance cannot.
  for (const [source, want] of [['profile', /your override/], ['config', /this node/], ['app', /app’s own/], [undefined, /none · 无/]]) {
    const dom = mkDom();
    const PASettings = load(dom);
    await opened(dom, PASettings, { ok: true, systemPrompt: { effective: 'x', source }, prefs: {} });
    assert.match(dom.find('pag-src').textContent, want, `source=${source}`);
  }
});

test('an app with no preferences yet opens on an EMPTY box, not on "{}"', async () => {
  // "{}" reads as content the user has to delete before typing anything.
  const dom = mkDom();
  const PASettings = load(dom);
  await opened(dom, PASettings, { ok: true, systemPrompt: {}, prefs: {} });
  assert.equal(dom.made.filter((n) => n.tag === 'textarea')[1].value, '');
});

test('a failed READ says so instead of opening on a blank panel that looks like "no settings"', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  await opened(dom, PASettings, { ok: false, error: 'offline · 离线' });
  const msg = dom.find('pag-msg');
  assert.match(msg.textContent, /Could not load settings · 无法加载设置/, 'the failure is on screen (R5)');
  assert.match(msg.textContent, /offline · 离线/, "carrying the shell's own reason");
  assert.ok(msg.classList.contains('pag-err'), 'and marked as an error, not as status');
});

test('with no shell at all the read REPORTS rather than hanging on a promise nobody settles', async () => {
  const dom = mkDom();
  dom.win.parent = { postMessage() { throw new Error('no parent'); } };
  const PASettings = load(dom);
  const host = dom.doc.createElement('div');
  PASettings.attach({ host }).el.fire('click');
  await tick(); await tick();
  assert.match(dom.find('pag-msg').textContent, /no shell · 无法连接外壳/);
});

// ── 5. saving ────────────────────────────────────────────────────────────────────────────────
test('Save sends the parsed JSON and the prompt override, and closes only on success', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  const h = await opened(dom, PASettings, { ok: true, systemPrompt: { effective: 'a', source: 'app' }, prefs: {} });
  const [pTa, jTa] = dom.made.filter((n) => n.tag === 'textarea');
  jTa.value = '{"fontSize": 20}';
  pTa.value = 'Be brief.';
  dom.made.find((n) => n.classList.contains('pag-go')).fire('click');
  await tick();
  const sent = dom.posted[dom.posted.length - 1];
  assert.equal(sent.kind, 'set-app-settings');
  assert.deepEqual(sent.prefs, { fontSize: 20 }, 'PARSED, not the raw string — the shell must not re-parse it');
  assert.equal(sent.systemPrompt, 'Be brief.');
  assert.equal(h.isOpen(), true, 'still open while the write is in flight');
  dom.reply({ ok: true, settings: { systemPrompt: { effective: 'Be brief.', override: 'Be brief.', source: 'profile' }, prefs: { fontSize: 20 } } });
  await tick();
  assert.equal(h.isOpen(), false, 'and closes once the server confirms');
});

test('a failed SAVE keeps the panel open with every edit intact, and says why', async () => {
  // Closing on a failed write loses what the user typed AND tells them it worked. This is the
  // R5 case that matters most here: the write is the only thing that makes any of it durable.
  const dom = mkDom();
  const PASettings = load(dom);
  const h = await opened(dom, PASettings, { ok: true, systemPrompt: {}, prefs: {} });
  const [, jTa] = dom.made.filter((n) => n.tag === 'textarea');
  jTa.value = '{"a":1}';
  dom.made.find((n) => n.classList.contains('pag-go')).fire('click');
  await tick();
  dom.reply({ ok: false, error: 'Preferences too large · 偏好过大' });
  await tick();
  assert.equal(h.isOpen(), true, 'the panel stays open');
  assert.equal(jTa.value, '{"a":1}', 'and the edit is still there to retry');
  const msg = dom.find('pag-msg');
  assert.match(msg.textContent, /Not saved · 未保存/);
  assert.match(msg.textContent, /偏好过大/, "with the SERVER's reason, not a generic one");
  assert.ok(msg.classList.contains('pag-err'));
});

test('invalid JSON is refused locally, said out loud, and never sent', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  const h = await opened(dom, PASettings, { ok: true, systemPrompt: {}, prefs: {} });
  const [, jTa] = dom.made.filter((n) => n.tag === 'textarea');
  const before = dom.posted.length;
  for (const [what, text] of [['broken', '{"a":'], ['an array', '[1,2]'], ['a bare string', '"nope"'], ['a number', '42']]) {
    jTa.value = text;
    dom.made.find((n) => n.classList.contains('pag-go')).fire('click');
    await tick();
    assert.equal(dom.posted.length, before, `${what}: nothing reaches the shell`);
    assert.ok(dom.find('pag-msg').classList.contains('pag-err'), `${what}: and the panel says so`);
    assert.ok(jTa.classList.contains('pag-bad'), `${what}: the box itself is marked`);
    assert.equal(h.isOpen(), true, `${what}: nothing closes`);
  }
});

test('the JSON box reports a mistake WHILE it is typed, not only on Save', async () => {
  // A parse error found only on Save is found after the user has stopped looking at the thing
  // that caused it.
  const dom = mkDom();
  const PASettings = load(dom);
  await opened(dom, PASettings, { ok: true, systemPrompt: {}, prefs: {} });
  const [, jTa] = dom.made.filter((n) => n.tag === 'textarea');
  jTa.value = '{"a":';
  jTa.fire('input');
  assert.ok(jTa.classList.contains('pag-bad'), 'marked while typing');
  assert.match(dom.find('pag-msg').textContent, /Not valid JSON · JSON 格式无效/);
  jTa.value = '{"a":1}';
  jTa.fire('input');
  assert.ok(!jTa.classList.contains('pag-bad'), 'and unmarked as soon as it parses again');
  assert.equal(dom.find('pag-msg').textContent, '', 'with the message cleared');
});

test('an emptied JSON box means "no preferences", not a parse error', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  await opened(dom, PASettings, { ok: true, systemPrompt: {}, prefs: { a: 1 } });
  const [, jTa] = dom.made.filter((n) => n.tag === 'textarea');
  jTa.value = '   ';
  dom.made.find((n) => n.classList.contains('pag-go')).fire('click');
  await tick();
  assert.deepEqual(dom.posted[dom.posted.length - 1].prefs, {}, 'it clears them rather than refusing to save');
});

test('Save and Cancel are disabled while a write is in flight', async () => {
  // Two Saves in flight would race, and the second reply would repaint over the first.
  const dom = mkDom();
  const PASettings = load(dom);
  const h = await opened(dom, PASettings, { ok: true, systemPrompt: {}, prefs: {} });
  const save = dom.made.find((n) => n.classList.contains('pag-go'));
  const cancel = dom.made.filter((n) => n.classList.contains('pag-btn') && !n.classList.contains('pag-go'))[0];
  save.fire('click');
  await tick();
  assert.equal(save.disabled, true, 'Save is disabled mid-write');
  assert.equal(cancel.disabled, true, 'and so is Cancel');
  const at = dom.posted.length;
  save.fire('click');
  await tick();
  assert.equal(dom.posted.length, at, 'a second Save is refused rather than racing the first');
  dom.key('Escape');
  assert.equal(h.isOpen(), true, 'and Escape cannot hide the surface the failure is about to appear on');
  dom.reply({ ok: true });
  await tick();
  assert.equal(save.disabled, false, 'both come back once it settles');
});

test('after a save the panel repaints from what the SERVER now holds', async () => {
  // Adding an override changes the effective prompt AND its source. Re-deriving that here would
  // be a second copy of a rule the server already owns (R3).
  const dom = mkDom();
  const PASettings = load(dom);
  let handed = null;
  const host = dom.doc.createElement('div');
  const h = PASettings.attach({ host, onSave: (s) => { handed = s; } });
  h.el.fire('click'); await tick();
  dom.reply({ ok: true, systemPrompt: { effective: 'default text', source: 'config' }, prefs: {} });
  await tick();
  assert.match(dom.find('pag-src').textContent, /this node/);
  dom.made.find((n) => n.classList.contains('pag-go')).fire('click');
  await tick();
  dom.reply({ ok: true, settings: { systemPrompt: { effective: 'mine', override: 'mine', source: 'profile' }, prefs: {} } });
  await tick();
  assert.equal(dom.find('pag-eff').textContent, 'mine', 'the effective text is the server\'s answer');
  assert.match(dom.find('pag-src').textContent, /your override/, 'and so is the source');
  assert.ok(handed && handed.systemPrompt, 'the host is handed the settled settings so it can react');
});

// ── 6. dismissal ─────────────────────────────────────────────────────────────────────────────
test('Escape and a backdrop click close it; a click inside does not', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  const h = await opened(dom, PASettings, { ok: true, systemPrompt: {}, prefs: {} });
  const ov = dom.find('pag-ov'), dlg = dom.find('pag-dlg');
  ov.fire('click', { target: dlg });
  assert.equal(h.isOpen(), true, 'a click inside the dialog must not dismiss it');
  ov.fire('click', { target: ov });
  assert.equal(h.isOpen(), false, 'the backdrop does');
  h.el.fire('click'); await tick(); dom.reply({ ok: true, systemPrompt: {}, prefs: {} }); await tick();
  assert.equal(h.isOpen(), true);
  dom.key('Escape');
  assert.equal(h.isOpen(), false, 'and so does Escape');
  assert.equal((dom.docKeys.keydown || []).length, 0, 'the key listener is removed, not left stacking per open');
});

test('reopening does not stack key listeners', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  const h = await opened(dom, PASettings, { ok: true, systemPrompt: {}, prefs: {} });
  for (let i = 0; i < 3; i++) { h.open(); await tick(); }
  assert.equal((dom.docKeys.keydown || []).length, 1, 'open() is idempotent');
  assert.equal(dom.posted.length, 1, 'and a redundant open does not re-fetch');
});

// ── 7. the Bible, the first consumer ─────────────────────────────────────────────────────────
const BIBLE = fs.readFileSync(path.join(ROOT, 'workspace.example', 'apps', 'bible', 'index.html'), 'utf8');
const LIVE_PATH = path.join(ROOT, 'workspace', 'apps', 'bible', 'index.html');
const LIVE = fs.existsSync(LIVE_PATH) ? fs.readFileSync(LIVE_PATH, 'utf8') : null;

test('both Bibles put the ⚙ in their OWN header bar, and carry the marker', () => {
  for (const [label, src] of [['template', BIBLE], ['live', LIVE]]) {
    if (!src) continue;
    const code = stripComments(src);
    assert.match(code, /PASettings\.attach\(\{\s*host:\s*document\.getElementById\('nav'\)/,
      `${label}: the button goes in #nav, the app's own bar — not a floating control of its own`);
    assert.ok(src.includes('<!--PA_SETTINGS_UI-->'),
      `${label}: without the marker web.mjs serves 200 with the component silently absent`);
    // Guarded, so an app page served without the marker still boots (the same shape splitOn uses).
    assert.match(code, /window\.PASettings/, `${label}: the mount is guarded on the component existing at all`);
  }
});

// ── 8. the SHELL half: scoping, precedence, and the write ────────────────────────────────────
// The app is sandboxed and must never call /api/profile itself — the profile carries the
// member's name, notes, briefing email and every other app's settings. The shell reads it and
// hands back ONE APP'S SLICE. That scoping is run here, not grepped.
const SHELL_SRC = (await import('./helpers-app.mjs')).SHELL;

const loadShell = loadShellAppSettings;   // the shell's own app-settings block, run (test/helpers-shell-broker.mjs)

const FULL_ME = {
  name: 'Owner', about: 'twelve years of private notes', briefingEmail: 'me@example.com',
  prefs: 'short answers', postcode: 'AB1 2CD',
  appPrefs: { bible: { fontSize: 18 }, notes: { secretLayout: 'x' } },
  appModels: { bible: 'mistral' },
  systemPrompts: { global: 'be terse', apps: { bible: 'study aid', notes: 'other app' } },
  systemPromptDefaults: { global: 'g', apps: { bible: 'node default', notes: 'nd' } },
};

test('the shell hands the app ONLY its own slice — never the rest of the profile', () => {
  const { appSettingsOf } = loadShell({ me: FULL_ME });
  const out = appSettingsOf('bible', 'the app\'s own');
  assert.deepEqual(Object.keys(out).sort(), ['prefs', 'systemPrompt'], 'two keys, nothing else');
  assert.deepEqual(out.prefs, { fontSize: 18 }, 'this app\'s preferences');
  const flat = JSON.stringify(out);
  for (const leak of ['twelve years', 'me@example.com', 'AB1 2CD', 'secretLayout', 'other app', 'be terse', 'Owner']) {
    assert.ok(!flat.includes(leak), `${leak} must not cross into a sandboxed app`);
  }
});

test('the prompt precedence is the SAME chain the chat route resolves (R3)', () => {
  // web.mjs resolveSystemPrompts returns `appOver || appDefault || appSent || null`. The panel
  // answers without a round trip to the chat route, so the order lives in two places; if they
  // drift, the panel tells the user one thing and the model is told another.
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  const route = /return \{ global, app: ([^}]+?) \};/.exec(web);
  assert.ok(route, 'resolveSystemPrompts still returns its chain in one expression');
  assert.deepEqual(route[1].split('||').map((s) => s.trim()), ['appOver', 'appDefault', 'appSent', 'null'],
    'the route resolves override, then node default, then the app\'s own');
  const shellChain = /const eff=([^;]+);/.exec(SHELL_SRC.slice(SHELL_SRC.indexOf('function appPromptOf')));
  assert.ok(shellChain, 'and the shell resolves its own in one expression');
  assert.deepEqual(shellChain[1].split('||').map((s) => s.trim()), ['pick(over)', 'pick(dflt)', 'sent', 'null'],
    'in the SAME order — override, node default, the app\'s own');

  // And the resolution really behaves that way, not just reads that way.
  const { appPromptOf } = loadShell({ me: FULL_ME });
  assert.equal(appPromptOf('bible', 'app own').effective, 'study aid', 'an override wins');
  assert.equal(appPromptOf('bible', 'app own').source, 'profile');
  const noOver = loadShell({ me: { ...FULL_ME, systemPrompts: { apps: {} } } });
  assert.equal(noOver.appPromptOf('bible', 'app own').effective, 'node default', 'then the node default');
  assert.equal(noOver.appPromptOf('bible', 'app own').source, 'config');
  const bare = loadShell({ me: {} });
  assert.equal(bare.appPromptOf('bible', 'app own').effective, 'app own', "then the app's own");
  assert.equal(bare.appPromptOf('bible', 'app own').source, 'app');
  assert.equal(bare.appPromptOf('bible', '').source, 'none', 'and nothing at all is named as such');
  assert.equal(bare.appPromptOf('bible', '   ').source, 'none', 'whitespace is not a prompt');
});

test('the override box shows ONLY the user\'s own override, never the default text', async () => {
  // Prefilling it with the default would turn "I have not overridden this" into an override the
  // moment the user pressed Save, freezing today's default for ever.
  const { appPromptOf } = loadShell({ me: { systemPromptDefaults: { apps: { bible: 'node default' } } } });
  const p = appPromptOf('bible', 'app own');
  assert.equal(p.effective, 'node default', 'the default is what is in force');
  assert.equal(p.override, '', 'but the override box is empty');
});

test('saving sends the FULL maps, so no other app loses its settings', async () => {
  const s = loadShell({ me: JSON.parse(JSON.stringify(FULL_ME)) });
  const r = await s.saveAppSettings('bible', { fontSize: 22 }, 'my own prompt', 'app own');
  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, '/api/profile');
  assert.equal(s.calls[0].opts.method, 'PUT');
  assert.deepEqual(s.calls[0].body.appPrefs, { bible: { fontSize: 22 }, notes: { secretLayout: 'x' } },
    'the other app\'s preferences ride along — the route replaces the whole map');
  assert.deepEqual(s.calls[0].body.systemPrompts.apps, { bible: 'my own prompt', notes: 'other app' },
    'and so does the other app\'s prompt override');
  assert.equal(s.calls[0].body.systemPrompts.global, 'be terse', 'the global override is not dropped either');
  assert.equal(r.settings.systemPrompt.source, 'profile', 'and the reply is re-resolved from what was just saved');
});

test('a BLANK override clears it, so the default starts flowing again', async () => {
  const s = loadShell({ me: JSON.parse(JSON.stringify(FULL_ME)) });
  await s.saveAppSettings('bible', {}, '   ', 'app own');
  assert.deepEqual(Object.keys(s.calls[0].body.systemPrompts.apps), ['notes'], 'this app\'s entry is gone');
  assert.equal(s.me.systemPrompts.apps.bible, undefined, 'and ME is in step without a re-fetch');
});

test('a failed save is REPORTED and ME is left untouched', async () => {
  for (const [what, respond] of [
    ['a refusal', async () => ({ ok: false, status: 400, json: async () => ({ error: 'Preferences too large · 偏好过大' }) })],
    ['a dropped request', async () => { throw new Error('Failed to fetch'); }],
    ['a non-JSON error body', async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } })],
  ]) {
    const s = loadShell({ me: JSON.parse(JSON.stringify(FULL_ME)), respond });
    const r = await s.saveAppSettings('bible', { fontSize: 99 }, 'x', 'app own');
    assert.equal(r.ok, false, what);
    assert.ok(r.error, `${what}: with a reason`);
    assert.deepEqual(s.me.appPrefs.bible, { fontSize: 18 }, `${what}: the profile object is unchanged`);
    assert.equal(s.me.systemPrompts.apps.bible, 'study aid', `${what}: including the prompt override`);
  }
});

test('a save with no app in view, or a non-object blob, is refused before the network', async () => {
  const s = loadShell({ me: {} });
  assert.equal((await s.saveAppSettings('', {}, '', '')).ok, false, 'no slug');
  for (const bad of [null, [1], 'x', 42]) {
    assert.equal((await s.saveAppSettings('bible', bad, '', '')).ok, false, `blob ${JSON.stringify(bad)}`);
  }
  assert.equal(s.calls.length, 0, 'none of them reach the server');
});

test('the broker uses the slug the SHELL derives, never one the app supplies', () => {
  // An app that could name its own slug could read and overwrite another app's settings.
  assert.match(SHELL_SRC, /reply\(\{ok:true, \.\.\.appSettingsOf\(appSlug, m\.appPrompt\)\}\)/,
    'the read is keyed to appSlug');
  assert.match(SHELL_SRC, /const saved=await saveAppSettings\(appSlug, m\.prefs, m\.systemPrompt, m\.appPrompt\); reply\(saved\);/,
    'and so is the write — AWAITED, or a failure is replied as an unresolved promise (R5)');
  assert.ok(!/appSettingsOf\(m\.(slug|app)/.test(SHELL_SRC), 'no path takes the slug from the message');
});

test('a profile that never loaded reads as empty settings, not as a crash', () => {
  for (const me of [{}, { appPrefs: null }, { appPrefs: 'x' }, { systemPrompts: 'x' }]) {
    const { appSettingsOf } = loadShell({ me });
    const out = appSettingsOf('bible', '');
    assert.deepEqual(out.prefs, {}, `ME=${JSON.stringify(me)}`);
    assert.equal(out.systemPrompt.source, 'none');
  }
});

// ── readout extras: a line the sheet SHOWS, never a box it saves (the Bible's device readout) ──
// TODO(R4 seam): this file is over budget; split the extras tests (this one + the explain-prompt ones) into test/app-settings-extras.test.mjs.
test('an extra with readout:true renders a .pag-eff line filled on open, has no textarea, and Save never calls onCommit for it', async () => {
  const dom = mkDom();
  const PASettings = load(dom);
  const host = dom.doc.createElement('div');
  let reads = 0, commits = 0;
  const h = PASettings.attach({ host, extras: [
    { label: 'Device readout · 设备读数', readout: true, getValue: () => { reads++; return 'Device 设备: 834×1194 px'; }, onCommit: async () => { commits++; return { ok: true }; } },
    { label: 'Box', getValue: () => 'typed', onCommit: async () => { commits++; return { ok: true }; } },
  ] });
  h.el.fire('click'); await tick();
  dom.reply({ ok: true, systemPrompt: {}, prefs: {} }); await tick();
  const lines = dom.made.filter((n) => n.classList.contains('pag-eff'));
  assert.equal(lines.length, 2, 'the effective-prompt line and the readout line');
  assert.equal(lines[1].tag, 'div'); assert.equal(lines[1].textContent, 'Device 设备: 834×1194 px', 'filled when the sheet opens');
  assert.equal(reads, 1);
  assert.equal(dom.made.filter((n) => n.tag === 'textarea').length, 3, 'prompt, prefs and the one typed extra — no box for the readout');
  dom.made.find((n) => n.classList.contains('pag-go')).fire('click'); await tick();
  dom.reply({ ok: true, settings: { systemPrompt: {}, prefs: {} } }); await tick(); await tick();
  assert.equal(commits, 1, 'the typed extra was committed; the readout never is (even with an onCommit passed by mistake)');
});

