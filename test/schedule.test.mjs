import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_MS, dueJobs, localDateStr } from '../lib/schedule.mjs';

// The time logic, on dueJobs — the one due-checker since the bot's config `schedules` (and
// dueSchedules) went with the Telegram bot (docs/adr/0006).
const S = [{ name: 'brief', time: '07:30' }];
const at = (h, m) => new Date(2026, 7, 24, h, m); // Aug 24 2026, local (a Monday)

test('not due before its time', () => {
  assert.equal(dueJobs(S, {}, at(7, 0)).length, 0);
});

test('due at and after its time', () => {
  assert.equal(dueJobs(S, {}, at(7, 30)).length, 1);
  assert.equal(dueJobs(S, {}, at(22, 0)).length, 1);
});

test('never fires twice on the same day', () => {
  const ran = { brief: localDateStr(at(8, 0)) };
  assert.equal(dueJobs(S, ran, at(9, 0)).length, 0);
});

test('fires again the next day', () => {
  const ran = { brief: '2026-08-23' };
  assert.equal(dueJobs(S, ran, at(8, 0)).length, 1);
});

test('invalid entries are ignored — including hours past 23 and minutes past 59', () => {
  const bad = [{ name: 'a', time: 'noon' }, { name: 'b' }, { time: '08:00' }, { name: 'c', time: '25:00' },
    { name: 'x', time: '07:75' }, { name: 'y', time: '24:00' }];
  assert.equal(dueJobs(bad, {}, at(23, 59)).length, 0);
  assert.equal(dueJobs([{ name: 'ok', time: '23:59' }], {}, at(23, 59)).length, 1, 'CONTROL: the edge itself is valid');
});

// ── dueJobs: the job-engine variant (daily by default, weekly via `day`) ──────
const J = [{ name: 'daily-brief', time: '08:00' }, { name: 'health-brief', time: '20:00', day: 0 }];

test('dueJobs: daily job fires at/after its time, once per day', () => {
  assert.deepEqual(dueJobs(J, {}, at(7, 59)).map((j) => j.name), []);
  assert.deepEqual(dueJobs(J, {}, at(9, 0)).map((j) => j.name), ['daily-brief']);
  const ran = { 'daily-brief': localDateStr(at(9, 0)) };
  assert.deepEqual(dueJobs(J, ran, at(10, 0)).map((j) => j.name), []);
});

test('dueJobs: weekly job fires only on its weekday', () => {
  assert.deepEqual(dueJobs(J, {}, at(21, 0)).map((j) => j.name), ['daily-brief'], 'Monday: no weekly');
  const sunday = new Date(2026, 7, 23, 21, 0);   // Aug 23 2026 is a Sunday
  assert.deepEqual(dueJobs(J, {}, sunday).map((j) => j.name).sort(), ['daily-brief', 'health-brief']);
  assert.deepEqual(dueJobs(J, {}, new Date(2026, 7, 23, 19, 59)).map((j) => j.name), ['daily-brief'], 'Sunday before 20:00');
});

test('DAY_MS: the ONE named day constant (R3) — no bare 86400000 in server code outside lib/schedule.mjs', () => {
  assert.equal(DAY_MS, 86400000);
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Every server module, not a hand-kept list: the list named three files that were deleted with
  // the daily brief (2026-10-11), and a list can only shrink that way. Scanning lib/ recursively
  // covers every current and future module.
  const libFiles = fs.readdirSync(path.join(ROOT, 'lib'), { recursive: true })
    .filter((f) => f.endsWith('.mjs') && f !== 'schedule.mjs').map((f) => path.join('lib', f));
  assert.ok(libFiles.includes(path.join('lib', 'actions.mjs')) && libFiles.includes(path.join('lib', 'health-analyze.mjs')),
    'the scan reaches the modules the old list named');
  for (const f of [...libFiles, 'web.mjs'])
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /86400000/, `${f} must import DAY_MS`);
});

// Moved from test/daily-brief.test.mjs when the daily brief was removed (2026-10-11). Its bot.mjs
// and dueSchedules halves went with the Telegram bot (2026-10-12, docs/adr/0006).
test('morning-brief fully retired: nothing ships it', () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const example = fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8');
  assert.match(example, /"claude_args"/, 'CONTROL: the example config was read');
  assert.doesNotMatch(example, /morning-brief|"schedules"/, 'the legacy 07:30 LLM schedule no longer ships to new installs (R1)');
});
