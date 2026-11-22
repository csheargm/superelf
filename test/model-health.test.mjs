// lib/model-health.mjs at its edges — the cases the end-to-end file (model-retired.test.mjs) does
// not reach: what must NOT hide a lane, what must fail the run rather than pass it, and damage.
// Probes go over real HTTP to a node:http stub; nothing here stands in for fetch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { probeLane, checkModels, runModelCheck, recordGone, readModelHealth, ollamaHttpError, goneReason,
  catalogName, modelHealthFor, MODEL_HEALTH_FILENAME } from '../lib/model-health.mjs';

let srv, url;
const answers = {};   // model → { status, body } | 'hang'; absent = 200
before(async () => {
  srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const a = answers[JSON.parse(b || '{}').model];
      if (a === 'hang') return;   // never answers: the probe's own timeout must end it
      if (a) { res.writeHead(a.status, { 'content-type': 'application/json' }); return res.end(a.body); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { content: 'x' }, done: true }) + '\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.closeAllConnections(); srv.close(); });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mh-')), MODEL_HEALTH_FILENAME);
const lane = (id, model) => ({ id, label: id.toUpperCase(), provider: 'ollama', model });

test('only 410 or Ollama\'s model-not-found 404 mean gone; a 5xx, a hang or a refused connection say nothing', async () => {
  answers['a:cloud'] = { status: 410, body: '{"error":"a was retired at 2026-09-25 00:00:00 -0700 PDT"}' };
  answers['b:cloud'] = { status: 404, body: '{"error":"model \'b\' not found"}' };
  answers['c:cloud'] = { status: 500, body: 'upstream exploded' };
  answers['d:cloud'] = 'hang';
  assert.deepEqual(await probeLane({ url, model: 'ok:cloud' }), { state: 'ok' }, 'R14 control: a served model is ok');
  assert.deepEqual(await probeLane({ url, model: 'a:cloud' }), { state: 'gone', status: 410, error: 'a was retired at 2026-09-25 00:00:00 -0700 PDT' });
  assert.equal((await probeLane({ url, model: 'b:cloud' })).state, 'gone');
  const five = await probeLane({ url, model: 'c:cloud' });
  assert.equal(five.state, 'unknown');
  assert.match(five.error, /Ollama HTTP 500 — upstream exploded/);
  assert.deepEqual(await probeLane({ url, model: 'd:cloud', timeoutMs: 300 }), { state: 'unknown', error: 'no answer within 0.3s' });
  assert.equal((await probeLane({ url: 'http://127.0.0.1:1', model: 'x' })).state, 'unknown', 'Ollama down is not "gone"');
});

test('the error every caller throws carries the status, the server\'s words and a Chinese line', () => {
  const e = ollamaHttpError(410, '{"error":"m was retired at 2026-09-25 00:00:00 -0700 PDT (ref: x)"}');
  assert.equal(e.message, 'Ollama HTTP 410 — m was retired at 2026-09-25 00:00:00 -0700 PDT (ref: x) · 该模型已被 Ollama 停用');
  assert.equal(e.gone, true);
  assert.equal(ollamaHttpError(502, '').message, 'Ollama HTTP 502 · Ollama 出错（502）', 'no body: the status alone');
  assert.equal(ollamaHttpError(502, '').gone, false);
  assert.equal(goneReason({ status: 410, error: e.serverError }), 'retired 2026-09-25');
  assert.equal(goneReason({ status: 404, error: "model 'b' not found" }), 'not found');
});

test('Ollama down fails the run — it is never a quiet "all fine" (R14)', async () => {
  await assert.rejects(checkModels({ chatModels: [lane('x', 'x:cloud')], url: 'http://127.0.0.1:1' }),
    /no Ollama lane could be checked/);
  const file = tmpFile();
  await assert.rejects(runModelCheck({ file, chatModels: [lane('x', 'x:cloud')], url: 'http://127.0.0.1:1' }));
  assert.ok(!fs.existsSync(file), 'a failed run writes no record');
});

