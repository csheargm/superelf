// PANote paste ownership + markdown conversion — the surviving half of the 2026-09-02 scar work.
//
// SYMPTOM (f) of the incident: a markdown converter was added to the engine while an app already
// had one, so ONE paste ran TWO handlers and the pasted answer landed twice, in two dialects.
// The engine now OWNS the paste event (a capture-phase document listener plus a per-event claim
// flag) and apps supply a `pasteConverter` instead of a listener.
//
// This file was split out of test/note-draft-integrity.test.mjs when the draft mechanism was
// DELETED (round 4). The draft tests went with the mechanism; these did not — the paste path is
// unrelated to durability and was verified unbroken, so it keeps its coverage under a name that
// says what it covers.
//
// HARNESS FIDELITY (R14): the paste block is EXTRACTED from web/note-ui.inline.html and RUN
// against a faithful DOM event shim (capture → target → bubble, with stopPropagation and
// stopImmediatePropagation). The shim's fidelity is not assumed: the control below proves it
// REPRODUCES the two-handler double insert once the engine's claim is removed, and the mutation
// at the bottom proves each guard is load-bearing.
// R11 — searched: "PASTE_OWNED", "pasteTargetsPad", "pasteConverter", "mdToHtml", "onDocPaste"
//   — all owned by web/note-ui.inline.html; this file only consumes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');

// ── Extract the engine's DOM-free core and RUN IT (the same slice the other suites use) ────────
function coreFrom(engineSrc) {
  const from = engineSrc.indexOf('  const SCHEMA=');
  const to = engineSrc.indexOf('\n  function Note(host, opts){');
  assert.ok(from > 0 && to > from, 'the engine core must stay a DOM-free block above function Note()');
  // eslint-disable-next-line no-new-func
  return new Function(`${engineSrc.slice(from, to)}
    return {mdToHtml,looksLikeMarkdown,plainToHtml,sanitizeHtml,HTML_TAGS,STYLE_OK};`)();
}
const G = coreFrom(ENGINE);

test('control: the extraction found real converters, not a stub', () => {
  assert.equal(typeof G.mdToHtml, 'function');
  assert.equal(G.mdToHtml('a **b** c'), 'a <strong>b</strong> c');
  assert.equal(G.looksLikeMarkdown('just a sentence'), false);
});

// ══ 5. SYMPTOM (f): EXACTLY ONE paste handler per paste event ════════════════════════════════

