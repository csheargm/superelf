// PAOffline (web/offline-client.js) — the on-device write queue, the warm set and the state line,
// docs/plans/offline-first.md §2/§5/§7. makeOffline runs on an in-memory IndexedDB (the request /
// transaction surface the real offDb wrapper drives, with a quota switch) and a fake line; then the
// broker AS SHIPPED runs the same code against a node that answers and one that is gone
// (helpers-shell-broker, offline deps), so the user flow — save with no node, read it back, a
// greyed feature refused — is proved on the real hooks, not on a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SHELL, OFFLINE_CORE, loadShellBroker } from './helpers-shell-broker.mjs';
import { between } from './helpers-app.mjs';
import { fakeClock } from './helpers-sandbox-app.mjs';
import { fakeIndexedDB, lineStub } from './helpers-offline.mjs';

const SW_BLOCK = between(SHELL, '/* ══ PA_SW_CLIENT_BEGIN', 'PA_SW_CLIENT_END ══ */');
const SW_CORE = SW_BLOCK.slice(0, SW_BLOCK.indexOf('const PASW=makeSwClient('));
// eslint-disable-next-line no-new-func
const { makeOffline, offDb, OFF_DB, OFF_NODE_KINDS, OFF_TXT_OFFLINE, OFF_TXT_CHECK_VPN, OFF_NEEDS_NODE } = new Function(`${SW_CORE}\n${OFFLINE_CORE}\nreturn { makeOffline, offDb, OFF_DB, OFF_NODE_KINDS, OFF_TXT_OFFLINE, OFF_TXT_CHECK_VPN, OFF_NEEDS_NODE };`)();

