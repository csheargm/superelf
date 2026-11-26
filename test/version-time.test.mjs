// PAVerTime formatting (web/version-time.js, evaluated as the shell inlines it) + the server side
// (lib/version-time.mjs) + bump-version recording `time`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseTime } from '../lib/version-time.mjs';
import { planReleases } from '../lib/version-bump.mjs';
import { SHELL_PARTS } from '../lib/shellhtml.mjs';

const SRC = fs.readFileSync(new URL('../web/version-time.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-new-func
const { verTimeShort, verTimeFull, verTimeLabel } = new Function(`${SRC}\nreturn { verTimeShort, verTimeFull, verTimeLabel };`)();
const inZone = (tz, fn) => { const was = process.env.TZ; process.env.TZ = tz; try { return fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; } };
const NOW = new Date('2026-11-25T12:00:00Z');

test('MM-DD HH:mm (24h) in the local zone', () => {
  assert.equal(inZone('Asia/Shanghai', () => verTimeShort('2026-11-25T06:32:00Z', NOW)), '11-25 14:32');
  assert.equal(inZone('America/Los_Angeles', () => verTimeShort('2026-11-25T06:32:00Z', NOW)), '11-24 22:32', 'the day moves with the zone');
  assert.equal(inZone('UTC', () => verTimeShort('2026-11-25T21:05:30.123Z', NOW)), '11-25 21:05');
});

test('the year shows only when it is not the current year', () => {
  assert.equal(inZone('UTC', () => verTimeShort('2025-12-31T23:59:00Z', NOW)), '2025-12-31 23:59');
  assert.equal(inZone('Asia/Shanghai', () => verTimeShort('2025-12-31T23:59:00Z', NOW)), '01-01 07:59', 'local year decides: already 2026 in Shanghai');
});

test('missing or bad time: nothing, and the label falls back to the date', () => {
  for (const bad of [undefined, null, '', '2026-11-25', 'garbage', '2026-13-45T99:99:00Z', '2026-11-25T06:32:00+08:00']) assert.equal(verTimeShort(bad, NOW), '', String(bad));
  assert.equal(verTimeFull(undefined), '');
  assert.equal(verTimeLabel(undefined, '11-25', NOW), '11-25', 'older release: date only, no fake time');
  assert.equal(verTimeLabel(undefined, undefined, NOW), '');
  assert.equal(inZone('UTC', () => verTimeLabel('2026-11-25T06:32:00Z', '2026-11-25', NOW)), '11-25 06:32');
});

test('tooltip: full local date-time with offset and zone', () => {
  assert.equal(inZone('Asia/Shanghai', () => verTimeFull('2026-11-25T06:32:09Z')), '2026-11-25 14:32:09 UTC+08:00 (Asia/Shanghai)');
  assert.match(inZone('America/Los_Angeles', () => verTimeFull('2026-11-25T06:32:09Z')), /^2026-11-24 22:32:09 UTC-08:00 /);
});

test('the shell inlines web/version-time.js before settings.js (which calls it)', () => {
  const files = SHELL_PARTS.map(([, f]) => f);
  assert.ok(files.indexOf('version-time.js') >= 0 && files.indexOf('version-time.js') < files.indexOf('settings.js'));
});

test('releaseTime: the running version entry `time`, else empty', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-'));
  try {
    assert.equal(releaseTime(d, '1.0.0'), '', 'no notes file');
    fs.writeFileSync(path.join(d, 'version-notes.json'), JSON.stringify({ 'v1.0.0': { date: '2026-11-25', time: '2026-11-25T06:32:00.000Z' }, 'v0.9.0': { date: '2026-11-20' }, 'v0.8.0': { time: '<b>' } }));
    assert.equal(releaseTime(d, '1.0.0'), '2026-11-25T06:32:00.000Z');
    assert.equal(releaseTime(d, '0.9.0'), '', 'older release without time');
    assert.equal(releaseTime(d, '0.8.0'), '', 'a non-ISO value never reaches the page');
    assert.equal(releaseTime(d, '2.0.0'), '', 'no entry');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('planReleases records the release time on every new entry; absent → no key', () => {
  const merges = [{ sha: 'a'.repeat(40), date: '2026-11-25', subject: "Merge branch 'fix/x'", branch: [{ subject: 'fix: x', body: '' }] }];
  const [r] = planReleases('1.0.0', merges, '2026-11-25T06:32:00.000Z');
  assert.equal(r.entry.time, '2026-11-25T06:32:00.000Z');
  assert.ok(!('time' in planReleases('1.0.0', merges)[0].entry));
});
