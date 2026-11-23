// PASync (web/offline-sync.js) — the drain of the write queue, docs/plans/offline-first.md §3/§7:
// order (the last text per path, entry-*.json before journal.json, seq within), stop on a 4xx/5xx
// with the rows kept and the sentence on the line, a quiet stop on a network failure, rule A applied
// against the base with the merged text posted, busy while in flight, superseded paths dropped.
// Then the broker AS SHIPPED (helpers-shell-broker: PAOffline + the merge + PASync's own wiring)
// against a stand-in node that goes away and comes back — the user flow, on the real hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL, OFFLINE_CORE, MERGE_BLOCK, SYNC_CORE, loadShellBroker } from './helpers-shell-broker.mjs';
import { between } from './helpers-app.mjs';
import { fakeIndexedDB, lineStub, standInNode, settle } from './helpers-offline.mjs';

const SW_BLOCK = between(SHELL, '/* ══ PA_SW_CLIENT_BEGIN', 'PA_SW_CLIENT_END ══ */');
const SW_CORE = SW_BLOCK.slice(0, SW_BLOCK.indexOf('const PASW=makeSwClient('));
// eslint-disable-next-line no-new-func
const { makeOffline, makeSync, offDb, OFF_DB, mergeOffline, syncOrder } = new Function(`${SW_CORE}\n${OFFLINE_CORE}\n${MERGE_BLOCK}\n${SYNC_CORE}\nreturn { makeOffline, makeSync, offDb, OFF_DB, mergeOffline, syncOrder };`)();

const NET = { ok: false, code: 'network', error: 'network unreachable' };
const page = (id, updated, html = '') => ({ id, created: 1, updated, strokes: [], pageHtml: html, images: [] });
const nb = (updated, pages) => JSON.stringify({ v: 3, id: 'n1', created: 1, updated, template: 'plain', pages });

// PAOffline (the queue) and PASync over one in-memory store; the node is a map of files plus
// switches: `reachable`, `postFail` (a reply for the next POST), `readNet` (GET fails as the network).
function harness({ uid = 'u1', db = 'yes' } = {}) {
  const f = fakeIndexedDB(), line = lineStub();
  const node = { files: new Map(), reachable: true, postFail: null, readNet: false, posts: [], reads: [] };
  let now = 1000;
  const store = db === 'yes' ? offDb(f.idb) : null;
  const o = makeOffline({ db: store, uid: () => uid, now: () => ++now, onLine: () => true, line: () => line,
    fetchJson: async () => ({ warm_files: 50 }), remember: () => {}, recall: () => null, onNet: null });
  const key = (slug, path) => `${slug}/${path}`;
  const s = makeSync({ db: store, uid: () => uid, now: () => ++now,
    reachable: async () => node.reachable,
    read: async (slug, path) => { node.reads.push(path); if (node.readNet) return NET; const t = node.files.get(key(slug, path)); return t == null ? { ok: false, code: 'not-found', status: 404 } : { ok: true, text: t }; },
    post: async (slug, path, text) => { if (node.postFail) { const r = node.postFail; node.postFail = null; return r; } node.posts.push([path, text]); node.files.set(key(slug, path), text); return { ok: true, bytes: text.length }; },
    merge: mergeOffline, state: o.syncState, onTrigger: null });
  return { o, s, f, line, node, writes: () => f.rows(OFF_DB, 'writes'), files: () => f.rows(OFF_DB, 'files') };
}
const queue = (h, path, text) => h.o.write('notes', path, text, async () => NET);

test('syncOrder: the last row per path, entry-*.json before the rest, seq order within', () => {
  const r = (seq, path) => ({ seq, uid: 'u', slug: 'notes', path });
  const out = syncOrder([r(1, 'journal.json'), r(2, 'entry-a.json'), r(3, 'entry-a.json'), r(4, 'entry-b.json'), r(5, 'journal.json'), r(6, 'other.json')]);
  assert.deepEqual(out.map((x) => [x.seq, x.path]), [[3, 'entry-a.json'], [4, 'entry-b.json'], [5, 'journal.json'], [6, 'other.json']]);
});

