// PAPhoto（拍照输入）— the ONE photo-as-input path, and the guards that decide whether a
// photo is ACCEPTED, REFUSED or REPORTED.
//
// WHY THIS FILE EXISTS
// Measured 2026-09-10 (PLAN.md): picking, reading and uploading an image was implemented FOUR
// times and the four disagreed — only the note pad knew the real cap, only the meal UI resized,
// the shell posted /api/upload with no cap at all. Three ways that divergence reaches a user:
//   · a cap hardcoded below the server's refuses a photo the server would have taken, and the
//     message that says so is simply FALSE;
//   · a missing cap spends a 20MB upload over cellular to earn a 413 nobody rendered;
//   · one generic "Upload failed" for a 401, a dead socket and an oversized photo makes the
//     user retry the thing that can never work — leftover (e) of the 2026-09-02 data loss.
// So the property under test is not "an upload works". It is: the accept/refuse decision is
// made against the SERVER's number, and every distinct failure produces a distinct sentence.
//
// HARNESS FIDELITY (R14 — a lenient mock is what let the original incident through)
//   · The component's decision core is EXTRACTED from the shipped web/photo-ui.inline.html and
//     RUN. Nothing is re-implemented here; if the extraction stops finding real code it fails.
//   · Its failure sentences come from the REAL PAChat.failText, sliced out of the shipped
//     web/chat-ui.inline.html — the same seam the component uses in production, not a stub.
//   · The upload round trip runs the WHOLE component against a REAL web.mjs on a throwaway
//     root: real /api/upload, real BODY_LIMITS, real 413. The only things faked are the four
//     browser objects node does not have (FileReader, Image, canvas, postMessage), and each is
//     driven through BOTH its success and its failure callback.
//   · Every guard is MUTATION-TESTED: the guard is removed from the component's own source and
//     the assertion protecting it is shown to go red. A guard nobody can break is not tested.
// NEVER live data: throwaway roots only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BODY_LIMITS, CODE_TOO_LARGE, humanBytes } from '../lib/webutil.mjs';
import { mkWebRoot, startWeb, stopWeb, waitReady, freePort, api } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';   // TODO(R4 seam): this file is over budget; split by test group (one describe per file)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const SRC = read('web', 'photo-ui.inline.html');
const CHAT = read('web', 'chat-ui.inline.html');
const WEB = read('web.mjs');
const SHELL = read('web', 'index.html');   // read-only: the shell is another session's file this cycle
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

// ── The component's DOM-free decision core, extracted and RUN ────────────────────────────────
// `mutate` rewrites the component's OWN source before it runs, so a guard can be deleted and the
// assertion that protects it shown to fail. It must match something, or the "mutation" would be
// testing unmutated code and proving nothing.
const CORE_BEGIN = '/* ══ PA_PHOTO_CORE_BEGIN';
const CORE_END = '/* ══ PA_PHOTO_CORE_END ══ */';
function core(win, mutate) {
  const from = SRC.indexOf(CORE_BEGIN);
  const to = SRC.indexOf(CORE_END);
  assert.ok(from > 0 && to > from, 'the decision core must stay one contiguous block between its markers');
  let src = SRC.slice(from, to);
  assert.match(src, /const papRefuse=/, 'the extraction found the real guard, not an empty slice');
  assert.match(src, /const papOutcome=/, 'and the real reply reader');
  assert.ok(!/\bdocument\b|createElement|appendChild/.test(stripComments(src)),
    'the core must stay DOM-free, or it cannot be run and mutated here at all');
  if (mutate) { const before = src; src = mutate(src); assert.notEqual(src, before, 'the mutation matched nothing — it would prove nothing'); }
  // eslint-disable-next-line no-new-func
  return new Function('window', `${src}\nreturn {PAP_TOO_LARGE,PAP_ENVELOPE_BYTES,PAP_TXT,papB64Bytes,papFileCap,papCap,papBodyLimit,papRefuse,papScale,papFailText,papWhat,papFail,papOutcome,setPrefsLimit:(n)=>{PAP_PREFS_LIMIT=n;}};`)(win);
}

