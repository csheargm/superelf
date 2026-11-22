// A notebook's own text as a key · 以笔记自身的文字为键 (ADR 0015)
//
// A page's id, an image's path, a template name and a store's reply code are text from the notebook or
// the store, and the Journal's notebook can be written by the app's confined AI turn (ADR 0002). PANote
// looked each one up in a plain {…}, which finds Object.prototype's members. Measured before the fix:
//   · a page id named after one of the 12 (e.g. 'constructor'): every stroke on that page threw a
//     TypeError in pushUndo, so nothing could be drawn there;
//   · a page id of '__proto__': the save guard refused every write ("a page disappeared");
//   · an image path of 'constructor' or '__proto__': the photo stayed a grey box for good;
//   · a template of 'constructor': kept, and drawn as ruled paper with a margin;
//   · a store reply code of 'constructor' or '__proto__': read as "nothing there", so the pad opened
//     a blank note and unlocked writing over the real one.
// Run here as the user meets them (R6): a notebook read from the store, then strokes, undo, redo, a
// page turn, a deleted page, a reload and a save; and a photo resolved and drawn.
//
// FIDELITY (R14), stated plainly. Run VERBATIM from web/note-ui.inline.html: the DOM-free core
// (sanitize, LOAD, makeSaveGuard, census), pull(), the guard as Note() builds it, the stroke pipeline,
// the undo block, delPage, and the image cache with drawImages. Stubbed: canvas drawing, the text
// region and its HTML parser (these pages hold no text), the save pill and curtain, and timers. The
// timers are inert, so every write is an explicit flushSave(), the call a page turn makes. Each case
// is mutation-tested: the old {…} is put back and the same notebook fails. The other gates, and the
// invariant over all of note-ui: test/note-proto-gates.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, settle, mutated } from './helpers-app.mjs';
import { FakeImage } from './helpers-stationery.mjs';
import { PROTO_KEYS, oldTable } from './helpers-proto.mjs';

const cut = (from, to) => {
  const i = ENGINE.indexOf(from), j = ENGINE.indexOf(to, i + from.length);
  assert.ok(i >= 0 && j > i, `note-ui still has ${from.trim()}`);
  return ENGINE.slice(i, j);
};
const CORE = cut('  const SCHEMA=', '\n  function Note(host, opts){');
const PAD = [
  cut('    const page=()=>NB.pages[cur];', '\n'),
  cut('    const clearSelection=', '\n'),
  cut('    const denorm=', '\n'),
  cut('    const imgCache=', '\n    // A photo is stored outside'),
  cut('    function startStroke(e){', '\n    // ── Eraser'),
  cut('    let undoStacks', '\n\n    // ── Pointer routing'),
  cut('    const touchPage=', '\n'),
  `${cut('    async function delPage(){', '\n    }\n')}\n    }`,
  cut('    const guard=makeSaveGuard({', '\n    const flushDurable='),
  cut('    let loadOut=LOAD.absent()', '\n    // Retry the SAME load'),
].join('\n');
const STUBS = `
  const setTimeout=()=>0, clearTimeout=()=>{};                // inert: every write is an explicit flushSave()
  let txtEdit=false, sel=[], marquee=null, moveDrag=null, resizeDrag=null, _sizeWarned='';
  let drawing=false, curTool='pen', curPts=[], drawnUpto=0, rafId=0, tool='pen', color='#111111';
  const W=816, H=1056, inkCtx=null, committedCtx=null, undoBtn={}, redoBtn={}, Image=env.Image;
  const pointAt=(e)=>({x:e.x,y:e.y,p:0.5}), baseFor=()=>3, requestAnimationFrame=()=>0, cancelAnimationFrame=()=>{};
  const drawStroke=()=>{}, segTo=()=>{}, redrawPage=()=>{}, rebuildCommitted=()=>{}, renderTextLayer=()=>{}, drawOverlay=()=>{};
  const commitPageHtml=()=>{}, exitTextMode=()=>{}, renderLock=()=>{}, renderSave=()=>{}, updatePageLabel=()=>{}, flash=()=>{};
  // A written page carries pageHtml:'', which sanitize() parses on the way back in. These pages hold no
  // text, and a page that did would throw here rather than pass unparsed.
  const document={implementation:{createHTMLDocument:()=>({createElement:()=>({childNodes:[], get innerHTML(){ return ''; },
    set innerHTML(v){ if(v) throw new Error('this harness parses no HTML'); }})})}};
  const opts={ load:async()=>LOAD.fromBroker(await env.read()), save:(nb)=>env.save(nb), template:env.template,
    imageUrl:async(p)=>'blob:'+p };`;

