// Email channel（邮件通道）UI + wiring contract — PLAN.md Phase B (v2.7.0).
//
// The shell's inline <script> is not importable (guard style of
// test/briefings-ui.test.mjs; SYNTAX is separately gated by
// test/app-scripts.test.mjs, which parses web/index.html): pure pieces
// (markNew, the _PA_NEW_KEYS registry) are extracted and RUN in a harness;
// wiring is asserted in the committed sources (web/index.html + web.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'); // throws if moved — never a vacuous pass (R14)
const html = readShell(ROOT);
const web = read('web.mjs');

// ── new-UI rule: registry keys + dots (harness-run, not just grepped) ────────
function newKeys() {
  const m = html.match(/window\._PA_NEW_KEYS=\{[\s\S]*?\};/);
  assert.ok(m, '_PA_NEW_KEYS registry must stay a literal object');
  return new Function('const window={};' + m[0] + ' return window._PA_NEW_KEYS;')();
}

function extractMarkNew() {
  const m = html.match(/function markNew\(el,key\)\{[^\n]*\}/);
  assert.ok(m, 'markNew must stay a one-line named function');
  return (seen, saved) => new Function('_SEEN', '_saveSeen', m[0] + '; return markNew;')(seen, saved);
}

const fakeEl = () => {
  const el = { classes: new Set(), handlers: {} };
  el.classList = { add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c) };
  el.addEventListener = (ev, fn) => { el.handlers[ev] = fn; };
  return el;
};

test('registry: the two v2.7.0 keys exist and no key regressed', () => {
  const keys = newKeys();
  assert.equal(keys['briefing-email'], 'v2.7.0');
  assert.equal(keys['agent-address'], 'v2.7.0');
  assert.equal(keys['health-setup'], 'v2.3.0', 'existing keys untouched');
});

test('dots: both new keys mark, clear on first tap, and stay cleared (persisted seen-set)', () => {
  const seen = new Set(); const saves = [];
  const markNew = extractMarkNew()(seen, () => saves.push(1));
  for (const key of ['briefing-email', 'agent-address']) {
    const el = fakeEl();
    markNew(el, key);
    assert.ok(el.classes.has('pa-new'), `${key}: dot appears`);
    el.handlers.pointerdown();
    assert.ok(!el.classes.has('pa-new'), `${key}: dot cleared on tap`);
    assert.ok(seen.has(key), `${key}: recorded as seen`);
    const again = fakeEl();
    markNew(again, key);
    assert.ok(!again.classes.has('pa-new'), `${key}: never re-marked once seen`);
  }
  assert.equal(saves.length, 2, 'each clear persisted');
});

test('shell: briefing-email input + agent-address section wired, marked, and honest on failure', () => {
  assert.match(html, /简报邮箱 · Briefing email/, 'bilingual label');
  assert.match(html, /id="pBriefEmail" type="email"/);
  assert.match(html, /briefingEmail:\$\('#pBriefEmail'\)\.value/, 'save body carries the field');
  assert.match(html, /\$\('#pBriefEmail'\)\.value=ME\.briefingEmail\|\|''/, 'prefill from the profile');
  // ROUND 3: the same property, now through the ONE failure mapper — a refusal is SHOWN
  // and the dialog stays open. The house sentence it replaces ('Save failed · 保存失败')
  // read identically for a 400, a 413 and a dropped connection; g.text names which.
  // (that the generic 'Save failed · 保存失败' is gone from the CODE is pinned in
  //  test/fail-legibility.test.mjs, which strips comments before scanning)
  assert.match(html, /if\(!g\.ok\)\{ alert\(g\.text\); return; \}/, 'a refused save (400/413/401) is SHOWN and the dialog stays open — never silently closed');
  assert.match(html, /Agent email · 管家邮箱/);
  assert.match(html, /api\('\/api\/agentmail\/address'\)/, 'address fetched lazily via the API');
  assert.match(html, /ME\.role==='owner'\?'block':'none'/, 'owner-only visibility');
  assert.match(html, /无法加载管家邮箱/, 'honest bilingual failure line — never a fake address');
  assert.match(html, /clipboard\.writeText\(s\.address\)/, 'copy affordance');
  assert.match(html, /markNewSel\('#pBriefWrap','briefing-email'\)/);
  assert.match(html, /markNewSel\('#agentMailWrap>summary','agent-address'\)/);
});

// ── web.mjs wiring: profile whitelist + delivery + owner endpoint ────────────
test('web.mjs: PUT whitelist validates briefingEmail via emailOk, blank clears, junk 400s bilingually', () => {
  assert.match(web, /typeof b\.briefingEmail === 'string'/);
  assert.match(web, /if \(!v\) delete prof\.briefingEmail;/, 'blank disables email delivery');
  assert.match(web, /else if \(emailOk\(v\)\) prof\.briefingEmail = v;/, 'ONE email gate (R3: lib/users.mjs emailOk)');
  assert.match(web, /400, 'application\/json', JSON\.stringify\(\{ error: 'Invalid email address · 邮箱格式无效' \}\)/);
  assert.match(web, /briefingEmail: typeof prof\.briefingEmail === 'string' \? prof\.briefingEmail : ''/, 'GET returns it for prefill');
});

test('web.mjs: pushBriefing delivers by email, audit-guarded, never rejecting', () => {
  const fn = web.slice(web.indexOf('const pushBriefing'), web.indexOf('async function settleAndAnnotate'));
  assert.match(fn, /notifyBriefingEmail\(\{ mail: MAIL, email: prof && prof\.briefingEmail/);
  assert.equal((fn.match(/\.catch\(\(e\) => audit\(/g) || []).length, 1, 'the send has its unhandled-rejection guard (R5)');
});

test('web.mjs: /api/agentmail/address is owner-only and honest — ok:false + bilingual error, never a fake address', () => {
  const ep = web.slice(web.indexOf("p === '/api/agentmail/address'"));
  assert.match(ep.slice(0, 400), /user\.role !== 'owner'/, 'owner-gated');
  assert.match(ep.slice(0, 700), /未配置邮件通道/, 'unconfigured is reported, not faked');
  assert.match(ep.slice(0, 1400), /agentmail-inbox-error/, 'inbox failure audited (R5)');
  assert.match(ep.slice(0, 1400), /无法获取管家邮箱/, 'failure surfaced bilingually to the owner');
});
