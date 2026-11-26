// 分享 · Share by link — the store and the channel, unit level (docs/adr/0047; flows: app-share-e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newShareId, SHARE_ID_RE, shareLimit, SHARE_DEFAULTS, ingestSecret, checkIngestFiles, signIngest, verifyIngest, makeShareStore, scanShare } from '../lib/app-share.mjs';
import { demoRouteAllowed } from '../lib/demo.mjs';
import { scanFiles } from '../lib/publish/scan.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const f = (p, t = '<p>x</p>') => ({ path: p, b64: Buffer.from(t).toString('base64') });

test('ids are 128 random bits, base64url, and only that shape routes', () => {
  const ids = new Set(Array.from({ length: 200 }, newShareId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, SHARE_ID_RE);
  const id = [...ids][0];
  assert.ok(demoRouteAllowed('GET', `/s/${id}`)); assert.ok(demoRouteAllowed('POST', `/api/share/${id}/join`));
  assert.ok(!demoRouteAllowed('GET', `/s/${id}x`)); assert.ok(!demoRouteAllowed('GET', '/s/../etc'));
});

test('limits come from config at use time, with defaults; a short secret is no secret', () => {
  assert.equal(shareLimit({}, 'per_day'), SHARE_DEFAULTS.per_day);
  assert.equal(shareLimit({ shares: { per_day: 4 } }, 'per_day'), 4);
  assert.equal(shareLimit({ shares: { demo_url: 'javascript:alert(1)' } }, 'demo_url'), SHARE_DEFAULTS.demo_url);
  assert.equal(ingestSecret({ share_ingest_secret: 'short' }), '');
  assert.equal(ingestSecret({ share_ingest_secret: 'k'.repeat(64) }), 'k'.repeat(64));
});

test('ingested files: code kinds only, no data/, no climbing, an index.html, under the size cap', () => {
  assert.equal(checkIngestFiles([f('index.html'), f('js/app.js')], {}).length, 2);
  for (const bad of [[f('data/x.js'), f('index.html')], [f('../index.html')], [f('index.html'), f('notes.json')], [f('app.js')], [f('/index.html')]]) {
    assert.throws(() => checkIngestFiles(bad, {}), /bad file|no index/);
  }
  assert.throws(() => checkIngestFiles([f('index.html', 'x'.repeat(3 * 1024 * 1024))], {}), (e) => e.status === 413);
});

test('signature: good passes once; bad, stale and replayed fail', () => {
  const s = 'k'.repeat(64), body = '{"a":1}', seen = new Map();
  const h = signIngest(s, body);
  assert.equal(verifyIngest(s, h, body, seen), true);
  assert.equal(verifyIngest(s, h, body, seen), false, 'replay');
  assert.equal(verifyIngest(s, signIngest(s, body), '{"a":2}', seen), false, 'body changed');
  assert.equal(verifyIngest('j'.repeat(64), signIngest(s, body), body, seen), false, 'other secret');
  assert.equal(verifyIngest(s, signIngest(s, body, Date.now() - 301_000), body, seen), false, 'stale');
  assert.equal(verifyIngest('', signIngest(s, body), body, seen), false, 'no secret');
});

test('store: re-share keeps the id, take-down hides it, join copies the snapshot only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-share-'));
  try {
    const st = makeShareStore(root), by = { kind: 'demo', uid: 'sb-0000000000000001' };
    const files = (t) => [{ path: 'index.html', content: Buffer.from(t) }];
    const a = st.put({ srcKey: 'u:app', slug: 'app', name: 'App', desc: '', by, files: files('v1') });
    const b = st.put({ srcKey: 'u:app', slug: 'app', name: 'App', desc: '', by, files: files('v2') });
    assert.equal(b.id, a.id); assert.equal(b.versions, 2);
    const apps = path.join(root, 'ws', 'apps');
    const j = st.join(a.id, 'sb-0000000000000002', apps, 20);
    assert.equal(fs.readFileSync(path.join(apps, j.slug, 'index.html'), 'utf8'), 'v2');
    assert.ok(st.takedown(a.id)); assert.equal(st.get(a.id), null);
    assert.throws(() => st.join(a.id, 'sb-0000000000000003', apps, 20), (e) => e.status === 404);
    assert.ok(fs.existsSync(path.join(apps, j.slug, 'index.html')), 'the copy stays');
    assert.throws(() => st.join(st.put({ srcKey: 'u:x', slug: 'x', name: 'X', desc: '', by, files: files('x') }).id, 'sb-0000000000000004', apps, 1), (e) => e.code === 'apps_full');
  } finally { rmTemp(root); }
});

test('the scan: demo (no terms) runs generic rules; Publish still fails closed without terms', () => {
  const files = [{ path: 'index.html', content: Buffer.from(`mail me: someone${'@'}realmail.com`) }];
  assert.ok(scanShare(files, { name: 'n', desc: '' }, []).length > 0);
  assert.throws(() => scanFiles(files, []), /Privacy terms missing/);
});
