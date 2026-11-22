// The data core's load deadline must not leak its timer.
//
// SCAR: `deadline()` was `Promise.race([pr, new Promise(r => setTimeout(..., timeoutMs))])`
// with no clearTimeout. Promise.race settles on the winner, but the LOSER's timer keeps
// running — so every successful read left a 20s timer armed. In a browser that is a real
// leak (one per read, and opening a notebook reads many pages). In Node it held the event
// loop open, so `test/app-load.test.mjs` sat for exactly 20.00s AFTER its last assertion
// before the process could exit — two thirds of that file's runtime, and the single largest
// contributor to the whole suite's wall time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SRC, ENG } from './helpers-app.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// workspace/apps is the owner's LIVE set — gitignored, so absent on a fresh clone. Reading it
// unconditionally made this file ENOENT for everyone but the author, which meant the PUBLISHED
// repo did not pass its own suite. helpers-app.mjs already resolves each app to its live copy
// when present and its tracked template otherwise; use that one definition rather than a fourth
// hardcoded path list (R3).
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'); // throws if moved (R14)

function core(rel) {
  const src = read(rel);
  const a = src.indexOf('// ══ PA_DATA_CORE_BEGIN'), b = src.indexOf('PA_DATA_CORE_END ══');
  assert.ok(a > 0 && b > a, `${rel} still carries the data core`);
  const block = src.slice(a, b);
  // The engine's own LOAD, as on the page: the apps have no copy of the rule to fall back on (ADR 0015).
  return new Function('PANote', `${block}\nreturn {makeReader,LOAD_TIMEOUT_MS};`)({ LOAD: ENG.LOAD });
}

const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('a resolved read leaves NO timer behind', async () => {
  const C = core('workspace.example/apps/notes/index.html');
  const R = C.makeReader({ load: async () => ({ ok: true, text: '{"pages":[]}' }), save: async () => ({ ok: true }) });
  const before = timers();
  await R.read('entry-a.json');
  assert.equal(timers(), before, 'the deadline timer must be cleared when the load wins the race');
});

test('many reads do not accumulate timers', async () => {
  const C = core('workspace.example/apps/notes/index.html');
  const R = C.makeReader({ load: async () => ({ ok: true, text: '{"pages":[]}' }), save: async () => ({ ok: true }) });
  const before = timers();
  for (let i = 0; i < 25; i++) await R.read(`entry-${i}.json`);
  assert.equal(timers(), before, '25 reads left ' + (timers() - before) + ' timers armed');
});

test('a read that FAILS also leaves no timer', async () => {
  const C = core('workspace.example/apps/notes/index.html');
  const R = C.makeReader({ load: async () => ({ ok: false, code: 'server-error', error: 'boom' }), save: async () => ({ ok: true }) });
  const before = timers();
  await R.read('entry-a.json');
  assert.equal(timers(), before);
});

test('the deadline still fires when the load never answers', async () => {
  // The clear must not defeat the deadline it exists to enforce.
  const C = core('workspace.example/apps/notes/index.html');
  const R = C.makeReader({ load: () => new Promise(() => {}), save: async () => ({ ok: true }), timeoutMs: 30 });
  const out = await R.read('entry-a.json');
  assert.equal(out.status, 'failed', 'a reply that never comes is still a FAILURE, not a hang');
  assert.match(out.error, /timed out|超时/, 'and the reason still travels with it (R5)');
});

test('every copy of the data core carries the clear — they must not drift', () => {
  // APP_SRC is every app the repo ships, each resolved to its LIVE copy on a machine that has one
  // and to its tracked template otherwise — so this asserts over four sources here and two on a
  // fresh clone, instead of throwing ENOENT there.
  const entries = Object.entries(APP_SRC);
  assert.ok(entries.length >= 2, 'CONTROL: there are app sources to check, so this cannot pass empty');
  for (const [label, src] of entries) {
    assert.match(src, /const deadline=\(pr\)=>\{[^\n]*clearTimeout/,
      `${label}: the deadline helper must clear its timer`);
    assert.equal(/Promise\.race\(\[pr,new Promise\(r=>setTimeout\([^\n]*\)\]\);/.test(src), false,
      `${label}: the leaking one-liner must stay gone`);
  }
});
