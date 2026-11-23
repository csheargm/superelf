// The 信纸 studio · AI design and pictures (web/stationery-studio.inline.html + PAChat.complete)
//
// What is pinned, each against the SHIPPED code (loaded whole, or sliced out and run):
//   · an AI answer reaches the page ONLY through PAStationery.sanitize — a malicious reply
//     (script, onload, external href, image, style) comes back as a REASON with no markup, on the
//     typed path AND the picture path; both call sites are mutation-tested;
//   · <svg> is found inside a chatty reply; tweak sends the CURRENT svg with the instruction;
//   · Keep saves versions (v1, v2 …) to My templates, which list and delete through the store;
//   · a picture used as paper keeps its resolution (page-shaped, <= 2550x3300) and its alpha
//     (PNG, never JPEG), and goes up with maxEdge 0 — not PAPhoto's 1600px JPEG;
//   · a picture is painted with its fade, and only a data:image URL is ever accepted as one;
//   · Recreate sends the picture as an ATTACHMENT through the same channel;
//   · PAChat.complete accumulates the answer over the real broker head and never passes a relay
//     warning off as an answer.
// Fidelity (R14): the AI is a FAKE channel with the host's signature (the Journal's STN_HOST.ai),
// and the shell is faked at the relay's own envelope ({ev} per event, then {done:true}).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_SRC, ENGINE } from './helpers-app.mjs';
import { ROOT, STN_HTML, SAN_HTML, STUDIO_HTML, PICKER_HTML, loadStationery, loadStudio, loadComplete, fakePhoto, fakeCanvasDoc,
  recordingCtx, svg } from './helpers-stationery.mjs';

const GOOD = svg('<rect width="816" height="1056" fill="#fffaf2"/><circle cx="60" cy="60" r="30" fill="#f2b8c6"/>');
const CHATTY = `Here is a soft, light design — note the <svg> element below:\n\n\`\`\`svg\n${GOOD}\n\`\`\`\n\nEnjoy!`;
// The fake AI channel: records every call, answers what the test scripted.
function fakeAi(...answers) {
  const calls = [];
  const ai = async (message, o) => { calls.push({ message, o }); const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof a === 'function' ? a(message, o) : a; };
  return { ai, calls };
}
const answer = (text, convoId = 'c1') => ({ ok: true, text, convoId, error: '' });
const memIo = (files = {}, failRead = null) => ({ files, writes: [],
  read: async (p) => (p === failRead ? { status: 'failed', error: 'boom' }
    : p in files ? { status: 'loaded', data: JSON.parse(files[p]) } : { status: 'absent', data: null }),
  write: async function (p, t) { this.writes.push(p); files[p] = t; return { ok: true }; } });
const studio = (opts) => { const S = loadStationery(); return { S, ST: loadStudio(S, opts) }; };

// ── Extraction ─────────────────────────────────────────────────────────────────────────────
test('extractSvg finds the real <svg> inside prose, fences and a stray "<svg>" mention', () => {
  const { ST } = studio();
  assert.equal(ST.extractSvg(CHATTY), GOOD, 'prose + code fence + an earlier bare "<svg>" in the prose');
  assert.equal(ST.extractSvg('<SVG viewBox="0 0 816 1056"></SVG> trailing'), '<SVG viewBox="0 0 816 1056"></SVG>', 'any case');
  assert.equal(ST.extractSvg('I cannot draw that, sorry.'), '');
  assert.equal(ST.extractSvg('<svg viewBox="0 0 816 1056"><rect/>'), '', 'unterminated: nothing, never a fragment');
  assert.equal(ST.extractSvg(null), '');
});