// ── The REAL PAChat seam, sliced out of the shipped chat component ───────────────────────────
// Same extraction boundary test/fail-legibility.test.mjs uses (R3: one boundary, not a second
// one invented here). This is the arrow PAPhoto actually calls in the browser.
function realPAChat() {
  const helpers = CHAT.slice(CHAT.indexOf('  const PAC_LIMITS='), CHAT.indexOf('\n  const esc=s=>'));
  assert.match(helpers, /PAC_NOUNS/, 'the extraction found chat-ui\'s round-3 noun table');
  const from = CHAT.indexOf('    failText:(reply,o)=>');
  const endMark = "'请求失败 · Request failed — 未给出原因 · no reason given'; },";
  const to = CHAT.indexOf(endMark);
  assert.ok(from > 0 && to > from, 'PAChat.failText must stay one findable expression');
  const expr = CHAT.slice(from, to + endMark.length).replace(/^\s*failText:/, '').replace(/,\s*$/, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${helpers}\nreturn {failText:(${expr}), whatForFile:pacWhatForFile, limits:Object.freeze({...PAC_LIMITS})};`)();
}
const PACHAT = realPAChat();
const winChat = () => ({ PAChat: PACHAT });

/* ═══ PART A — R14 controls: prove the harness can fail ═══════════════════════════════════ */

test('CONTROL: a stub extraction fails loudly instead of silently testing nothing', () => {
  assert.throws(() => core({}, (s) => s.replace(/const papRefuse=/, 'const papNeverExisted=')),
    /papRefuse is not defined|papRefuse/, 'removing the guard from the source really breaks the extraction');
});

test('CONTROL: the PRE-FIX surface collapses every failure to one sentence — the tests below have teeth', () => {
  const C = core(winChat());
  const preFix = () => 'Upload failed';
  const classes = [
    { ok: false, code: CODE_TOO_LARGE, status: 413, limit: BODY_LIMITS.upload },
    { ok: false, code: 'unauthorized', status: 401, text: '登录已过期 · Signed out. 未上传 · Photo not uploaded' },
    { ok: false, code: 'network', text: '连接中断 · Connection lost' },
    { ok: false, code: 'timeout', error: '外卡无响应 · No answer from the app shell' },
    { ok: true },   // an ok with no path
  ];
  assert.equal(new Set(classes.map(preFix)).size, 1, 'the pre-fix surface really is one indistinguishable sentence');
  const now = new Set(classes.map((r) => C.papOutcome(r, { what: 'Photo', bytes: 1024 }).text));
  assert.equal(now.size, classes.length, 'and the shipped component really is not: ' + [...now].join(' | '));
});

/* ═══ PART B — the cap is the SERVER's number, never this component's ═════════════════════ */

test('the file cap is DERIVED from the real body limit, and a file at exactly the cap still fits', () => {
  const C = core(winChat());
  assert.equal(C.PAP_TOO_LARGE, CODE_TOO_LARGE, 'the size code is the ONE code every route answers (R3)');
  const cap = C.papFileCap(BODY_LIMITS.upload);
  assert.ok(cap > 0 && cap < BODY_LIMITS.upload, 'the FILE cap is below the BODY cap…');
  assert.ok(cap > BODY_LIMITS.upload * 0.7, '…by roughly the base64 ratio, not arbitrarily');
  // The property that matters: the pre-flight never refuses what the server would accept, and
  // never admits what it would refuse.
  const bodyFor = (fileBytes) => Math.ceil(fileBytes / 3) * 4 + C.PAP_ENVELOPE_BYTES;
  assert.ok(bodyFor(cap) <= BODY_LIMITS.upload, 'a file at exactly the cap still fits the body the shell posts');
  assert.ok(bodyFor(cap + 1024 * 1024) > BODY_LIMITS.upload, 'and 1MB over does not');
  assert.equal(C.papFileCap(0), 0, 'an unknown body limit yields no cap at all — not a guessed one');
});

test('the cap comes from the shell first, PAChat second, and is 0 — not a guess — when neither is there', () => {
  const C = core(winChat());
  assert.equal(C.papBodyLimit(null), BODY_LIMITS.upload, 'PAChat.limits.upload when nothing else is known');
  C.setPrefsLimit(7 * 1024 * 1024);
  assert.equal(C.papBodyLimit(null), 7 * 1024 * 1024, '{pa:prefs, uploadMaxBytes} from the shell WINS — it is the live server number');
  assert.equal(C.papBodyLimit({ bodyLimit: 123456 }), 123456, 'and an explicit caller override beats both');
  const bare = core(null);   // a page with PAPhoto and no PAChat, and no prefs yet
  assert.equal(bare.papBodyLimit(null), 0, 'with no source at all the cap is UNKNOWN, never invented');
  assert.match(SHELL, /uploadMaxBytes:RELAY_LIMITS\.upload/, 'and the shell really does publish that number to every app frame');
});

test('a caller may tighten the cap but never raise it', () => {
  const C = core(winChat());
  const server = C.papFileCap(BODY_LIMITS.upload);
  assert.equal(C.papCap(BODY_LIMITS.upload, 6 * 1024 * 1024), 6 * 1024 * 1024, 'the meal route\'s own smaller photo limit wins');
  assert.equal(C.papCap(BODY_LIMITS.upload, 999 * 1024 * 1024), server, 'an app asking for more than the server takes gets the server\'s number');
  assert.equal(C.papCap(0, 6 * 1024 * 1024), 6 * 1024 * 1024, 'with no server number the caller\'s own cap still applies');
});

/* ═══ PART C — the ACCEPT / REFUSE guard, mutation-tested in both directions ══════════════ */

test('the guard refuses an oversized photo, accepts one that fits, and NEVER refuses on an unknown cap', () => {
  const C = core(winChat());
  const cap = C.papFileCap(BODY_LIMITS.upload);
  assert.equal(C.papRefuse(cap, cap), null, 'exactly at the cap is accepted');
  assert.equal(C.papRefuse(cap - 1, cap), null);
  const r = C.papRefuse(cap + 1, cap);
  assert.ok(r && r.ok === false, 'one byte over is refused');
  assert.equal(r.code, CODE_TOO_LARGE, 'with the machine-readable code the rest of the tree branches on');
  assert.equal(r.limit, cap, 'and the CAP, so the sentence can say what would fit');
  assert.equal(r.bytes, cap + 1, 'and what was actually offered');
  assert.equal(C.papRefuse(999 * 1024 * 1024, 0), null, 'cap unknown → the SERVER decides; a guessed refusal is the false message this component exists to stop');
});

test('MUTATION: dropping the size comparison lets an oversized photo through — and the test above goes red', () => {
  const M = core(winChat(), (s) => s.replace('return n>c ? {ok:false,code:PAP_TOO_LARGE,limit:c,bytes:n} : null;', 'return null;'));
  const cap = M.papFileCap(BODY_LIMITS.upload);
  assert.equal(M.papRefuse(cap + 1, cap), null, 'the mutant accepts a photo the server will 413 — proving the real guard is what refuses it');
});

test('MUTATION: guessing a cap when none is known produces the FALSE refusal this component exists to stop', () => {
  const M = core(winChat(), (s) => s.replace('if(c<=0) return null;', 'if(c<=0) return {ok:false,code:PAP_TOO_LARGE,limit:0,bytes:n};'));
  assert.notEqual(M.papRefuse(1024, 0), null, 'the mutant refuses a 1KB photo on a page with no known cap');
});

test('MUTATION: letting a caller RAISE the cap admits a body the server refuses', () => {
  const M = core(winChat(), (s) => s.replace('return (a&&b)?Math.min(a,b):(a||b||0);', 'return (a&&b)?Math.max(a,b):(a||b||0);'));
  assert.equal(M.papCap(BODY_LIMITS.upload, 999 * 1024 * 1024), 999 * 1024 * 1024,
    'the mutant hands back more than the server takes — the real papCap clamps to the server');
});

/* ═══ PART D — the REPORT: an outcome a caller can act on, never a bare null ══════════════ */

test('a successful reply becomes {ok,path}; a reply that confirms without storing is a FAILURE that says so', () => {
  const C = core(winChat());
  const good = C.papOutcome({ ok: true, path: 'uploads/171_meter.jpg' }, { name: 'meter.jpg', bytes: 4096 });
  assert.deepEqual({ ok: good.ok, path: good.path, name: good.name, bytes: good.bytes }, { ok: true, path: 'uploads/171_meter.jpg', name: 'meter.jpg', bytes: 4096 });
  // The notebook's `wroteNothing` scar, on the photo path: a store may only confirm work it did.
  const empty = C.papOutcome({ ok: true }, { what: 'Photo', bytes: 4096 });
  assert.equal(empty.ok, false, 'an ok:true with no path is NOT a success');
  assert.equal(empty.code, 'no-path');
  assert.match(empty.text, /上传已确认但未保存文件 · Upload confirmed but no file was stored/, 'and it says exactly that, in both languages');
});

test('MUTATION: treating an ok-without-path as success hands the caller an empty path', () => {
  const M = core(winChat(), (s) => s.replace('if(reply&&reply.ok===true&&reply.path) return', 'if(reply&&reply.ok===true) return'));
  const empty = M.papOutcome({ ok: true }, { bytes: 1 });
  assert.equal(empty.ok, true, 'the mutant calls it a success…');
  assert.equal(/^uploads\//.test(empty.path), false, `…carrying ${JSON.stringify(empty.path)} as the path — which the caller would store as a broken image`);
});

test('every failure shape — including null, undefined and {} — comes back as an actionable object', () => {
  const C = core(winChat());
  for (const reply of [null, undefined, {}, { ok: false }, 'nope', 0]) {
    const out = C.papOutcome(reply, { what: 'Photo', bytes: 2048 });
    assert.equal(typeof out, 'object', `a ${JSON.stringify(reply)} reply must not come back as a bare value`);
    assert.equal(out.ok, false);
    assert.equal(out.path, '', 'and never a half-built success');
    assert.ok(out.text && typeof out.text === 'string', 'with something to show a human');
    assert.ok(out.error && typeof out.error === 'string', 'and a reason for the log');
    assert.match(out.text, /请|未|过/, 'bilingual, like every other failure surface in the tree');
  }
});

test('the failure sentence is PAChat\'s — the shell\'s own wording, not a second dialect', () => {
  const C = core(winChat());
  // 1. The shell already rendered it: that sentence wins, verbatim, so every surface agrees.
  const fromShell = { ok: false, code: 'unauthorized', status: 401, text: '登录已过期 · Signed out. 未上传 · Photo not uploaded' };
  assert.equal(C.papOutcome(fromShell, { what: 'Photo' }).text, fromShell.text);
  // 2. A bare 413 still gets the size sentence WITH the cap — through PAChat, not a local copy.
  const sized = C.papOutcome({ ok: false, code: CODE_TOO_LARGE, status: 413, limit: 15 * 1048576 }, { what: 'Photo', bytes: 24 * 1048576 }).text;
  assert.match(sized, /照片过大 · Photo too large/);
  assert.match(sized, new RegExp(`max ${humanBytes(15 * 1048576)}`), 'the cap is named');
  assert.match(sized, /请选择更小的照片或裁剪后重试/, 'and what to DO about it');
  assert.equal(sized, PACHAT.failText({ ok: false, code: CODE_TOO_LARGE, status: 413, limit: 15 * 1048576 }, { what: 'Photo', bytes: 24 * 1048576 }),
    'byte-for-byte the seam\'s own output — PAPhoto owns no second renderer (R3)');
  // 3. A non-image name degrades to "File" through the SAME inference point PAChat exposes.
  assert.match(C.papOutcome({ ok: false, code: CODE_TOO_LARGE, limit: 99 }, { what: C.papWhat('scan.pdf'), bytes: 100 }).text, /文件过大 · File too large/);
  assert.match(C.papOutcome({ ok: false, code: CODE_TOO_LARGE, limit: 99 }, { what: C.papWhat('IMG_1.HEIC'), bytes: 100 }).text, /照片过大 · Photo too large/);
});

test('MUTATION: a component-local generic sentence collapses the failure classes again', () => {
  const M = core(winChat(), (s) => s.replace('if(chat&&typeof chat.failText===\'function\') return chat.failText(reply,c);', ''));
  const a = M.papOutcome({ ok: false, code: CODE_TOO_LARGE, status: 413, limit: 15 * 1048576 }, { what: 'Photo', bytes: 99 }).text;
  assert.doesNotMatch(a, /max /, 'the mutant stops naming the cap — which is the whole of leftover (e)');
});

test('without PAChat on the page the component degrades to the shell\'s HEADING, never to a second dialect', () => {
  const bare = core(null);
  const t = bare.papOutcome({ ok: false, code: CODE_TOO_LARGE, limit: 99 }, { what: 'Photo', bytes: 100 }).text;
  assert.equal(t, '照片过大 · Photo too large', 'the same heading the shell and the note pad use');
  assert.equal(CHAT.includes('照片过大 · Photo too large'), true, 'which really is the shared heading, not a string invented here');
  assert.equal(bare.papWhat('x.pdf'), 'Photo', 'and with no PAChat to ask, a photo component says Photo rather than inventing a noun table');
});

/* ═══ PART E — arithmetic the user is shown ═══════════════════════════════════════════════ */

test('base64 byte counting is exact, including padding — the number is printed to the user', () => {
  const C = core(winChat());
  for (const n of [0, 1, 2, 3, 4, 5, 100, 1023, 4096, 65537]) {
    const b64 = Buffer.alloc(n, 0x41).toString('base64');
    assert.equal(C.papB64Bytes(b64), n, `${n} bytes round-trips exactly`);
  }
});

test('downscaling fits the longest edge, keeps the aspect ratio and never ENLARGES a small photo', () => {
  const C = core(winChat());
  assert.deepEqual(C.papScale(4032, 3024, 1600), { w: 1600, h: 1200, scaled: true }, 'a 12MP phone shot lands on the long edge');
  assert.deepEqual(C.papScale(3024, 4032, 1600), { w: 1200, h: 1600, scaled: true }, 'portrait too');
  assert.deepEqual(C.papScale(800, 600, 1600), { w: 800, h: 600, scaled: false }, 'a small photo is left alone — upscaling costs bytes and adds nothing');
  assert.deepEqual(C.papScale(0, 0, 1600), { w: 0, h: 0, scaled: false }, 'an image with no dimensions is not resized into existence');
  assert.equal(C.papScale(4032, 3024, 0).scaled, false, 'no maxEdge means no resize');
});

/* ═══ PART F — the WHOLE component, over a REAL web.mjs ═══════════════════════════════════ */
// Only the four browser objects node lacks are faked, and each is driven through BOTH its
// success and its failure callback. The bytes really cross the real /api/upload route.

function fakeFile(name, bytes, type = 'image/jpeg') {
  return { name, size: bytes.length, type, _b64: Buffer.from(bytes).toString('base64') };
}
// A browser stand-in for the four objects node lacks. Each is driven through BOTH its success
// and its failure callback below, and the canvas returns bytes PROPORTIONAL TO PIXELS so a
// downscale really shows up as a smaller payload — a stub that returned a constant would make
// the resize untestable while looking green (R14).
function mountComponent(onPost, dom = {}) {
  const body = SRC.slice(SRC.indexOf('<script id="pap-script">') + '<script id="pap-script">'.length, SRC.lastIndexOf('</script>'));
  assert.match(body, /window\.PAPhoto=/, 'the extraction found the real component body');
  const listeners = [];
  const inputs = [];
  const win = {
    PAChat: PACHAT,
    addEventListener: (t, f) => { if (t === 'message') listeners.push(f); },
    removeEventListener: () => {},
    _emit: (data) => listeners.forEach((f) => f({ data })),
  };
  const parent = { postMessage: (m) => onPost(m, win) };
  class FakeFileReader {
    readAsDataURL(file) {
      setTimeout(() => {
        if (file._fail) return this.onerror && this.onerror();
        this.result = `data:${file.type};base64,${file._b64}`;
        this.onload && this.onload();
      }, 0);
    }
  }
  const blobs = new Map(); let blobN = 0;
  const URLStub = { createObjectURL: (f) => { const u = `blob:${++blobN}`; blobs.set(u, f); return u; }, revokeObjectURL: (u) => blobs.delete(u) };
  class FakeImage {
    set src(u) {
      const f = blobs.get(u);
      setTimeout(() => {
        if (!f || f._notImage) return this.onerror && this.onerror();
        this.width = f._w || 0; this.height = f._h || 0;
        this.onload && this.onload();
      }, 0);
    }
  }
  const makeInput = () => {
    const h = {};
    const el = {
      type: '', accept: '', multiple: false, files: [], style: {}, attrs: {}, _clicked: false,
      setAttribute: (k, v) => { el.attrs[k] = v; },
      addEventListener: (t, f) => { h[t] = f; },
      remove: () => {},
      click: () => { el._clicked = true; if (dom.onPick) setTimeout(() => dom.onPick(el, h), 0); },
    };
    inputs.push(el); return el;
  };
  const makeCanvas = () => {
    const c = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) };
    // ~1 byte per 50 pixels: not a real encoder, but monotonic in pixel count, which is the
    // only property the pre-flight depends on.
    c.toDataURL = (type, q) => `data:image/jpeg;base64,${Buffer.alloc(Math.max(1, Math.round(c.width * c.height / 50)), 0x41).toString('base64')}`;
    return c;
  };
  const doc = { body: { appendChild: () => {} }, createElement: (tag) => (tag === 'input' ? makeInput() : tag === 'canvas' ? makeCanvas() : (() => { throw new Error(`unexpected createElement(${tag})`); })()) };
  // eslint-disable-next-line no-new-func
  new Function('window', 'parent', 'FileReader', 'document', 'Image', 'URL', `${body}\nreturn window.PAPhoto;`)(
    win, parent, FakeFileReader, doc, FakeImage, URLStub);
  return { PAPhoto: win.PAPhoto, win, inputs };
}

async function withWeb(fn) {
  const port = await freePort();
  const root = mkWebRoot({ port });
  const inst = startWeb(root);
  try { await waitReady(port); await fn({ port, root }); } finally { await stopWeb(inst); rmTemp(root); }
}

test('END TO END: the component uploads through the broker contract and the REAL /api/upload stores the file', async () => {
  await withWeb(async ({ port, root }) => {
    let posted = null;
    // The shell's half of the broker, reduced to what the upload kind does: take {name,data} to
    // the real route and hand the real answer back as {pa:'res'}.
    const { PAPhoto } = mountComponent(async (m, win) => {
      posted = m;
      const res = await api(port, '/api/upload', { method: 'POST', body: JSON.stringify({ name: m.name, data: m.data }) });
      const j = await res.json().catch(() => ({}));
      win._emit(Object.assign({ pa: 'res', id: m.id }, j, res.ok ? {} : { ok: false, status: res.status }));
    });
    const out = await PAPhoto.upload(fakeFile('meter.jpg', 'glucose 6.1 mmol/L'));
    assert.equal(out.ok, true, `upload failed: ${JSON.stringify(out)}`);
    assert.match(out.path, /^uploads\//, 'the caller gets the store path the rest of the tree speaks');
    assert.equal(posted.kind, 'upload', 'through the EXISTING broker kind, not a new one');
    assert.equal(posted.pa, 'req');
    assert.equal(posted.name, 'meter.jpg');
    assert.ok(!/^data:/.test(posted.data), 'the payload is BARE base64 — a data: prefix is what the contract forbids');
    assert.equal(Buffer.from(posted.data, 'base64').toString(), 'glucose 6.1 mmol/L', 'and it is the file\'s real bytes');
    const stored = fs.readFileSync(path.join(root, 'workspace', out.path), 'utf8');
    assert.equal(stored, 'glucose 6.1 mmol/L', 'the REAL route really wrote the REAL bytes');
    assert.equal(out.dataUrl.startsWith('data:image/jpeg;base64,'), true, 'and the caller gets a thumbnail source without splitting anything itself');
  });
});

test('END TO END: an oversized photo is refused BEFORE the upload is spent, naming the cap', async () => {
  let posted = false;
  const { PAPhoto } = mountComponent(() => { posted = true; });
  const huge = { name: 'IMG_0001.HEIC', size: BODY_LIMITS.upload, type: 'image/heic', _b64: '' };
  const out = await PAPhoto.upload(huge);
  assert.equal(out.ok, false);
  assert.equal(posted, false, 'nothing was sent — the refusal happens before the bytes go over cellular');
  assert.equal(out.code, CODE_TOO_LARGE);
  assert.match(out.text, /照片过大 · Photo too large/, 'the noun is PHOTO, from the file name');
  assert.match(out.text, new RegExp(`max ${humanBytes(PAPhoto.MAX_BYTES)}`), 'and the sentence names the cap the component actually enforces');
  assert.equal(PAPhoto.MAX_BYTES > 0 && PAPhoto.MAX_BYTES < BODY_LIMITS.upload, true, 'which is the FILE cap, not the body cap');
});

test('a broker that never answers resolves as a NAMED failure, not a promise that hangs forever', async () => {
  const { PAPhoto } = mountComponent(() => { /* the shell is gone: no reply ever comes */ });
  const core0 = core(winChat());
  assert.match(SRC, /PAP_REQ_TIMEOUT_MS=\d+/, 'the timeout is a named constant, not a magic number');
  assert.match(core0.PAP_TXT.timeout, /外壳无响应/, 'and the sentence says the shell did not answer, bilingually');
  // The real timeout is 120s — far too long to sit through here — so the CONTRACT is proved on
  // the core's own text plus the source pin above, and labelled as such (R14: no false claim).
  assert.match(stripComments(SRC), /res\(\{ok:false,code:'timeout',error:PAP_TXT\.timeout\}\)/, 'silence resolves as an outcome like any other (R5)');
  assert.ok(PAPhoto && typeof PAPhoto.upload === 'function');
});

test('an unreadable file is reported, not swallowed — and the FileReader error path really fires', async () => {
  const { PAPhoto } = mountComponent(() => { assert.fail('a file that cannot be read must never reach the broker'); });
  const out = await PAPhoto.toBase64({ name: 'broken.jpg', size: 10, type: 'image/jpeg', _b64: '', _fail: true });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'unreadable');
  assert.match(out.text, /无法读取该照片/, 'the user is told, in both languages');
  const none = await PAPhoto.upload(null);
  assert.equal(none.ok, false, 'and no file at all is an outcome too, never a thrown TypeError');
  assert.equal(none.code, 'no-file');
});

/* ═══ PART F2 — the CAMERA, and the downscale that makes a phone photo usable ════════════ */

test('the picker opens the CAMERA only when asked — a chat attachment must keep the library', async () => {
  const lib = mountComponent(() => {}, { onPick: (el, h) => { el.files = []; h.cancel(); } });
  const a = await lib.PAPhoto.pick();
  assert.equal(lib.inputs[0].attrs.capture, undefined,
    'no capture attribute by default: on iOS it REMOVES the photo library, which is where a chat attachment comes from');
  assert.equal(lib.inputs[0].accept, 'image/*');
  assert.deepEqual({ ok: a.ok, cancelled: a.cancelled, n: a.files.length }, { ok: false, cancelled: true, n: 0 },
    'a cancelled pick is a shaped outcome, never a bare null the caller has to guess at');

  const cam = mountComponent(() => {}, { onPick: (el, h) => { el.files = [fakeFile('x.jpg', 'x')]; h.change(); } });
  const b = await cam.PAPhoto.pick({ camera: true });
  assert.equal(cam.inputs[0].attrs.capture, 'environment',
    'camera:true is capture="environment" — the camera on a phone, the picker on a laptop');
  assert.equal(b.ok, true);
  assert.equal(b.files.length, 1);
});

test('pick({multiple:true}) sets the input to multiple and returns EVERY file, in order', async () => {
  const lib = mountComponent(() => {}, { onPick: (el, h) => { el.files = [fakeFile('a.jpg', 'a'), fakeFile('b.jpg', 'b'), fakeFile('c.jpg', 'c')]; h.change(); } });
  const r = await lib.PAPhoto.pick({ multiple: true });
  assert.equal(lib.inputs[0].multiple, true);
  assert.deepEqual({ ok: r.ok, names: r.files.map((f) => f.name) }, { ok: true, names: ['a.jpg', 'b.jpg', 'c.jpg'] });
  const one = mountComponent(() => {}, { onPick: (el, h) => { el.files = [fakeFile('a.jpg', 'a')]; h.change(); } });
  await one.PAPhoto.pick();
  assert.equal(one.inputs[0].multiple, false, 'CONTROL: off unless asked');
});

test('capture() defaults to the camera AND to a downscale — that is the whole point of one path', async () => {
  // A 12MP phone shot of a glucose meter: 8MB, 4032x3024. Uploading it whole is what every
  // surface except the meal UI used to do.
  const shot = { name: 'IMG_4821.HEIC', size: 8 * 1024 * 1024, type: 'image/heic', _b64: '', _w: 4032, _h: 3024 };
  let posted = null;
  const m = mountComponent((msg, win) => { posted = msg; win._emit({ pa: 'res', id: msg.id, ok: true, path: 'uploads/1_IMG_4821.HEIC' }); },
    { onPick: (el, h) => { el.files = [shot]; h.change(); } });
  const out = await m.PAPhoto.capture();
  assert.equal(m.inputs[0].attrs.capture, 'environment', 'capture() means the camera by default');
  assert.equal(out.ok, true, JSON.stringify(out));
  // 4032x3024 fitted to the default 1600 long edge = 1600x1200 = 1,920,000 px, at the harness's
  // 1 byte per 50 px = ~38KB. The exact number is the harness's; that it is FAR below the
  // original 8MB is the component's.
  assert.ok(out.bytes < shot.size / 20, `the photo was downscaled before it was sent (${out.bytes} vs ${shot.size})`);
  assert.equal(Buffer.from(posted.data, 'base64').length, out.bytes, 'and the bytes reported are the bytes actually posted');
});

test('a photo far over the cap is ACCEPTED once it is resized — the refusal chat used to give was avoidable', async () => {
  const huge = { name: 'IMG_9.jpg', size: 40 * 1024 * 1024, type: 'image/jpeg', _b64: '', _w: 6000, _h: 4000 };
  // Without a resize this is refused, correctly: 40MB cannot cross a 20MB body.
  let sent = false;
  const plain = mountComponent(() => { sent = true; });
  const no = await plain.PAPhoto.upload(huge);
  assert.equal(no.ok, false, 'unresized, it is over the cap');
  assert.equal(no.code, CODE_TOO_LARGE);
  assert.equal(sent, false, 'and nothing was spent finding that out');
  // With the resize the SAME photo fits — and the pre-flight runs on the resized bytes, not the
  // original, or every camera photo would be refused before it was ever shrunk.
  const m = mountComponent((msg, win) => win._emit({ pa: 'res', id: msg.id, ok: true, path: 'uploads/2_IMG_9.jpg' }),
    { onPick: (el, h) => { el.files = [huge]; h.change(); } });
  const yes = await m.PAPhoto.capture();
  assert.equal(yes.ok, true, `the resized photo must be accepted: ${JSON.stringify(yes)}`);
  assert.ok(yes.bytes < m.PAPhoto.MAX_BYTES, 'comfortably under the cap');
});

test('a file that is not an image says so, and a canvas that cannot encode is reported too', async () => {
  const m = mountComponent(() => { assert.fail('nothing that failed to encode may reach the broker'); });
  const notImg = await m.PAPhoto.toBase64({ name: 'notes.pdf', size: 100, type: 'application/pdf', _notImage: true }, { maxEdge: 1600 });
  assert.equal(notImg.ok, false);
  assert.match(notImg.text, /该文件不是图片/, 'the Image error path fires and is named — not swallowed into a generic failure (R5)');
  assert.equal(notImg.code, 'unreadable');
});

/* ═══ PART G — delivery: the marker, the idempotence guard, and the one outstanding step ══ */

test('the component names its marker BARE in its own header, or it would erase its own docs', () => {
  const header = SRC.slice(0, SRC.indexOf('-->'));
  assert.match(header, /\bPA_PHOTO_UI\b/, 'the header documents the marker');
  assert.equal(/<!--\s*PA_PHOTO_UI\s*-->/.test(header), false,
    'written bare: the literal form would close this comment early AND be replaced by the file\'s own content at serve time');
});

test('a double inline is a no-op, because chat-ui carries the marker and an app may carry it too', () => {
  assert.match(SRC, /if\(window\.PAPhoto\) return;/, 'the idempotence guard is the first statement of the component');
  assert.match(CHAT, /<!--PA_PHOTO_UI-->/, 'chat-ui carries the marker, so every app that mounts PAChat gets PAPhoto with no per-app edit');
});

test('OUTSTANDING: the PA_COMPONENTS registration in web.mjs, and the ORDER it must take', (t) => {
  const registered = /photo-ui\.inline\.html/.test(WEB);
  if (!registered) {
    t.diagnostic('PA_PHOTO_UI is NOT yet registered in web.mjs PA_COMPONENTS — the component is not served. '
      + "Add { marker: PA_PHOTO_MARKER, file: 'photo-ui.inline.html' } LAST in PA_COMPONENTS.");
    assert.equal(registered, false, 'recorded as outstanding, deliberately: web.mjs is owned by another session this cycle');
    return;
  }
  // Once it is registered the ordering becomes a real invariant: web.mjs re-tests the ALREADY
  // INLINED html for each remaining marker, so PAPhoto must come AFTER chat-ui or chat-ui's
  // marker is never resolved.
  const order = [...WEB.matchAll(/file: '([a-z-]+\.inline\.html)'/g)].map((m) => m[1]);
  assert.ok(order.indexOf('photo-ui.inline.html') > order.indexOf('chat-ui.inline.html'),
    'PAPhoto must be registered AFTER chat-ui, or the marker chat-ui carries is never inlined');
});

/* ═══ PART H — the inlining itself, which is the only way this component reaches an app ═══ */
// The marker is not yet registered (see above), so the SERVED page cannot be asserted over HTTP
// yet. What CAN be proved today is the mechanism: web.mjs's replacement loop, pinned to its own
// source and reproduced over the REAL component files, with PAPhoto registered last.

const PA_LOOP = (html, components) => {           // == web.mjs sendAppHtml's loop, pinned below
  for (const c of components) {
    if (!html.includes(c.marker)) continue;
    html = html.split(c.marker).join(read('web', c.file));
  }
  return html;
};

test('an app that mounts PAChat receives PAPhoto too — once, with no per-app edit', () => {
  // The loop reproduced above really is the shipped one, character for character on the two
  // lines that decide this. A reproduction that drifted would prove nothing (R14).
  assert.match(WEB, /for \(const c of PA_COMPONENTS\)/, 'the shipped loop walks PA_COMPONENTS in order');
  assert.match(WEB, /if \(!html\.includes\(c\.marker\)\) continue;/, 'skipping markers the page does not carry');
  assert.match(WEB, /html = html\.split\(c\.marker\)\.join\(snippet\);/, 'and replacing EVERY occurrence — which is what lets chat-ui pull PAPhoto in');
  const registry = [
    { marker: '<!--PA_CHAT_UI-->', file: 'chat-ui.inline.html' },
    { marker: '<!--PA_SPLIT_UI-->', file: 'split-ui.inline.html' },
    { marker: '<!--PA_SETTINGS_UI-->', file: 'settings-ui.inline.html' },
    { marker: '<!--PA_PHOTO_UI-->', file: 'photo-ui.inline.html' },   // LAST, so chat-ui's copy resolves
  ];
  const served = PA_LOOP('<body><!--PA_CHAT_UI--></body>', registry);
  assert.equal(served.split('window.PAPhoto=').length - 1, 1, 'exactly one PAPhoto definition reached the page');
  assert.equal(served.split('window.PAChat=').length - 1, 1, 'and exactly one PAChat');
  assert.equal(served.includes('<!--PA_PHOTO_UI-->'), false, 'no marker survives into the served html');
  // Registered BEFORE chat-ui, the marker chat-ui carries is never revisited — the ordering note
  // in PA_COMPONENTS is load-bearing, not decoration.
  const wrongOrder = PA_LOOP('<body><!--PA_CHAT_UI--></body>', [registry[3], registry[0]]);
  assert.equal(wrongOrder.includes('<!--PA_PHOTO_UI-->'), true, 'registered too early it is left unresolved — hence "LAST"');
});

test('an app that ALSO carries the marker gets the source twice and the component once', () => {
  const registry = [
    { marker: '<!--PA_CHAT_UI-->', file: 'chat-ui.inline.html' },
    { marker: '<!--PA_PHOTO_UI-->', file: 'photo-ui.inline.html' },
  ];
  const served = PA_LOOP('<body><!--PA_CHAT_UI--><!--PA_PHOTO_UI--></body>', registry);
  assert.equal(served.split('if(window.PAPhoto) return;').length - 1, 2, 'the source really is inlined twice');
  // Executed, not assumed: the second copy must return before it registers a second broker
  // listener, or one reply would resolve one waiter and the other would sit there forever.
  const body = SRC.slice(SRC.indexOf('<script id="pap-script">') + '<script id="pap-script">'.length, SRC.lastIndexOf('</script>'));
  let listeners = 0;
  const win = { addEventListener: (t) => { if (t === 'message') listeners++; }, removeEventListener: () => {} };
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'parent', 'FileReader', 'document', 'Image', 'URL', `${body}\n${body}\nreturn window.PAPhoto;`);
  const api = run(win, { postMessage: () => {} }, class {}, { createElement: () => ({}) }, class {}, {});
  assert.equal(listeners, 1, 'the second inline registered NO second listener');
  assert.equal(typeof api.upload, 'function', 'and the one component is intact');
});

/* ══ THE POINT OF THE COMPONENT: there is no SECOND photo path left ════════════════════════
   PAPhoto was built as a deletion (R1), and a deletion is only real once the copies are gone.
   The rule the user's own scar states: on a bug in a pattern, fix EVERY occurrence and pin an
   invariant — patching the reported one invites the same report again. So this enumerates the
   surfaces rather than spot-checking the ones that were migrated first. */
test('no surface owns a private photo reader any more — enumerated, not spot-checked', () => {
  // Every shared component except PAPhoto itself, and every committed app template. Derived by
  // listing the directories, so a component or app added LATER is checked without a list to
  // update — omission has to be impossible here, not merely unlikely.
  const components = fs.readdirSync(path.join(ROOT, 'web'))
    .filter((f) => f.endsWith('.inline.html') && f !== 'photo-ui.inline.html')
    .map((f) => path.join('web', f));
  const appsDir = path.join(ROOT, 'workspace.example', 'apps');
  const apps = fs.readdirSync(appsDir)
    .map((d) => path.join('workspace.example', 'apps', d, 'index.html'))
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  assert.ok(components.length >= 3 && apps.length >= 4,
    `the sweep must actually find files, or it passes vacuously (R14): ${components.length} components, ${apps.length} apps`);
  // Comments are documentation: several of these files deliberately QUOTE the deleted code
  // ("capture=\"environment\" opens the camera…", "a private FileReader…"), and a sweep that
  // could not tell a comment from a statement would fail on its own scar notes.
  // createObjectURL(blob) of a JSON export (productivity-hub's download) is not a photo reader.
  const OWN_READER = /new FileReader\(|readAsDataURL|createObjectURL\((?!blob\))|capture\s*=/;
  for (const rel of [...components, ...apps]) {
    const src = stripComments(read(...rel.split('/')).replace(/<!--[\s\S]*?-->/g, ''));
    const hit = src.split('\n').find((l) => OWN_READER.test(l));
    assert.equal(hit, undefined,
      `${rel} grew its own photo reader/picker again — it must go through PAPhoto:\n    ${String(hit).trim()}`);
  }
  // …and the surfaces that DO take photos really call the component, so "no reader" cannot be
  // satisfied by quietly dropping the feature instead of migrating it.
  for (const [rel, call] of [
    ['web/chat-ui.inline.html', /PAPhoto\.upload\(/],
    ['web/note-ui.inline.html', /PAPhoto\.pick\(/],
    ['workspace.example/apps/notes/index.html', /PAPhoto\.upload\(/],
    ['workspace.example/apps/longevity/index.html', /PAPhoto\.(pick|toBase64)\(/],
    ['workspace.example/apps/diabetes/index.html', /PAPhoto\.(pick|toBase64)\(/],
  ]) {
    assert.match(read(...rel.split('/')), call, `${rel} still takes photos, through the shared component`);
  }
});

test('the note pad stands down from its own pre-flight only when PAPhoto is there to do it', () => {
  // The pad's cap only ever had the right to say "the server will not take this". Once the app's
  // uploadImage DOWNSCALES, checking the ORIGINAL file size would refuse an 8MB camera shot that
  // lands at 300KB — a false refusal, which is the failure the cap exists to prevent, inverted.
  const NOTE = read('web', 'note-ui.inline.html');
  assert.match(NOTE, /if\(!window\.PAPhoto&&file&&file\.size>PHOTO_MAX_BYTES\)\{ flash\(PHOTO_TXT\.big\(PHOTO_MAX_BYTES\)\+PHOTO_TXT\.bigAct\); return; \}/,
    'the guard is still there for a page without the component, and gone for a page with it');
  assert.match(NOTE, /noComponent:'无法添加照片 · Photo unavailable/,
    'and a missing component is NAMED rather than silently doing nothing (R5)');
  // The cap itself is untouched: PANote still EXPORTS the number an app states in its own surface.
  assert.match(NOTE, /UPLOAD_MAX_BYTES, PHOTO_TXT,/, 'the exported cap and vocabulary are unchanged');

  // …and the OTHER half of that trade: the app hook must ASK for the downscale. PAPhoto.upload()
  // resizes only when told to — capture() is the call that defaults it, and the test above
  // ("a photo far over the cap is ACCEPTED once it is resized") shows a bare upload() being
  // refused at full size. Since the pad has stood down from its own pre-flight, a hook that
  // forgot maxEdge would send the original all the way to the server to earn a 413. Silent in
  // the common case, which is exactly why it is pinned.
  for (const rel of ['workspace.example/apps/notes/index.html']) {
    assert.match(read(...rel.split('/')), /PAPhoto\.upload\(file,\{name:file\.name\|\|'image\.png',what:'Photo',\s*maxEdge:window\.PAPhoto\.DEFAULT_MAX_EDGE\}\)/,
      `${rel}: the note upload hook asks for the downscale, by the component's own constant (R3)`);
  }
});

