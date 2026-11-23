// The drawer row's time label · 抽屉行的时间标签
//
// SCAR 2026-09-12. A note last written at 20:27 was read at 00:20 the next morning. Its row sat
// under "Yesterday 昨天" — correct — while its own label read "4h", which reads as today. It was
// reported as a stale-timestamp bug. It was not: the stored time was right, the label was
// unreadable next to the header above it.
//
// The cause was that the two labels measured different things. The day header diffs CALENDAR
// DATES (boundary: local midnight). The old row label diffed ROLLING ELAPSED TIME (boundary: 24h
// ago). Just after midnight those boundaries are nearly a full day apart, so a row could carry a
// small-hours label under a Yesterday header for the whole 24h window. Measured: at k minutes past
// midnight the contradiction window is 24h − k.
//
// So these tests are not about formatting. They pin the INVARIANT the formatting exists to serve:
// a row's label can never contradict the day header it sits under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT } from './helpers-app.mjs';

// Pull the three helpers out of the component and run them against a PINNED clock, so these are
// real behavioural assertions rather than a regex staring at source. `new Date()` with no argument
// must yield the pinned now; `new Date(ms)` must stay a real date.
const SRC = /function usableTs[\s\S]*?padStart\(2,'0'\); \}/.exec(CHAT);
assert.ok(SRC, 'the drawer time helpers must be extractable at module scope');

function at(nowIso) {
  const nowMs = new Date(nowIso).getTime();
  const Real = Date;
  class Pinned extends Real {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  }
  return new Function('Date', SRC[0] + '; return { usableTs, listDay, listTime };')(Pinned);
}

const ts = (iso) => new Date(iso).getTime();

test('the reported case: a row reads as the evening it was written, not as "4h"', () => {
  const { listDay, listTime } = at('2026-09-12T00:20:00');
  const john31 = ts('2026-09-11T20:27:57');
  assert.equal(listDay(john31), 'Yesterday 昨天', 'the day header was never wrong');
  assert.equal(listTime(john31), '20:27', 'and the row now says WHEN, so the header makes sense');
});

test('no row can contradict the header above it', () => {
  // The old label failed this for every one of the "yesterday" rows below: 4h, 5h, 1h, 21m all
  // read as today. A time-of-day label cannot make that claim at all — it states an instant and
  // lets the header supply the day.
  const { listDay, listTime } = at('2026-09-12T00:20:00');
  const cases = [
    ['2026-09-11T20:27:00', 'Yesterday 昨天', '20:27'],
    ['2026-09-11T18:55:00', 'Yesterday 昨天', '18:55'],
    ['2026-09-11T23:59:00', 'Yesterday 昨天', '23:59'],   // 21 minutes ago, and still yesterday
    ['2026-09-12T00:01:00', 'Today 今天', '00:01'],       // 19 minutes ago, and today
    ['2026-09-10T21:00:00', 'Thu 周四 · 9月10日', '21:00'],
  ];
  for (const [iso, day, time] of cases) {
    assert.equal(listDay(ts(iso)), day, iso);
    assert.equal(listTime(ts(iso)), time, iso);
    assert.ok(/^\d{2}:\d{2}$/.test(listTime(ts(iso))), 'a label is a clock time, never a duration');
  }
  // The sharpest pair: two minutes apart, two different day sections. Under the old label they
  // read "21m" and "19m" — indistinguishable, yet filed under different headers.
  assert.notEqual(listDay(ts('2026-09-11T23:59:00')), listDay(ts('2026-09-12T00:01:00')));
});

test('the label stays true while the drawer sits open across midnight', () => {
  // Nothing redraws the list on a timer, so a docked drawer left open overnight keeps whatever
  // draw() baked into innerHTML. A relative label silently rots ("4h" at 00:20 is "16h" by
  // afternoon); an absolute one is still correct whenever it is eventually read.
  const evening = ts('2026-09-11T20:27:00');
  assert.equal(at('2026-09-11T21:00:00').listTime(evening), '20:27');
  assert.equal(at('2026-09-12T00:20:00').listTime(evening), '20:27');
  assert.equal(at('2026-09-12T16:00:00').listTime(evening), '20:27');
});

test('midnight and noon are not mangled, and single digits are padded', () => {
  const { listTime } = at('2026-09-12T12:00:00');
  assert.equal(listTime(ts('2026-09-12T00:00:00')), '00:00', 'midnight is 00:00, not 0:0 or 24:00');
  assert.equal(listTime(ts('2026-09-12T09:05:00')), '09:05', 'both halves are zero-padded');
  assert.equal(listTime(ts('2026-09-12T23:59:00')), '23:59');
});

test('a row with no timestamp says so instead of inventing one', () => {
  // Both the header and the label used to fall back to Date.now(), so a stamp-less row rendered as
  // "now" under "Today 今天" — a fabricated modification time for a write that never happened
  // (the same shape as the save-pill scar). Worse, the SORT used ||0, so that row sorted to the
  // BOTTOM and minted a second "Today 今天" header underneath "Yesterday".
  const { usableTs, listDay, listTime } = at('2026-09-12T00:20:00');
  for (const bad of [0, undefined, null, '', NaN, -1, 'nonsense']) {
    assert.equal(usableTs(bad), 0, `${String(bad)} is not a usable instant`);
    assert.equal(listTime(bad), '', `${String(bad)} must render no time`);
    assert.equal(listDay(bad), '无日期 · No date', `${String(bad)} must not claim a day`);
  }
  // 1ms after the epoch is a REAL instant, so it must be reported as a day, not refused. Asserted
  // without naming the date: ts=1 falls on either side of Jan 1 1970 depending on the machine's
  // timezone, and a test that encodes the author's offset fails for the next person who runs it.
  assert.notEqual(listDay(1), '无日期 · No date', 'a real (if ancient) instant is still a day');
  assert.match(listTime(1), /^\d{2}:\d{2}$/, 'and still has a clock time');
});

test('the header and the sort agree on what a missing timestamp means', () => {
  // draw() sorts by (b.updated||0)-(a.updated||0) and groups by listDay(it.updated). If those two
  // disagree about the fallback, rows land under headers that do not describe them.
  const body = /const rowHtml=it=>\{[\s\S]*?return html; \}/.exec(CHAT);   // the row renderer and the day loop (dayHtml) under it
  assert.ok(body, 'the row loop must be findable');
  // Pinned as an INVARIANT, not as a field name: the drawer can now be sorted by created time as
  // well as modified, and the whole point is that the sort, the day header and the row label move
  // together. Naming `it.updated` here made this test fail the moment that choice was added, while
  // the property it exists to protect was never broken.
  const dayArg = /const day=listDay\((.+?)\);/.exec(body[0]);
  const timeArg = /listTime\((.+?)\)\+/.exec(body[0]);
  assert.ok(dayArg && timeArg, 'the header and the label are both computed');
  assert.equal(dayArg[1], timeArg[1], 'the header and the row label read the SAME time');
  // …and the list is ORDERED by that same time, or rows sit under headers that do not describe them.
  const accessor = dayArg[1].replace(/\(.*\)$/, '');
  const sortLine = /\.sort\(\(a,b\)=>[^;]+\);/.exec(CHAT);
  assert.ok(sortLine, 'the list is sorted');
  assert.ok(sortLine[0].includes(accessor),
    `the sort must use the same time as the header (header: ${dayArg[1]}, sort: ${sortLine[0].trim()})`);
});