const NET = { ok: false, code: 'network', error: 'network unreachable' };
function harness({ db = 'yes', onLine = true, config = { warm_files: 3 }, warm = null } = {}) {
  const f = fakeIndexedDB(), clock = fakeClock(), line = lineStub(), mem = new Map();
  if (warm) mem.set('pa_offline_warm', warm);
  let now = 1000;
  const d = { db: db === 'yes' ? offDb(f.idb) : null, uid: () => 'u1', now: () => ++now, onLine: () => onLine, line: () => line,
    fetchJson: async (u) => { assert.equal(u, '/api/offline-config'); if (!config) throw new Error('HTTP 503'); return config; },
    remember: (k, v) => mem.set(k, v), recall: (k) => (mem.has(k) ? mem.get(k) : null),
    onNet: (fn) => { d.net = fn; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const o = makeOffline(d);
  return { o, d, line, f, mem, writes: () => f.rows(OFF_DB, 'writes'), files: () => f.rows(OFF_DB, 'files') };
}

test('a save with no network is queued and answered {ok:true,offline:true}; the state line counts it', async () => {
  const h = harness();
  assert.equal(await h.o.boot(), 'online');
  const r = await h.o.write('notes', 'entry-e1.json', { v: 2, pages: [] }, async () => NET);
  assert.deepEqual(r, { ok: true, offline: true, bytes: 18 });
  assert.equal(h.writes().length, 1);
  assert.deepEqual({ ...h.writes()[0], ts: 0 }, { seq: 1, uid: 'u1', slug: 'notes', path: 'entry-e1.json', text: '{"v":2,"pages":[]}', bytes: 18, ts: 0, kind: 'save-data' });
  assert.equal(h.files()[0].queued, true, 'the mirror row is marked queued: never trimmed');
  assert.equal(h.o.offline(), true);
  assert.equal(h.line.textContent, OFF_TXT_OFFLINE + OFF_TXT_CHECK_VPN + ' · 1 to sync · 待同步');
  assert.ok(h.line.classList.contains('on'));
  await h.o.write('notes', 'journal.json', '{"v":1}', async () => NET);
  assert.equal(h.o.status().pending, 2);
  assert.equal(h.line.textContent, OFF_TXT_OFFLINE + OFF_TXT_CHECK_VPN + ' · 2 to sync · 待同步');
});

test('a 4xx/5xx is a real refusal: passed through, nothing queued, the device stays online', async () => {
  const h = harness();
  const r500 = { ok: false, code: 'server-error', status: 500 };
  assert.equal(await h.o.write('notes', 'a.json', '{}', async () => r500), r500);
  const r413 = { ok: false, code: 'too-large', status: 413 };
  assert.equal(await h.o.write('notes', 'a.json', '{}', async () => r413), r413);
  const r404 = { ok: false, code: 'not-found', status: 404 };
  assert.equal(await h.o.read('notes', 'a.json', async () => r404), r404);
  assert.equal(h.writes().length, 0); assert.equal(h.files().length, 0);
  assert.equal(h.o.offline(), false); assert.equal(h.line.textContent, '');
});

test('reads: the node first; with no network a warm path is served from the mirror, a cold one is "offline"', async () => {
  const h = harness();
  const online = { ok: true, text: '{"v":1,"entries":[]}' };
  assert.equal(await h.o.read('notes', 'journal.json', async () => online), online, 'an online read is handed back as it came');
  assert.equal(h.files().length, 1, 'and warms the mirror');
  assert.deepEqual(await h.o.read('notes', 'journal.json', async () => NET), { ok: true, text: '{"v":1,"entries":[]}', offline: true });
  const cold = await h.o.read('notes', 'entry-never.json', async () => NET);
  assert.equal(cold.ok, false); assert.equal(cold.code, 'offline');
  assert.match(cold.error, /Not on this device · 本设备上没有/);
  assert.equal(h.line.textContent, OFF_TXT_OFFLINE + OFF_TXT_CHECK_VPN, 'offline, nothing queued');
  // Back: a successful read flips the line off again.
  await h.o.read('notes', 'journal.json', async () => online);
  assert.equal(h.o.offline(), false); assert.equal(h.line.textContent, '');
});

test('quota: {ok:false,code:"offline-full"}, nothing queued, the count unchanged (R14: never a vacuous ok)', async () => {
  const h = harness();
  h.f.state.quota = true;
  const r = await h.o.write('notes', 'a.json', '{}', async () => NET);
  assert.equal(r.ok, false); assert.equal(r.code, 'offline-full'); assert.match(r.error, /This device is full · 本设备存储已满/);
  assert.equal(h.writes().length, 0); assert.equal(h.o.status().pending, 0);
  // A store that fails for another reason is not "full" and is not ok either.
  h.f.state.quota = false;
  h.d.db = { ...h.d.db, add: async () => { throw new Error('closed'); } };
  const r2 = await h.o.write('notes', 'a.json', '{}', async () => NET);
  assert.equal(r2.ok, false); assert.equal(r2.code, 'offline'); assert.match(r2.error, /Could not keep it on this device.*closed/);
});

test('the warm set: the latest text per path, the cap from the config (remembered), oldest non-queued rows trimmed, queued rows never', async () => {
  const h = harness({ config: { warm_files: 2 } });
  await h.o.boot();
  assert.equal(h.mem.get('pa_offline_warm'), 2, 'the cap is remembered for a boot with no node');
  const ok = (text) => async () => ({ ok: true, text });
  await h.o.read('notes', 'a.json', ok('A1'));
  await h.o.read('notes', 'a.json', ok('A2'));
  assert.equal(h.files().length, 1); assert.equal(h.files()[0].text, 'A2', 'one row per path, the latest text');
  await h.o.write('notes', 'q.json', 'Q', async () => NET);          // queued
  await h.o.read('notes', 'b.json', ok('B'));                        // online again
  await h.o.read('notes', 'c.json', ok('C'));
  const keys = h.files().map((r) => r.path).sort();
  assert.deepEqual(keys, ['c.json', 'q.json'], 'past the cap of 2 the oldest non-queued rows (a, b) went; the queued row stayed');
  assert.equal(h.o.status().error, '');
});

test('no config yet and nothing remembered: no cap, nothing trimmed; a remembered cap stands when the node is away', async () => {
  const h = harness({ config: null });
  assert.equal(await h.o.boot(), 'online');
  assert.match(h.o.status().error, /config: HTTP 503/);
  const ok = (text) => async () => ({ ok: true, text });
  for (const p of ['a', 'b', 'c', 'd', 'e']) await h.o.read('notes', p, ok(p));
  assert.equal(h.files().length, 5, 'no cap known: the warm set is not cut on a guess');
  const h2 = harness({ onLine: false, warm: 1 });
  assert.equal(await h2.o.boot(), 'offline', 'navigator.onLine false at boot');
  assert.equal(h2.line.textContent, OFF_TXT_OFFLINE);
  await h2.o.read('notes', 'a', ok('a')); await h2.o.read('notes', 'b', ok('b'));
  assert.equal(h2.files().length, 1, 'the remembered cap of 1 applied');
});

test('greyed features: a kind that needs the node is refused only while offline, with the one sentence', () => {
  const h = harness();
  for (const k of ['note-search', 'note-text', 'chat', 'ask', 'websearch', 'bible-search', 'upload', 'speech-start', 'summary-followup']) assert.ok(OFF_NODE_KINDS.has(k), k);
  for (const k of ['data', 'save-data', 'bible', 'pref', 'render-md', 'notify']) assert.ok(!OFF_NODE_KINDS.has(k), `${k} works offline`);
  assert.equal(h.o.refuse('note-search'), null, 'online: the request goes to the node');
  h.o.noteNet(false);
  assert.deepEqual(h.o.refuse('note-search'), { ok: false, code: 'offline', error: OFF_NEEDS_NODE, text: OFF_NEEDS_NODE });
  assert.equal(h.o.refuse('data'), null, 'a read is never refused up front: it has a mirror to try');
  assert.equal(OFF_NEEDS_NODE, 'Needs the home node · 需要家中节点');
});

test('the browser\'s online/offline events move the line; the count is read back at boot', async () => {
  const h = harness();
  await h.o.write('notes', 'a.json', '{}', async () => NET);
  h.d.net(true);
  assert.equal(h.o.offline(), false);
  assert.equal(h.line.textContent, '1 to sync · 待同步', 'online with a queue: the count, never "Syncing" while nothing syncs (session 3)');
  h.d.net(false);
  assert.equal(h.line.textContent, OFF_TXT_OFFLINE + OFF_TXT_CHECK_VPN + ' · 1 to sync · 待同步');
  // A second PAOffline over the same database (the next boot) finds the queue.
  const o2 = makeOffline({ ...h.d, line: () => h.line });
  await o2.boot();
  assert.equal(o2.status().pending, 1);
});

test('no IndexedDB: pass-through — the network\'s answer, unchanged, and nothing is refused', async () => {
  const h = harness({ db: 'no' });
  assert.equal(await h.o.boot(), 'online');
  assert.equal(await h.o.write('notes', 'a.json', '{}', async () => NET), NET);
  assert.equal(await h.o.read('notes', 'a.json', async () => NET), NET);
  h.o.noteNet(false);
  assert.ok(h.o.refuse('note-search'), 'the refusal needs no store: it still applies');
});

// ── The broker as shipped (R6): save-data / data through the real hooks, against a node that is gone.
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
test('broker flow: save with the node gone → queued ok; read it back from this device; note-search is refused; a live node is read first', async () => {
  const saved = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/save-data') { saved.push(body.length); res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"bytes":9}'); }
      if (req.url.startsWith('/api/data/')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('{"live":1}'); }
      res.writeHead(404); res.end('nf');
    });
  });
  const base = await listen(srv);
  const f = fakeIndexedDB(), line = lineStub();
  try {
    const live = loadShellBroker(base, { app: 'notes', offline: { idb: f.idb, line } });
    await live.post({ id: 1, kind: 'data', path: 'journal.json' }); await settle();
    assert.deepEqual(live.reply(1), { pa: 'res', id: 1, ok: true, text: '{"live":1}' }, 'online: the node\'s text, nothing added');
    assert.equal(f.rows(OFF_DB, 'files').length, 1, 'and it is warm now');
    await live.post({ id: 2, kind: 'save-data', path: 'entry-e1.json', data: { v: 2 } }); await settle();
    assert.equal(live.reply(2).ok, true); assert.equal(live.reply(2).offline, undefined, 'online save: the server\'s own reply');
    assert.equal(saved.length, 1);
  } finally { srv.closeAllConnections(); srv.close(); }
  // The node is gone (the port is closed): the same database, a fresh broker (the next shell boot).
  const gone = loadShellBroker(base, { app: 'notes', offline: { idb: f.idb, line } });
  await gone.post({ id: 3, kind: 'save-data', path: 'entry-e1.json', data: { v: 3, pages: [] } }); await settle();
  assert.deepEqual(gone.reply(3), { pa: 'res', id: 3, ok: true, offline: true, bytes: 18 }, 'queued on this device');
  assert.equal(f.rows(OFF_DB, 'writes').length, 1);
  assert.equal(line.textContent, OFF_TXT_OFFLINE + OFF_TXT_CHECK_VPN + ' · 1 to sync · 待同步');
  await gone.post({ id: 4, kind: 'data', path: 'entry-e1.json' }); await settle();
  assert.deepEqual(gone.reply(4), { pa: 'res', id: 4, ok: true, text: '{"v":3,"pages":[]}', offline: true }, 'read back from the mirror');
  await gone.post({ id: 5, kind: 'data', path: 'journal.json' }); await settle();
  assert.deepEqual(gone.reply(5), { pa: 'res', id: 5, ok: true, text: '{"live":1}', offline: true }, 'the warm set from the online session');
  await gone.post({ id: 6, kind: 'data', path: 'entry-cold.json' }); await settle();
  assert.equal(gone.reply(6).ok, false); assert.equal(gone.reply(6).code, 'offline');
  assert.match(gone.reply(6).text, /Not on this device · 本设备上没有/, 'relayFail rendered the reason');
  await gone.post({ id: 7, kind: 'note-search', q: 'x' }); await settle();
  assert.deepEqual(gone.reply(7), { pa: 'res', id: 7, ok: false, code: 'offline', error: OFF_NEEDS_NODE, text: OFF_NEEDS_NODE }, 'greyed: refused at once');
  assert.equal(gone.held.size, 0, 'nothing left in flight');
});