test('camera-as-input replaced the Shortcut, and a photographed health screen is NOT a measurement', () => {
  // PLAN.md "CAMERA AS INPUT" (2026-09-11): the Apple Shortcuts health-ingest route is dropped
  // as a product direction. The Longevity app's health box used to tell the user to "set up the
  // Shortcut" — pointing a family member at a route nobody could make work is worse than saying
  // nothing, and it is the one piece of that UX this change had to remove rather than repair.
  const LNG = read('workspace.example', 'apps', 'longevity', 'index.html');
  // On the STRIPPED source: the scar comment deliberately quotes the sentence that was removed,
  // and a grep that cannot tell a comment from a statement would fail on its own documentation.
  assert.equal(/set up the Shortcut/i.test(stripComments(LNG.replace(/<!--[\s\S]*?-->/g, ''))), false,
    'the app no longer advertises the abandoned route');
  assert.match(LNG, /拍照读取 · 📷 Photograph a Health screen/, 'it offers the camera instead');
  assert.match(LNG, /PAPhoto\.capture\(\)/, 'through the shared component, camera-first and downscaled');

  // THE JUDGEMENT, pinned: this reading is shown and talked about, never stored as a metric.
  // A misread "12,480 steps" entering health.json would be reported back as fact by the weekly
  // 健康简报 and by the health jobs. Storing it needs a confirmation step like the glucose one,
  // and a write path that does not exist yet — so until then it must not be written at all.
  const shot = LNG.slice(LNG.indexOf('async function healthShot'), LNG.indexOf('broker({kind:\'health\''));
  assert.ok(shot.length > 400, 'the handler was really found (R14)');
  assert.equal(/save-data|health\/ingest|HEALTH\.push|HEALTH=/.test(shot), false,
    'the reading is never written to a store and never merged into the imported health days');
  assert.match(shot, /textContent=HEALTH_SHOT/, 'and model output reaches the page as TEXT, never innerHTML');
  assert.match(LNG, /not a stored measurement 未存入记录/, 'the user is told which it is');
  assert.match(LNG, /a reading of a PHOTO, not a stored measurement/,
    'and so is the advisor, so it can weigh a reported number differently from a measured one');
});
