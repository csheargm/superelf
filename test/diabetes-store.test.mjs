// The Diabetes Tracker's STORE（血糖记录的存储）— the accept/refuse decision behind every write
// of a health record.
//
// WHY THIS FILE EXISTS
// Until 2026-09-11 this app kept its readings and HbA1c entries in localStorage. An app here
// runs sandboxed at an OPAQUE ORIGIN (web/index.html: iframe sandbox="allow-scripts", no
// allow-same-origin), where every storage API throws SecurityError. So `save()` threw inside the
// click handler, the reading was never written, `render()` never ran, and "Save reading" was a
// dead button. Measured before the fix: workspace/data/diabetes/ was EMPTY on disk — nothing the
// app had ever logged by hand existed anywhere. Nothing failed to say so, because nothing
// checked; that is exactly the vacuous success R14 forbids.
//
// The camera work makes this the store a MODEL'S READING of a photograph lands in, so the rules
// below are not housekeeping:
//   · a read resolves loaded / absent / failed and never collapses them;
//   · `absent` is EARNED by the shell's own code:'not-found', never inferred;
//   · a FAILED read BLOCKS writing to that path — an unreadable store is not an empty one, and
//     writing over it is the 2026-09-02 empty-overwrite class (months of history → {}, ok:true);
//   · every refusal reaches the USER, on the page it failed to write (R5).
//
// Nothing here restates those rules: the store block is EXTRACTED from the committed app and
// RUN, and the 404 → 'not-found' mapping it depends on is proved against a real web.mjs over
// real HTTP rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';   // TODO(R4 seam): this file is over budget; split by test group (one describe per file)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');   // throws if moved — a renamed file fails here, never passes vacuously
const APP_TEMPLATE = 'workspace.example/apps/diabetes/index.html';
const APP_LIVE = 'workspace/apps/diabetes/index.html';
const SRC = read(APP_TEMPLATE);
const SHELL = read('web/index.html');

const between = (src, a, b) => {
  const i = src.indexOf(a);
  assert.ok(i >= 0, `the store block must stay findable: missing ${JSON.stringify(a)}`);
  const j = src.indexOf(b, i + a.length);
  assert.ok(j > i, `the store block must stay contiguous: missing ${JSON.stringify(b)}`);
  return src.slice(i, j + b.length);
};

// The REAL block, run with a scripted broker and a one-element DOM. Nothing is re-implemented:
// if the app's guard changes, this changes with it or fails.
const BLOCK = between(SRC, "const DATA_PATH='readings.json'", 'async function save(d){DB=d;return persist();}');
assert.ok(BLOCK.length > 800, 'the extraction found the real store, not an empty match (R14)');

function mkStore(reply) {
  const el = { textContent: '', style: { display: 'none' } };
  const doc = { getElementById: (id) => (id === 'storeMsg' ? el : null) };
  const sent = [];
  const pa = async (kind, payload) => { sent.push({ kind, ...payload }); return reply(kind, payload); };
  // eslint-disable-next-line no-new-func
  const api = new Function('pa', 'document', `${BLOCK}
    return { storeRead, storeWrite, persist, storeMsg, blockedPaths, dbShapeOk, load, save,
             DATA_PATH, STORE_NOT_FOUND, setDB:(v)=>{DB=v;} };`)(pa, doc);
  return { ...api, sent, msg: el };
}
const okReply = (text) => ({ ok: true, text });
const GOOD = JSON.stringify({ readings: [{ ts: 1, val: 95, ctx: 'fasting' }], a1c: [] });

/* ══ PART A — the read resolves three states, and only one of them is "empty" ═════════════ */

