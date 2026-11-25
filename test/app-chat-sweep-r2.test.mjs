// App chat self-test round 2 · 应用对话自测第二轮 (2026-11-24), real-model sweep on a throwaway node:
// R2-1 the member plain-lane status was drawn in the reply bubble and then overwritten by the answer;
// R2-2 a member's panel auto-attached a screenshot and showed the camera, but the member lane cannot see pictures
//      ("我看不到你附的截图");
// R2-3 after Undo the member model doubted the page ("我不能确认那两次修改现在生效了");
// R2-4 a Chinese plan's Apply sentence came back in English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScopedEdit, UNDONE_RULE } from '../lib/app-edit-lane.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

test('R2-1: a kept status is its own log line, not the reply bubble', () => {
  const ui = src('web/chat-ui.inline.html');
  assert.match(ui, /ev\.type==='status'&&ev\.keep\)\{ if\(!thinking\.isConnected\) return; const d=addMsg\('status',ev\.text\); thinking\.parentNode\.insertBefore\(d,thinking\)/);
  assert.match(src('web.mjs'), /line\(\{ type: 'status', text: laneStatus, keep: true \}\)/);
});

test('R2-2: only the owner\'s panel gets the auto-shot, the camera and its tip', () => {
  const js = src('web/app-edit.js');
  assert.match(js, /const sees=ROLE==='owner';/);
  assert.match(js, /shot=sees\?await upload\(/);
  assert.match(js, /camTip=sees&&onceTip\(CAM_TIP_KEY\)/);
  assert.match(js, /snap:sees,/);
  assert.match(src('web/app-edit-panel.html'), /else if\(m\.snap\) setTimeout\(\(\)=>note\(NO_SHOT,'noShot'\),0\)/, 'no "could not capture" note when no shot was wanted');
});

function tmpApp() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-')); const dir = path.join(ws, 'apps', 'todo');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><h2>T</h2>');
  return { ws, dir };
}

test('R2-3: the member plan prompt says the PAGE is now and an earlier change may have been undone', async () => {
  const { ws, dir } = tmpApp(); let seen;
  try {
    await runScopedEdit({ edit: { slug: 'todo', dir, confirmed: false }, wsDir: ws, message: '现在是什么颜色？', prior: [], ask: async (m) => { seen = m; return 'ok'; } });
    assert.ok(seen[0].content.includes(UNDONE_RULE));
    assert.match(UNDONE_RULE, /撤销 · Undo/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('R2-4: the Apply prompt asks for the sentence in the plan\'s language', async () => {
  const { ws, dir } = tmpApp(); let seen;
  try {
    await runScopedEdit({ edit: { slug: 'todo', dir, confirmed: true, plan: '把小标题改成绿色' }, wsDir: ws, message: '改', prior: [], contract: '', ask: async (m) => { seen = seen || m; return "no blocks"; } }).catch(() => {});
    assert.match(seen[1].content, /in the language of the line that starts with The change:/);
    assert.match(seen[1].content, /The change: 把小标题改成绿色/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('R2-5: every edit prompt says the shared theme variables cannot restyle an app', async () => {
  const { CONCRETE_VALUE_RULE } = await import('../lib/app-edit-confirm.mjs');
  const theme = src('web/theme-tokens.css');
  for (const v of ['--bg', '--card', '--text', '--muted', '--line', '--accent', '--danger']) {
    assert.ok(theme.includes(v + ':'), `${v} is still a shared theme token`);
    assert.ok(CONCRETE_VALUE_RULE.includes(v), `the rule names ${v}`);
  }
  assert.match(CONCRETE_VALUE_RULE, /set the property itself on the element/);
});