test('an unknown probe keeps what was known, and is reported rather than hidden', async () => {
  answers['c:cloud'] = { status: 500, body: 'flaky' };
  const prev = { checked: 1, gone: { 'c:cloud': { status: 410, error: 'gone', since: 5, reported: true } }, catalog: null };
  const { next, changes } = await checkModels({ chatModels: [lane('ok', 'ok:cloud'), lane('c', 'c:cloud')], url, prev, now: 9 });
  assert.deepEqual(next.gone['c:cloud'], prev.gone['c:cloud'], 'a 500 is no evidence the model came back');
  assert.equal(changes.back.length, 0);
  assert.deepEqual(changes.unknown.map((r) => r.lane.id), ['c']);
});

test('a damaged record is rebuilt and the rebuild is said; a chat-time record keeps its first sighting', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  assert.throws(() => readModelHealth(file), 'the strict read throws — each caller decides what damage means');
  const brief = await runModelCheck({ file, chatModels: [lane('ok', 'ok:cloud')], url, catalogUrl: '', manual: true });
  assert.match(brief.body, /model-health\.json was unreadable and has been rebuilt/);
  assert.deepEqual(readModelHealth(file).gone, {});
  const err = ollamaHttpError(410, '{"error":"z was retired at 2026-09-25"}');
  assert.equal(recordGone(file, 'z:cloud', err, 100), true, 'first sighting');
  assert.equal(recordGone(file, 'z:cloud', err, 200), false, 'already known');
  assert.deepEqual(readModelHealth(file).gone['z:cloud'], { status: 410, error: 'z was retired at 2026-09-25', since: 100, reported: false });
});

test('a catalog that cannot be read is reported, and the last good list is kept', async () => {
  const prev = { checked: 1, gone: {}, catalog: ['kept'] };
  const { next, changes } = await checkModels({ chatModels: [lane('ok', 'ok:cloud')], url, catalogUrl: `${url}/nope`, prev });
  assert.match(changes.catalogError, /no "models" list|HTTP/);
  assert.deepEqual(next.catalog, ['kept']);
});

test('new catalog models are recorded, never briefed: the weekly model review reports them (docs/adr/0017)', async () => {
  const cat = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'ok' }, { name: 'shiny-new' }] })); });
  await new Promise((r) => cat.listen(0, '127.0.0.1', r));
  try {
    const file = tmpFile();
    const run = (manual) => runModelCheck({ file, chatModels: [lane('ok', 'ok:cloud')], url, catalogUrl: `http://127.0.0.1:${cat.address().port}/`, manual });
    assert.equal(await run(false), null, 'a scheduled run with only an arrival is a quiet day');
    assert.deepEqual(readModelHealth(file).catalog, ['ok', 'shiny-new'], 'R14 control: the catalog really was read and kept');
    assert.ok(!/shiny-new/.test((await run(true)).body), 'Run now does not list it either');
  } finally { cat.close(); }
});

test('catalog names: a cloud model maps to its catalog entry, a local one to nothing', () => {
  assert.equal(catalogName('deepseek-v4.1-flash:cloud'), 'deepseek-v4.1-flash');
  assert.equal(catalogName('deepseek-v4-pro:0813-cloud'), 'deepseek-v4-pro:0813');
  assert.equal(catalogName('mistral-large-3:675b:cloud'), 'mistral-large-3:675b');
  assert.equal(catalogName('qwen3:8b'), null);
});

test('a gone answer a chat turn records WHILE the job probes survives the job\'s write', async () => {
  // runModelCheck reads, probes (seconds), then writes. A turn's record landing in between used
  // to be overwritten by the job's older snapshot whenever its own probe came back unknown.
  const file = tmpFile();
  answers['c:cloud'] = { status: 500, body: 'flaky' };
  const err = ollamaHttpError(410, '{"error":"c was retired at 2026-09-25"}');
  const during = async (u, init) => {
    const model = JSON.parse(init.body).model;
    if (model === 'c:cloud') recordGone(file, 'c:cloud', err);        // the turn, mid-run
    if (model === 'ok:cloud') recordGone(file, 'ok:cloud', err);      // a stale record for a model this run sees answer
    return fetch(u, init);
  };
  await runModelCheck({ file, chatModels: [lane('ok', 'ok:cloud'), lane('c', 'c:cloud')], url, catalogUrl: '', fetchImpl: during });
  const h = readModelHealth(file);
  assert.equal(h.gone['c:cloud'] && h.gone['c:cloud'].status, 410, 'the turn\'s record is kept: this run had no evidence against it');
  assert.equal(h.gone['c:cloud'].reported, false, 'and the next run still briefs it');
  assert.equal(h.gone['ok:cloud'], undefined, 'a model this run saw answer is not hidden by a record older than the answer');
});