// A pad mounted on `reply` (the store's answer to the read), as an app mounts it, then pulled (boot).
async function openPad(reply, { mutate, template } = {}) {
  const src = mutated(`${STUBS}\n${CORE}\nlet NB=freshNotebook(opts.template), cur=0;\n${PAD}`, mutate, 'pad');
  const writes = [];
  // The store reads back what it last took, as the real one does after a write.
  const env = { Image: FakeImage, template, read: async () => (writes.length ? { ok: true, text: JSON.stringify(writes.at(-1)) } : reply),
    save: async (nb) => { writes.push(JSON.parse(JSON.stringify(nb))); return { ok: true }; } };
  // eslint-disable-next-line no-new-func
  const pad = new Function('env', `${src}
    return { pull, endStroke, undo, redo, delPage, flushSave, drawImages, primeImage, guard, NB:()=>NB, page,
      draw:(x)=>{ startStroke({x,y:100}); extendStroke({x:x+20,y:130}); endStroke(); },
      turnTo:(i)=>{ cur=i; pruneOtherPageHistory(); clearSelection(); updateUndo(); },
      canUndo:()=>!undoBtn.disabled, canRedo:()=>!redoBtn.disabled };`)(env);
  await pad.pull(false);
  return { pad, writes };
}
const stored = (ids, extra = {}) => ({ ok: true, text: JSON.stringify({ v: 2, id: 'nb', created: 1, updated: 1, template: 'plain',
  pages: ids.map((id) => ({ id, created: 1, updated: 1, strokes: [], images: [] })), ...extra }) });
const strokes = (pad) => pad.page().strokes.length;

// ── A page's id: undo history and the save guard ───────────────────────────────────────────────
// [as shipped, as it was]: the declaration and the three resets in pull().
const HISTORY = 'let undoStacks, redoStacks; const clearHistory=()=>{ undoStacks=Object.create(null); redoStacks=Object.create(null); }; clearHistory();';
const oldHistory = (s) => s.replace(HISTORY, 'let undoStacks={}, redoStacks={};').replaceAll(' clearHistory();', ' undoStacks={}; redoStacks={};');
const OLD_CENSUS = (s) => s.replace('pages:Object.create(null)', 'pages:{}');

test('a page whose id is an Object.prototype name takes a stroke, undoes and redoes it, and saves it', async () => {
  for (const id of PROTO_KEYS) {
    const { pad, writes } = await openPad(stored([id, 'p2']));
    assert.equal(pad.page().id, id, 'the page keeps its id: a load does not rename pages');
    pad.draw(100);
    assert.equal(strokes(pad), 1, `${id}: the stroke is on the page`);
    pad.undo();
    assert.equal(strokes(pad), 0, `${id}: undo takes it off`);
    assert.ok(pad.canRedo() && !pad.canUndo(), `${id}: and the bar says so`);
    pad.redo();
    assert.equal(strokes(pad), 1, `${id}: redo puts it back`);
    const r = await pad.flushSave();
    assert.ok(r.ok, `${id}: ${r.error}`);
    assert.equal(writes.at(-1).pages[0].strokes.length, 1, `${id}: the stroke is in the file`);
  }
});
test('mutation: with the old {} history maps, the first stroke on such a page throws a TypeError', async () => {
  for (const id of PROTO_KEYS) {
    const { pad } = await openPad(stored([id]), { mutate: oldHistory });
    assert.throws(() => pad.draw(100), TypeError, id);
  }
});

