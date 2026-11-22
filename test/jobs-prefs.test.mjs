// Turning a BUILT-IN job off · 关闭内置任务
//
// 每日一报 arrived every morning and there was no supported way to stop it: the settings row
// shows an Edit button only for file jobs, and PATCH/DELETE answered 403 for a built-in. The
// user's own words: "daily briefing is really not working out... how to turn it off?" — and the
// honest answer was that they could not.
//
// The gate that actually decides whether a job fires is entriesOf() in lib/jobruns.mjs, so these
// tests run the override THROUGH it. A row that merely says "paused" while the scheduler still
// fires at 07:30 would be the worst possible outcome — the user believes it is off and the mail
// keeps coming.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJobPrefs, setJobEnabled, applyJobPrefs, heldOff, prefsFile, PAUSED_BY_USER } from '../lib/jobs/prefs.mjs';
import { entriesOf } from '../lib/jobruns.mjs';
import { rmTemp } from './helpers-tmp.mjs';

// Two built-ins in the shape web.mjs declares them (no `enabled` key — that absence is the whole
// reason they could never be paused). 'daily-brief' was a real built-in until it was removed on
// 2026-10-11; it stays here as a fixture because these tests need a SECOND built-in to show an
// override is per job.
const BUILTINS = () => ({
  'daily-brief': { name: 'daily-brief', title: '每日一报 · Daily Brief', schedule: { time: '07:30' } },
  'health-brief': { name: 'health-brief', title: '健康简报 · Weekly Health Brief', schedule: { day: 0, time: '20:00' } },
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-jobprefs-'));
const scheduled = (map) => entriesOf(map).map((e) => e.name).sort();

test('CONTROL: with no override every built-in is scheduled — the gate is not simply always-off', () => {
  // Without this the "it is skipped" assertions below would pass against a filter that drops
  // everything, and the feature would look done while the briefing quietly never ran again.
  const d = tmp();
  try { assert.deepEqual(scheduled(applyJobPrefs(BUILTINS(), readJobPrefs(d))), ['daily-brief', 'health-brief']); }
  finally { rmTemp(d); }
});

test('a job switched off is skipped by the scheduler itself, not merely labelled', () => {
  const d = tmp();
  try {
    setJobEnabled(d, 'daily-brief', false);
    const map = applyJobPrefs(BUILTINS(), readJobPrefs(d));
    assert.deepEqual(scheduled(map), ['health-brief'], '每日一报 has no turn');
    assert.equal(map['daily-brief'].enabled, false);
    assert.equal(map['daily-brief'].pausedReason, PAUSED_BY_USER, 'and it reads as a choice, never as a fault');
    // Switching it back on restores it AND leaves no leftover key — the file stays a list of
    // deliberate exceptions rather than a second copy of the defaults.
    setJobEnabled(d, 'daily-brief', true);
    assert.deepEqual(readJobPrefs(d), {});
    assert.deepEqual(scheduled(applyJobPrefs(BUILTINS(), readJobPrefs(d))), ['daily-brief', 'health-brief']);
  } finally { rmTemp(d); }
});

test('applyJobPrefs never mutates the built-ins it is given', () => {
  // THE bug this shape exists to prevent: the JOBS literal is module-level and shared by every
  // user in the household, so writing `enabled` onto it would turn one person's briefing off for
  // everybody — and would survive until restart, with nothing on disk to explain it.
  const d = tmp();
  try {
    setJobEnabled(d, 'daily-brief', false);
    const src = BUILTINS();
    const out = applyJobPrefs(src, readJobPrefs(d));
    assert.equal('enabled' in src['daily-brief'], false, 'the source object is untouched');
    assert.equal(out['daily-brief'].enabled, false, 'only the copy carries the override');
    assert.notEqual(out['daily-brief'], src['daily-brief'], 'a copy, not the same object');
    assert.equal(out['health-brief'], src['health-brief'], 'an unaffected job is passed straight through');
  } finally { rmTemp(d); }
});

test('an unreadable prefs file holds every built-in OFF and says why', () => {
  // A damaged file must never be read as "no overrides": that silently resurrects a job the user
  // switched off and starts mailing them again, which is the one outcome this file exists to
  // prevent. Failing toward silence is recoverable; failing toward sending is not.
  const d = tmp();
  try {
    fs.writeFileSync(prefsFile(d), '{ "daily-brief": ');                 // killed mid-write
    assert.throws(() => readJobPrefs(d), 'a corrupt file is never quietly {}');
    fs.writeFileSync(prefsFile(d), '[]');
    assert.throws(() => readJobPrefs(d), /not an object/, 'and neither is the wrong shape');
    const map = heldOff(BUILTINS(), 'unexpected end of JSON input');
    assert.deepEqual(scheduled(map), [], 'nothing is scheduled while the switches cannot be read');
    assert.match(map['daily-brief'].pausedReason, /settings unreadable · 无法读取任务开关 — unexpected end/,
      'and the row explains itself instead of showing a bare "paused"');
  } finally { rmTemp(d); }
});

test('a missing file is a first run, not damage', () => {
  const d = tmp();
  try {
    assert.deepEqual(readJobPrefs(d), {}, 'no file yet = no overrides');
    assert.equal(fs.existsSync(prefsFile(d)), false, 'and reading did not create one');
  } finally { rmTemp(d); }
});
