// The approval loop's in-app deciding surface（待批准）— shell broker relay +
// the longevity template's pending-approvals + reminders sections. Same guard
// style as test/briefings-ui.test.mjs (inline-script HTML is not importable;
// contracts are asserted in the committed sources, syntax gated by
// app-scripts.test.mjs). PLUS functional harnesses: the shell's decide/remove
// relays and the template's card builders are PURE functions extracted and
// executed here without a DOM — the trusted-chrome gate is proven by running
// the relay with a refusing/approving confirm stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'); // throws if missing — a moved file must fail here, not pass vacuously (R14)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Extract a top-level `function name(...){...}` (closing brace at column 0)
// from an HTML file's inline script and instantiate it with injected deps.
function extractFn(src, name, deps = {}) {
  const m = src.match(new RegExp(`(async )?function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must stay a named top-level function — the harness runs it without a DOM`);
  const keys = Object.keys(deps);
  return new Function(...keys, `${m[0]}; return ${name};`)(...keys.map((k) => deps[k]));
}

test('shell broker relays kind "actions" → GET /api/actions', () => {
  const html = readShell(ROOT);
  assert.match(html, /m\.kind==='actions'/);
  // Through the shared failure mapper, not a bare api() call: a 401/500/network drop must
  // reach the app as its own code, never as an empty list (test/broker-relay.test.mjs).
  assert.match(html, /relayCall\('\/api\/actions'/);
});

test('trusted chrome: relayActionDecide refuses without the SHELL confirm — an app postMessage alone never reaches the server', async () => {
  const relay = extractFn(readShell(ROOT), 'relayActionDecide');
  let decided = 0;
  const deps = (confirmAnswer) => ({
    listPending: async () => [{ id: 'a1', title: 'Daily walk reminder · 每日散步提醒' }],
    confirm: async () => confirmAnswer,
    decide: async (id, verb) => { decided++; return { ok: true, action: { id, status: verb === 'approve' ? 'done' : 'denied' } }; },
  });
  // A synthetic app message with NO human tap in shell chrome: refused, decide never called.
  const refused = await relay({ actionId: 'a1', verb: 'approve' }, deps(false));
  assert.equal(refused.ok, false);
  assert.match(refused.error, /已在外壳取消/);
  assert.equal(decided, 0, 'the server POST is unreachable without the shell tap');
  // The human taps the shell dialog: the decision proceeds. Deny confirms too (one mechanism).
  const okd = await relay({ actionId: 'a1', verb: 'deny' }, deps(true));
  assert.equal(okd.ok, true);
  assert.equal(decided, 1);
  // Bad params never even reach the confirm.
  assert.equal((await relay({ actionId: 'a1', verb: 'execute' }, deps(true))).ok, false, 'verb whitelist');
  assert.equal((await relay({ actionId: 42, verb: 'approve' }, deps(true))).ok, false, 'non-string id rejected');
});

test('trusted chrome: the confirm label comes from the SERVER queue, never from the app message', async () => {
  const relay = extractFn(readShell(ROOT), 'relayActionDecide');
  const titles = [];
  await relay({ actionId: 'a1', verb: 'approve', title: 'Harmless thing · 无害操作' }, {
    listPending: async () => [{ id: 'a1', title: 'Send email · 发送邮件' }],
    confirm: async (verb, title) => { titles.push(title); return false; },
    decide: async () => ({ ok: true }),
  });
  assert.deepEqual(titles, ['Send email · 发送邮件'], 'an app cannot caption its own confirm dialog');
});

test('trusted chrome: relayReminderRemove goes through the same confirm gate', async () => {
  const relay = extractFn(readShell(ROOT), 'relayReminderRemove');
  let removed = 0;
  const deps = (answer) => ({
    list: async () => [{ id: 'walk', text: 'Walk 散步' }],
    confirm: async () => answer,
    remove: async () => { removed++; return { ok: true }; },
  });
  assert.equal((await relay({ reminderId: 'walk' }, deps(false))).ok, false);
  assert.equal(removed, 0);
  assert.equal((await relay({ reminderId: 'walk' }, deps(true))).ok, true);
  assert.equal(removed, 1);
});

test('shell: the confirm dialog is SHELL-owned chrome and the broker wires both gated kinds through it', () => {
  const html = readShell(ROOT);
  assert.match(html, /<dialog id="actConfirm"/, 'the dialog lives in the shell document, outside every app sandbox');
  assert.match(html, /m\.kind==='action-decide'/);
  assert.match(html, /relayActionDecide\(m,\{/);
  assert.match(html, /m\.kind==='reminder-remove'/);
  assert.match(html, /relayReminderRemove\(m,\{/);
  assert.match(html, /m\.kind==='reminders'/);
  assert.match(html, /confirm:shellConfirm/);
});

test('longevity template: approvals + reminders sections wired to the broker kinds, bilingual, no emojis', () => {
  const html = read('workspace.example/apps/longevity/index.html');
  assert.match(html, /待批准 · Pending Approvals/, 'section present');
  assert.match(html, /kind:'actions'/, 'queue loaded via the shell broker');
  assert.match(html, /kind:'action-decide',actionId:/, 'decision via the broker (actionId, never a clobbering `id`)');
  assert.match(html, /Approve · 批准/);
  assert.match(html, /Deny · 拒绝/);
  assert.match(html, /已批准并执行/, 'outcome labels bilingual');
  assert.match(html, /执行失败/, 'executor failure surfaced in the section (honest, R14)');
  assert.match(html, /审批队列加载失败/, 'R5: a failed queue load is shown, never identical to an empty queue');
  assert.match(html, /提醒 · Reminders/, 'revocation section present');
  assert.match(html, /kind:'reminder-remove',reminderId:/, 'remove via the gated broker kind');
  assert.match(html, /Remove · 移除/);
  assert.match(html, /提醒加载失败/, 'R5 failure state for the reminders list too');
});

// Functional harness: run the template's own card builders on real data.
test('harness: the template renders a pending proposal card with working Approve/Deny controls', () => {
  const render = extractFn(read('workspace.example/apps/longevity/index.html'), 'renderActionsHtml', { esc });
  const html = render([{ id: 'health-brief-1000-a0', title: 'Daily walk reminder · 每日散步提醒',
    summary: 'why: steps 7d avg 4000 < 5000 threshold' }]);
  assert.match(html, /data-aid="health-brief-1000-a0"/, 'card carries the action id the click handler decides on');
  assert.match(html, /Daily walk reminder · 每日散步提醒/);
  assert.match(html, /why: steps 7d avg 4000 &lt; 5000 threshold/, 'why sentence shown, HTML-escaped');
  assert.match(html, /<button class="act-btn" data-verb="approve">Approve · 批准<\/button>/);
  assert.match(html, /<button class="act-btn" data-verb="deny">Deny · 拒绝<\/button>/);
  const hostile = render([{ id: 'x', title: '<img src=x onerror=alert(1)>', summary: '' }]);
  assert.ok(!hostile.includes('<img'), 'titles are escaped — no HTML injection into the card');
});

test('harness: the template renders each reminder with its Remove control', () => {
  const src = read('workspace.example/apps/longevity/index.html');
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const render = extractFn(src, 'renderRemindersHtml', { esc, DAY_NAMES });
  const html = render([{ id: 'walk', text: 'Walk 20 minutes · 散步20分钟', time: '18:00' },
    { id: 'chk', text: 'Check Shortcut · 检查快捷指令', time: '09:00', day: 6 }]);
  assert.match(html, /data-rid="walk"/);
  assert.match(html, /18:00 · daily · 每日/);
  assert.match(html, /09:00 · weekly Sat · 每周/);
  assert.equal((html.match(/data-rem-remove/g) || []).length, 2, 'every reminder carries its off switch');
  const hostile = render([{ id: 'x', text: '<script>alert(1)</script>', time: '08:00' }]);
  assert.ok(!hostile.includes('<script>'), 'text escaped');
});

test('live-instance parity: the workspace copy carries the same approvals + reminders sections', () => {
  // The owner's live instance is gitignored personal data; when present it must
  // carry the identical sections so template and instance don't drift.
  const live = path.join(ROOT, 'workspace', 'apps', 'longevity', 'index.html');
  if (!fs.existsSync(live)) return; // fresh checkout: no instance — template-only is correct
  const html = fs.readFileSync(live, 'utf8');
  for (const marker of ["kind:'actions'", "kind:'action-decide',actionId:", '待批准 · Pending Approvals', 'function renderActionsHtml',
    '提醒 · Reminders', "kind:'reminder-remove',reminderId:", 'function renderRemindersHtml', '审批队列加载失败']) {
    assert.ok(html.includes(marker), `live longevity app missing: ${marker}`);
  }
});