test('history stays per page across a page turn, a deleted page and a reload', async () => {
  const { pad, writes } = await openPad(stored(['constructor', '__proto__', 'p3']));
  pad.draw(100);
  pad.turnTo(1);
  assert.ok(!pad.canUndo(), "page '__proto__' has no history of its own yet");
  pad.draw(200); pad.draw(300);
  pad.undo();
  assert.equal(strokes(pad), 1, 'undo on this page undoes this page');
  await pad.delPage();
  assert.deepEqual(writes.at(-1).pages.map((p) => [p.id, p.strokes.length]), [['constructor', 1], ['p3', 0]]);
  await pad.pull(true);                                         // a reload: clearHistory() in pull()
  assert.deepEqual(pad.NB().pages.map((p) => p.id), ['constructor', 'p3'], 'the reload read the file back');
  assert.ok(!pad.canUndo() && !pad.canRedo(), 'a reload starts every page with no history');
  pad.draw(100);
  assert.ok(pad.canUndo(), 'and the next stroke on page constructor can be undone');
});

test("mutation: with the census's old {} map, a page whose id is __proto__ can never be saved", async () => {
  const { pad, writes } = await openPad(stored(['__proto__']), { mutate: OLD_CENSUS });
  pad.draw(100);
  const r = await pad.flushSave();
  assert.match(r.error, /a page disappeared/);
  assert.equal(writes.length, 0, 'nothing reached the store');
});
// The guard is not blinded either way: a page that vanishes on its own (no user action, so no
// allowShrink) is still refused when its id is a prototype name.
const vanish = async (id, mutate) => {
  const { pad, writes } = await openPad(stored([id, 'p2']), { mutate });
  pad.NB().pages[0] = { id: 'other', created: 1, updated: 1, strokes: [], pageHtml: '', images: [] };
  pad.guard.touch();
  return { r: await pad.flushSave(), writes };
};
test('the shrink guard refuses a write in which a page named after a prototype member vanished', async () => {
  for (const id of PROTO_KEYS) {
    const { r, writes } = await vanish(id);
    assert.match(r.error || '', /a page disappeared/, id);
    assert.equal(writes.length, 0, id);
  }
});
test('mutation: with the old census map, that write goes through for every name the map finds as a function', async () => {
  for (const id of PROTO_KEYS.filter((k) => k !== '__proto__')) {   // '__proto__' is refused there, by accident
    const { r, writes } = await vanish(id, OLD_CENSUS);
    assert.ok(r.ok && writes.length === 1, `${id}: the vanished page was written over`);
  }
});

// ── A store reply code: "nothing there" opens a blank, writable note ──────────────────────────
const failedRead = (code) => ({ ok: false, code, error: 'x' });
test('a read that fails with a code named after a prototype member locks the pad: nothing is written', async () => {
  for (const code of PROTO_KEYS) {
    const { pad, writes } = await openPad(failedRead(code));
    pad.draw(100);
    assert.equal((await pad.flushSave()).ok, false, code);
    assert.equal(writes.length, 0, `${code}: the note on the server is untouched`);
  }
  const { pad, writes } = await openPad(failedRead('not-found'));   // control: a real absence opens a note
  pad.draw(100);
  assert.ok((await pad.flushSave()).ok && writes.length === 1, 'not-found is still a proven absence');
});
test('mutation: with the old LOAD_NOT_FOUND, codes constructor and __proto__ open a blank note that is written', async () => {
  const absent = [];
  for (const code of PROTO_KEYS) {
    const { pad, writes } = await openPad(failedRead(code), { mutate: oldTable('LOAD_NOT_FOUND') });
    pad.draw(100);
    if ((await pad.flushSave()).ok && writes.length) absent.push(code);
  }
  assert.deepEqual(absent, ['constructor', '__proto__'], 'the codes are lower-cased first, so only these two match');
});