test('drain: entries first, the last text per path, journal.json last; rows gone on 200; the line says Syncing only while it runs', async () => {
  const h = harness();
  await h.o.boot();
  await queue(h, 'journal.json', '{"v":1,"entries":[{"id":"a","updated":1}]}');
  await queue(h, 'entry-a.json', nb(10, [page('p', 10)]));
  await queue(h, 'entry-a.json', nb(20, [page('p', 20)]));
  await queue(h, 'entry-b.json', nb(30, [page('q', 30)]));
  assert.equal(h.line.textContent, 'Offline · 离线 — saving on this device · 保存在本设备 · check Tailscale or the node · 请检查 Tailscale 或节点 · 4 to sync · 待同步');
  h.o.noteNet(true);
  assert.equal(h.line.textContent, '4 to sync · 待同步', 'online with a queue, nothing running: the count');
  const seen = [];
  const origPost = h.node.posts;
  h.node.posts = { push: (x) => { seen.push(h.line.textContent); origPost.push(x); } };
  const p = h.s.drain();
  assert.equal(h.s.inFlight(), true, 'busy from the first tick');
  assert.equal(await h.s.drain(), 'running', 'one drain at a time');
  assert.equal(await p, 'drained');
  assert.equal(h.s.inFlight(), false);
  assert.deepEqual(origPost.map((x) => x[0]), ['entry-a.json', 'entry-b.json', 'journal.json']);
  assert.equal(JSON.parse(origPost[0][1]).updated, 20, 'the LAST text per path went up');
  assert.deepEqual(seen, ['Syncing · 同步中 · 4 to sync · 待同步', 'Syncing · 同步中 · 2 to sync · 待同步', 'Syncing · 同步中 · 1 to sync · 待同步'], 'the count falls as paths land');
  assert.equal(h.writes().length, 0);
  assert.equal(h.line.textContent, '', 'drained: nothing to say');
  assert.ok(h.files().every((r) => r.queued === false && r.base === null), 'the mirror rows are plain warm rows again');
  assert.deepEqual(h.s.status().log.map((x) => x.did), ['sent', 'sent', 'sent']);
  assert.equal(await h.s.drain(), 'empty');
});

test('a 4xx/5xx stops the drain: the path\'s rows and every later row stay, the sentence is on the line with tap-to-retry; the retry finishes', async () => {
  const h = harness();
  await h.o.boot();
  await queue(h, 'entry-a.json', nb(10, [page('p', 10)]));
  await queue(h, 'entry-b.json', nb(20, [page('q', 20)]));
  await queue(h, 'journal.json', '{"v":1,"entries":[]}');
  h.node.postFail = { ok: false, code: 'server-error', status: 500, error: 'save failed · 保存失败' };
  assert.equal(await h.s.drain(), 'failed');
  assert.deepEqual(h.writes().map((r) => r.path), ['entry-a.json', 'entry-b.json', 'journal.json'], 'nothing dropped: the first POST failed');
  assert.equal(h.line.textContent, 'Sync failed · 同步失败 — save failed · 保存失败 · tap to retry · 点按重试');
  assert.equal(h.o.status().pending, 3);
  h.node.postFail = { ok: false, code: 'too-large', status: 413, error: 'payload too large · 内容过大' };
  assert.equal(await h.s.drain(), 'failed', 'the retry starts over with entry-a: the 413 stops it there');
  assert.deepEqual(h.writes().map((r) => r.path), ['entry-a.json', 'entry-b.json', 'journal.json']);
  assert.match(h.line.textContent, /^Sync failed · 同步失败 — payload too large/);
  assert.equal(await h.s.drain(), 'drained', 'the tap: the rest goes');
  assert.equal(h.line.textContent, '');
  assert.deepEqual(h.node.posts.map((x) => x[0]), ['entry-a.json', 'entry-b.json', 'journal.json']);
});

test('no node: /api/build unanswered → nothing read or posted; a network failure mid-drain stops quietly and the line goes back to offline', async () => {
  const h = harness();
  await h.o.boot();
  await queue(h, 'entry-a.json', nb(10, [page('p', 10)]));
  h.node.reachable = false;
  assert.equal(await h.s.drain(), 'unreachable');
  assert.deepEqual(h.node.reads, []); assert.deepEqual(h.node.posts, []);
  assert.equal(h.o.status().pending, 1);
  h.node.reachable = true; h.node.readNet = true;
  assert.equal(await h.s.drain(), 'unreachable', 'the GET of the node\'s file failed as the network');
  assert.equal(h.o.offline(), true);
  assert.equal(h.line.textContent, 'Offline · 离线 — saving on this device · 保存在本设备 · check Tailscale or the node · 请检查 Tailscale 或节点 · 1 to sync · 待同步', 'no "Sync failed": the node is simply away again');
  h.node.readNet = false; h.node.postFail = NET;
  assert.equal(await h.s.drain(), 'unreachable', 'the POST failed as the network');
  assert.equal(h.writes().length, 1);
});