test('a lasting outage is briefed once: a scheduled run repeats neither "could not check" nor a catalog failure', async () => {
  const file = tmpFile();
  answers['c:cloud'] = { status: 500, body: 'down' };
  const run = (manual) => runModelCheck({ file, chatModels: [lane('ok', 'ok:cloud'), lane('c', 'c:cloud')], url, catalogUrl: `${url}/nope`, manual });
  const first = await run(false);
  assert.match(first.body, /Could not check · 无法检查:\n- C \(c:cloud\)/, 'the first failing run says so');
  assert.match(first.body, /Could not read the Ollama catalog/);
  assert.equal(await run(false), null, 'the same failures the next day: a quiet day, not a daily nag');
  const asked = await run(true);
  assert.match(asked.body, /Could not check/, 'a person pressing Run now is still told');
  assert.match(asked.body, /Could not read the Ollama catalog/);
  delete answers['c:cloud'];
  answers['c:cloud'] = { status: 503, body: 'down again' };
  assert.equal(await run(false), null, 'still failing is still not news');
});

test('the per-request wiring: a damaged file reads as nothing known and is audited; a sighting is audited once', () => {
  const file = tmpFile();
  const events = [];
  const mh = modelHealthFor(file, (ev, extra) => events.push({ ev, ...extra }));
  assert.deepEqual(mh.gone(), {}, 'R14 control: no file yet, nothing gone, nothing audited');
  assert.equal(events.length, 0);
  const err = ollamaHttpError(410, '{"error":"m was retired at 2026-09-25"}');
  mh.noteGone('m:cloud', err);
  mh.noteGone('m:cloud', err);
  assert.deepEqual(mh.gone(), { 'm:cloud': 'retired 2026-09-25' });
  assert.deepEqual(events.map((e) => e.ev), ['model-gone'], 'audited on the first sighting only');
  fs.writeFileSync(file, '[]');
  assert.deepEqual(mh.gone(), {}, 'damage degrades to nothing known');
  assert.equal(events.at(-1).ev, 'model-health-error', 'and says so');
});

test('a bare 404 is not "gone": a wrong ollama_url answering 404 to every path must not hide every lane', async () => {
  // Ollama's real "not found" names the model; Go's default 404 for an unknown path does not.
  const wrong = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404 page not found'); }); });
  await new Promise((r) => wrong.listen(0, '127.0.0.1', r));
  const wrongUrl = `http://127.0.0.1:${wrong.address().port}`;
  try {
    assert.equal((await probeLane({ url: wrongUrl, model: 'a:cloud' })).state, 'unknown');
    await assert.rejects(checkModels({ chatModels: [lane('a', 'a:cloud'), lane('b', 'b:cloud')], url: wrongUrl }),
      /no Ollama lane could be checked/, 'a server that is not Ollama fails the run, it does not retire every lane');
    assert.equal(ollamaHttpError(404, '404 page not found').gone, false);
    assert.equal(ollamaHttpError(404, '{"error":"model \'b\' not found"}').gone, true, 'R14 control: Ollama\'s own 404 still counts');
  } finally { wrong.close(); }
});

test('the probe carries the chat lane\'s Ollama auth (ollama.com answers 401 without it)', async () => {
  const seen = [];
  const fetchImpl = async (u, o) => {
    seen.push(o.headers && o.headers.authorization);
    return o.headers && o.headers.authorization === 'Bearer k1' ? new Response('{}', { status: 200 }) : new Response('{"error":"unauthorized"}', { status: 401 });
  };
  const file = tmpFile();
  await runModelCheck({ file, chatModels: [lane('g', 'glm-5.3')], url: 'https://ollama.example', auth: { authorization: 'Bearer k1' }, fetchImpl });   // resolves: the lane was checked
  assert.deepEqual(seen.filter(Boolean), ['Bearer k1'], 'the key reached the probe');
  // R14 control: without the key the same lane is unknown (never "gone"), and with no lane known the run fails.
  await assert.rejects(runModelCheck({ file: tmpFile(), chatModels: [lane('g', 'glm-5.3')], url: 'https://ollama.example', fetchImpl }));
});
