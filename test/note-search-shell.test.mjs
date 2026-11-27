// The broker kind `note-search` and its client, PANote.search.
//
// Shell half: web/index.html's broker is RUN (helpers-shell-broker loadShellBroker) against a
// stand-in server that records the URL, so the test proves the slug comes from the FRAME and the
// query is encoded — not that the branch merely exists. Client half: PANote's search block is
// sliced from note-ui.inline.html and run with a fake PAStore.ask, the one round-trip it must use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadShellBroker } from './helpers-shell-broker.mjs';
import { ENGINE, CHAT, SHELL, stripComments } from './helpers-app.mjs';

function stand(answer) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    const a = answer(req.url);
    res.writeHead(a.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(a.body));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ seen, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((d) => srv.close(d)) })));
}
const HITS = [{ path: 'entry-1.json', scope: '', page: 0, score: 10, where: 'tag', snippet: '…#祷告…' }];

test('note-search relays to /api/note-search with the FRAME\'s slug and the encoded query, verbatim reply', async () => {
  const S = await stand(() => ({ body: { ok: true, hits: HITS } }));
  try {
    const B = loadShellBroker(S.base, { app: 'notes' });
    const r = await new Promise((done) => B.route({ id: 7, kind: 'note-search', q: '祷告 #ores', app: 'bible' }, done));
    assert.deepEqual(S.seen, ['/api/note-search?app=notes&q=%E7%A5%B7%E5%91%8A%20%23ores'], 'the app\'s own `app` field is ignored; the slug is the frame\'s');
    assert.deepEqual(r, { pa: 'res', id: 7, ok: true, hits: HITS }, 'the server\'s shape passes through: no nesting under a key');
  } finally { await S.close(); }
});

test('a server failure reaches the app with a code and a rendered sentence', async () => {
  const S = await stand(() => ({ status: 500, body: { ok: false, error: '搜索失败 · search failed', code: 'search_failed' } }));
  try {
    const B = loadShellBroker(S.base, { app: 'notes' });
    const r = await new Promise((done) => B.route({ id: 8, kind: 'note-search', q: 'x' }, done));
    assert.equal(r.ok, false);
    assert.ok(r.code, 'a code');
    assert.ok(r.text, 'and the shell\'s bilingual sentence');
  } finally { await S.close(); }
});

test('the kind sits behind the no-slug guard, is in superelf.md, and no app posts it itself', () => {
  const code = stripComments(SHELL);
  const guard = code.indexOf("if(!appSlug) return reply({ok:false,code:'bad-request',error:NO_APP_TEXT});");
  const kind = code.indexOf("m.kind==='note-search'");
  assert.ok(guard > 0 && kind > guard, 'fails closed with no slug, like every kind');
  assert.match(code, /relayCall\('\/api\/note-search\?app='\+encodeURIComponent\(appSlug\)\+'&q='\+encodeURIComponent\(String\(m\.q\|\|''\)\),undefined,'raw'\)/);
  assert.equal((ENGINE.match(/kind:'note-search'/g) || []).length, 1, 'PANote sends it from ONE place');
  assert.doesNotMatch(CHAT, /note-search/, 'the drawer never names the kind: it asks PANote.search');
});

// ── PANote.search, run ──
function loadSearch(PAStore) {
  const a = ENGINE.indexOf('  // ── Note search（笔记搜索）──'), b = ENGINE.indexOf('  window.PANote={', a);
  assert.ok(a > 0 && b > a, 'the search block is findable, just above the PANote export');
  const window = PAStore === undefined ? {} : { PAStore };
  // eslint-disable-next-line no-new-func
  return new Function('window', `${ENGINE.slice(a, b)}\nreturn { search: searchNotes, SEARCH_TXT };`)(window);
}

test('PANote.search goes through PAStore.ask and resolves an outcome, never a throw', async () => {
  const asked = [];
  const P = loadSearch({ ask: async (o) => { asked.push(o); return { ok: true, hits: HITS }; } });
  assert.deepEqual(await P.search('  祷告 '), { ok: true, hits: HITS, truncated: false, pending: 0, ocr: '', reason: '', terms: [] }, 'no pending/ocr/reason/terms from the node → 0, \'\' and [] (phase 1 reply shape still works)');
  assert.deepEqual(asked, [{ kind: 'note-search', q: '祷告' }], 'trimmed, one request, the broker kind');
  const S2 = loadSearch({ ask: async () => ({ ok: true, hits: [], pending: 2, ocr: 'failed', reason: 'swiftc: error: no toolchain' }) });
  assert.deepEqual(await S2.search('x'), { ok: true, hits: [], truncated: false, pending: 2, ocr: 'failed', reason: 'swiftc: error: no toolchain', terms: [] }, 'the phase 2 state passes through, the node\'s reason with it');
  const S3 = loadSearch({ ask: async () => ({ ok: true, hits: [{ ...HITS[0], boxes: [[0.1, 0.2, 0.5, 0.05]] }], terms: ['祷告', 7] }) });
  assert.deepEqual(await S3.search('祷告'), { ok: true, hits: [{ ...HITS[0], boxes: [[0.1, 0.2, 0.5, 0.05]] }], truncated: false, pending: 0, ocr: '', reason: '', terms: ['祷告'] }, 'phase 3: hits keep their boxes, terms pass through as strings only');
  assert.deepEqual(await P.search('   '), { ok: true, hits: [] }, 'an empty query asks nothing');
  assert.equal(asked.length, 1);
  const F = loadSearch({ ask: async () => ({ ok: false, code: 'server-error', text: '搜索失败 (500) · Search failed' }) });
  assert.deepEqual(await F.search('x'), { ok: false, error: '搜索失败 (500) · Search failed', code: 'server-error' }, 'the shell\'s sentence is kept');
  const N = loadSearch(undefined);
  const none = await N.search('x');
  assert.equal(none.ok, false); assert.equal(none.code, 'no-broker'); assert.equal(none.error, P.SEARCH_TXT.failed);
});

test('a reply to a superseded query is marked stale', async () => {
  const pending = [];
  const P = loadSearch({ ask: () => new Promise((r) => pending.push(r)) });
  const first = P.search('lan'), second = P.search('landlord');
  pending[1]({ ok: true, hits: HITS }); pending[0]({ ok: true, hits: [] });
  assert.deepEqual(await second, { ok: true, hits: HITS, truncated: false, pending: 0, ocr: '', reason: '', terms: [] });
  assert.deepEqual(await first, { ok: true, stale: true, hits: [] });
});

test('the where-labels are exported once, bilingual, with phase 2\'s names reserved', () => {
  const P = loadSearch(undefined);
  assert.deepEqual(P.SEARCH_TXT, { transcript: '转写 · Transcript', tag: '标签 · Tag', typed: '文本 · Text', ink: '手写 · Ink', photo: '图片 · Photo', failed: '搜索不可用 · Search unavailable', searching: '搜索中… · Searching…', more: '仅显示最相关的笔记 · Only the best matches are shown',
    pending: '正在识别 {n} 页 · Transcribing {n} pages', noOcr: '手写搜索需要 Mac 节点 · Handwriting search needs the Mac node', ocrFailed: '本机手写识别失败 · Handwriting transcription failed on this node' });
  assert.equal((ENGINE.match(/SEARCH_TXT=/g) || []).length, 1);
  assert.match(ENGINE, /\n    search:searchNotes, SEARCH_TXT,\n/, 'both on the PANote export');
  assert.ok(Object.isFrozen(P.SEARCH_TXT));
});