test('rule A on the way up: the node moved since the base this device read → the merged notebook is posted, with the copy page', async () => {
  const h = harness();
  await h.o.boot();
  const base = nb(10, [page('p', 10, 'base')]);
  await h.o.read('notes', 'entry-a.json', async () => ({ ok: true, text: base }));   // read online: the base
  await queue(h, 'entry-a.json', nb(30, [page('p', 30, 'mine')]));
  await queue(h, 'entry-a.json', nb(31, [page('p', 31, 'mine again')]));
  assert.equal(h.files()[0].base, base, 'the base travels with the queued row');
  h.node.files.set('notes/entry-a.json', nb(20, [page('p', 20, 'theirs')]));   // the Mac wrote while the iPad was away
  assert.equal(await h.s.drain(), 'drained');
  const posted = JSON.parse(h.node.posts[0][1]);
  assert.equal(posted.updated, 31);
  assert.deepEqual(posted.pages.map((p) => p.pageHtml.replace(/<p><b>Conflict copy · 冲突副本 \([^)]*\)<\/b><\/p>/, 'COPY:')), ['mine again', 'COPY:theirs']);
  assert.deepEqual(h.s.status().log, [{ path: 'entry-a.json', did: 'merged (1 copy)' }]);
  assert.equal(h.files()[0].text, h.node.posts[0][1], 'the mirror holds what the node holds now');
  // The node did not move: the local text goes up untouched.
  await h.o.read('notes', 'entry-b.json', async () => ({ ok: true, text: base }));
  h.node.files.set('notes/entry-b.json', base);
  const local = nb(40, [page('p', 40, 'only here')]);
  await queue(h, 'entry-b.json', local);
  assert.equal(await h.s.drain(), 'drained');
  assert.equal(h.node.posts[1][1], local);
  // A note the node never had: posted as it is (not-found is no conflict).
  await queue(h, 'entry-new.json', nb(50, [page('n', 50)]));
  assert.equal(await h.s.drain(), 'drained');
  assert.equal(h.node.posts[2][0], 'entry-new.json');
  // A file the node holds in a shape nobody can read stops the drain with the reason (R5), rows kept.
  await queue(h, 'entry-c.json', nb(60, [page('c', 60)]));
  h.node.files.set('notes/entry-c.json', 'not json');
  assert.equal(await h.s.drain(), 'failed');
  assert.match(h.line.textContent, /^Sync failed · 同步失败 — cannot read the node file/);
  assert.equal(h.writes().length, 1);
});

test('a path saved online since (mirror row no longer queued) is dropped without a POST; another user\'s rows are left alone; no store → no-db', async () => {
  const h = harness();
  await h.o.boot();
  await queue(h, 'entry-a.json', nb(10, [page('p', 10)]));
  await h.o.write('notes', 'entry-a.json', nb(11, [page('p', 11)]), async () => ({ ok: true, bytes: 1 }));   // online again, the app saved
  assert.equal(h.files()[0].queued, false);
  await h.f.idb.open(OFF_DB, 1);   // (the store exists)
  const other = makeOffline({ db: offDb(h.f.idb), uid: () => 'u2', now: () => 5, onLine: () => true, line: () => null, fetchJson: async () => ({}), remember: () => {}, recall: () => null, onNet: null });
  await other.write('notes', 'entry-z.json', '{"v":1}', async () => NET);
  assert.equal(await h.s.drain(), 'drained');
  assert.deepEqual(h.node.posts, [], 'superseded: nothing posted');
  assert.deepEqual(h.node.reads, [], 'nor read');
  assert.deepEqual(h.writes().map((r) => r.uid), ['u2'], 'u2\'s row stays for u2\'s own sign-in');
  assert.equal(h.o.status().pending, 1, 'the count is the store\'s count (the line shows every row on this device)');
  assert.equal(await harness({ db: 'no' }).s.drain(), 'no-db');
});

