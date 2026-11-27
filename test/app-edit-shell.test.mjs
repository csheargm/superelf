// 改这个应用 · Change this app, the shell wiring pinned by source (ADR 0040). The flows run in
// test/app-edit-e2e.test.mjs; these hold the invariants a refactor could silently drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { readShell } from '../lib/shellhtml.mjs';

const SHELL = readShell(ROOT);
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');

test('the menu order the owner approved: 改这个应用 first, then 发布 · Publish', () => {
  const m = SHELL.match(/m\.innerHTML=\(ROLE==='owner'\?PAAppEdit\.item\(\):''\)[\s\S]{0,400}?PAPublish\.item\(name\)/);
  assert.ok(m, 'drawer ⋯: Change this app before Publish');
  assert.match(SHELL, /m\.innerHTML=item\(\)\+PAShare\.item\(\)\+\(window\.PADemoAuth\?'':PAPublish\.item\(slug\)\);/, "the open app's ⋯: Change, 分享 · Share, then Publish (no Publish on the demo)");
  assert.match(SHELL, /m\.querySelector\('#aeItem'\)\.after\(u\)/, 'Undo last change joins right after Change this app');
});

test('the panel is the only window whose chat skips the app-origin header, and it has the chat kinds only', () => {
  assert.match(SHELL, /fr\.edit===true\?editTurnInit\(body,ac\.signal\):appAgentInit\(body,ac\.signal\)/);
  assert.match(SHELL, /function frameRec\(win\)\{ return S&&win&&S\.fr\.contentWindow===win\?S\.rec:null; \}/);
  assert.match(SHELL, /if\(fr\.edit&&!PAAppEdit\.kindOk\(m\.kind\)\) return reply\(/);
  for (const k of ['data', 'save-data', 'open-url', 'notify', 'print']) assert.doesNotMatch(SHELL.match(/const KINDS=new Set\(\[[^\]]*\]\)/)[0], new RegExp(`'${k}'`), k);
});

test('PASnap rides on every served app page, after PABusy', () => {
  assert.match(WEB, /PA_BROKER_MARKER \+ PA_BUSY_MARKER \+ PA_SNAP_MARKER \+ m\)/);
  assert.match(WEB, /\{ marker: PA_SNAP_MARKER, file: 'snap\.inline\.html' \},\n(?:  \/\/[^\n]*\n  \{ marker: '[^']+', file: '[^']+' \},\n)*\];/, 'registered in order; only later components follow it (the append-only rule)');
});

test('the edit tag the shell lists by is the one the server writes (R3)', async () => {
  const { EDIT_TAG_PREFIX } = await import('../lib/agent-origin.mjs');
  assert.ok(SHELL.includes(`'${EDIT_TAG_PREFIX}'+appSlug`));
});
