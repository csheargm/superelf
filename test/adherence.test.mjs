// Adherence loop（跟进闭环）producer rules — PLAN.md capability #2. R14: the
// named thresholds and windows in lib/adherence.mjs decide every verdict and
// every proposal; these tests pin the exact lines and the deterministic
// follow-up actions. Pure functions — no workspaces, no IO, no LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adherenceReport, adherenceHorizonDays, ADHERENCE_MAX_LINES, ADHERENCE_MAX_PROPOSALS,
  ADHERENCE_WINDOW_DAYS, ADHERENCE_EVAL_MAX_DAYS } from '../lib/adherence.mjs';
import { ACTION_TYPES } from '../lib/actions.mjs';
import { DAY_MS } from '../lib/schedule.mjs';

const NOW = new Date(2026, 7, 30, 12);
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() - n); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// rows(fn): offsets 30..1 (1 = yesterday); fn(offset) → partial row or null.
const rows = (fn) => { const out = []; for (let n = 30; n >= 1; n--) { const r = fn(n); if (r) out.push({ date: day(n), ...r }); } return out; };
// Steps beforeVal for offsets > cut, afterVal for offsets <= cut.
const stepsRows = (beforeVal, afterVal, cut) => rows((n) => ({ steps: n > cut ? beforeVal : afterVal, weight: 70 }));

// One create-reminder intervention `daysActive` days old. Reminder id = action
// id — exactly how lib/actions.mjs execCreateReminder registers it.
function intervention(daysActive, { flag = 'steps_min_daily', time = '18:00', status = 'done', removed = false, id = 'hb-1-a0' } = {}) {
  const created = NOW.getTime() - daysActive * DAY_MS;
  const action = { id, type: 'create-reminder', status, created, decided: created,
    payload: { flag, text: 'Walk 20 minutes · 散步20分钟', time } };
  const reminder = { id, text: 'Walk 20 minutes · 散步20分钟', time, created };
  return { actionsHistory: [action], reminders: status === 'done' && !removed ? [reminder] : [] };
}

test('improvement → keeping-it line with both window means; no proposal', () => {
  const iv = intervention(8);
  const r = adherenceReport({ ...iv, rows: stepsRows(4100, 5800, 8), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /active 8 days/);
  assert.match(r.lines[0], /4100 → 5800/);
  assert.match(r.lines[0], /\+41%/);
  assert.match(r.lines[0], /keeping it · 保持/);
  assert.deepEqual(r.proposals, []);
  assert.ok(r.activeFlags.has('steps_min_daily'));
});

test('no change after ≥14 days → adjust-reminder-time proposal, deterministic alternate slot', () => {
  const iv = intervention(15);
  const r = adherenceReport({ ...iv, rows: stepsRows(4900, 4800, 15), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /no change after 15 days/);
  assert.match(r.lines[0], /4900 → 4800/);
  assert.match(r.lines[0], /调整待定/, 'suffix says pending（待定）— true even if a store-time duplicate filter drops this run\'s instance');
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0];
  assert.equal(p.type, 'adjust-reminder-time');
  assert.equal(p.payload.reminderId, 'hb-1-a0');
  assert.equal(p.payload.flag, 'adherence_hb-1-a0');
  assert.equal(p.payload.time, '07:30', 'an 18:00 reminder swaps to the OTHER named slot');
  assert.match(p.summary, /^why: /, 'why cites the computed numbers (R14)');
  assert.match(p.summary, /4900 → 4800/);
});

test('a 07:30 reminder adjusts to 18:00 — the swap is deterministic both ways', () => {
  const iv = intervention(15, { time: '07:30' });
  const r = adherenceReport({ ...iv, rows: stepsRows(4900, 4800, 15), now: NOW });
  assert.equal(r.proposals[0].payload.time, '18:00');
});

test('young (<14d) intervention with no improvement → no line yet (silence, not a verdict)', () => {
  const iv = intervention(10);
  const r = adherenceReport({ ...iv, rows: stepsRows(4800, 4800, 10), now: NOW });
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.proposals, []);
  assert.ok(r.activeFlags.has('steps_min_daily'), 'flag ownership does not wait for a verdict');
});