// ── A template name, through the load and through the host ───────────────────────────────────
const OLD_TPL = oldTable('VALID_TPL');
test("a stored template named after a prototype member opens as the legacy 'ruled', and is saved so", async () => {
  for (const template of [...PROTO_KEYS, ['grid']]) {
    const { pad, writes } = await openPad(stored(['p1'], { template }));
    assert.equal(pad.NB().template, 'ruled', String(template));
    pad.draw(100); await pad.flushSave();
    assert.equal(writes.at(-1).template, 'ruled');
  }
});
test("a host template named after a prototype member, or not a string, gives a new note the default 'plain'", async () => {
  for (const template of [...PROTO_KEYS, ['grid']]) {
    const { pad } = await openPad(failedRead('not-found'), { template });
    await pad.pull(true);                                       // a reload onto a note that does not exist yet
    assert.equal(pad.NB().template, 'plain', String(template));
  }
  assert.equal((await openPad(failedRead('not-found'), { template: 'grid' })).pad.NB().template, 'grid', 'control');
});
test('mutation: with the old VALID_TPL, both keep the name; without either string check, ["grid"] is kept', async () => {
  for (const template of PROTO_KEYS) {
    assert.equal((await openPad(stored(['p1'], { template }), { mutate: OLD_TPL })).pad.NB().template, template);
    assert.equal((await openPad(failedRead('not-found'), { template, mutate: OLD_TPL })).pad.NB().template, template);
  }
  const noHostCheck = (s) => s.replace("typeof tpl==='string'&&VALID_TPL[tpl]", 'VALID_TPL[tpl]');
  assert.deepEqual((await openPad(failedRead('not-found'), { template: ['grid'], mutate: noHostCheck })).pad.NB().template, ['grid']);
  const noStoredCheck = (s) => s.replace("typeof o.template==='string'&&VALID_TPL[o.template]", 'VALID_TPL[o.template]');
  assert.deepEqual((await openPad(stored(['p1'], { template: ['grid'] }), { mutate: noStoredCheck })).pad.NB().template, ['grid']);
});

// ── An image's path: the photo cache ────────────────────────────────────────────────────────
const sheet = () => { const drawn = []; return { drawn, drawImage: (img) => drawn.push(img.src), save() {}, restore() {},
  fillRect() {}, strokeRect() {}, set fillStyle(v) {}, set strokeStyle(v) {} }; };
const OLD_CACHE = (s) => s.replace('const imgCache=Object.create(null);', 'const imgCache={};');
const photos = (paths) => ({ images: paths.map((path) => ({ path, x: 0.1, y: 0.1, w: 0.2, h: 0.2 })) });
test('a photo whose path is an Object.prototype name resolves and is drawn, and leaves the others alone', async () => {
  const paths = [...PROTO_KEYS, 'photo.jpg'];
  const { pad } = await openPad(stored(['p1']));
  pad.drawImages(photos(paths), sheet());                       // the first paint asks for each photo
  await settle();
  const ctx = sheet(); pad.drawImages(photos(paths), ctx);
  assert.deepEqual(ctx.drawn, paths.map((p) => `blob:${p}`), 'every photo is drawn, none is a grey box');
});
test('mutation: with the old {} cache, those photos stay grey boxes', async () => {
  const { pad } = await openPad(stored(['p1']), { mutate: OLD_CACHE });
  pad.drawImages(photos([...PROTO_KEYS, 'photo.jpg']), sheet());
  await settle();
  const ctx = sheet(); pad.drawImages(photos([...PROTO_KEYS, 'photo.jpg']), ctx);
  assert.deepEqual(ctx.drawn, ['blob:photo.jpg'], 'only the ordinary path is drawn');
});
// Inserting a photo primes the cache with its uploaded path (addPhoto → primeImage). A path of
// '__proto__' used to replace the cache's prototype, so the paths 'img' and 'ready' then found the
// record's own fields and stayed grey boxes.
const inserted = async (mutate) => {
  const { pad } = await openPad(stored(['p1']), { mutate });
  await pad.primeImage('__proto__', 'blob:__proto__');
  const paths = photos(['__proto__', 'img', 'ready', 'photo.jpg']);
  pad.drawImages(paths, sheet());
  await settle();
  const ctx = sheet(); pad.drawImages(paths, ctx);
  return ctx.drawn;
};
test('a photo inserted with the path __proto__ is drawn, and every other path still resolves', async () => {
  assert.deepEqual(await inserted(), ['blob:__proto__', 'blob:img', 'blob:ready', 'blob:photo.jpg']);
});
test('mutation: with the old {} cache, that insert leaves the photos at img and ready grey', async () => {
  assert.deepEqual(await inserted(OLD_CACHE), ['blob:__proto__', 'blob:photo.jpg']);
});
