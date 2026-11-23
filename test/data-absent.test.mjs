// A first read of app data that does not exist yet is not an error (triage 2026-11-23): Bible
// logged four 404 console errors per open (general.json, notes/<b>-<c>.json and both .bak). The
// broker's data read asks with ?absent=empty and an absent file answers 204, which the shell maps
// to the same 'not-found' result as before. CONTROL: without the query it is still 404, and the
// path and access rules are unchanged (a traversal is still 400, another user's file is not seen).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { DATA_ABSENT_QUERY } from '../lib/appdata.mjs';

let port, root, web;
before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); });
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });

test('an absent data file answers 204 when the read says absent is expected; 404 otherwise', async () => {
  const r = await api(port, `/api/data/data/bible/general.json?${DATA_ABSENT_QUERY}`);
  assert.equal(r.status, 204); assert.equal(await r.text(), '');
  assert.equal((await api(port, '/api/data/data/bible/general.json')).status, 404, 'CONTROL: no query, still 404');
});

test('a present file answers 200 with its content either way; an empty file is 200, not 204', async () => {
  const d = path.join(root, 'workspace', 'data', 'bible'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'general.json'), '{"a":1}'); fs.writeFileSync(path.join(d, 'empty.json'), '');
  const r = await api(port, `/api/data/data/bible/general.json?${DATA_ABSENT_QUERY}`);
  assert.equal(r.status, 200); assert.equal(await r.text(), '{"a":1}');
  assert.equal((await api(port, `/api/data/data/bible/empty.json?${DATA_ABSENT_QUERY}`)).status, 200);
});

test('access rules unchanged: traversal is 400, a directory is not "absent"', async () => {
  assert.equal((await api(port, `/api/data/..%2F..%2Fconfig.json?${DATA_ABSENT_QUERY}`)).status, 400);
  assert.equal((await api(port, `/api/data/data?${DATA_ABSENT_QUERY}`)).status, 404, 'a directory is a fault, never empty data');
});

test('the shell asks with the same query and maps 204 to not-found (R3: one spelling)', () => {
  const shell = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(shell.includes(`const DATA_ABSENT_QUERY='${DATA_ABSENT_QUERY}'`), 'the shell constant equals lib/appdata.mjs');
  assert.ok(shell.includes(`if(r.status===204&&url.endsWith('?'+DATA_ABSENT_QUERY)) return {ok:false,code:'not-found'`), 'relayCall maps a 204 read to not-found');
});