// ── The broker as shipped (R6): away, then back, then the merge — through PAOffline, the merge and PASync's own wiring.
test('broker flow: read online, save with the node gone, node back → one drain posts entry then index with rule A applied; the line clears', async () => {
  const base = nb(10, [page('p', 10, 'base')]);
  const node = standInNode(new Map([['data/notes/entry-e1.json', base]]));
  const port = await node.listen(); const url = `http://127.0.0.1:${port}`;
  const f = fakeIndexedDB(), line = lineStub();
  const B = loadShellBroker(url, { app: 'notes', offline: { idb: f.idb, line } });
  assert.deepEqual(Object.fromEntries(Object.entries(B.triggers).map(([k, v]) => [k, v.length])), { online: 1, visible: 1, poll: 1, click: 1 }, 'PASync wired itself to online, visible, the poll and the tap');
  assert.equal(B.triggers.poll[0].ms, 15 * 60 * 1000, 'PAUpdate\'s cadence');
  await B.post({ id: 1, kind: 'data', path: 'entry-e1.json' }); await settle();
  assert.equal(B.reply(1).text, base);
  await node.close();
  await B.post({ id: 2, kind: 'save-data', path: 'journal.json', data: '{"v":1,"entries":[{"id":"e1","updated":30}]}' }); await settle();
  await B.post({ id: 3, kind: 'save-data', path: 'entry-e1.json', data: nb(30, [page('p', 30, 'mine')]) }); await settle();
  assert.equal(B.reply(3).offline, true);
  assert.equal(line.textContent, 'Offline · 离线 — saving on this device · 保存在本设备 · check Tailscale or the node · 请检查 Tailscale 或节点 · 2 to sync · 待同步');
  assert.equal(await B.sync.drain(), 'unreachable', 'still gone: the drain asks /api/build and stops');
  node.files.set('data/notes/entry-e1.json', nb(20, [page('p', 20, 'theirs')]));   // the Mac wrote meanwhile
  await node.listen(port);
  try {
    B.triggers.online[0]();   // the browser's online event
    await settle(200);
    assert.deepEqual(node.posts, ['data/notes/entry-e1.json', 'data/notes/journal.json'], 'entry before index, through the shipped POST');
    const merged = JSON.parse(node.files.get('data/notes/entry-e1.json'));
    assert.deepEqual(merged.pages.map((p) => p.pageHtml.replace(/<p><b>Conflict copy · 冲突副本 \([^)]*\)<\/b><\/p>/, 'COPY:')), ['mine', 'COPY:theirs']);
    assert.equal(f.rows(OFF_DB, 'writes').length, 0);
    assert.equal(line.textContent, '');
    assert.equal(B.sync.inFlight(), false);
    await B.post({ id: 4, kind: 'data', path: 'entry-e1.json' }); await settle();
    assert.equal(B.reply(4).offline, undefined, 'online again: the node answers reads');
    assert.equal(JSON.parse(B.reply(4).text).pages.length, 2);
    // A 5xx from the node: the sentence on the line, the row kept; a tap on the line retries.
    await node.close();
    await B.post({ id: 5, kind: 'save-data', path: 'entry-fail.json', data: nb(1, [page('x', 1)]) }); await settle();
    await node.listen(port);
    B.triggers.click[0]({ target: { id: 'offLine' } });
    await settle(200);
    assert.equal(line.textContent, 'Sync failed · 同步失败 — save failed · 保存失败 · tap to retry · 点按重试');
    assert.equal(f.rows(OFF_DB, 'writes').length, 1);
  } finally { await node.close(); }
});