test('broker without IndexedDB (every other suite): a save-data with no node is still the network failure it always was', async () => {
  const srv = http.createServer(() => {}); const base = await listen(srv); srv.close();
  const B = loadShellBroker(base, { app: 'notes' });
  await B.post({ id: 1, kind: 'save-data', path: 'a.json', data: {} }); await settle();
  assert.equal(B.reply(1).code, 'network');
  assert.match(B.reply(1).text, /Connection failed · 连接失败/);
});

test('wiring in the shell as served: the part last, both broker hooks, the refusal first, the line, boot and ping', () => {
  assert.match(SHELL, /reply\(await PAOffline\.read\(appSlug,m\.path,\(\)=>relayCall\('\/api\/data\/'\+appData\(m\.path\)/, 'kind data reads through PAOffline');
  assert.match(SHELL, /reply\(await PAOffline\.write\(appSlug,m\.path,m\.data,\(\)=>relayCall\('\/api\/save-data',\{method:'POST'/, 'kind save-data writes through PAOffline');
  const broker = between(SHELL, '/* ── Broker (for sandboxed apps) ── */', '/* ── Chat log helpers ── */');
  assert.ok(broker.indexOf('const needsNode=PAOffline.refuse(m.kind); if(needsNode) return reply(needsNode);') < broker.indexOf("if(m.kind==='pref')"), 'the refusal runs before any kind, inside the try (the frame\'s busy count is released)');
  assert.match(SHELL, /<span id="offLine" class="fs-toast"><\/span>/, 'the one state line, outside the inert header like #updBar');
  assert.match(SHELL, /#updBar\.on \+ #offLine\.on\{ transform:translate\(-50%,calc\(100% \+ \.4em\)\); \}/, 'both lit: no overlap');
  assert.ok(SHELL.indexOf('/* ══ PA_SW_CLIENT_END ══ */') < SHELL.indexOf('/* ══ PA_OFFLINE_BEGIN ══ */'), 'after PASW: PAOffline borrows its remember/recall');
  assert.match(SHELL, /await ensureToken\(\);\n\s*PAOffline\.boot\(\);/, 'boot after the sign-in');
  assert.match(SHELL, /catch\{ if\(T===t0&&!signal\) PAOffline\.noteNet\(false\); return 'offline'; \} if\(T!==t0\) return false;[^\n]*\n  if\(signal\)\{ let j0; try\{ j0=await r\.clone\(\)\.json\(\); \}catch\{ return false; \}[^\n]*\n  PAOffline\.noteNet\(true\);/, 'ping tells the line both ways');
  assert.match(SHELL, /remember:PASW\.remember, recall:PASW\.recall,/, 'one per-device memory (R3)');
  assert.equal(SHELL.split("'Needs the home node · 需要家中节点'").length, 2, 'the sentence is written once');
});

test('the offline line shows in full for a few seconds, then shrinks to a corner pill; a tap shows it again', async () => {
  const clock = fakeClock(), line = lineStub();
  const o = makeOffline({ db: null, uid: () => 'u1', now: () => 1, onLine: () => false, line: () => line,
    fetchJson: async () => ({}), remember: () => {}, recall: () => null, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await o.boot();
  assert.equal(line.textContent, OFF_TXT_OFFLINE);
  assert.ok(line.classList.contains('on') && !line.classList.contains('mini'), 'first: the full line');
  clock.advance(4000);
  assert.ok(line.classList.contains('mini') && line.classList.contains('on'), 'then: the small pill');
  assert.equal(line.dataset.mini, '离线 Offline');
  o.render();
  assert.ok(line.classList.contains('mini'), 'a re-render with the same text keeps it small');
  line.onclick();
  assert.ok(!line.classList.contains('mini'), 'a tap on the pill shows the full line');
  clock.advance(4000);
  assert.ok(line.classList.contains('mini'));
  o.noteNet(true);
  clock.advance(4000);
  assert.ok(!line.classList.contains('on'), 'back online with nothing queued: nothing shows');
});
test('owner 2026-11-21: offline with the device on a network adds "check Tailscale"; with no network it does not', async () => {
  const h = harness({ onLine: false }); assert.equal(await h.o.boot(), 'offline');
  assert.equal(h.line.textContent, OFF_TXT_OFFLINE, 'no network at all: the short line');
  const h2 = harness(); h2.o.noteNet(false);
  assert.equal(h2.line.textContent, OFF_TXT_OFFLINE + OFF_TXT_CHECK_VPN, 'network up, node unreachable: the VPN hint');
  assert.match(OFF_TXT_CHECK_VPN, /check Tailscale or the node · 请检查 Tailscale 或节点/);
});
test('GPT: losing the device network while already offline drops the Tailscale hint', async () => {
  let up = true; const h = harness(); h.d.onLine = () => up;
  h.o.noteNet(false); assert.equal(h.line.textContent, OFF_TXT_OFFLINE + OFF_TXT_CHECK_VPN);
  up = false; h.o.noteNet(false); assert.equal(h.line.textContent, OFF_TXT_OFFLINE);
});

// F5-6 (overnight 2026-11-22): the offline line said "saving on this device · 保存在本设备" on a
// phone and a desktop too. The shell cannot know the device, so every offline string says
// "this device · 本设备" — one word for every screen it runs on.
test('offline strings never name one kind of device', () => {
  const texts = OFFLINE_CORE.match(/const OFF_TXT_\w+='[^']*'/g) || [];
  assert.ok(texts.length >= 6, 'the offline strings were found');
  for (const t of texts) assert.doesNotMatch(t, /iPad|iPhone|Mac\b/, t);
  assert.match(OFFLINE_CORE, /const OFF_TXT_OFFLINE='Offline · 离线 — saving on this device · 保存在本设备'/);
});
