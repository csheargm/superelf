// lib/ics.mjs — the hand-rolled ICS parser behind the daily brief's calendar
// section. Fixtures are protocol-faithful ICS text (folding, escaping, RRULE,
// a malformed line); NEVER a live calendar fetch in tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, occursOn, todaysEvents, fetchIcs } from '../lib/ics.mjs';

// A fixed "today": Tuesday 2026-09-01 (local).
const TODAY = new Date(2026, 8, 1, 7, 30);

const wrap = (body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', body, 'END:VCALENDAR'].join('\r\n');
const vevent = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');

test('timed event today: local floating time parsed, shows with HH:MM', () => {
  const evs = parseIcs(wrap(vevent(['DTSTART:20260901T093000', 'SUMMARY:Standup'])));
  assert.equal(evs.length, 1);
  const today = todaysEvents(evs, TODAY);
  // endTime rides along so the brief can detect collisions; null when the VEVENT has no DTEND.
  assert.deepEqual(today, [{ summary: 'Standup', allDay: false, time: '09:30', endTime: null }]);
});

test('UTC "Z" time is converted to local clock time', () => {
  const evs = parseIcs(wrap(vevent(['DTSTART:20260901T160000Z', 'SUMMARY:Call'])));
  const d = evs[0].start;
  assert.equal(d.getTime(), Date.UTC(2026, 8, 1, 16, 0, 0), 'epoch is the UTC instant');
  const local = todaysEvents(evs, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 1));
  assert.equal(local[0].time, `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
});

test('all-day event (VALUE=DATE) shows with time null, sorted before timed events', () => {
  const evs = parseIcs(wrap([
    vevent(['DTSTART:20260901T093000', 'SUMMARY:Standup']),
    vevent(['DTSTART;VALUE=DATE:20260901', 'SUMMARY:Holiday']),
  ].join('\r\n')));
  const today = todaysEvents(evs, TODAY);
  assert.deepEqual(today.map((e) => e.summary), ['Holiday', 'Standup'], 'all-day first');
  assert.equal(today[0].time, null);
  assert.equal(today[0].allDay, true);
});

test('RRULE FREQ=DAILY: an old event occurs today; UNTIL in the past ends it', () => {
  const daily = parseIcs(wrap(vevent(['DTSTART:20260101T080000', 'SUMMARY:Walk', 'RRULE:FREQ=DAILY'])))[0];
  assert.equal(occursOn(daily, TODAY), true);
  const ended = parseIcs(wrap(vevent(['DTSTART:20260101T080000', 'SUMMARY:Walk', 'RRULE:FREQ=DAILY;UNTIL=20260801T000000Z'])))[0];
  assert.equal(occursOn(ended, TODAY), false, 'UNTIL before today ends the series');
  assert.equal(occursOn(daily, new Date(2025, 11, 31)), false, 'never before DTSTART');
});

test('RRULE FREQ=WEEKLY: BYDAY match, BYDAY mismatch, and default = DTSTART weekday', () => {
  const tue = parseIcs(wrap(vevent(['DTSTART:20260106T100000', 'SUMMARY:Piano', 'RRULE:FREQ=WEEKLY;BYDAY=TU'])))[0];
  assert.equal(occursOn(tue, TODAY), true, '2026-09-01 is a Tuesday');
  const mowe = parseIcs(wrap(vevent(['DTSTART:20260105T100000', 'SUMMARY:Gym', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE'])))[0];
  assert.equal(occursOn(mowe, TODAY), false, 'Tuesday not in MO,WE');
  const noByday = parseIcs(wrap(vevent(['DTSTART:20260106T100000', 'SUMMARY:Choir', 'RRULE:FREQ=WEEKLY'])))[0];
  assert.equal(occursOn(noByday, TODAY), true, 'defaults to the DTSTART weekday (Tuesday)');
});

test('unsupported RRULEs are ignored honestly: event shows on its DTSTART date only', () => {
  for (const rule of ['FREQ=MONTHLY', 'FREQ=DAILY;INTERVAL=2', 'FREQ=DAILY;COUNT=10', 'FREQ=WEEKLY;BYDAY=2MO']) {
    const ev = parseIcs(wrap(vevent(['DTSTART:20260801T080000', 'SUMMARY:X', `RRULE:${rule}`])))[0];
    assert.equal(ev.rrule, null, `${rule} → unsupported`);
    assert.equal(occursOn(ev, TODAY), false, `${rule} → not expanded onto today`);
    assert.equal(occursOn(ev, new Date(2026, 7, 1)), true, `${rule} → still shows on its literal start date`);
  }
});

test('malformed lines and blocks are skipped without a crash; alien text yields []', () => {
  const evs = parseIcs(wrap([
    'THIS LINE HAS NO COLON AND IS MALFORMED',
    vevent(['DTSTART:garbage-not-a-date', 'SUMMARY:Broken']),  // unparsable DTSTART → dropped
    vevent(['DTSTART:20260901T110000', 'SUMMARY:Survivor']),
  ].join('\r\n')));
  assert.deepEqual(evs.map((e) => e.summary), ['Survivor']);
  assert.deepEqual(parseIcs('not ics at all\njust text'), []);
  assert.deepEqual(parseIcs(''), []);
});

test('folded lines are unfolded and SUMMARY text is unescaped', () => {
  const evs = parseIcs('BEGIN:VEVENT\r\nDTSTART:20260901T090000\r\nSUMMARY:Lunch\\, with\r\n  the family\r\nEND:VEVENT');
  assert.equal(evs[0].summary, 'Lunch, with the family');
});

// ── R13 review regressions: UNTIL instant, SSRF gate, size caps ─────────────
const publicLookup = async () => [{ address: '203.0.113.5', family: 4 }];

test('RRULE UNTIL compares the occurrence INSTANT against the UNTIL instant, not local day strings', () => {
  // TZ-independent repro: the occurrence at 23:59 local is AFTER the same-day
  // 00:00 UNTIL instant — a day-string comparison cannot see that.
  const late = parseIcs(wrap(vevent(['DTSTART:20260101T235900', 'SUMMARY:Late', 'RRULE:FREQ=DAILY;UNTIL=20260901T000000'])))[0];
  assert.equal(occursOn(late, new Date(2026, 8, 1)), false, '23:59 occurrence is after the 00:00 UNTIL instant that day');
  assert.equal(occursOn(late, new Date(2026, 7, 31)), true, 'the day before UNTIL still occurs');
  // Asia/Shanghai (UTC+8) repro from the review: series ended Aug 31 23:59:59Z
  // must NOT appear on the Sep 1 morning brief (Sep 1 08:00 +08 = Sep 1 00:00Z).
  const oldTZ = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const cn = parseIcs(wrap(vevent(['DTSTART:20260101T080000', 'SUMMARY:Sync', 'RRULE:FREQ=DAILY;UNTIL=20260831T235959Z'])))[0];
    assert.equal(occursOn(cn, new Date(2026, 8, 1)), false, 'ended series must not appear the morning after UNTIL');
    assert.equal(occursOn(cn, new Date(2026, 7, 31)), true, 'still occurs on the UNTIL day itself');
  } finally { if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ; }
});

test('fetchIcs: plain http is refused at fetch time — https only (SSRF gate)', async () => {
  await assert.rejects(
    () => fetchIcs('http://cal.example.com/x.ics', { fetchImpl: async () => { throw new Error('must not fetch'); }, lookupImpl: publicLookup }),
    /https|必须使用/);
});

test('fetchIcs: redirects are refused with the honest bilingual line (no silent follow)', async () => {
  await assert.rejects(
    () => fetchIcs('https://ok.example/x.ics', { lookupImpl: publicLookup,
      fetchImpl: async (url, opts) => { assert.equal(opts.redirect, 'manual', 'fetch must not auto-follow'); return { status: 302, ok: false, text: async () => '' }; } }),
    /feed redirected|日历源发生跳转/);
});

test('fetchIcs: hosts resolving to loopback/RFC1918/link-local/metadata ranges are refused per-fetch', async () => {
  const noFetch = async () => { throw new Error('must not fetch'); };
  for (const ip of ['127.0.0.1', '10.0.0.8', '172.16.5.5', '192.168.1.1', '169.254.169.254', '0.0.0.1', '::1', 'fd00::1', 'fe80::2', '::ffff:192.168.1.9']) {
    await assert.rejects(
      () => fetchIcs('https://cal.example.com/x.ics', { fetchImpl: noFetch, lookupImpl: async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }] }),
      /private address|内网地址/, `resolved ${ip} must be refused`);
  }
  await assert.rejects(
    () => fetchIcs('https://192.168.0.10/x.ics', { fetchImpl: noFetch, lookupImpl: async () => { throw new Error('literal IP needs no lookup'); } }),
    /private address|内网地址/, 'literal private IP host');
  await assert.rejects(
    () => fetchIcs('https://localhost/x.ics', { fetchImpl: noFetch, lookupImpl: publicLookup }),
    /private address|内网地址/, 'localhost by name');
});

test('fetchIcs: a feed streaming more than the byte cap is aborted with an honest failure line', async () => {
  const big = 'X'.repeat(64 * 1024 + 1024); // just over the injected cap (the real default is ICS_MAX_BYTES)
  await assert.rejects(
    () => fetchIcs('https://cal.example.com/x.ics', { lookupImpl: publicLookup, fetchImpl: async () => new Response(big), maxBytes: 64 * 1024 }),
    /too large|超过大小上限/);
  const ok = await fetchIcs('https://cal.example.com/x.ics', { lookupImpl: publicLookup, fetchImpl: async () => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR') });
  assert.match(ok, /VCALENDAR/, 'normal-size feeds still stream through');
});

test('parseIcs event guard: a pathological feed cannot materialize unbounded event objects (injectable cap)', () => {
  const many = Array.from({ length: 600 }, (x, i) => vevent(['DTSTART:20260901T090000', `SUMMARY:E${i}`])).join('\r\n');
  assert.equal(parseIcs(wrap(many), { maxEvents: 500 }).length, 500);
  // and the real default must NOT truncate a large-but-legitimate feed (today's events sort last)
  assert.equal(parseIcs(wrap(many)).length, 600);
});

test('fetchIcs: webcal:// rewritten to https://, non-2xx throws with context (R14)', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, text: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }; };
  await fetchIcs('webcal://cal.example.com/私人.ics', { fetchImpl, lookupImpl: publicLookup });
  assert.match(calls[0], /^https:\/\/cal\.example\.com\//);
  await assert.rejects(
    () => fetchIcs('https://cal.example.com/x.ics', { lookupImpl: publicLookup, fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /ics fetch HTTP 404/);
  await assert.rejects(
    () => fetchIcs('https://gone.example/x.ics', { fetchImpl: async () => ({ ok: true, text: async () => '' }), lookupImpl: async () => { throw new Error('ENOTFOUND'); } }),
    /DNS lookup failed|域名解析失败/, 'DNS failure is its own honest error');
});

test('endTime is carried through when the event has a DTEND', () => {
  // Without it there is no way to know two events overlap — the single most useful thing a
  // daily brief can point out, and the reason this field exists.
  const evs = parseIcs(wrap(vevent(['DTSTART:20260901T090000', 'DTEND:20260901T093000', 'SUMMARY:Stretch'])));
  const [e] = todaysEvents(evs, TODAY);
  assert.equal(e.time, '09:00');
  assert.equal(e.endTime, '09:30');
});