test('wiring in the shell as served: merge then sync after PAOffline, the boot drain, shellBusy reads inFlight, the deps', () => {
  const at = (m) => SHELL.indexOf(m);
  assert.ok(at('/* ══ PA_OFFLINE_END ══ */') < at('/* ══ PA_MERGE_BEGIN ══ */') && at('/* ══ PA_MERGE_END ══ */') < at('/* ══ PA_SYNC_BEGIN ══ */'), 'PAOffline, the merge, then PASync');
  assert.match(SHELL, /PAOffline\.boot\(\);[^\n]*\n\s*PASync\.drain\(\);/, 'the boot drain follows PAOffline.boot');
  assert.match(SHELL, /shellBusy:\(\)=>!!\(\$\('#box'\)\.value\.trim\(\)\|\|\$\('#log'\)\.querySelector\('\.msg\.status'\)\|\|\(typeof PASync!=='undefined'&&PASync\.inFlight\(\)\)\)/, 'PAUpdate never reloads under a drain');
  assert.match(SHELL, /reachable:\(\)=>PAOrigin\.reachable\(\),/, 'the reachability question goes to PAOrigin (web/offline-origin.js): the public name, then the home name');
  assert.match(SHELL, /read:\(slug,path\)=>relayCall\('\/api\/data\/'\+offDataPath\(slug,path\)/);
  assert.match(SHELL, /post:\(slug,path,text\)=>relayCall\('\/api\/save-data',\{method:'POST'/);
  assert.match(SHELL, /merge:mergeOffline, state:PAOffline\.syncState,/);
  assert.match(SHELL, /setInterval\(\(\)=>\{ if\(document\.visibilityState==='visible'\) fn\(\); \},UPDATE_POLL_MS\);/, 'one cadence (R3)');
  assert.match(SHELL, /if\(e\.target&&e\.target\.id==='offLine'\) fn\(\);/, 'the line: tap to retry');
  for (const s of ['Syncing · 同步中', 'Sync failed · 同步失败 — ', 'Conflict copy · 冲突副本']) assert.equal(SHELL.split(`'${s}'`).length, 2, `${s} is written once`);
});

// ── Regressions (review of session 3): a queued path survives an online read and a save that lands mid-drain.
test('regression: an online read of a queued path answers the mirror and leaves the row queued; the drain still posts it', async () => {
  const h = harness();
  await h.o.boot();
  const base = nb(10, [page('p', 10, 'base')]);
  h.node.files.set('notes/entry-a.json', base);
  await h.o.read('notes', 'entry-a.json', async () => ({ ok: true, text: base }));
  const mine = nb(30, [page('p', 30, 'mine')]);
  await queue(h, 'entry-a.json', mine);
  // The app frame's startup read beside the boot drain: the node answers its (older) file.
  const r = await h.o.read('notes', 'entry-a.json', async () => ({ ok: true, text: base }));
  assert.deepEqual(r, { ok: true, text: mine, offline: true }, 'the device holds the newest text until the drain posts it');
  assert.equal(h.files()[0].queued, true, 'the mirror row is still queued');
  assert.equal(h.files()[0].base, base, 'with its base');
  assert.equal(await h.s.drain(), 'drained');
  assert.deepEqual(h.node.posts.map((x) => x[0]), ['entry-a.json'], 'one POST: the queued edit reached the node');
  assert.equal(h.node.files.get('notes/entry-a.json'), mine);
  assert.equal(h.writes().length, 0);
  assert.equal(h.files()[0].queued, false);
  // Online again with nothing queued: a read warms the row as before.
  const newer = nb(40, [page('p', 40, 'from the Mac')]);
  const r2 = await h.o.read('notes', 'entry-a.json', async () => ({ ok: true, text: newer }));
  assert.equal(r2.offline, undefined);
  assert.equal(h.files()[0].text, newer);
});

test('regression: a save queued while the POST is in flight keeps its row queued (the posted text as its base); the next drain posts it', async () => {
  const h = harness();
  await h.o.boot();
  await queue(h, 'entry-a.json', nb(30, [page('p', 30, 'v1')]));
  let release; const gate = new Promise((r) => { release = r; });
  // A second PASync over the same store whose first POST waits on `gate` (stubbed: setImmediate only).
  const node = h.node;
  const origFiles = node.files;
  let gated = false;
  const sync = makeSync({ db: offDb(h.f.idb), uid: () => 'u1', now: () => 9000 + node.posts.length,
    reachable: async () => true,
    read: async (slug, path) => { const t = origFiles.get(`${slug}/${path}`); return t == null ? { ok: false, code: 'not-found', status: 404 } : { ok: true, text: t }; },
    post: async (slug, path, text) => { if (!gated) { gated = true; await gate; } node.posts.push([path, text]); origFiles.set(`${slug}/${path}`, text); return { ok: true, bytes: text.length }; },
    merge: mergeOffline, state: h.o.syncState, onTrigger: null });
  const p = sync.drain();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.equal(sync.inFlight(), true);
  const v2 = nb(40, [page('p', 40, 'v2')]);
  await queue(h, 'entry-a.json', v2);   // the network flapped during the POST: v2 is queued under the drain
  assert.equal(h.files()[0].queued, true);
  release();
  assert.equal(await p, 'drained');
  assert.deepEqual(h.node.posts.map((x) => JSON.parse(x[1]).updated), [30], 'the first drain posted v1 only');
  assert.equal(h.files()[0].queued, true, 'the row queued under the drain is still queued');
  assert.equal(h.files()[0].text, v2, 'with v2');
  assert.equal(JSON.parse(h.files()[0].base).updated, 30, 'and the posted text as its base');
  assert.equal(h.writes().length, 1, 'v2\'s row stays for the next drain');
  assert.equal(await sync.drain(), 'drained');
  assert.deepEqual(h.node.posts.map((x) => JSON.parse(x[1]).updated), [30, 40], 'v2 reached the node');
  assert.equal(origFiles.get('notes/entry-a.json'), v2);
  assert.equal(h.files()[0].queued, false);
  assert.equal(h.writes().length, 0);
});

// ── Review finding 1: a replay after the POST reached the node must not merge again.
test('regression: the store fails after the POST (a reload under the drain) → the next drain sees its own text on the node, posts nothing, cleans up; no second conflict copy', async () => {
  const h = harness();
  await h.o.boot();
  const base = nb(10, [page('p', 10, 'base')]);
  await h.o.read('notes', 'entry-a.json', async () => ({ ok: true, text: base }));
  await queue(h, 'entry-a.json', nb(30, [page('p', 30, 'mine')]));
  h.node.files.set('notes/entry-a.json', nb(50, [page('p', 50, 'theirs')]));   // the node's page is NEWER: this device's edit becomes the copy
  // A store that dies right after the POST: the same drain over a db whose next put after a POST throws.
  const real = offDb(h.f.idb); let crashNext = false, crashAfterPost = true;
  const db = { ...real, put: async (st, v) => { if (crashNext) { crashNext = false; throw new Error('store gone'); } return real.put(st, v); } };
  const sync = makeSync({ db, uid: () => 'u1', now: () => 7000 + h.node.posts.length, reachable: async () => true,
    read: async (slug, path) => { const t = h.node.files.get(`${slug}/${path}`); return t == null ? { ok: false, code: 'not-found', status: 404 } : { ok: true, text: t }; },
    post: async (slug, path, text) => { h.node.posts.push([path, text]); h.node.files.set(`${slug}/${path}`, text); crashNext = crashAfterPost; return { ok: true, bytes: text.length }; },
    merge: mergeOffline, state: h.o.syncState, onTrigger: null });
  assert.equal(await sync.drain(), 'error');
  assert.equal(h.node.posts.length, 1);
  const onNode = JSON.parse(h.node.files.get('notes/entry-a.json'));
  assert.equal(onNode.pages.length, 2, 'the node holds the merged notebook: theirs + one copy of mine');
  assert.equal(h.writes().length, 1, 'the queue row survived the crash');
  assert.equal(h.files()[0].queued, true);
  assert.equal(await sync.drain(), 'drained');
  assert.equal(h.node.posts.length, 1, 'nothing posted again: the node already holds this drain\'s text');
  assert.equal(JSON.parse(h.node.files.get('notes/entry-a.json')).pages.length, 2, 'before the fix: a SECOND conflict copy (3 pages)');
  assert.deepEqual(sync.status().log, [{ path: 'entry-a.json', did: 'committed' }]);
  assert.equal(h.writes().length, 0);
  assert.equal(h.files()[0].queued, false);
  assert.equal(h.files()[0].text, h.node.files.get('notes/entry-a.json'), 'the mirror holds what the node holds');
  assert.equal(h.files()[0].prepared, undefined, 'the prepared record is gone with the row');
  // CONTROL: the node moved AGAIN after the crash (another device wrote) → a real merge, one new POST.
  await queue(h, 'entry-a.json', nb(60, [page('p', 60, 'mine 2')]));
  h.node.files.set('notes/entry-a.json', nb(70, [page('p', 70, 'theirs 2')]));
  assert.equal(await sync.drain(), 'error');
  h.node.files.set('notes/entry-a.json', nb(80, [page('p', 80, 'theirs 3')]));
  crashAfterPost = false;
  assert.equal(await sync.drain(), 'drained');
  assert.equal(h.node.posts.length, 3, 'the prepared text no longer matches the node: merged and posted again');
});
