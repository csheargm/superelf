// The hosts forward a search hit to the pad (phase 3 of note search): the Journal's openEntry runs
// for real (helpers-app runApp, the engine's save guard, a real server) and hands `at` to
// pad.reveal AFTER the reload; the Bible's open path is pinned in both shipped copies (its openDrawFull
// needs the rail and the chapter loader, which the harness does not stand up). Template and live
// copies of both apps are checked, so the two cannot drift apart on this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_SRC, startHarness, runApp, until } from './helpers-app.mjs';

const NOTEBOOK = { v: 3, id: 'nb', pages: [{ id: 'p0', strokes: [], pageHtml: '<div>landlord</div>', images: [] }, { id: 'p1', strokes: [{ p: [[0.1, 0.2]] }], pageHtml: '', images: [] }] };
const INDEX = { v: 1, entries: [{ id: 'e0', title: 'Note 0', created: 1, updated: 2, preview: 'p' }] };
const AT = { page: 1, boxes: [[0.1, 0.2, 0.5, 0.05]], terms: ['landlord'] };

for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: openEntry(id, at) reveals the hit on the pad after the reload; a plain open reveals nothing`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', INDEX); h.put('entry-e0.json', NOTEBOOK);
      const A = runApp(app, h.relay, ['DATA', 'S', 'openEntry', 'boot'], { clampTimers: true });
      await until(() => A.S.entries.length === 1, 'boot to load the index');
      const pad = A.captured.pads[0];
      await A.openEntry('e0');
      assert.deepEqual(pad.reveals, [], 'no hit: nothing revealed');
      await A.openEntry('e0', AT);
      assert.deepEqual(pad.reveals, [AT], 'the hit, as the drawer handed it');
      assert.deepEqual(pad.nb.pages.length, 2, 'and the reload happened first: the notebook is loaded');
    } finally { await h.stop(); }
  });
}

test('the Journal drawer forwards onOpen\'s second argument to openEntry, in both copies', () => {
  for (const app of ['notes (template)', 'notes (live)']) {
    assert.match(APP_SRC[app], /onOpen:\(id,at\)=>openEntry\(id,at\),/, `${app}: the drawer row`);
    assert.match(APP_SRC[app], /async function openEntry\(id,at,o\)\{/, `${app}: the signature`);
    assert.match(APP_SRC[app], /pad\.setTitle\(displayTitle\(entryById\(id\)\)\);\n  if\(at&&pad\.reveal\) pad\.reveal\(at\);/, `${app}: revealed after the reload and the title, feature-detected`);
  }
});

test('the Bible forwards the hit from the ☰ row through openPanel/openDrawFull to drawPad.reveal, in both copies', () => {
  for (const app of ['bible (template)', 'bible (live)']) {
    const src = APP_SRC[app];
    assert.match(src, /onClick:\(_id,at\)=>\{/, `${app}: the augment row takes the hit`);
    assert.match(src, /goChapter\(n\.bookIdx,n\.chapter\)\.then\(ok=>\{ if\(ok!==false\) doOpen\(at\); \}\); \}\n\s+else doOpen\(at\);/, `${app}: both branches hand it to doOpen (never goChapter()'s own result)`);
    assert.match(src, /const doOpen=\(at\)=>\{/, `${app}: doOpen takes it`);
    assert.match(src, /openPanel\(free\?'draw':\(n\.hasDraws\?'draw':'note'\),free,free\?n\.title:undefined,rowId,at\),120\)/, `${app}: and passes it on`);
    assert.match(src, /async function openPanel\(pane,forceKey,forceTitle,rowId,at\)\{\n  return openDrawFull\(forceKey,forceTitle,rowId,at\);/, `${app}: openPanel forwards`);
    assert.match(src, /async function openDrawFull\(forceKey,forceTitle,rowId,at\)\{/, `${app}: openDrawFull takes it`);
    const open = src.indexOf('await drawPad.open('), reveal = src.indexOf('if(at&&drawPad.reveal) drawPad.reveal(at);');
    assert.ok(open > 0 && reveal > open && reveal - open < 1500, `${app}: revealed after drawPad.open, feature-detected`);
    assert.equal((src.match(/drawPad\.reveal\(/g) || []).length, 1, `${app}: from ONE place`);
  }
});