// A faithful DOM event shim: capture phase root→target, then target, then bubble target→root,
// with stopPropagation / stopImmediatePropagation semantics. Its fidelity is not assumed — the
// control test below proves it REPRODUCES the two-handler double insert when the engine's claim
// is removed. A shim that could not fail that way would prove nothing (R14).
function makeDom() {
  const mk = (name, parent) => {
    const el = { name, parent: parent || null, children: [], listeners: [], cls: new Set(),
      addEventListener(t, fn, cap) { el.listeners.push({ t, fn, cap: !!cap }); },
      removeEventListener(t, fn, cap) { const i = el.listeners.findIndex((l) => l.t === t && l.fn === fn && l.cap === !!cap); if (i >= 0) el.listeners.splice(i, 1); },
      contains(n) { for (let c = n; c; c = c.parent) if (c === el) return true; return false; },
      closest(sel) { const want = sel.replace(/^\./, '').split('.'); for (let c = el; c; c = c.parent) if (want.every((w) => c.cls.has(w))) return c; return null; } };
    if (parent) parent.children.push(el);
    return el;
  };
  const doc = mk('#document', null);
  doc.activeElement = null;
  doc.dispatch = (target, ev) => {
    const path = []; for (let n = target; n; n = n.parent) path.unshift(n);
    ev.target = target;
    let stop = false, stopAll = false;
    ev.stopPropagation = () => { stop = true; };
    ev.stopImmediatePropagation = () => { stop = true; stopAll = true; };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    const fire = (node, capture) => {
      stopAll = false;
      for (const l of node.listeners.slice()) {
        if (l.t !== ev.type || l.cap !== capture) continue;
        l.fn(ev);
        if (stopAll) return;
      }
    };
    for (const n of path) { fire(n, true); if (stop) return ev; }                    // capture, root → target
    fire(target, false); if (stop) return ev;                                        // target, bubble listeners
    for (const n of path.slice(0, -1).reverse()) { fire(n, false); if (stop) return ev; }
    return ev;
  };
  return { doc, mk };
}
// Extract the engine's paste block and run it against the shim + the engine's REAL converters.
const PASTE_FROM = "    const PASTE_OWNED='__paNotePaste';";
const PASTE_TO = "    document.addEventListener('paste',onDocPaste,true);";
// `mutate` is applied to the EXTRACTED block, so a mutation may delete the very marker the
// extraction needs (the claim itself is one of them).
function mountPaste({ converter = null, dom = makeDom(), mutate = (s) => s } = {}) {
  const from = ENGINE.indexOf(PASTE_FROM), to = ENGINE.indexOf(PASTE_TO);
  assert.ok(from > 0 && to > from, 'the paste block must stay locatable in the engine');
  const src = mutate(ENGINE.slice(from, to + PASTE_TO.length));
  const textLayer = dom.mk('textlayer', dom.doc);
  textLayer.cls.add('pan-textlayer'); textLayer.cls.add('pan-txted');
  const log = { inserts: [], commits: 0, flashes: [], converter: 0 };
  // sanitizeHtml is the ONE piece of the paste path that needs a real DOM (it parses into an inert
  // document), so here it is the identity — justified, not waved through: mdToHtml's output is a
  // documented FIXPOINT of sanitizeHtml, and `fixpointCheck` below re-proves that for every string
  // this file pastes, against the engine's own HTML_TAGS/STYLE_OK. Sanitizing itself is proven in
  // test/note-load-safety.test.mjs (V3) and the browser e2e; what is under test HERE is how many
  // handlers run per event, which no sanitizer can affect.
  const env = {
    looksLikeMarkdown: G.looksLikeMarkdown, sanitizeHtml: (h) => h, mdToHtml: G.mdToHtml, plainToHtml: G.plainToHtml,
    document: dom.doc, window: { getSelection: () => ({ rangeCount: 0 }) },
    // Counting stubs for the two DOM effects; the OWNERSHIP question is how many times they run.
    insertHtmlAtCaret: (html) => { log.inserts.push(html); return true; },
    commitPageHtml: () => { log.commits++; }, flash: (m) => { log.flashes.push(m); },
    textLayer, opts: { pasteConverter: converter ? (t) => { log.converter++; return converter(t); } : null },
    txtEdit: { el: textLayer },
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('env', `
    const {looksLikeMarkdown,sanitizeHtml,mdToHtml,plainToHtml,document,window,insertHtmlAtCaret,
           commitPageHtml,flash,textLayer,opts} = env;
    let txtEdit = env.txtEdit, textTimer = 0;
${src}
    return {onPaste,onDocPaste};`)(env);
  // enterTextMode() also binds the region's own listener; mirrored here so the harness has BOTH
  // registrations the real pad has — without it, "exactly one handler ran" would be measuring a
  // pad that only ever had one (R14).
  textLayer.addEventListener('paste', api.onPaste, false);
  return { dom, textLayer, log, api };
}
const pasteEvent = (text, html = '') => ({ type: 'paste', defaultPrevented: false,
  clipboardData: { types: html ? ['text/plain', 'text/html'] : ['text/plain'], getData: (t) => (t === 'text/plain' ? text : html) } });

test('control: an identity sanitizer is exact for what this file pastes (mdToHtml is a fixpoint)', () => {
  for (const s of ['## grace 恩典\n\n**faith** and *trust*', '**faith**', '- one 一\n- two 二', '## 恩典']) {
    const html = G.mdToHtml(s);
    for (const m of html.matchAll(/<([a-z]+)[\s>]/g))
      assert.ok(G.HTML_TAGS[m[1].toUpperCase()], `<${m[1]}> must be allow-listed, or the identity sanitizer would be a lie`);
    for (const m of html.matchAll(/style="([^"]+)"/g))
      for (const decl of m[1].split(';').filter(Boolean))
        assert.ok(G.STYLE_OK[decl.split(':')[0].trim()], 'every style property must be allow-listed too');
  }
});

test('control: the event shim reproduces the two-handler double insert it is meant to detect', () => {
  const { dom, textLayer, log } = mountPaste({ mutate: (s) => s.replace(PASTE_TO, '/* claim removed */') });
  // A legacy app listener, exactly like the one the Bible app registered: document, CAPTURE phase.
  let appRuns = 0;
  dom.doc.addEventListener('paste', (e) => { appRuns++; e.preventDefault(); log.inserts.push('APP'); }, true);
  dom.doc.dispatch(textLayer, pasteEvent('## grace 恩典\n\n**faith**'));
  assert.equal(appRuns, 1, 'the app handler ran');
  assert.equal(log.inserts.length, 2, 'AND the engine handler ran too — one paste, two insertions: the round-2 regression');
});

test('(f) exactly ONE handler runs per paste — the engine claims the event', () => {
  const { dom, textLayer, log } = mountPaste();
  let appRuns = 0;
  dom.doc.addEventListener('paste', (e) => { appRuns++; log.inserts.push('APP'); }, true);   // registered AFTER the pad mounted
  const ev = dom.doc.dispatch(textLayer, pasteEvent('## grace 恩典\n\n**faith** and *trust*'));
  assert.equal(appRuns, 0, 'the app listener never sees it — stopImmediatePropagation');
  assert.equal(log.inserts.length, 1, 'EXACTLY ONE insertion for one paste event');
  assert.equal(log.commits, 1, 'and exactly one commit');
  assert.equal(ev.defaultPrevented, true, 'the native paste is suppressed once, by the owner');
  assert.match(log.inserts[0], /<strong>faith<\/strong>/, 'the markdown really was converted');
  assert.equal(ev.__paNotePaste, true, 'the event is marked, so any re-entry is a no-op');
});

test('(f) a second dispatch of the SAME event object inserts nothing more (idempotent)', () => {
  const { dom, textLayer, log, api } = mountPaste();
  const ev = dom.doc.dispatch(textLayer, pasteEvent('- one 一\n- two 二'));
  assert.equal(log.inserts.length, 1);
  api.onPaste(ev); api.onDocPaste(ev);                       // the region listener + a re-entry
  assert.equal(log.inserts.length, 1, 'still one — PASTE_OWNED gates every later handler');
});

test('(f) an app supplies its RENDERER, not a listener — and it runs exactly once', async () => {
  const seen = [];
  const { dom, textLayer, log } = mountPaste({
    converter: async (t) => { seen.push(t); return '<div><b>from the app</b></div>'; },
  });
  dom.doc.dispatch(textLayer, pasteEvent('## 恩典'));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(log.converter, 1, 'the app converter ran ONCE');
  assert.deepEqual(seen, ['## 恩典'], 'with the plain-text clipboard');
  assert.equal(log.inserts.length, 1, 'and produced exactly one insertion');
  assert.match(log.inserts[0], /from the app/);
  assert.equal(log.flashes.length, 0, 'no degrade to report');
});

test('(f) a converter that throws, stalls or returns nothing never eats the paste (R5)', async () => {
  for (const conv of [async () => { throw new Error('broker down'); }, async () => '', async () => null]) {
    const { dom, textLayer, log } = mountPaste({ converter: conv });
    dom.doc.dispatch(textLayer, pasteEvent('**faith**'));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(log.inserts.length, 1, 'the text still lands, exactly once');
    assert.match(log.inserts[0], /<strong>faith<\/strong>/, 'via the engine\'s own conversion');
    assert.equal(log.flashes.length, 1, 'and the degrade is said out loud');
    assert.match(log.flashes[0], /已用内置格式粘贴/, 'bilingually');
  }
});

test('(f) a paste OUTSIDE the pad, and an image paste, are left alone', () => {
  const { dom, log } = mountPaste();
  const elsewhere = dom.mk('input', dom.doc);                 // a search box, a rename field
  let appRuns = 0;
  dom.doc.addEventListener('paste', () => { appRuns++; }, true);
  const ev1 = dom.doc.dispatch(elsewhere, pasteEvent('hello'));
  assert.equal(log.inserts.length, 0, 'the engine did not touch it');
  assert.equal(appRuns, 1, 'and the app still got it');
  assert.equal(ev1.defaultPrevented, false);
  const { dom: d2, textLayer: t2, log: l2 } = mountPaste();
  const img = { type: 'paste', defaultPrevented: false, clipboardData: { types: ['Files'], getData: () => '' } };
  d2.doc.dispatch(t2, img);
  assert.equal(l2.inserts.length, 0, 'an image/file paste is not ours to handle');
  assert.equal(img.defaultPrevented, false, 'so the browser still performs it');
});

test('(f) the engine is the documented single owner, and no app-side listener is needed', () => {
  assert.match(ENGINE, /document\.addEventListener\('paste',onDocPaste,true\);/, 'the engine claims the event at mount');
  assert.match(ENGINE, /document\.removeEventListener\('paste',onDocPaste,true\)/, 'and releases it on destroy');
  assert.match(ENGINE, /if\(e\[PASTE_OWNED\]\) return;/, 'one run per event');
  assert.match(ENGINE, /pasteTargetsPad:\(e\)=>/, 'and an app listener that cannot be removed can bow out');
  assert.match(ENGINE, /pasteConverter: async\(plainText\)=> htmlString/, 'the hook apps consume is documented in the mount contract');
});


// ══ AUDIT: the two engine surfaces this file also owns ═══════════════════════════════════════

test('audit: a load SUCCESS does not discard unsaved work the pad already holds', () => {
  assert.match(ENGINE, /const keptMemory=!!\(clean&&!reset&&guard\.state\(\)\.unsaved&&pickRicher\(clean,NB\)===NB\);/,
    'pull() keeps the richer copy on a same-note pull');
  assert.match(ENGINE, /if\(keptMemory\) guard\.touch\(\);/, 'and what memory kept stays dirty, so it is written back');
  // A scope switch must NOT merge: the pad holds the OUTGOING note there.
  assert.match(ENGINE, /!reset&&guard\.state\(\)\.unsaved/, 'the protection is scoped to a same-note pull');
});

test('audit: the photo-insert failure names its reason AND the cap, bilingually (leftover (e))', () => {
  assert.ok(!/flash\('Upload failed'\)/.test(ENGINE), 'the reasonless English-only message is gone');
  // ROUND 4: the pre-flight said 图片过大 while the shell said 照片过大, and it named the PHOTO'S
  // size instead of the LIMIT — so the message did not say what would fit. One wording, one number.
  assert.match(ENGINE, /big:\(limit\)=>'照片过大 · Photo too large \(max '\+photoMB\(limit\)\+'\)'/,
    'the size refusal names the CAP, in the shell\'s own wording');
  assert.match(ENGINE, /flash\(PHOTO_TXT\.big\(PHOTO_MAX_BYTES\)\+PHOTO_TXT\.bigAct\)/, 'and the pre-flight uses it');
  assert.match(ENGINE, /flash\(PHOTO_TXT\.failed\+\(\(r&&\(r\.text\|\|r\.error\)\)\?' — '\+\(r\.text\|\|r\.error\):''\)\)/,
    "and a post-facto failure prefers the shell's RENDERED sentence over the raw error");
  assert.match(ENGINE, /flash\(PHOTO_TXT\.broken\+' — '\+String\(\(err&&err\.message\)\|\|err\)\)/, 'a thrown failure carries its message');
});

// ══ MUTATION — revert the claim, prove the suite goes RED ════════════════════════════════════

test('mutation — the engine stops claiming the paste — two handlers run again (f)', () => {
  // Proven above by the shim control; pinned here as the paired mutation so the claim cannot be
  // deleted without a red test.
  const broken = mountPaste({ mutate: (s) => s.replace(PASTE_TO, '/* claim removed */') });
  broken.dom.doc.addEventListener('paste', (e) => { broken.log.inserts.push('APP'); }, true);
  broken.dom.doc.dispatch(broken.textLayer, pasteEvent('**faith**'));
  assert.equal(broken.log.inserts.length, 2, 'without the claim one paste inserts twice');
  // …and the flag alone is not enough either: an app listener in the CAPTURE phase runs first.
  const noFlag = mountPaste({ mutate: (s) => s.replace('if(e[PASTE_OWNED]) return;', '') });
  noFlag.dom.doc.dispatch(noFlag.textLayer, pasteEvent('**faith**'));
  noFlag.api.onPaste(noFlag.dom.doc.dispatch(noFlag.textLayer, pasteEvent('**faith**')));
  assert.equal(noFlag.log.inserts.length, 3, 'without PASTE_OWNED a re-entrant handler inserts again');
  const real = mountPaste();
  real.dom.doc.addEventListener('paste', (e) => { real.log.inserts.push('APP'); }, true);
  real.dom.doc.dispatch(real.textLayer, pasteEvent('**faith**'));
  assert.equal(real.log.inserts.length, 1, 'with it, exactly one');
});
