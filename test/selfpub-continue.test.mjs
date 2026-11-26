// 2026-11-26 dead end: a change failed its checks, the owner asked superelf to fix it from a NEW chat and
// got CHANGE_OPEN. Now the owner's open change continues from any conversation (R6: the server flow on a
// throwaway checkout and local bare remote; never the live node). Unknown dirt is still refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selfpubFixture, tgit } from './helpers-selfpub.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { runCoreChange } from '../lib/selfpub/lane.mjs';
import { getChange, putChange } from '../lib/selfpub/state.mjs';
import { discardBranch, changedPaths } from '../lib/selfpub/checkout.mjs';
import { FAILED_NEXT } from '../lib/selfpub/verify.mjs';
import { skipIf } from './helpers-skip.mjs';
const POSIX_ONLY = skipIf(process.platform === 'win32', 'posix-only', 'the core lane runs on Linux/macOS nodes (docs/adr/0044)');

const OWNER = { id: 'owner', role: 'owner' };
const okRender = async () => ({ ok: true, shots: ['x.png'] });
const writer = (rel, text) => async ({ cwd }) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text);
  return { reply: 'changed ' + rel, toolCalls: [{ name: 'Write', input: { file_path: path.join(cwd, rel) } }] }; };
const change = (fx, runAgent, convo, message = 'change') => runCoreChange({ user: OWNER, origin: { fromApp: false }, message, convo, root: fx.root, cloneUrl: fx.bare, runAgent, cfg: {}, render: okRender });

test('a failed change + "fix it" from another chat continues the same branch with the combined diff', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture();
  try {
    const a = await change(fx, writer('web/home.css', 'body{content:"BOOM"}\n'), 'c1', 'darker');
    assert.equal(a.ready, false); assert.ok(a.headline.includes(FAILED_NEXT), 'the failed reply says the two ways forward');
    const b = await change(fx, writer('web/extra.css', 'p{}\n'), 'c2', 'fix it');
    assert.ok(b.id && b.id !== a.id); assert.equal(b.branch, a.branch, 'same branch: continued, not refused');
    assert.deepEqual(b.changed.map((c) => c.path), ['web/extra.css', 'web/home.css'], 'the new card shows both requests\' edits');
    assert.equal(getChange(fx.root, a.id).state, 'superseded'); assert.equal(getChange(fx.root, a.id).by, b.id);
    assert.match(getChange(fx.root, b.id).request, /darker\nfix it/);
    const c = await change(fx, writer('web/home.css', 'body{color:#222}\n'), 'c3', 'really fix');
    assert.equal(c.ready, true, 'checks re-run on the combined change'); assert.equal(getChange(fx.root, b.id).state, 'superseded');
    discardBranch(path.join(fx.root, 'repo'));
    assert.deepEqual(changedPaths(path.join(fx.root, 'repo')), [], 'discard still throws the whole change away');
  } finally { rmTemp(fx.d); }
});

test('unknown dirt is still CHECKOUT_DIRTY; a change mid-publish is still CHANGE_OPEN; another user never continues it', { skip: POSIX_ONLY }, async () => {
  const fx = selfpubFixture();
  try {
    const a = await change(fx, writer('web/home.css', 'body{color:#333}\n'), 'c1');
    putChange(fx.root, a.id, { state: 'publishing' });
    await assert.rejects(change(fx, writer('web/x.css', 'x\n'), 'c2'), { code: 'CHANGE_OPEN' });
    putChange(fx.root, a.id, { state: 'ready', who: 'someone-else' });
    await assert.rejects(change(fx, writer('web/x.css', 'x\n'), 'c2'), { code: 'CHANGE_OPEN' });
    const dir = path.join(fx.root, 'repo');
    discardBranch(dir); fs.writeFileSync(path.join(dir, 'web', 'home.css'), 'stray\n');
    await assert.rejects(change(fx, writer('web/x.css', 'x\n'), 'c2'), { code: 'CHECKOUT_DIRTY' });
    assert.equal(fs.readFileSync(path.join(dir, 'web', 'home.css'), 'utf8'), 'stray\n', 'unknown edits are never thrown away');
    assert.equal(tgit(dir, 'status', '--porcelain').trim(), 'M web/home.css');
  } finally { rmTemp(fx.d); }
});