test('insufficient data-days in a window → honest 数据不足 line, never a verdict or proposal', () => {
  const iv = intervention(15);
  // before window (offsets 22..16) has only 2 data days; after window is full
  const r = adherenceReport({ ...iv, rows: rows((n) => (n <= 7 || n === 16 || n === 17 ? { steps: 4800 } : null)), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /insufficient data · 数据不足/);
  assert.match(r.lines[0], /2\/7/);
  assert.deepEqual(r.proposals, []);
});

test('suppressed follow-up flag → the LINE is silenced with its proposal (no weekly nag · 拒绝后不唠叨)', () => {
  const iv = intervention(15);
  const r = adherenceReport({ ...iv, rows: stepsRows(4900, 4800, 15), now: NOW,
    isSuppressed: (f) => f === 'adherence_hb-1-a0' });
  assert.deepEqual(r.lines, [], 'a denied/pending/just-executed follow-up must not repeat its nag text weekly (R13 finding 18)');
  assert.deepEqual(r.proposals, []);
  assert.ok(r.activeFlags.has('steps_min_daily'), 'flag ownership survives the silence');
});

test('denied reminder whose metric later improves → one positive line, no proposal', () => {
  const iv = intervention(15, { status: 'denied' });
  const r = adherenceReport({ ...iv, rows: stepsRows(4100, 5800, 15), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /自行改善/);
  assert.match(r.lines[0], /4100 → 5800/);
  assert.match(r.lines[0], /无需行动/);
  assert.deepEqual(r.proposals, []);
  assert.ok(!r.activeFlags.has('steps_min_daily'));
});

test('denied reminder with no improvement → total silence (the denial is respected)', () => {
  const iv = intervention(15, { status: 'denied' });
  const r = adherenceReport({ ...iv, rows: stepsRows(4900, 4800, 15), now: NOW });
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.proposals, []);
});

test('removed reminder (executed, later retired) with improvement → positive line, no proposal', () => {
  const iv = intervention(15, { removed: true });
  const r = adherenceReport({ ...iv, rows: stepsRows(4100, 5800, 15), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /提醒移除后自行改善/);
  assert.deepEqual(r.proposals, []);
});

test('gap reminder with sleep data now flowing → coverage keeping-it line', () => {
  const iv = intervention(15, { flag: 'gap_sleep', time: '09:00' });
  const r = adherenceReport({ ...iv, rows: rows((n) => ({ steps: 6000, ...(n <= 7 ? { sleepMinutes: 400 } : {}) })), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /0\/7 → 7\/7/);
  assert.match(r.lines[0], /keeping it · 保持/);
  assert.deepEqual(r.proposals, []);
});

test('gap reminder still yielding no data after ≥14 days → retire-reminder proposal', () => {
  const iv = intervention(15, { flag: 'gap_sleep', time: '09:00' });
  const r = adherenceReport({ ...iv, rows: rows(() => ({ steps: 6000 })), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /移除待定/);
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].type, 'retire-reminder');
  assert.equal(r.proposals[0].payload.reminderId, 'hb-1-a0');
  assert.equal(r.proposals[0].payload.flag, 'adherence_hb-1-a0');
});

test('re-proposed same flag → ONE intervention (the latest action), one line', () => {
  const old = intervention(25, { id: 'old-a0' });
  const cur = intervention(8);
  const r = adherenceReport({ actionsHistory: [...old.actionsHistory, ...cur.actionsHistory],
    reminders: cur.reminders, rows: stepsRows(4100, 5800, 8), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /active 8 days/);
});

test('every flag firing at once → line cap holds and exactly ONE proposal ships (oldest first)', () => {
  const mk = (id, flag, time, daysActive) => {
    const created = NOW.getTime() - daysActive * DAY_MS;
    return { action: { id, type: 'create-reminder', status: 'done', created, decided: created,
        payload: { flag, text: `reminder ${id}`, time } },
      reminder: { id, text: `reminder ${id}`, time, created } };
  };
  const a = mk('a1', 'steps_min_daily', '18:00', 16);      // flat steps → no-change → adjust candidate
  const b = mk('a2', 'sleep_min_minutes', '22:00', 15);    // no sleep data at all → insufficient line
  const c = mk('a3', 'gap_sleep', '09:00', 15);            // still no sleep data → retire candidate
  const r = adherenceReport({ actionsHistory: [a.action, b.action, c.action],
    reminders: [a.reminder, b.reminder, c.reminder],
    rows: rows(() => ({ steps: 4800 })), now: NOW });
  assert.equal(r.lines.length, 3);
  assert.ok(r.lines.length <= ADHERENCE_MAX_LINES);
  assert.equal(r.proposals.length, ADHERENCE_MAX_PROPOSALS);
  assert.equal(r.proposals[0].type, 'adjust-reminder-time', 'the oldest intervention proposes; the cap blocks the rest');
  assert.equal(r.lines.filter((l) => l.includes('待定')).length, 1, 'only the shipped proposal gets a pending suffix');
});

// ── R13 review regressions（审查回归）— each was red before its fix ──────────

const WALK = 'Walk 20 minutes · 散步20分钟';
const mkCreate = (id, at, { status = 'done', time = '18:00', flag = 'steps_min_daily' } = {}) =>
  ({ id, type: 'create-reminder', status, created: at, decided: at,
    payload: { flag, text: WALK, time } });

test('zero baseline with full coverage is DATA (R14) → keeping-it from zero, never 数据不足', () => {
  const iv = intervention(10);
  const r = adherenceReport({ ...iv, rows: stepsRows(0, 3500, 10), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /0 → 3500/);
  assert.match(r.lines[0], /从0开始/);
  assert.match(r.lines[0], /keeping it · 保持/);
  assert.ok(!r.lines[0].includes('数据不足'), 'present data is never declared missing');
  assert.deepEqual(r.proposals, []);
});

test('zero baseline, denied reminder, later improvement → the positive line is not swallowed', () => {
  const iv = intervention(15, { status: 'denied' });
  const r = adherenceReport({ ...iv, rows: stepsRows(0, 3500, 15), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /提醒被拒后自行改善/);
  assert.match(r.lines[0], /0 → 3500/);
});

test('calendar days, not elapsed/DAY_MS: a later-in-day start still counts 14 days at the 14th-day brief', () => {
  // Approved 14 calendar days ago at 20:00; the brief runs at 12:00 — elapsed
  // is 13.67 days and the old Math.floor(elapsed / DAY_MS) read 13, deferring
  // the follow-up by a whole weekly cycle.
  const created = NOW.getTime() - 14 * DAY_MS + 8 * 3600 * 1000;
  const r = adherenceReport({ actionsHistory: [mkCreate('hb-1-a0', created)],
    reminders: [{ id: 'hb-1-a0', text: WALK, time: '18:00', created }],
    rows: stepsRows(4900, 4800, 14), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /no change after 14 days/);
  assert.equal(r.proposals.length, 1, 'the follow-up ships at the 14-calendar-day brief, not a week later');
});

test('young gate: an intervention younger than the window never credits a pre-existing trend — silence, flag still owned', () => {
  // Steps began rising 5 days BEFORE the reminder existed; the reminder is 2
  // days old. The overlapping windows still differ by ≥10% — the old code
  // printed 'active 2 days … keeping it' for a trend it never caused.
  const iv = intervention(2);
  const r = adherenceReport({ ...iv, rows: stepsRows(4100, 5800, 5), now: NOW });
  assert.deepEqual(r.lines, [], 'no verdict before a full post-intervention after-window has elapsed');
  assert.deepEqual(r.proposals, []);
  assert.ok(r.activeFlags.has('steps_min_daily'));
});

test('join: a re-approved flag whose latest action id matches NO reminder still classifies ACTIVE (semantic fallback)', () => {
  const created = NOW.getTime() - 20 * DAY_MS;
  // addReminder's semantic dedupe kept the ORIGINAL reminder id; the newer
  // done action ('hb-2-a0') registered no reminder of its own.
  const r = adherenceReport({
    actionsHistory: [mkCreate('old-a0', created), mkCreate('hb-2-a0', NOW.getTime() - 10 * DAY_MS)],
    reminders: [{ id: 'old-a0', text: WALK, time: '18:00', created }],
    rows: stepsRows(4100, 5500, 20), now: NOW });
  assert.ok(r.activeFlags.has('steps_min_daily'), 'live reminder owns its flag — create-reminder is not re-proposed');
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /active 20 days/);
  assert.ok(!r.lines[0].includes('自行改善'), 'a live, firing reminder is never reported as removed');
});

test('join: a later DENIED re-proposal cannot shadow a LIVE reminder', () => {
  const created = NOW.getTime() - 20 * DAY_MS;
  const r = adherenceReport({
    actionsHistory: [mkCreate('a1', created), mkCreate('a2', NOW.getTime() - 5 * DAY_MS, { status: 'denied' })],
    reminders: [{ id: 'a1', text: WALK, time: '18:00', created }],
    rows: stepsRows(4100, 5500, 20), now: NOW });
  assert.ok(r.activeFlags.has('steps_min_daily'));
  assert.match(r.lines[0], /active 20 days/);
  assert.ok(!r.lines.some((l) => l.includes('提醒被拒后自行改善')), 'no false denied-self-improvement about a firing reminder');
});

test('join: the reminder\'s own flag field joins FIRST — id and time may both have diverged', () => {
  const created = NOW.getTime() - 20 * DAY_MS;
  const r = adherenceReport({ actionsHistory: [mkCreate('gone-id', created)],
    reminders: [{ id: 'zzz', flag: 'steps_min_daily', text: WALK, time: '07:30', created }],
    rows: stepsRows(4100, 5500, 20), now: NOW });
  assert.ok(r.activeFlags.has('steps_min_daily'));
  assert.match(r.lines[0], /active 20 days/);
});

test('anchor: a removed reminder\'s verdict anchors to the RECORDED retirement date, not the creation era', () => {
  const created = NOW.getTime() - 40 * DAY_MS, retired = NOW.getTime() - 10 * DAY_MS;
  const retire = { id: 'r1', type: 'retire-reminder', status: 'done', created: retired, decided: retired,
    done: retired, payload: { flag: 'adherence_c1', reminderId: 'c1', retiredFlag: 'steps_min_daily' } };
  const r = adherenceReport({ actionsHistory: [mkCreate('c1', created), retire], reminders: [],
    rows: stepsRows(4000, 5500, 10), now: NOW });
  assert.equal(r.lines.length, 1, 'the before-removal week is inside the data — the creation-era window was off the horizon');
  assert.match(r.lines[0], /提醒移除后自行改善/);
  assert.match(r.lines[0], /4000 → 5500/);
});

test('age-out: an established intervention leaves evaluation — silence, never insufficient-data-forever', () => {
  const iv = intervention(ADHERENCE_EVAL_MAX_DAYS + 8);
  const r = adherenceReport({ ...iv, rows: stepsRows(4800, 4800, 15), now: NOW });
  assert.deepEqual(r.lines, [], 'no eternal 数据不足 line once the before-window predates any fetchable horizon');
  assert.deepEqual(r.proposals, []);
  assert.ok(r.activeFlags.has('steps_min_daily'), 'flag ownership never ages out');
});

test('adherenceHorizonDays reaches the oldest EVALUATED intervention\'s before-window; aged-out needs 0', () => {
  const iv = intervention(30);
  assert.equal(adherenceHorizonDays({ ...iv, now: NOW }), 30 + ADHERENCE_WINDOW_DAYS + 1);
  const aged = intervention(ADHERENCE_EVAL_MAX_DAYS + 8);
  assert.equal(adherenceHorizonDays({ ...aged, now: NOW }), 0);
  assert.equal(adherenceHorizonDays({ reminders: [], actionsHistory: [], now: NOW }), 0);
});

test('re-baseline: windows anchor to adjustedAt — the ADJUSTMENT is measured, not the original slot forever', () => {
  const created = NOW.getTime() - 40 * DAY_MS, adjustedAt = NOW.getTime() - 10 * DAY_MS;
  const rem = { id: 'hb-1-a0', flag: 'steps_min_daily', text: WALK, time: '07:30', created, adjustedAt, triedTimes: ['18:00'] };
  const r = adherenceReport({ actionsHistory: [mkCreate('hb-1-a0', created)], reminders: [rem],
    rows: stepsRows(4000, 5500, 10), now: NOW });
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /active 10 days/, 'days count from the adjustment');
  assert.match(r.lines[0], /4000 → 5500/, 'before-window = the week before the adjustment');
});

test('terminal state: tried slots are never re-proposed — all spent → retire, no 18:00↔07:30 oscillation', () => {
  const created = NOW.getTime() - 40 * DAY_MS, adjustedAt = NOW.getTime() - 15 * DAY_MS;
  const rem = { id: 'hb-1-a0', flag: 'steps_min_daily', text: WALK, time: '07:30', created, adjustedAt, triedTimes: ['18:00'] };
  const r = adherenceReport({ actionsHistory: [mkCreate('hb-1-a0', created)], reminders: [rem],
    rows: stepsRows(4900, 4800, 15), now: NOW });
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].type, 'retire-reminder', 'never a swap back to a slot already proven ineffective');
  assert.equal(r.proposals[0].payload.retiredFlag, 'steps_min_daily', 'retirement enters the ORIGINAL flag\'s cooldown');
  assert.match(r.lines[0], /移除待定/);
});

test('R3: proposal titles come from the ONE ACTION_TYPES registry', () => {
  const iv = intervention(15);
  const r = adherenceReport({ ...iv, rows: stepsRows(4900, 4800, 15), now: NOW });
  assert.equal(r.proposals[0].title, ACTION_TYPES['adjust-reminder-time'].label);
});
