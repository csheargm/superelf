// Rotating a token（重新生成令牌）. Until this existed a leaked token could not be revoked at
// all: it is long-lived, it is printed in the health-setup panel and encoded in its QR, and it
// is a full bearer credential for the account.
//
// The assertion that matters is not that a new token works — it is that the OLD one STOPS. A
// rotation that leaves the previous credential alive is worse than none, because it looks like
// it worked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, OWNER_TOKEN } from './helpers-web.mjs';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let port, root, web;
before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); });
after(async () => { if (web) await stopWeb(web); });

const call = (p, token, opt = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { ...opt, headers: { authorization: `Bearer ${token}`, ...(opt.headers || {}) } });

test('the OLD token stops working the moment a new one is issued', async () => {
  assert.equal((await call('/api/profile', OWNER_TOKEN)).status, 200, 'precondition: the old token works');

  const r = await (await call('/api/profile/token/rotate', OWNER_TOKEN, { method: 'POST' })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(typeof r.token === 'string' && r.token.length >= 24, 'a real token comes back');
  assert.notEqual(r.token, OWNER_TOKEN, 'and it is actually different');
  assert.equal(r.revoked, true);

  // THE point of the feature.
  assert.equal((await call('/api/profile', OWNER_TOKEN)).status, 401, 'the leaked token must be DEAD');
  assert.equal((await call('/api/profile', r.token)).status, 200, 'and the new one works immediately — no restart');

  // …including on the route whose credential this is.
  assert.equal((await call('/api/health/ingest', OWNER_TOKEN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401,
    'a health Shortcut holding the old token must stop, not silently keep uploading');

  // Rotating again from the NEW token works, and kills that one in turn.
  const again = await (await call('/api/profile/token/rotate', r.token, { method: 'POST' })).json();
  assert.equal(again.ok, true);
  assert.equal((await call('/api/profile', r.token)).status, 401, 'each rotation revokes the previous one');
  assert.equal((await call('/api/profile', again.token)).status, 200);
});

test('an unauthenticated caller cannot rotate anyone\'s token', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/profile/token/rotate`, { method: 'POST' });
  assert.equal(r.status, 401, 'no token, no rotation — otherwise it is a denial-of-service on every account');
  assert.equal((await call('/api/profile/token/rotate', 'not-a-real-token', { method: 'POST' })).status, 401);
});

test('the new token is persisted, not just held in memory', () => {
  // A rotation that survives only until restart would leave the user locked out on the next
  // boot with the leaked token silently valid again.
  // writeUsers persists into config.json (lib/users.mjs), not a separate users.json.
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const owner = cfg.users.find((u) => u.id === 'owner');
  assert.ok(owner, 'the owner is on disk');
  assert.notEqual(owner.token, OWNER_TOKEN, 'and carries the rotated token, not the original');
  assert.ok(owner.token && owner.token.length >= 24, 'a real credential, not a blank');
});

test('the token VALUE is never written to the audit log', () => {
  // The audit log is owner-readable; a credential in it defeats the rotation.
  const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  const i = WEB.indexOf("p === '/api/profile/token/rotate'");
  const block = WEB.slice(i, WEB.indexOf('\n      }', i));
  assert.match(block, /audit\('token-rotate', \{ who: user\.id \}\)/, 'audit records WHO, and nothing else');
  assert.ok(!/audit\([^)]*token[^)]*:\s*(fresh|old|user\.token)/.test(block), 'never the value');
});

test('the UI warns before revoking, and clears the QR after', () => {
  const SHELL = readShell(ROOT);
  assert.match(SHELL, /id="hsRotate"/, 'there is a button');
  // Not just that the sentence EXISTS — that it GATES the request. A confirm whose answer is
  // ignored is decoration, and the first version of this test could not tell the difference.
  assert.match(SHELL, /if\(!await askConfirm\('Regenerate your token\?[^)]*\)\) return;/,
    'the confirm must be able to CANCEL the rotation, not merely be displayed');
  assert.match(SHELL, /stops working immediately/, 'saying plainly what it breaks');
  // …and the request must come after the gate, not before it.
  const h = SHELL.slice(SHELL.indexOf("$('#hsRotate').onclick"));
  assert.ok(h.indexOf('askConfirm') < h.indexOf('/api/profile/token/rotate'),
    'the confirmation must precede the call');
  // The panel still shows the dead token until it is re-rendered.
  assert.match(SHELL, /healthSetupLoaded=false;[\s\S]{0,120}healthSetupTxt'\)\.textContent=''/,
    'the stale token is cleared, not left on screen');
  assert.ok(!SHELL.includes('healthQr'), 'and there is no QR canvas to leave a revoked credential in');
  assert.match(SHELL, /\$\('#healthWrap'\)\.open=false; \$\('#healthWrap'\)\.open=true;/,
    'and the loader is re-triggered — it only runs on a closed→open transition');
});

test('the setup panel no longer implies that scanning sets it up', () => {
  // The old wording ("Scan from your iPhone to set up the health-upload Shortcut") led
  // straight to opening the URL in a browser and getting a correct-but-baffling "bad token".
  const SHELL = readShell(ROOT);
  assert.ok(!SHELL.includes('Scan from your iPhone to set up the health-upload Shortcut'), 'the misleading line is gone');
  assert.match(SHELL, /Open this page ON YOUR IPHONE and copy/, 'it says what to actually do');
  assert.ok(!SHELL.includes('healthQr'), 'and there is no QR to scan into that dead end');
});