test('A1 — a store that has never been written is absent, not blocked: the first save goes through', async () => {
  const s = mkStore((kind) => (kind === 'data' ? { ok: false, code: 'not-found', error: 'not found' } : { ok: true }));
  const v = await s.storeRead(s.DATA_PATH, { readings: [], a1c: [] }, s.dbShapeOk);
  assert.deepEqual(v, { readings: [], a1c: [] }, 'first run starts empty');
  assert.equal(s.blockedPaths.size, 0, 'and nothing is blocked — this is the ONE legitimate empty');
  assert.equal(s.msg.textContent, '', 'so the user is shown no error');
  const w = await s.storeWrite(s.DATA_PATH, GOOD);
  assert.equal(w.ok, true);
  assert.equal(s.sent.filter((m) => m.kind === 'save-data').length, 1, 'the write really reached the broker');
});

test('A2 — a read that FAILED blocks the write, and no save-data is ever sent', async () => {
  // THE guard. A 401 after a server restart, a 500, a dropped socket: every one of them used to
  // arrive at this app as `catch { allScans = [] }` and the next save wrote that emptiness back.
  for (const bad of [
    { ok: false, code: 'relay-error', error: 'relay failed' },
    { ok: false, code: 'unauthorized', text: '登录已过期 · Signed out' },
    { ok: false, code: 'timeout', error: '外壳无响应 · no answer from the app shell' },
    { ok: true, text: '{not json' },
    { ok: true, text: JSON.stringify({ readings: 'nope', a1c: [] }) },
    { ok: true, text: JSON.stringify([1, 2, 3]) },
  ]) {
    const s = mkStore((kind) => (kind === 'data' ? bad : { ok: true }));
    const v = await s.storeRead(s.DATA_PATH, { readings: [], a1c: [] }, s.dbShapeOk);
    assert.deepEqual(v, { readings: [], a1c: [] }, `${bad.code || 'bad content'}: the UI still has something to render`);
    assert.equal(s.blockedPaths.has(s.DATA_PATH), true, `${bad.code || 'bad content'}: but the path is BLOCKED`);
    const w = await s.storeWrite(s.DATA_PATH, GOOD);
    assert.equal(w.ok, false, `${bad.code || 'bad content'}: the write is refused`);
    assert.ok(w.error, 'with a reason');
    assert.equal(s.sent.filter((m) => m.kind === 'save-data').length, 0,
      `${bad.code || 'bad content'}: and NOTHING was sent — an unreadable store is never overwritten`);
    // R5: the refusal is on the page, not in a console.
    assert.ok(s.msg.textContent.length > 0, 'the reason is shown to the user');
    assert.equal(s.msg.style.display, 'block');
    assert.match(s.msg.textContent, /[一-鿿]/, 'bilingual, like every other refusal in this tree');
  }
});

test('A3 — a good read unblocks and persists; persist() reports a refused write instead of claiming success', async () => {
  let mode = 'ok';
  const s = mkStore((kind) => {
    if (kind === 'data') return okReply(GOOD);
    return mode === 'ok' ? { ok: true } : { ok: false, text: '笔记过长 (max 4 MB) · Note too large' };
  });
  const v = await s.storeRead(s.DATA_PATH, { readings: [], a1c: [] }, s.dbShapeOk);
  assert.equal(v.readings.length, 1, 'the stored readings come back');
  s.setDB(v);
  assert.equal(await s.persist(), true, 'a good write reports true');
  assert.equal(s.msg.textContent, '', 'and clears the banner');
  mode = 'refused';
  assert.equal(await s.persist(), false, 'a refused write reports FALSE — never a silent success');
  assert.match(s.msg.textContent, /未保存 · Not saved — 笔记过长 \(max 4 MB\) · Note too large/,
    "and shows the SHELL'S own sentence, not a generic one");
});

test('A4 — an empty file is absent, and a standing block is not cleared by an unrelated success', async () => {
  const s = mkStore((kind) => (kind === 'data' ? okReply('   ') : { ok: true }));
  assert.deepEqual(await s.storeRead(s.DATA_PATH, { readings: [], a1c: [] }, s.dbShapeOk), { readings: [], a1c: [] });
  assert.equal(s.blockedPaths.size, 0, 'an empty file really is no content');
  s.blockedPaths.set('scans.json', '无法读取 · scans unreadable');
  s.storeMsg('');
  assert.equal(s.msg.textContent, '无法读取 · scans unreadable',
    'clearing the message must not hide a store that is STILL blocked');
});

