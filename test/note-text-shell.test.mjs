// The broker kind `note-text` and its ONE client, PANoteText.fetch (web/note-text.inline.html).
// Shell half: web/index.html's broker is RUN (helpers-shell-broker) against a stand-in server that
// records the URL — the slug is the FRAME's, paths repeat as path=, scope only when given, fields a
// comma list, reply verbatim. Client half: the component's script is run with a fake PAStore.ask.
// Mirrors test/note-search-shell.test.mjs (R3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadShellBroker } from './helpers-shell-broker.mjs';
import { ROOT, SHELL, CHAT, ENGINE, stripComments } from './helpers-app.mjs';

const TEXT_HTML = fs.readFileSync(path.join(ROOT, 'web', 'note-text.inline.html'), 'utf8');
function stand(answer) {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.url); const a = answer(req.url); res.writeHead(a.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(a.body)); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ seen, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((d) => srv.close(d)) })));
}
const PAGES = [{ path: 'entry-1.json', scope: '', page: 0, pending: false, tags: ['ores'] }];

test('note-text relays to /api/note-text with the FRAME\'s slug; paths repeat, scope only when given, fields joined; reply verbatim', async () => {
  const S = await stand(() => ({ body: { ok: true, pages: PAGES, truncated: false, pending: 0, ocr: 'ready' } }));
  try {
    const B = loadShellBroker(S.base, { app: 'notes' });
    const r = await new Promise((done) => B.route({ id: 7, kind: 'note-text', paths: ['entry-1.json', 'notes/43 3.json', '', 5], scope: '', fields: ['src', 'labels'], app: 'bible' }, done));
    assert.deepEqual(S.seen, ['/api/note-text?app=notes&path=entry-1.json&path=notes%2F43+3.json&scope=&fields=src%2Clabels'], 'the app\'s own `app` field is ignored; empty and non-string paths are dropped; scope "" is SENT (it means the root notebook)');
    assert.deepEqual(r, { pa: 'res', id: 7, ok: true, pages: PAGES, truncated: false, pending: 0, ocr: 'ready' }, 'the server\'s shape passes through');
    await new Promise((done) => B.route({ id: 8, kind: 'note-text' }, done));
    assert.equal(S.seen[1], '/api/note-text?app=notes', 'nothing given: every file, any scope, the default fields');
  } finally { await S.close(); }
});

test('a server failure reaches the app with a code and a rendered sentence', async () => {
  const S = await stand(() => ({ status: 500, body: { ok: false, error: 'note text unavailable · 笔记文本不可用', code: 'text_failed' } }));
  try {
    const B = loadShellBroker(S.base, { app: 'notes' });
    const r = await new Promise((done) => B.route({ id: 9, kind: 'note-text', paths: ['x.json'] }, done));
    assert.equal(r.ok, false); assert.ok(r.code, 'a code'); assert.ok(r.text, 'and the shell\'s bilingual sentence');
  } finally { await S.close(); }
});

test('the kind sits behind the no-slug guard, is in superelf.md\'s Kinds list, and only PANoteText posts it', () => {
  const code = stripComments(SHELL);
  const guard = code.indexOf("if(!appSlug) return reply({ok:false,code:'bad-request',error:NO_APP_TEXT});");
  const kind = code.indexOf("m.kind==='note-text'");
  assert.ok(guard > 0 && kind > guard, 'fails closed with no slug, like every kind');
  const md = fs.readFileSync(path.join(ROOT, 'superelf.md'), 'utf8');
  assert.match(/^Kinds: [\s\S]*?`\.$/m.exec(md)[0], /`note-text`/, 'in the Kinds list the kinds test reads');
  assert.match(md, /`note-text` `\{paths\?, scope\?, fields\?\}`/, 'with its reply contract documented');
  assert.equal((TEXT_HTML.match(/kind:'note-text'/g) || []).length, 1, 'PANoteText sends it from ONE place');
  assert.doesNotMatch(CHAT, /note-text'/, 'the drawer never names the kind');
  assert.doesNotMatch(ENGINE, /kind:'note-text'/, 'nor does PANote itself: the component is the client');
});

// ── PANoteText.fetch, run ──
function loadText(PAStore) {
  const a = TEXT_HTML.indexOf('<script id="pnt-script">'), b = TEXT_HTML.indexOf('</script>', a);
  const src = TEXT_HTML.slice(TEXT_HTML.indexOf('>', a) + 1, b);
  const window = PAStore === undefined ? {} : { PAStore };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(window, { createElement: () => { throw new Error('fetch needs no DOM'); } });
  return window.PANoteText;
}

test('PANoteText.fetch goes through PAStore.ask and resolves an outcome, never a throw', async () => {
  const asked = [];
  const P = loadText({ ask: async (o) => { asked.push(o); return { ok: true, pages: PAGES, pending: 2, ocr: 'building' }; } });
  assert.deepEqual(await P.fetch({ paths: ['entry-1.json', 7, ''], scope: 'v16', fields: ['src', 'labels'] }), { ok: true, pages: PAGES, truncated: false, pending: 2, ocr: 'building', reason: '' });
  assert.deepEqual(asked, [{ kind: 'note-text', paths: ['entry-1.json'], scope: 'v16', fields: ['src', 'labels'] }], 'the broker kind, non-string paths dropped');
  assert.deepEqual(await P.fetch({ fields: ['tags'] }), { ok: true, pages: PAGES, truncated: false, pending: 2, ocr: 'building', reason: '' });
  assert.deepEqual(asked[1], { kind: 'note-text', fields: ['tags'] }, 'no paths, no scope: neither key is sent (any file, any scope)');
  const F = loadText({ ask: async () => ({ ok: false, code: 'server-error', text: 'Note text failed · 笔记文本失败 (500)' }) });
  assert.deepEqual(await F.fetch({}), { ok: false, error: 'Note text failed · 笔记文本失败 (500)', code: 'server-error' }, 'the shell\'s sentence is kept');
  const N = loadText(undefined);
  const none = await N.fetch({});
  assert.equal(none.ok, false); assert.equal(none.code, 'no-broker'); assert.equal(none.error, N.TXT.unavailable);
  const junk = loadText({ ask: async () => ({ ok: true, pages: 'no', pending: -3 }) });
  assert.deepEqual(await junk.fetch({}), { ok: true, pages: [], truncated: false, pending: 0, ocr: '', reason: '' }, 'a malformed reply is normalised, never thrown on');
});
