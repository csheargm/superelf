// The demo's waiting list · 演示等候名单 (lib/demo-waitlist.mjs, lib/demo-waitlist-ui.mjs).
// Unit: validation, length caps, dedupe, the per-network and total caps. Server: answered on a demo
// node only. Real browser (R6): ?join=1 opens the form, a submit lands one line on disk, a second
// submit of the same address does not add another. Without Playwright the browser tests FAIL,
// unless PA_E2E_SKIP=1 (see test/helpers-e2e-gate.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { makeQuotaStore } from '../lib/demo-quota.mjs';
import { validateEntry, addToWaitlist, WAITLIST_FILE, WAITLIST_MAX, WAITLIST_PATH, WAITLIST_MESSAGES } from '../lib/demo-waitlist.mjs';
import { WAITLIST_LABELS } from '../lib/demo-waitlist-ui.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = (root) => { const f = path.join(root, WAITLIST_FILE); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };

test('validation: a plain email shape, lower-cased; name and note capped and kept on one line', () => {
  for (const bad of [undefined, '', 'nope', 'a@example', 'a b@example.test', '<a@example.test>', 42, 'x'.repeat(250) + '@example.test']) assert.equal(validateEntry({ email: bad }).ok, false, String(bad));
  assert.equal(validateEntry(null).ok, false); assert.equal(validateEntry([]).ok, false);
  const v = validateEntry({ email: ' Ann@Example.ORG ', name: 'A\nB', note: 'n'.repeat(900) });
  assert.equal(v.entry.email, 'ann@example.org');
  assert.equal(v.entry.name, 'A B', 'no newline survives: one entry, one JSONL line');
  assert.equal(v.entry.note.length, WAITLIST_MAX.note);
  assert.equal(validateEntry({ email: 'a@example.test', note: 7 }).entry.note, '', 'a non-string note is dropped');
});

function sandbox(demo = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-waitlist-'));
  const store = makeQuotaStore(path.join(root, 'demo-quota.json'));
  const add = (body, ip = '203.0.113.9') => addToWaitlist({ cfg: { demo: { enabled: true, ...demo } }, root, store, ip, body });
  return { root, add };
}

test('dedupe by email: a repeat answers like a new entry and adds nothing', () => {
  const s = sandbox();
  try {
    assert.deepEqual(s.add({ email: 'a@example.test', note: 'hi' }), { status: 200, body: { ok: true } });
    assert.deepEqual(s.add({ email: 'A@EXAMPLE.TEST' }), { status: 200, body: { ok: true } }, 'no "already listed" oracle');
    const list = entries(s.root);
    assert.equal(list.length, 1);
    assert.equal(list[0].email, 'a@example.test'); assert.equal(list[0].note, 'hi'); assert.ok(!('ip' in list[0]), 'no IP stored');
    assert.equal(s.add({ email: 'bad' }).body.error, WAITLIST_MESSAGES.bad_email);
    assert.equal(entries(s.root).length, 1, 'a refused entry writes nothing');
  } finally { rmTemp(s.root); }
});

test('caps: per network per day, then the total; a damaged line is skipped, not fatal', () => {
  const s = sandbox({ waitlist_per_ip_per_day: 2, waitlist_max_entries: 3 });
  try {
    assert.equal(s.add({ email: '1@example.test' }).status, 200);
    assert.equal(s.add({ email: '2@example.test' }).status, 200);
    const r = s.add({ email: '3@example.test' });
    assert.equal(r.status, 429); assert.equal(r.body.code, 'waitlist_rate');
    assert.equal(s.add({ email: '1@example.test' }).status, 429, 'over the network cap: listed or not, the same refusal');
    assert.equal(s.add({ email: '3@example.test' }, '198.51.100.1').status, 200, 'another network is its own bucket');
    fs.appendFileSync(path.join(s.root, WAITLIST_FILE), '{broken\n');
    const full = s.add({ email: '4@example.test' }, '198.51.100.2');
    assert.equal(full.status, 507); assert.equal(full.body.code, 'waitlist_full');
    assert.equal(fs.readFileSync(path.join(s.root, WAITLIST_FILE), 'utf8').split('\n').filter(Boolean).length, 4, 'nothing appended once full');
    assert.equal(s.add({ email: '1@example.test' }, '198.51.100.3').status, 507, 'a listed address gets the same answer as a new one: no oracle');
  } finally { rmTemp(s.root); }
});

let demo, owner, browser;
async function node(extraConfig) {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  const web = startWeb(root); await waitReady(port);
  return { port, root, web };
}
before(async () => {
  demo = await node({ users: [], demo: { enabled: true, behind_cloudflare: true, new_users_per_ip_per_day: 50 } });
  owner = await node({});
  if (!skip) browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  for (const n of [demo, owner]) if (n) { await stopWeb(n.web); rmTemp(n.root); }
});
const post = (n, body) => fetch(`http://127.0.0.1:${n.port}${WAITLIST_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.7' }, body: JSON.stringify(body) });

test('server: the demo answers and stores outside every workspace; a private node has no such route', async () => {
  const r = await post(demo, { email: 'srv@example.test' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true }, 'nothing else echoed back');
  assert.ok(entries(demo.root).some((e) => e.email === 'srv@example.test'));
  assert.equal((fs.statSync(path.join(demo.root, WAITLIST_FILE)).mode & 0o077), 0, 'owner-only file');
  assert.equal((await post(demo, { email: 'nope' })).status, 400);
  const o = await post(owner, { email: 'srv@example.test' });
  assert.notEqual(o.status, 200, `private node refuses (${o.status})`);
  assert.equal(fs.existsSync(path.join(owner.root, WAITLIST_FILE)), false, 'CONTROL: nothing written on a private node');
});

test('real flow: ?join=1 opens the form, submit thanks the visitor, one line on disk, a repeat adds none', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const send = async () => {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${demo.port}/?join=1`);
    const form = page.locator('#demoWait form');
    await form.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#demoWait p').textContent(), WAITLIST_LABELS.hint);
    await form.locator('input[type=email]').fill('E2E@Example.org');
    await form.locator('textarea').fill('for my family');
    await form.locator('button[type=submit]').click();
    await page.locator('#demoWaitMsg', { hasText: WAITLIST_LABELS.thanks }).waitFor();
    return page;
  };
  const page = await send();
  await page.evaluate(() => openDrawer());
  assert.equal(await page.locator('#drawer > #demoJoin').textContent(), WAITLIST_LABELS.line, 'the quiet drawer row');
  await send();
  await waitFor(() => entries(demo.root).some((e) => e.email === 'e2e@example.org'), 'entry on disk');
  const mine = entries(demo.root).filter((e) => e.email === 'e2e@example.org');
  assert.equal(mine.length, 1, 'a duplicate submit is not doubled');
  assert.equal(mine[0].note, 'for my family');
  await ctx.close();
});

test('CONTROL / owner node: no waiting-list row or form', { skip }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${owner.port}/?join=1`);
  await page.locator('#drawer').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#demoJoin, #demoWait').count(), 0);
  await ctx.close();
});
