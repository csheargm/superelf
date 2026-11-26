// 分享 · Share by link through TWO real web.mjs nodes (R6, docs/adr/0047): an owner node and a demo
// node, a stub Supabase. The owner shares → the signed channel → a link; a new visitor on a network
// already at its new-visitor cap opens the link, signs in, joins and gets their OWN copy (no data/);
// a demo user shares; re-share keeps the id; limits; privacy refusals; take-down; bad signatures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { startStubSupabase } from './helpers-demo-sb.mjs';
import { AUTH_HEADER } from '../lib/demo-auth.mjs';
import { ADMIN_PATHS } from '../lib/demo.mjs';
import { SHARE_COOKIE, signIngest } from '../lib/app-share.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'a'.repeat(64);
const ADMIN = 'owner@example.org';
let sb, demo, owner, demoRoot, ownerRoot, dPort, oPort;

before(async () => {
  sb = await startStubSupabase();
  dPort = await freePort(); oPort = await freePort();
  const shares = { demo_url: `http://127.0.0.1:${dPort}`, per_day: 3, joins_per_link: 2 };
  demoRoot = mkWebRoot({ port: dPort, extraConfig: { users: [], share_ingest_secret: SECRET, shares,
    demo: { enabled: true, behind_cloudflare: true, new_users_per_ip_per_day: 1, sessions_per_ip_per_day: 50, admin_emails: [ADMIN],
      auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(demoRoot, 'workspace.example'), { recursive: true });
  ownerRoot = mkWebRoot({ port: oPort, extraConfig: { share_ingest_secret: SECRET, shares } });
  fs.writeFileSync(path.join(ownerRoot, 'privacy-terms.txt'), 'Zebulonia\n');
  fs.writeFileSync(path.join(ownerRoot, 'workspace', 'identity-denylist.txt'), 'Quixotely\n');
  const app = path.join(ownerRoot, 'workspace', 'apps', 'notes');
  fs.cpSync(path.join(REPO, 'workspace.example', 'apps', 'notes'), app, { recursive: true });
  fs.mkdirSync(path.join(app, 'data'), { recursive: true });
  fs.writeFileSync(path.join(app, 'data', 'secret.json'), '{"mine":"OWNER-DATA"}');
  demo = startWeb(demoRoot); owner = startWeb(ownerRoot);
  await waitReady(dPort); await waitReady(oPort);
});
after(async () => { await stopWeb(demo); await stopWeb(owner); sb.srv.close(); rmTemp(demoRoot); rmTemp(ownerRoot); });

const call = (port, p, { token, sbToken, ip = '198.51.100.9', cookie, headers = {}, ...o } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual', ...o, headers: {
  'content-type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(sbToken ? { [AUTH_HEADER]: sbToken } : {}), ...(cookie ? { cookie } : {}), ...headers } });
const D = (p, o) => call(dPort, p, o), O = (p, o) => call(oPort, p, o);
const post = (body) => ({ method: 'POST', body: JSON.stringify(body) });
const member = async (sub, ip, cookie) => { const t = sb.jwt({ sub, email: `${sub}@example.org` }); const r = await D('/api/demo/start', { method: 'POST', sbToken: t, ip, cookie }); return { status: r.status, ...(await r.json()), sbToken: t }; };
const adminTok = () => sb.jwt({ sub: 'adm', email: ADMIN, amr: [{ method: 'otp', timestamp: 1 }] });
const ws = (uid) => path.join(demoRoot, `workspace-${uid}`);
let ownerShare;

test('owner shares → link page → a new visitor at the network cap signs in by the link and gets their own copy', async () => {
  const r = await O('/api/share', { token: OWNER_TOKEN, ...post({ slug: 'notes' }) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j)); assert.match(j.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(j.url, `http://127.0.0.1:${dPort}/s/${j.id}`); assert.equal(j.mail, false, 'no AgentMail on this owner node');
  ownerShare = j;
  assert.ok(!fs.existsSync(path.join(demoRoot, 'app-shares', j.id, 'data')), 'never data/');
  const page = await D(`/s/${j.id}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="shName"/); assert.match(html, new RegExp(`href="/\\?share=${j.id}"`));
  const cookie = `${SHARE_COOKIE}=${j.id}`;
  assert.ok(page.headers.get('set-cookie').startsWith(cookie));
  const ip = '203.0.113.20';
  assert.equal((await member('first', ip)).status, 200, 'the one new visitor this network may have today');
  assert.equal((await member('nolink', ip)).status, 429, 'a second without a link: the normal cap');
  const b = await member('bee', ip, cookie);
  assert.equal(b.status, 200, 'with a live link: exempt from the new-visitor cap');
  const k = await (await D(`/api/share/${j.id}/join`, { token: b.token, ip, ...post({}) })).json();
  assert.equal(k.ok, true, JSON.stringify(k));
  const copy = path.join(ws(b.uid), 'apps', k.slug);
  assert.ok(fs.existsSync(path.join(copy, 'index.html')));
  assert.ok(!fs.existsSync(path.join(copy, 'data', 'secret.json')), 'the owner\'s data never travels');
  assert.equal(JSON.parse(fs.readFileSync(path.join(copy, 'meta.json'), 'utf8')).sharedFrom, j.id);
  const again = await (await D(`/api/share/${j.id}/join`, { token: b.token, ip, ...post({}) })).json();
  assert.equal(again.slug, k.slug, 'joining twice gives the same copy');
});

test('the exemption runs out at joins_per_link; anonymous ids never join', async () => {
  const cookie = `${SHARE_COOKIE}=${ownerShare.id}`, ip = '203.0.113.21';
  assert.equal((await member('f2', ip)).status, 200);
  assert.equal((await D('/api/demo/start', { method: 'POST', ip, cookie })).status, 429, 'an anonymous start never spends the exemption');
  const c = await member('cee', ip, cookie); assert.equal(c.status, 200);
  await D(`/api/share/${ownerShare.id}/join`, { token: c.token, ip, ...post({}) });   // the 2nd join: the cap (2) is reached
  assert.equal((await member('dee', ip, cookie)).status, 429, 'past joins_per_link: no exemption');
  const anon = await (await D('/api/demo/start', { method: 'POST', ip: '203.0.113.99' })).json();
  assert.equal((await D(`/api/share/${ownerShare.id}/join`, { token: anon.token, ip: '203.0.113.99', ...post({}) })).status, 401);
});

test('a demo user shares, re-shares (same id, newcomers get the new version), and hits the daily cap', async () => {
  const a = await member('ann', '198.51.100.30');
  const app = path.join(ws(a.uid), 'apps', 'tasks');
  const r1 = await (await D('/api/share', { token: a.token, ...post({ slug: 'tasks' }) })).json();
  assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r1.mail, false, 'demo: Copy only');
  const z = await member('zed', '198.51.100.31');
  const kz = await (await D(`/api/share/${r1.id}/join`, { token: z.token, ...post({}) })).json();
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><p>VERSION-TWO</p>');
  const r2 = await (await D('/api/share', { token: a.token, ...post({ slug: 'tasks' }) })).json();
  assert.equal(r2.id, r1.id, 'a re-share keeps the link');
  assert.ok(!fs.readFileSync(path.join(ws(z.uid), 'apps', kz.slug, 'index.html'), 'utf8').includes('VERSION-TWO'), 'an existing copy stays');
  const y = await member('yan', '198.51.100.32');
  const ky = await (await D(`/api/share/${r1.id}/join`, { token: y.token, ...post({}) })).json();
  assert.match(fs.readFileSync(path.join(ws(y.uid), 'apps', ky.slug, 'index.html'), 'utf8'), /VERSION-TWO/);
  assert.equal((await D('/api/share', { token: a.token, ...post({ slug: 'notes' }) })).status, 200, 'the 3rd today');
  const r4 = await D('/api/share', { token: a.token, ...post({ slug: 'notes' }) });
  assert.equal(r4.status, 429, 'per_day: 3');
});

test('privacy refusal (no matched text for a demo user), the size cap, and an owner term', async () => {
  const p = await member('pii', '198.51.100.40');
  const app = path.join(ws(p.uid), 'apps', 'notes');
  fs.writeFileSync(path.join(app, 'index.html'), `<p>call me at (415) ${'555'}-0134</p>`);
  const r = await D('/api/share', { token: p.token, ...post({ slug: 'notes' }) });
  const j = await r.json();
  assert.equal(r.status, 422); assert.equal(j.code, 'private');
  assert.ok(!JSON.stringify(j).includes('555-0134'), 'the matched text is never shown to a demo user');
  fs.writeFileSync(path.join(app, 'index.html'), '<p>ok</p>');
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(app, `${n}.js`), 'x'.repeat(900 * 1024));
  assert.equal((await D('/api/share', { token: p.token, ...post({ slug: 'notes' }) })).status, 413, 'over 2 MB');
  const oapp = path.join(ownerRoot, 'workspace', 'apps', 'termy');
  fs.mkdirSync(oapp, { recursive: true }); fs.writeFileSync(path.join(oapp, 'index.html'), '<p>Zebulonia</p>');
  const o = await O('/api/share', { token: OWNER_TOKEN, ...post({ slug: 'termy' }) });
  assert.equal(o.status, 422, 'the owner\'s strict terms');
});

test('the channel: unsigned, forged and replayed ingests are 404; demo Publish stays refused', async () => {
  const body = JSON.stringify({ slug: 'evil', uid: 'owner', name: 'x', files: [{ path: 'index.html', b64: Buffer.from('<p>x</p>').toString('base64') }] });
  assert.equal((await D('/api/share/ingest', { method: 'POST', body })).status, 404, 'unsigned');
  assert.equal((await D('/api/share/ingest', { method: 'POST', body, headers: signIngest('b'.repeat(64), body) })).status, 404, 'wrong secret');
  const h = signIngest(SECRET, body);
  assert.equal((await D('/api/share/ingest', { method: 'POST', body, headers: h })).status, 200, 'genuine');
  assert.equal((await D('/api/share/ingest', { method: 'POST', body, headers: h })).status, 404, 'replayed');
  assert.equal((await D('/api/share/ingest', { method: 'POST', body, headers: signIngest(SECRET, body, Date.now() - 600_000) })).status, 404, 'stale');
  const a = await member('pub', '198.51.100.50');
  assert.equal((await D('/api/apps/tasks/publish', { token: a.token, ...post({}) })).status, 403, 'demo users never publish');
});

test('admin Shares tab lists who made and who joined; 下架 stops the link, copies stay', async () => {
  const s = await (await D(ADMIN_PATHS.shares, { sbToken: adminTok() })).json();
  const row = s.shares.find((x) => x.id === ownerShare.id);
  assert.equal(row.byKind, 'owner'); assert.equal(row.joins.length, 2);
  assert.equal((await D(ADMIN_PATHS.shares, { sbToken: sb.jwt({ sub: 'x', email: 'x@example.org' }) })).status, 404, 'non-admins: 404');
  assert.equal((await D(ADMIN_PATHS.takedown, { sbToken: adminTok(), ...post({ id: ownerShare.id }) })).status, 200);
  assert.equal((await D(`/s/${ownerShare.id}`)).status, 404, 'taken down = unknown');
  const b = await member('late', '198.51.100.60');
  assert.equal((await D(`/api/share/${ownerShare.id}/join`, { token: b.token, ...post({}) })).status, 404);
  const copies = fs.readdirSync(demoRoot).filter((n) => n.startsWith('workspace-sb-')).flatMap((w) => {
    const apps = path.join(demoRoot, w, 'apps');
    return fs.readdirSync(apps).filter((a) => { try { return JSON.parse(fs.readFileSync(path.join(apps, a, 'meta.json'), 'utf8')).sharedFrom === ownerShare.id; } catch { return false; /* an app with no meta */ } });
  });
  assert.equal(copies.length, 2, 'existing copies stay');
});

test('with no secret set, ingest is 404 and the owner is told the channel is not set up', async () => {
  const f = path.join(ownerRoot, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.share_ingest_secret = ''; fs.writeFileSync(f, JSON.stringify(c));
  await waitFor(async () => (await O('/api/share', { token: OWNER_TOKEN, ...post({ slug: 'notes' }) })).status === 409, 'owner config reload', { timeoutMs: 10000 });
  const j = await (await O('/api/share', { token: OWNER_TOKEN, ...post({ slug: 'notes' }) })).json();
  assert.equal(j.code, 'no_channel');
});