/* ══ PART B — the codes the guard branches on are the shell's real ones ═══════════════════ */

test("B1 — 'not-found' is the shell's own 404 code, and web.mjs really answers 404 for a missing file", async () => {
  const s = mkStore(() => ({ ok: true }));
  assert.equal(s.STORE_NOT_FOUND, 'not-found', 'the app branches on this exact string');
  assert.match(SHELL, /if\(r\.status===404\) return \{ok:false,code:'not-found'/,
    'and the shell relay really maps a 404 to it — a drifted copy would turn "nothing stored yet" into a permanent block');
  // Proved over real HTTP rather than assumed: a store file that does not exist must 404, and a
  // written one must come back byte-identical. If either changed, the app would either refuse to
  // start on a fresh install or start blank over real data.
  const port = await freePort();
  const root = mkWebRoot({ port });
  const web = startWeb(root);
  try {
    await waitReady(port);
    const miss = await api(port, '/api/data/data/diabetes/readings.json');   // the broker's shape: data/<slug>/<file>
    assert.equal(miss.status, 404, 'a store that was never written answers 404');
    const put = await api(port, '/api/save-data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'data/diabetes/readings.json', data: GOOD }),
    });
    assert.equal(put.status, 200, 'the write route accepts the app-scoped path (the only shape it takes, lib/appdata.mjs)');
    const got = await api(port, '/api/data/data/diabetes/readings.json');
    assert.equal(got.status, 200);
    assert.equal(await got.text(), GOOD, 'and reads back byte-identical');
  } finally { await stopWeb(web); rmTemp(root); }
});

/* ══ PART C — what must not come back ═════════════════════════════════════════════════════ */