// ── Design · 设计 ──────────────────────────────────────────────────────────────────────────
test('design: the prompt carries the whole contract, the answer is the SANITIZED svg', async () => {
  const { S, ST } = studio(); const f = fakeAi(answer(CHATTY));
  const r = await ST.design(f.ai, 'pressed violets in the corners');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.svg, S.sanitize(GOOD).svg, 'what comes back is sanitize()’s re-serialised output, not the reply');
  assert.match(r.svg, /width="816" height="1056"/);
  assert.equal(r.convoId, 'c1');
  const m = f.calls[0].message;
  assert.match(m, /pressed violets in the corners/);
  assert.match(m, /viewBox="0 0 816 1056"/);
  assert.match(m, /LIGHT background/);
  assert.match(m, /No <text>/);
  assert.match(m, /writing area \(x 80-736, y 100-960\) mostly clear/);
  assert.match(m, /Reply with ONLY the SVG/);
  for (const el of S.ELEMENTS) assert.ok(m.includes(el), `allow-list element ${el} is in the prompt`);
  for (const at of ['stroke-linejoin', 'gradientTransform', 'xChannelSelector', 'preserveAspectRatio']) assert.ok(m.includes(at), at);
  assert.equal(f.calls[0].o.label, ST.LABEL, 'the chat list can tell these turns apart');
});

const MALICIOUS = {
  script: svg('<script>parent.postMessage({pa:"req",kind:"save-data"},"*")</script><rect width="816" height="1056" fill="#fff"/>'),
  onload: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 816 1056" onload="alert(1)"><rect width="10" height="10"/></svg>',
  'external href': svg('<use href="http://evil.example/x.svg#a"/>'),
  'url() to the web': svg('<rect width="816" height="1056" fill="url(http://evil.example/p.svg#g)"/>'),
  image: svg('<image href="https://evil.example/track.png" width="816" height="1056"/>'),
  style: svg('<style>*{background:url(https://evil.example)}</style>'),
  foreignObject: svg('<foreignObject width="816" height="1056"><div>hi</div></foreignObject>'),
};
test('a malicious AI reply is REJECTED with a reason, and no markup is handed back to render', async () => {
  for (const [what, bad] of Object.entries(MALICIOUS)) {
    const { ST } = studio(); const f = fakeAi(answer('Sure!\n' + bad));
    const r = await ST.design(f.ai, 'anything');
    assert.equal(r.ok, false, `${what} must be rejected`);
    assert.match(r.reason, /^已拒绝 · Rejected — /, what);
    assert.equal(r.svg, undefined, `${what}: nothing drawable comes back`);
    assert.doesNotMatch(r.reason, /evil\.example|alert|postMessage/, `${what}: the reason names the rule, not the payload`);
  }
});
test('no answer, an AI failure, or a thrown channel is a named failure — never an empty success', async () => {
  const { ST } = studio();
  assert.match((await ST.design(fakeAi(answer('I would rather not.')).ai, 'x')).reason, /no <svg>/);
  assert.match((await ST.design(fakeAi({ ok: false, error: '登录已过期 · Signed out' }).ai, 'x')).reason, /Signed out/);
  assert.match((await ST.design(async () => { throw new Error('socket'); }, 'x')).reason, /AI request failed .* socket/);
});
test('MUTATION: without the sanitize() call in run(), the malicious replies would be accepted', async () => {
  const ST = loadStudio(loadStationery(), { mutate: (s) => s.replace('const v=S.simplify(raw);', 'const v={ok:true,svg:raw};') });
  const r = await ST.design(fakeAi(answer(MALICIOUS.script)).ai, 'x');
  assert.equal(r.ok, true, 'mutant accepts a <script> — so the shipped call is what stops it');
  assert.match(r.svg, /<script>/);
});

