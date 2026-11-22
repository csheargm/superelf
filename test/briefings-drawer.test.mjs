// 简报 · Briefings in the shell drawer.
//
// A job's output was readable only inside the LONGEVITY app — an accident of history:
// briefings began as a health feature and the reading surface never moved when they became
// general. So the answer to "I ran a job, where is the result?" was "open an app about
// longevity", which nobody would guess. Jobs are system-level; their output belongs beside
// My Apps, not inside one app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');

test('it is a PEER of My Apps, not nested inside anything', () => {
  const order = [...SHELL.matchAll(/<div class="dsec[^"]*" id="(sec[A-Za-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['secApps', 'secFamily', 'secBriefs', 'secChats'],
    'briefings sit at drawer level, between the app sections and chats');
  assert.match(SHELL, /<div class="dsec-head">简报 · Briefings<\/div>/, 'bilingual heading, like its neighbours');
});

test('it refreshes when the drawer opens — a stale feed is a wrong answer', () => {
  assert.match(SHELL, /function openDrawer\(\)\{[^}]*loadConvos\(\); loadBriefs\(\);/,
    'the same rule openDrawer already applies to conversations');
});

test('empty and FAILED are different states — a blank box must never mean "we could not look"', () => {
  // The worst failure mode in this codebase: a section that renders nothing and reads as
  // "nothing happened". loadApps had exactly this bug.
  assert.match(SHELL, /No briefings yet · 暂无简报/, 'an empty feed says so');
  assert.match(SHELL, /Could not load briefings · 无法加载简报/, 'a failure says something DIFFERENT');
  assert.match(SHELL, /color:var\(--danger\)[^`]*Could not load briefings/, 'and is coloured as an error');
  // Three-state: only an Array is data. `r.ok` alone is not enough — a 401 answers 200-shaped
  // JSON on some routes, and `{error:…}` is not a list.
  assert.match(SHELL, /if\(!Array\.isArray\(list\)\)\{[\s\S]{0,120}Could not load briefings/,
    'anything that is not an array is a FAILURE, not an empty feed');
});

test('the row list is bounded, and shows enough to identify a briefing', () => {
  assert.match(SHELL, /const BRIEFS_MAX=\d+/, 'the cap is a named constant');
  assert.match(SHELL, /list\.slice\(0,BRIEFS_MAX\)/, 'and it is applied');
  for (const bit of ['briefWhen(b.created)', 'b.title||b.job', 'b.preview||']) {
    assert.ok(SHELL.includes(bit), `a row must carry ${bit} — a time and a title alone cannot be told apart`);
  }
});

test('unseen briefings use the EXISTING blue dot, not a second mechanism', () => {
  assert.match(SHELL, /markNew\(el,'briefing:'\+el\.dataset\.brief\)/,
    'markNew + _SEEN already persists per device and clears on first tap');
  assert.ok(!/class="brief-new"|briefSeen/.test(SHELL), 'no parallel dot system');
});

test('opening one fetches the BODY — the list only carries previews', () => {
  // listBriefings returns {id,title,job,created,preview}. Rendering `preview` as the whole
  // briefing would silently truncate it at ~140 chars.
  assert.match(SHELL, /api\('\/api\/briefings\/'\+encodeURIComponent\(id\)\)/, 'the full record is fetched on open');
  assert.match(SHELL, /renderMd\(b\.body\)/, 'and rendered as markdown, like any other reply');
  assert.match(SHELL, /Could not open that briefing · 无法打开该简报/, 'a failed open says so rather than showing a blank page');
});

// ── Manual runs are delivered, not deferred ───────────────────────────────────────────────
test('a manual run PUSHES, whatever deliver says', () => {
  // Pressing Run now is deliberate: the result is emailed whatever the job's `deliver` says.
  const i = WEB.indexOf("/^\\/api\\/jobs\\/[\\w-]+\\/run$/");
  const block = WEB.slice(i, i + 3000);
  assert.match(block, /if \(out\.briefing\) \{\s*\n\s*pushBriefing\(user, out\.briefing\);/,
    'every manual run pushes, with no deliver check gating it');
  assert.ok(!/out\.briefing\.deliver !== FOLD_DELIVER\) pushBriefing/.test(WEB),
    'the old "do not push a folded briefing" gate must be gone');
});
