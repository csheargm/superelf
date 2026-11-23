// The off switch on a job row · 任务行上的开关
//
// Reported: "daily briefing is really not working out... how to turn it off?" — and there was no
// answer. Every job row offered Run now, and file jobs additionally offered Edit; enable/disable
// and Delete lived INSIDE that editor, so a built-in (no Edit button) had no off switch anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);

test('every job row carries the switch, not just the editable ones', () => {
  // The whole point. `editable` gates Edit — gating the switch the same way would rebuild the
  // exact dead end this closes, because a built-in is never editable.
  const row = /data-togglejob="\$\{esc\(r\.name\)\}"/.exec(SHELL);
  assert.ok(row, 'the toggle is rendered per job');
  const gate = /\$\{r\.kind==='job'\?`<button[^`]*data-togglejob=/.exec(SHELL);
  assert.ok(gate, 'gated on being a job at all — NOT on r.editable');
  assert.ok(!/r\.editable[^`]*data-togglejob/.test(SHELL), 'a built-in must still get one');
});

test('it reads as a switch: it says what it will DO, and carries the state it acts on', () => {
  // A control labelled with the current state instead of the next action is the classic
  // ambiguity — "Off" next to a job that is already off is unreadable.
  assert.match(SHELL, /data-on="\$\{r\.paused\?'1':'0'\}"/, 'the row hands the handler the state');
  assert.match(SHELL, /\$\{r\.paused\?'开启 · On':'关闭 · Off'\}/, 'and the label is the action, not the state');
});

test('the switch sends the one field the server accepts for a built-in', () => {
  const fn = /const tb=e\.target\.closest\('\[data-togglejob\]'\);[\s\S]*?\n  \}/.exec(SHELL);
  assert.ok(fn, 'the handler must be findable');
  assert.match(fn[0], /method:'PATCH'/, 'a patch, not a delete — a built-in has no file to remove');
  assert.match(fn[0], /JSON\.stringify\(\{enabled:on\}\)/, 'and exactly the one field it may change');
  assert.match(fn[0], /const on=tb\.dataset\.on==='1';/, 'the target state is the opposite of the current one');
  assert.match(fn[0], /loadJobs\(\)/, 'the list is re-read, so the row cannot disagree with the server');
});

test('a refusal shows the SERVER\'s sentence', () => {
  // "built-in" and "unknown job" are different problems with different answers; a house string
  // would flatten them and leave the user guessing (R5).
  const fn = /const tb=e\.target\.closest\('\[data-togglejob\]'\);[\s\S]*?\n  \}/.exec(SHELL);
  assert.match(fn[0], /\(await r\.json\(\)\)\.error/, 'the reason is read off the response');
  assert.match(fn[0], /alert\(m\|\|'无法更改该任务 · Could not change that job'\)/, 'with a fallback only when there is none');
  assert.match(fn[0], /tb\.disabled=true;/, 'and the button cannot be double-fired while in flight');
});

test('the buttons wrap instead of crushing the job title', () => {
  // Reported with a screenshot: "Daily Tech News" rendered one character per line. Every button
  // is flex-shrink:0, so on a narrow panel three of them took the full row and left the text
  // column about 20px wide. Adding the switch made a two-button row a three-button row and tipped
  // it over — the row has to survive the NEXT button too.
  assert.match(SHELL, /display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 0/,
    'the job row wraps');
  assert.match(SHELL, /<div style="flex:1 1 200px;min-width:0">/,
    'and the label keeps a floor wide enough to read, which is what forces the wrap');
  assert.ok(!/<div style="flex:1;min-width:0"><div style="overflow-wrap:anywhere">/.test(SHELL),
    'the unbounded flex:1 that let it collapse is gone');
});