// ── Tweak · 调整 ───────────────────────────────────────────────────────────────────────────
test('tweak sends the CURRENT svg with the instruction, in the same conversation', async () => {
  const { ST } = studio(); const f = fakeAi(answer(GOOD, 'c1'), answer(GOOD.replace('#f2b8c6', '#b8d8f2'), 'c1'));
  const first = await ST.design(f.ai, 'pink dot');
  const second = await ST.tweak(f.ai, first.svg, 'make the dot blue', { convoId: first.convoId });
  assert.equal(second.ok, true, second.reason);
  const m = f.calls[1].message;
  assert.ok(m.includes(first.svg), 'the previous svg travels with the instruction');
  assert.match(m, /Change: make the dot blue/);
  assert.match(m, /Reply with ONLY the SVG/, 'and the contract again');
  assert.equal(f.calls[1].o.convoId, 'c1', 'continues the same thread');
  assert.match(second.svg, /#b8d8f2/);
});

// ── Keep · 保存 → listed → deleted ─────────────────────────────────────────────────────────
test('keep saves versions to My templates; they list, and delete through the store', async () => {
  const { S, ST } = studio(); const io = memIo(); const store = S.store(io);
  const a = await ST.keep(store, { svg: S.sanitize(GOOD).svg, name: 'Spring Garden' });
  assert.deepEqual(a, { ok: true, id: 'spring-garden-v1', base: 'spring-garden', ref: { id: 'spring-garden-v1', source: 'mine' } });
  const b = await ST.keep(store, { svg: S.sanitize(GOOD).svg, name: 'Spring Garden', base: a.base });
  assert.equal(b.id, 'spring-garden-v2', 'a second keep is a new version, never an overwrite');
  assert.deepEqual(S.list().filter((t) => t.source === 'mine').map((t) => t.id), ['spring-garden-v1', 'spring-garden-v2']);
  assert.equal(S.list().find((t) => t.id === 'spring-garden-v2').name, 'Spring Garden · v2');
  assert.deepEqual(JSON.parse(io.files['templates/index.json']).ids, ['spring-garden-v1', 'spring-garden-v2']);
  assert.deepEqual(await store.deleteMine('spring-garden-v1'), { ok: true });
  assert.deepEqual(S.list().filter((t) => t.source === 'mine').map((t) => t.id), ['spring-garden-v2'], 'gone from the picker');
  assert.deepEqual(JSON.parse(io.files['templates/index.json']).ids, ['spring-garden-v2'], 'and from the index');
  const S2 = loadStationery(); await S2.store(io).loadMine();
  assert.deepEqual(S2.list().map((t) => t.id), ['spring-garden-v2'], 'a reload agrees');
  assert.equal((await ST.keep(store, { svg: S.sanitize(GOOD).svg, name: '春天' })).id, 'design-v1', 'a name with no latin letters still gets an id');
});
test('keep refuses an unsafe svg; delete never rewrites an index it could not read', async () => {
  const { S, ST } = studio(); const io = memIo();
  assert.equal((await ST.keep(S.store(io), { svg: MALICIOUS.onload, name: 'x' })).ok, false);
  assert.equal(io.writes.length, 0, 'nothing written');
  const io2 = memIo({}, 'templates/index.json');
  assert.equal((await S.store(io2).deleteMine('x')).ok, false);
  assert.equal(io2.writes.length, 0);
});

// ── Pictures ─────────────────────────────────────────────────────────────────────────────
test('fitRect: page-shaped cover crop, centred, capped at 2550x3300, never enlarged', () => {
  const { ST } = studio();
  assert.deepEqual(ST.fitRect(3000, 4000), { sx: 0, sy: (4000 - 3000 / (816 / 1056)) / 2, sw: 3000, sh: 3000 / (816 / 1056), w: 2550, h: 3300 });
  const land = ST.fitRect(4096, 3072);
  assert.equal(land.sh, 3072); assert.equal(Math.round(land.sw), Math.round(3072 * 816 / 1056));
  assert.equal(Math.round(land.sx), Math.round((4096 - land.sw) / 2), 'centred');
  assert.deepEqual([land.w, land.h], [Math.round(land.sw), 3072], 'below the cap: full resolution, not shrunk');
  const small = ST.fitRect(816, 1056);
  assert.deepEqual([small.w, small.h], [816, 1056], 'never enlarged');
});
test('use as background: a transparent PNG stays PNG at full page resolution, uploaded with maxEdge 0', async () => {
  const doc = fakeCanvasDoc({ alpha: true }), photo = fakePhoto();
  const { ST } = studio({ document: doc, photo });
  const ups = []; const upload = async (file, o) => { ups.push({ file, o }); return { ok: true, path: 'uploads/1_' + file.name }; };
  const r = await ST.importPicture(upload, { name: 'sticker.png', type: 'image/png', w: 3000, h: 4000 });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual([r.w, r.h, r.png], [2550, 3300, true]);
  assert.equal(photo.decoded[0], 4096, 'decoded at 4096, not at PAPhoto.DEFAULT_MAX_EDGE (1600)');
  const out = doc.made[0];
  assert.deepEqual(out.encodedAt, [2550, 3300]);
  assert.deepEqual([out.width, photo.sources[0].width], [0, 0], 'both big canvases released once encoded (Safari counts canvas memory)');
  assert.deepEqual(out.reads, [], 'a PNG stays PNG: no 8M-pixel scan for alpha');
  assert.deepEqual(out.encoded, { type: 'image/png', q: undefined }, 'PNG — no JPEG conversion, so the alpha survives');
  assert.equal(out.log.some((x) => x[0] === 'fillRect'), false, 'nothing painted under it (no black or white matte)');
  assert.equal(ups[0].o.maxEdge, 0, 'the upload does NOT downscale or re-encode');
  assert.match(ups[0].file.name, /^stationery-\d+\.png$/);
  assert.equal(ups[0].file.type, 'image/png');
});
test('an opaque photo becomes a high-quality JPEG; an opaque PNG screenshot stays PNG', async () => {
  const doc = fakeCanvasDoc(); const { ST } = studio({ document: doc });
  const ok = async () => ({ ok: true, path: 'uploads/p' });
  await ST.importPicture(ok, { name: 'p.jpg', type: 'image/jpeg', w: 4000, h: 3000 });
  assert.deepEqual(doc.made[0].encoded, { type: 'image/jpeg', q: 0.92 });
  await ST.importPicture(ok, { name: 'shot.png', type: 'image/png', w: 1640, h: 2360 });
  assert.equal(doc.made[1].encoded.type, 'image/png', 'a screenshot of a PDF page keeps crisp lines');
});
test('importPicture steps down ONLY when the cap refuses, and stops on any other failure', async () => {
  const doc = fakeCanvasDoc(); const photo = fakePhoto({ cap: 10 });   // every encoded file is "too large"
  const { ST } = studio({ document: doc, photo });
  const tries = []; const r = await ST.importPicture(async (f) => { tries.push(f); return { ok: false, code: 'too-large', text: '照片过大 · Photo too large' }; },
    { name: 'p.png', type: 'image/png', w: 3000, h: 4000 });
  assert.equal(r.ok, false); assert.match(r.reason, /Photo too large/);
  assert.deepEqual(doc.made.map((c) => c.encodedAt[0]), [2550, 2040, 1632], 'full size first, then 80%, then 64%');
  const doc2 = fakeCanvasDoc(); const { ST: ST2 } = studio({ document: doc2 });
  const r2 = await ST2.importPicture(async () => ({ ok: false, text: '登录已过期 · Signed out' }), { name: 'p.png', type: 'image/png', w: 900, h: 1200 });
  assert.match(r2.reason, /Signed out/); assert.equal(doc2.made.length, 1, 'shrinking cannot fix a sign-in');
});
test('recreate: the picture goes to the AI as an ATTACHMENT, flattened, and the answer is sanitized', async () => {
  const doc = fakeCanvasDoc({ alpha: true }); const { S, ST } = studio({ document: doc });
  const ups = []; const upload = async (file, o) => { ups.push({ file, o }); return { ok: true, path: 'uploads/9_' + file.name }; };
  const f = fakeAi(answer(CHATTY, 'c7'));
  const r = await ST.recreate(f.ai, upload, { name: 'card.png', type: 'image/png', w: 3000, h: 4000 }, '');
  assert.equal(r.ok, true, r.reason); assert.equal(r.svg, S.sanitize(GOOD).svg);
  assert.deepEqual(f.calls[0].o.attachments, [{ name: 'picture.jpg', path: 'uploads/9_' + ups[0].file.name }]);
  assert.match(f.calls[0].message, /Recreate the attached picture/); assert.match(f.calls[0].message, /Reply with ONLY the SVG/);
  assert.equal(Math.max(...doc.made[0].encodedAt), 1600, 'the AI copy is PAPhoto.DEFAULT_MAX_EDGE on its long side');
  assert.equal(doc.made[0].encoded.type, 'image/jpeg');
  assert.ok(doc.made[0].log.some((x) => x[0] === 'fillStyle' && x[1] === '#ffffff'), 'flattened on white: transparency is not shown as black');
  const bad = await ST.recreate(fakeAi(answer(MALICIOUS.onload)).ai, upload, { name: 'c.png', type: 'image/png', w: 900, h: 1200 }, '');
  assert.equal(bad.ok, false, 'the picture path rejects a malicious answer too');
});
test('MUTATION: the picture path shares the sanitize call — removing it lets a malicious recreate through', async () => {
  const ST = loadStudio(loadStationery(), { document: fakeCanvasDoc(), mutate: (s) => s.replace('const v=S.simplify(raw);', 'const v={ok:true,svg:raw};') });
  const r = await ST.recreate(fakeAi(answer(MALICIOUS.onload)).ai, async () => ({ ok: true, path: 'uploads/x' }),
    { name: 'c.png', type: 'image/png', w: 900, h: 1200 }, '');
  assert.equal(r.ok, true); assert.match(r.svg, /onload/);
});

// ── A picture as paper: fetched once, painted with its fade, only a data:image URL ─────────
const PIC = 'uploads/1_stationery-1.png';
test('a picture paints once the host fetched it, with its fade, and print waits for it', async () => {
  const S = loadStationery(); const asked = [];
  S.pictures(async (p) => { asked.push(p); return 'data:image/png;base64,AAAA'; });
  let changed = 0; S.onChange(() => changed++);
  const ref = { id: PIC, source: 'picture', fade: 0.4 };
  assert.equal(S.paint(recordingCtx(), ref, { w: 816, h: 1056 }), false, 'first paint: still fetching = plain paper');
  assert.equal(await S.prime(ref), true, 'print waits for the fetch AND the decode');
  assert.ok(changed >= 1, 'the page is told to redraw');
  const ctx = recordingCtx();
  assert.equal(S.paint(ctx, ref, { w: 816, h: 1056 }), true);
  assert.ok(ctx.log.some((x) => x[0] === 'globalAlpha' && Math.abs(x[1] - 0.6) < 1e-9), 'fade 40% -> drawn at 60%');
  assert.deepEqual(asked, [PIC], 'fetched once');
});
test('only a data:image URL becomes paper; anything else is plain paper and is retried later', async () => {
  for (const url of ['data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)', 'data:text/html,<b>', null, 'https://x/y.png']) {
    const S = loadStationery(); S.pictures(async () => url);
    assert.equal(await S.prime({ id: PIC, source: 'picture' }), false, String(url));
    assert.equal(S.has({ id: PIC, source: 'picture' }), false);
  }
  const S = loadStationery(); let n = 0; S.pictures(async () => { n++; throw new Error('offline'); });
  assert.equal(await S.prime({ id: PIC, source: 'picture' }), false, 'a rejected fetch is plain paper, not a throw');
  await S.prime({ id: PIC, source: 'picture' }); assert.equal(n, 2, 'and is tried again');
});
test('MUTATION: without the data:image check, an SVG or script URL would be drawn as paper', async () => {
  const S = loadStationery({ mutate: (s) => s.replace("if(typeof url!=='string'||!/^data:image\\/(png|jpeg|webp|gif);/.test(url))", 'if(typeof url!==\'string\')') });
  S.pictures(async () => 'data:image/svg+xml;base64,PHN2Zz4=');
  assert.equal(await S.prime({ id: PIC, source: 'picture' }), true, 'mutant accepts an SVG as a "picture"');
});

// ── PAChat.complete over the real broker head ────────────────────────────────────────────
test('PAChat.complete: the chat kind, the answer accumulated, attachments and label forwarded', async () => {
  const { complete, posted } = loadComplete((m, send) => {
    send({ ev: { type: 'convo', id: 'cv9' } }); send({ ev: { type: 'delta', text: '<svg viewBox="0 0 816 1056">' } });
    send({ ev: { type: 'delta', text: '</svg>' } }); send({ ev: { type: 'done', ok: true, text: '' } }); send({ done: true }); });
  const r = await complete('design it', { label: '信纸 · Stationery', attachments: [{ name: 'p.jpg', path: 'uploads/p.jpg' }], convoId: 'old' });
  assert.deepEqual(r, { ok: true, text: '<svg viewBox="0 0 816 1056"></svg>', error: '', convoId: 'cv9' });
  assert.equal(posted[0].kind, 'chat'); assert.equal(posted[0].message, 'design it'); assert.equal(posted[0].convoId, 'old');
  assert.deepEqual(posted[0].attachments, [{ name: 'p.jpg', path: 'uploads/p.jpg' }]); assert.equal(posted[0].label, '信纸 · Stationery');
});
test('PAChat.complete: the final text wins over working-out; a relay failure is NEVER text', async () => {
  const fin = loadComplete((m, send) => { send({ ev: { type: 'delta', text: 'thinking… <svg viewBox="0 0 1 1"></svg>' } });
    send({ ev: { type: 'done', ok: true, text: 'FINAL' } }); send({ done: true }); });
  assert.equal((await fin.complete('x')).text, 'FINAL');
  // The relay's own failure envelope: a ⚠ delta, then done carrying ok:false and the sentence.
  const fail = loadComplete((m, send) => { send({ ev: { type: 'delta', text: '\n\n⚠ 登录已过期 · Signed out' } });
    send({ done: true, ok: false, code: 'unauthorized', text: '登录已过期 · Signed out' }); });
  assert.deepEqual(await fail.complete('x'), { ok: false, text: '', error: '登录已过期 · Signed out', convoId: null });
  const lane = loadComplete((m, send) => { send({ ev: { type: 'done', ok: false, text: 'lane crashed' } }); send({ done: true }); });
  assert.equal((await lane.complete('x')).error, 'lane crashed');
  const empty = loadComplete((m, send) => send({ done: true }));
  assert.equal((await empty.complete('x')).ok, false, 'an empty answer is not a success');
});

// ── Wiring and budgets ─────────────────────────────────────────────────────────────────────
test('wiring: the Journal hands over its IO; note-ui passes it through; delivery order; R4 budgets', () => {
  const J = APP_SRC['notes (live)'];
  assert.match(J, /stationery:STN_HOST\|\|false,/, 'the Journal opts in with its studio IO');
  assert.match(J, /ai:\(message,o\)=>window\.PAChat&&PAChat\.complete\?PAChat\.complete\(message,o\)/, 'the AI is the chat kind via PAChat');
  assert.match(J, /upload:\(file,o\)=>window\.PAPhoto\?PAPhoto\.upload\(file,o\)/, 'the upload passes the studio’s maxEdge through untouched');
  assert.match(J, /window\.PAStationery\.pictures\(/, 'pictures are fetched through the host');
  assert.match(ENGINE, /studio:opts\.stationery\}\);/, 'note-ui passes the host IO to the picker');
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  const files = [.../const PA_COMPONENTS = \[([\s\S]*?)\n\];/.exec(web)[1].matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  const at = (f) => files.indexOf(f);
  assert.ok(at('stationery-ui.inline.html') < at('stationery-designs.inline.html')
    && at('stationery-designs.inline.html') < at('stationery-studio.inline.html')
    && at('stationery-studio.inline.html') < at('stationery-picker.inline.html'), 'engine, designs, studio, picker');
  for (const mk of ['<!--PA_STATIONERY_STUDIO-->', '<!--PA_STATIONERY_PICKER-->']) assert.equal(STN_HTML.split(mk).length, 2, `${mk} carried once`);
  for (const [f, src] of [['stationery-ui', STN_HTML], ['stationery-sanitize', SAN_HTML], ['stationery-studio', STUDIO_HTML], ['stationery-picker', PICKER_HTML]]) {
    assert.ok(src.split('\n').length <= 300, `${f} stays inside the 300-line budget`);
  }
  assert.match(PICKER_HTML, /Pictures you import stay in your own notes/);
  assert.match(PICKER_HTML, /PDFs are not supported: screenshot a PDF page instead/);
  assert.match(PICKER_HTML, /accept:'image\/\*'/);
});
test('the studio never routes a picture through a private reader (PAPhoto is the one decoder)', () => {
  for (const src of [STUDIO_HTML, PICKER_HTML]) assert.doesNotMatch(src, /new FileReader\(|readAsDataURL|createObjectURL/);
  assert.match(STUDIO_HTML, /P\.toCanvas\(file,PIC_DECODE_EDGE\)/);
});