// Comments are documentation, not code. The scar comments below deliberately QUOTE the deleted
// code (`localStorage`, `if(!confirm(...))`), so an identifier check that could not tell a
// comment from a statement would fail on its own documentation. Two views, on purpose:
//   · `code`      — no comments at all: for "this identifier is gone".
//   · `withBlocks` — block comments KEPT: for the empty-catch check, which must be able to see
//                    the difference between `catch(_){}` and `catch(_){ /* why silence is right */ }`.
const codeOf = (html) => {
  const m = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((x) => x[1].trim());
  assert.equal(m.length, 1, 'the app has exactly one executable inline script');
  const withBlocks = m[0][1].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return { code: withBlocks.replace(/\/\*[\s\S]*?\*\//g, ''), withBlocks };
};

test('C1 — no storage API, no modal, no swallowed failure survives in the app', () => {
  for (const [label, html] of Object.entries(appCopies())) {
    const { code, withBlocks } = codeOf(html);
    assert.equal(/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(code), false,
      `${label}: every storage API THROWS at this opaque origin — a store that throws is a store that loses data`);
    assert.equal(/\b(confirm|alert|prompt)\s*\(/.test(code), false,
      `${label}: modals are ignored in sandbox="allow-scripts" — confirm() returned false, so "Delete" silently did nothing`);
    assert.equal(/catch\s*\{\s*\}/.test(withBlocks), false, `${label}: no empty catch (R5)`);
    assert.match(code, /'save-data'/, `${label}: writes go through the broker`);
  }
});

test('C2 — a health record is never deleted on a single tap', () => {
  // confirm() is ignored here, so the old `if(!confirm(...)) return;` made deletion IMPOSSIBLE.
  // Restoring the store without replacing it would have turned it into one-tap, irreversible
  // deletion of a glucose reading. The × asks first, in place, through the shared PATwoTap.rows —
  // test/two-tap.test.mjs runs it: only a SECOND tap on the same row acts, and an ask lapses.
  for (const [label, html] of Object.entries(appCopies())) {
    const { code } = codeOf(html);
    assert.match(code, /const delArm=PATwoTap\.rows\(DEL_ARM_MS\);/, `${label}: the two-tap arm is the shared one`);
    assert.equal(/\bfunction armDelete\b|\barmedDel\b/.test(code), false, `${label}: no private copy survives (R3)`);
    for (const handler of ['histList', 'a1cList', 'pastScans']) {
      assert.ok(new RegExp(`getElementById\\('${handler}'\\)\\.onclick[\\s\\S]{0,400}?delArm\\.press\\(`).test(code),
        `${label}: ${handler} deletes only through delArm.press`);
    }
    // Every ✕ that asks looks like one: the same red `armed` style on the rows and the past scans.
    assert.match(html, /\.r-del\.armed,\.past-scan-del\.armed\{color:var\(--danger\)/, `${label}: one asking style for both`);
    assert.match(code, /<button class="past-scan-del\$\{asking\?' armed':''\}"/, `${label}: the past-scan ✕ takes it`);
  }
});

test('C3 — both copies of the app carry the same store', () => {
  // workspace.example/ is the committed template; workspace/ is the owner's live instance
  // (gitignored). Edited by hand, one at a time — a fix applied to only one comes back as a
  // fresh bug report weeks later (the longevity meal block has the same pin).
  const live = path.join(ROOT, APP_LIVE);
  if (!fs.existsSync(live)) return;   // fresh checkout: template-only is correct
  const b = between(fs.readFileSync(live, 'utf8'), "const DATA_PATH='readings.json'", 'async function save(d){DB=d;return persist();}');
  assert.equal(b, BLOCK, 'the live Diabetes app has drifted from the template — fix BOTH, always');
});

function appCopies() {
  const out = { template: SRC };
  const live = path.join(ROOT, APP_LIVE);
  if (fs.existsSync(live)) out.live = fs.readFileSync(live, 'utf8');
  return out;
}

/* ══ PART D — the gate between a MODEL'S READING and a health record ══════════════════════
   The camera path (2026-09-11): the user photographs a meter, a CGM screen or a lab printout
   and a vision model reads numbers off it. Those numbers are UNTRUSTED MODEL OUTPUT, and the
   place they are heading is a health record. A misread value recorded as fact is worse than no
   value, so parseReadings is the last gate before one can exist, and the review list is where a
   human confirms it. Both are RUN here, not described. */

// Same extraction shape the other app suites use: a named top-level function, run with its
// dependencies injected and no DOM.
function extractFn(src, name, deps = {}) {
  const m = src.match(new RegExp(`(async )?function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must stay a named top-level function — the harness runs it without a DOM`);
  const keys = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `${m[0]}; return ${name};`)(...keys.map((k) => deps[k]));
}
const lineOf = (needle) => {
  const l = SRC.split('\n').find((x) => x.trim().startsWith(needle));
  assert.ok(l, `the app must still declare ${needle}`);
  return l;
};
// eslint-disable-next-line no-new-func
const CONSTS = new Function(`${lineOf("const VALID_CTX=")}\n${lineOf("const READ_LOW=")}\nreturn {VALID_CTX,READ_LOW};`)();

const mkParse = () => extractFn(SRC, 'parseReadings', { ...CONSTS, extractedReadings: [] });

test('D1 — only a number this app would have accepted by hand can enter the record', () => {
  const parse = mkParse();
  const rows = parse(JSON.stringify([
    { val: 95, ctx: 'fasting', ts: '2026-09-11T08:00:00Z', note: 'morning', confidence: 'high' },
    { val: 39, ctx: 'fasting' },                     // below the app's own 40-600 range
    { val: 601, ctx: 'fasting' },                    // above it
    { val: 'one hundred', ctx: 'fasting' },          // not a number at all
    { val: null }, { ctx: 'fasting' }, null, 'nope', // shapes a model really does emit
    { val: 140.6, ctx: 'made-up', note: 'x'.repeat(200), confidence: 'low' },
  ]));
  assert.equal(rows.length, 2, 'every out-of-range, non-numeric and malformed row is DROPPED');
  assert.equal(rows[0].val, 95);
  assert.equal(rows[1].val, 141, 'a fractional mg/dL is rounded, not stored as 140.6');
  assert.equal(rows[1].ctx, 'random', 'a context this app does not know becomes "random", never stored raw');
  assert.equal(rows[1].note.length, 80, 'and a runaway note is truncated before it reaches the store');
});

test('D2 — a time the photo did not contain is MARKED, never fabricated', () => {
  const parse = mkParse();
  const rows = parse(JSON.stringify([
    { val: 95, ctx: 'fasting', ts: null },
    { val: 96, ctx: 'fasting', ts: 'sometime after lunch' },   // unparseable
    { val: 97, ctx: 'fasting', ts: '2026-09-11T08:00:00Z' },
  ]));
  assert.deepEqual(rows.map((r) => r.tsGuessed), [true, true, false],
    'a missing OR unparseable time is flagged — the reading still has to sort somewhere, but "3 hours ago" must not be invented');
  assert.equal(rows[2].ts, Date.parse('2026-09-11T08:00:00Z'));
  assert.equal(rows[0].ts, null, 'and no timestamp is minted inside the parser');
  // The renderers must SHOW that, or the flag is decoration.
  assert.match(SRC, /const whenTxt=\(r\)=>\(r&&r\.tsGuessed\)\?'照片中无时间 · time not in the photo':fmtDt\(r\.ts\)/,
    'the history and status rows print the absence instead of a precise clock time');
  assert.match(SRC, /<div class="r-time">\$\{whenTxt\(r\)\}<\/div>/, 'history uses it');
  assert.match(SRC, /r\.tsGuessed\?whenTxt\(r\)/, 'and so does the headline card');
});

test('D3 — the model\'s confidence survives, and defaults to the SAFE side of unknown', () => {
  const parse = mkParse();
  const rows = parse(JSON.stringify([
    { val: 95, confidence: 'low' }, { val: 96, confidence: 'high' },
    { val: 97 }, { val: 98, confidence: 'medium' }, { val: 99, confidence: 'LOW' },
  ]));
  assert.deepEqual(rows.map((r) => r.confidence), ['low', 'high', 'high', 'high', 'high'],
    "only the model's own exact 'low' marks a reading uncertain — an unrecognised value is not silently treated as one");
});

test('D4 — a model answer that is not a list of readings is reported, not thrown', () => {
  const parse = mkParse();
  // The old code did `JSON.parse(m[0]).filter(...)` inside the ONE try that also wrapped the
  // analysis, so a non-array reply took the whole conversation down with it.
  for (const bad of ['', 'I could not read that photo.', '[', '[1,2,3]', '{"val":95}', '["x"]']) {
    const out = parse(bad);
    assert.ok(out === null || Array.isArray(out), `${JSON.stringify(bad)} answers null or a list, never throws`);
    if (Array.isArray(out)) assert.equal(out.length, 0, `${JSON.stringify(bad)} contributes no readings`);
  }
  assert.deepEqual(parse('[]'), [], 'an empty array is a legitimate answer: "no numbers in that photo"');
});

test('D5 — an uncertain reading is UNTICKED by default and says why', () => {
  // The judgement this app makes: a family member photographing a meter wants speed, so a
  // clearly-printed value starts ticked. A value the model read off a curve does NOT — putting
  // it in the record takes a deliberate tap, and the row says what to check it against.
  const items = { innerHTML: '' }, list = { style: { display: 'none' } };
  const rows = [
    { val: 95, ctx: 'fasting', note: 'morning', confidence: 'high', ts: Date.parse('2026-09-11T08:00:00Z'), tsGuessed: false },
    { val: 210, ctx: 'post-meal', note: 'dinner spike', confidence: 'low', ts: null, tsGuessed: true },
  ];
  const render = extractFn(SRC, 'renderExtracted', {
    extractedReadings: rows,
    glucoseStatus: extractFn(SRC, 'glucoseStatus'),
    esc: extractFn(SRC, 'esc'),
    READ_LOW: CONSTS.READ_LOW,
    document: { getElementById: (id) => (id === 'extractedItems' ? items : list) },
  });
  render();
  const [, high, low] = items.innerHTML.split('<div class="ext-item');
  assert.ok(items.innerHTML.includes('id="ec0" checked'), 'the confident reading is pre-ticked — speed matters');
  assert.equal(/id="ec1"\s+checked/.test(items.innerHTML), false, 'the uncertain one is NOT');
  assert.match(items.innerHTML, /识别不确定 · uncertain reading/, 'and it says so, bilingually');
  assert.match(items.innerHTML, /照片中无时间 · no time in the photo/, 'a missing time is shown as missing');
  assert.equal(high.includes('lowc'), false);
  assert.ok(low.includes('lowc'), 'the uncertain row is marked in the markup too, not only in prose');
});

test('D6 — the record itself carries where the number came from', () => {
  // Provenance on the RECORD, not on the screen that drew it: the screen is gone tomorrow.
  const save = SRC.slice(SRC.indexOf("getElementById('saveAllBtn')"), SRC.indexOf('async function sendLogFollowUp'));
  assert.ok(save.length > 300, 'the save handler was really found (R14)');
  for (const field of [/src:'photo'/, /photo:\(logPhoto&&logPhoto\.path\)\|\|''/, /confidence:r\.confidence/,
    /tsGuessed:r\.tsGuessed/, /confirmed:true/]) {
    assert.match(save, field, `a photo-derived reading stores ${field}`);
  }
  assert.match(SRC, /d\.readings\.push\(\{ts,val,ctx:selCtx,note,src:'manual',confirmed:true\}\)/,
    'and a hand-typed one says so too — otherwise "no src" would mean both "typed" and "old record"');
  // Shown wherever the reading is, or the provenance is a field nobody ever sees.
  assert.match(SRC, /const provMark=\(r\)=>r&&r\.src==='photo'/, 'there is one marker renderer');
  assert.equal((SRC.match(/\$\{esc\(r\.ctx\)\}\$\{provMark\(r\)\}/g) || []).length, 2,
    'and it is used in BOTH places a reading is printed — the headline card and the history row');
});

test('D7 — the served page really carries PAPhoto, so the camera buttons are not a promise', async () => {
  // This app mounts no PAChat, so it carries PA_PHOTO_UI itself. If serve-time inlining ever
  // stopped resolving it, every camera button in here would fall into its "component not
  // loaded" branch — which is a backstop, not a working app.
  assert.match(SRC, /<!--PA_PHOTO_UI-->/, 'the app carries the marker');
  const port = await freePort();
  const root = mkWebRoot({ port });
  fs.mkdirSync(path.join(root, 'workspace/apps/diabetes'), { recursive: true });
  for (const f of ['index.html', 'meta.json']) {
    fs.copyFileSync(path.join(ROOT, 'workspace.example/apps/diabetes', f), path.join(root, 'workspace/apps/diabetes', f));
  }
  const web = startWeb(root);
  try {
    await waitReady(port);
    const r = await api(port, '/app/owner/diabetes/');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.equal(html.includes('<!--PA_PHOTO_UI-->'), false, 'no marker survives into the served page');
    assert.equal(html.split('window.PAPhoto=').length - 1, 1, 'exactly one PAPhoto definition reached the page');
    assert.match(html, /PAPhoto\.pick\(camera\?\{camera:true\}:\{\}\)/, 'and the app really calls it');
  } finally { await stopWeb(web); rmTemp(root); }
});
