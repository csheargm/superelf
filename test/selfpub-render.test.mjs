// iPhone render check (docs/adr/0044 §4, lib/selfpub/render.mjs), with the REAL headless Chromium: before
// (origin/main) and after (the checkout) at 390 px, a sideways-scrolling change fails the check, the page is
// served only from memory, and no browser means "no renderer" (verify then says not ready). Fails without
// Playwright unless PA_E2E_SKIP=1 (test/helpers-e2e-gate.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip } from './helpers-note-link.mjs';
import { selfpubFixture, tgit } from './helpers-selfpub.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { makeRenderer, playwrightPath, PHONE, NOT_VISIBLE, PREVIEW_MARKERS } from '../lib/selfpub/render.mjs';
import { fillShellMarkers } from '../lib/shellhtml.mjs';
import { writeVerLine } from './helpers-selfpub-verline.mjs';

function checkout(fx) {
  const dir = path.join(fx.d, 'co'); tgit(fx.d, 'clone', '-q', fx.bare, dir); return dir;
}

test('no browser on the node → no renderer (verify says so, never a pass)', () => {
  assert.equal(makeRenderer({ shotsDir: '/tmp/x', env: {} }), null);
  assert.equal(playwrightPath({ SELFPUB_PLAYWRIGHT: '/nonexistent/index.mjs' }), '');
});

test('renders before and after at iPhone width; a page that scrolls sideways fails', { skip, timeout: 120000 }, async () => {
  const fx = selfpubFixture({ web: true });
  try {
    const dir = checkout(fx), shots = path.join(fx.d, 'shots');
    const render = makeRenderer({ shotsDir: shots });
    fs.appendFileSync(path.join(dir, 'web', 'home-v2.css'), '\nheader h1{font-size:30px}\n');
    const ok = await render(dir, ['web/home-v2.css'], 'aaaa1');
    assert.equal(ok.ok, true, ok.note); assert.equal(ok.same, false, 'a visible change is seen'); assert.equal(ok.measured.width, PHONE.width);
    assert.deepEqual(ok.shots.map((f) => path.basename(f)), ['aaaa1-0.png', 'aaaa1-1.png']);
    for (const f of ok.shots) assert.ok(fs.statSync(f).size > 5000, 'a real picture');
    assert.notDeepEqual(fs.readFileSync(ok.shots[0]), fs.readFileSync(ok.shots[1]), 'the change shows');
    const hidden = path.join(fx.d, 'co2'); tgit(fx.d, 'clone', '-q', fx.bare, hidden);
    fs.appendFileSync(path.join(hidden, 'web', 'home-v2.css'), '\n.nowhere-on-home{color:red}\n');
    const same = await render(hidden, ['web/home-v2.css'], 'dddd4');
    assert.equal(same.same, true, 'pixel-identical shots are said to be'); assert.equal(same.note, NOT_VISIBLE);
    assert.match(same.note, /^改动在截图里看不出 · Change not visible in screenshots/);
    assert.notEqual(same.measured.hello, '', 'the seeded Home draws the greeting (2026-11-26: it was bare)'); assert.match(same.measured.hello, /Owner/);
    assert.ok(same.measured.tiles >= 3, `the seeded Home draws app tiles (${same.measured.tiles})`);
    const words = path.join(fx.d, 'co3'); tgit(fx.d, 'clone', '-q', fx.bare, words);
    for (const f of ['home-v2.js', 'index.html']) { const hv = path.join(words, 'web', f); fs.writeFileSync(hv, fs.readFileSync(hv, 'utf8').replace(/更多应用 · More apps/g, '更多 · Mehr')); }
    assert.equal((await render(words, ['web/home-v2.js'], 'eeee5')).same, false, 'changed words with the same layout are seen (GPT review r2)');
    fs.appendFileSync(path.join(dir, 'web', 'home-v2.css'), '\nbody{min-width:900px}\n');
    const wide = await render(dir, ['web/home-v2.css'], 'bbbb2');
    assert.equal(wide.ok, false); assert.match(wide.note, /scrolls sideways at iPhone width/);
    fs.appendFileSync(path.join(dir, 'web', 'home-v2.js'), '\nthrow new Error("selfpub broken home");\n');
    const broken = await render(dir, ['web/home-v2.js'], 'cccc3');
    assert.equal(broken.ok, false, 'a script error at load is not a pass (GPT review)'); assert.match(broken.note, /New page script error: .*selfpub broken home/);
  } finally { rmTemp(fx.d); }
});

test('the owner\'s version-line change (3 files) shows in After: the preview fills the version like the live node (2026-11-26)', { skip, timeout: 120000 }, async () => {
  const fx = selfpubFixture({ web: true });
  try {
    const dir = checkout(fx), render = makeRenderer({ shotsDir: path.join(fx.d, 'shots') });
    writeVerLine(dir);
    const r = await render(dir, ['web/home-v2.css', 'web/home-v2.js', 'web/index.html'], 'ver01');
    assert.equal(r.ok, true, r.note); assert.equal(r.same, false, 'the version line is drawn, so the shots differ'); assert.equal(r.note, '');
  } finally { rmTemp(fx.d); }
});

test('fillShellMarkers: every build marker filled, a $ in a value kept literally (one helper for web.mjs and the preview, R3)', () => {
  const html = fillShellMarkers('<!--APP_VERSION-->|<!--APP_VTIME-->|<!--APP_VDATE-->|<!--APP_NOTES-->', { version: 'v1 $&', vtime: 't', vdate: 'd', notes: '{"a":1}' });
  assert.equal(html, 'v1 $&|t|d|{"a":1}');
  assert.doesNotMatch(fillShellMarkers('<!--APP_VERSION-->', PREVIEW_MARKERS), /<!--/);
  assert.doesNotMatch(fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8'), /\.replace\('<!--APP_VERSION-->'/, 'web.mjs fills through the shared helper');
});

test('regression: a change that ADDS a shell part (its own web/shell-parts.json) is drawn in After (docs/adr/0049)', { skip, timeout: 120000 }, async () => {
  const fx = selfpubFixture({ web: true });
  try {
    const dir = checkout(fx), render = makeRenderer({ shotsDir: path.join(fx.d, 'shots') });
    fs.writeFileSync(path.join(dir, 'web', 'skin.js'), "addEventListener('DOMContentLoaded',()=>{ const d=document.createElement('div'); d.textContent='SKIN'; d.style.cssText='position:fixed;left:0;right:0;top:0;height:60px;background:#c2185b;color:#fff'; document.body.appendChild(d); });\n");
    const idx = path.join(dir, 'web', 'index.html'), list = path.join(dir, 'web', 'shell-parts.json');
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('/* PA_SELFPUB_JS */', '/* PA_SKIN_JS */\n/* PA_SELFPUB_JS */'));
    fs.writeFileSync(list, JSON.stringify([...JSON.parse(fs.readFileSync(list, 'utf8')), { marker: '/* PA_SKIN_JS */', file: 'skin.js' }]));
    const r = await render(dir, ['web/skin.js', 'web/shell-parts.json', 'web/index.html'], 'skin1');
    assert.equal(r.ok, true, r.note);
    assert.equal(r.same, false, 'the new part is drawn: the node\'s own parts list used to leave it out, so After equalled Before');
  } finally { rmTemp(fx.d); }
});
