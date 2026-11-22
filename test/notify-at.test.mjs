// Shell-side SCHEDULED notifications (kinds notify-at / notify-cancel).
//
// THE BUG THIS EXISTS FOR. The Productivity Hub's pomodoro rang from inside the app. But
// leaving an app DESTROYS it — web/index.html's #back sets the iframe to about:blank — so
// the countdown (setInterval), the bell (an AudioContext oscillator) and the end time all
// died the moment the user went Home or opened another app. Which is precisely when the
// alarm mattered. The shell is the same page across every app switch, so the SHELL now
// holds the timer and the app only asks for it.
//
// Out of scope on purpose: the browser tab being closed, and iOS freezing a background tab.
// No page-side timer can survive either; that needs a push channel and is a separate call.
//
// Everything below runs the SHIPPED code out of web/index.html — the pure rules block and
// the device-facing half are both extracted and executed against fake time / storage /
// Notification, never retyped (harness-fidelity rule, R14: a test that cannot see the real
// code cannot fail for the real reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
import { loadRelayCore } from './helpers-shell-broker.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const CJK = /[一-鿿]/;

const slice = (from, to, what) => {
  const a = SHELL.indexOf(from), b = SHELL.indexOf(to);
  assert.ok(a > 0 && b > a, `${what} must stay findable in web/index.html`);
  return SHELL.slice(a, b);
};

// The broker's three notification branches only, so a pin here cannot be satisfied by some
// other kind's code.
const NOTIFY_BRANCHES = codeOnly(slice("} else if(m.kind==='notify'){", "} else if(m.kind==='render-md'){", 'the notify branches'));
// The whole shell-side notification implementation (permission path + schedule store).
const IMPL_SRC = slice('// ── Notifications（通知）', '/* ── Broker (for sandboxed apps) ── */', 'the notification implementation');

// The REAL failure mapper, run — the same seam test/broker-relay.test.mjs and
// test/speech-broker.test.mjs use.
const { relayFail, relayText } = loadRelayCore(async () => {});

// ── harness ──────────────────────────────────────────────────────────────────────────────
// Controllable time. The shipped code calls Date.now(), setTimeout and clearTimeout; all
// three are injected as parameters of the Function wrapper, so inside the extracted source
// they shadow the globals and every deadline is exact rather than wall-clock-flaky.
function mkClock(start = 1_700_000_000_000) {
  let now = start, seq = 1;
  const timers = new Map();
  return {
    now: () => now,
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = seq++; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    armed: () => timers.size,
    // Fire every timer whose deadline falls inside the window, in order, moving `now` to
    // each deadline first (a timer that arms another timer therefore behaves as it would live).
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.fn();
      }
      now = target;
    },
  };
}
const flush = () => new Promise((r) => setImmediate(r));   // let the async fire path settle

function mkStorage(seed) {
  const box = new Map();
  if (seed !== undefined) box.set('pa_notify_at', JSON.stringify(seed));
  return {
    box,
    getItem: (k) => (box.has(k) ? box.get(k) : null),
    setItem: (k, v) => { box.set(k, String(v)); },
    pending: () => JSON.parse(box.get('pa_notify_at') || '[]'),
  };
}

// A stand-in for the browser's Notification constructor that records what was shown.
function mkNotification(permission = 'granted') {
  const shown = [];
  const asked = [];
  function Notification(title, opts) { shown.push({ title, ...(opts || {}) }); }
  Notification.permission = permission;
  Notification.requestPermission = async () => { asked.push(1); return Notification.permission; };
  return { Notification, shown, asked };
}

// Boot ONE shell's worth of notification code. `seed` is what a previous page load left in
// localStorage — that is how a reload is simulated: a fresh instance over the same store.
function bootShell({ seed, permission = 'granted', clock = mkClock(), storage } = {}) {
  const store = storage || mkStorage(seed);
  const N = mkNotification(permission);
  const confirms = [];
  const dialog = { open: false };
  const win = { Notification: N.Notification };
  const api = new Function(
    'window', 'Notification', 'localStorage', 'Date', 'setTimeout', 'clearTimeout', '$', 'askConfirm', 'relayText',
    `${IMPL_SRC}\nreturn {notifyAtPlan,notifyAtPut,notifyAtDrop,notifyAtTriage,notifyAtSchedule,notifyAtCancel,notifyAtBoot,notifyAtFire,shellNotify,shellNotifyPermission,NOTIFY_AT_MAX_MS,NOTIFY_AT_GRACE_MS,NOTIFY_AT_KEY};`,
  )(win, N.Notification, store, clock.Date, clock.setTimeout, clock.clearTimeout,
    () => dialog, (text, label) => { confirms.push({ text, label }); return Promise.resolve(true); }, relayText);
  return { ...api, clock, store, shown: N.shown, asked: N.asked, confirms, dialog, Notification: N.Notification };
}

// The pure block on its own, to prove it really is DOM-free: if any rule below ever reaches
// for localStorage/window/setTimeout, instantiating this throws instead of quietly working
// because the browser globals happened to exist.
function loadPure() {
  const src = slice('/* NOTIFY-SCHED-START', '/* NOTIFY-SCHED-END */', 'the pure scheduling block');
  return new Function(`${src}\nreturn {notifyAtPlan,notifyAtPut,notifyAtDrop,notifyAtTriage,NOTIFY_AT_MAX_MS,NOTIFY_AT_GRACE_MS};`)();
}
const P = loadPure();

// ── source pins: the R3 contract this feature had to not break ───────────────────────────
test('R3: the scheduled kind reuses the ONE notification path — there is no second copy', () => {
  const shell = codeOnly(SHELL);
  assert.equal([...shell.matchAll(/new Notification\(/g)].length, 1,
    'exactly one place constructs a Notification; a second is a second permission story');
  assert.equal([...shell.matchAll(/Notification\.requestPermission\(/g)].length, 1,
    'and exactly one place asks for the grant');
  assert.match(shell, /async function shellNotify\(/, 'the shared fire-now path must stay a named function');
  assert.match(shell, /async function shellNotifyPermission\(/, 'and the shared permission path');
  // The fire-now kind must not have kept an inline copy of the permission dance.
  assert.match(NOTIFY_BRANCHES, /m\.kind==='notify'\)\{[\s\S]*?reply\(await shellNotify\(m\)\)/,
    "the 'notify' kind answers through shellNotify, not through its own Notification code");
});

test('R3/R5: every notify branch answers through reply(), and every failure leads with a code', () => {
  assert.equal(/postMessage/.test(NOTIFY_BRANCHES), false,
    'a second postMessage helper here is a second mapping; use the broker-wide reply()');
  for (const kind of ['notify-at', 'notify-cancel']) {
    assert.ok(NOTIFY_BRANCHES.includes(`m.kind==='${kind}'`), `${kind} must be a real broker kind`);
  }
  const failures = [...NOTIFY_BRANCHES.matchAll(/\{ok:false,(.{0,24})/g)].map((m) => m[1]);
  assert.ok(failures.length >= 1, 'the cancel branch refuses a missing tag — that reply must be present');
  for (const f of failures) assert.match(f, /^code:/, `a notify failure without a code: {ok:false,${f}…`);
});

test('the persisted schedules are actually re-armed at shell load — otherwise persistence is dead code', () => {
  const shell = codeOnly(SHELL);
  assert.match(shell, /\nnotifyAtBoot\(\);/, 'notifyAtBoot() must be CALLED at top level, not merely defined');
  assert.match(shell, /localStorage\.setItem\(NOTIFY_AT_KEY/, 'pending schedules must be written to localStorage');
});

// ── the rules, run ───────────────────────────────────────────────────────────────────────
test('plan: a schedule needs a tag — without one, a restarted timer would stack a second alarm', () => {
  for (const m of [{}, { tag: '' }, { tag: '   ' }, { tag: 7 }]) {
    const g = P.notifyAtPlan({ ...m, inMs: 1000 }, 0);
    assert.equal(g.ok, false);
    assert.equal(g.code, 'bad-request');
    assert.match(g.error, CJK, 'house style is bilingual');
  }
});

test('plan: an absurd or non-finite delay is REFUSED with a code, never armed', () => {
  const now = 1_000_000;
  const bad = [
    { tag: 't' },                                   // no time at all
    { tag: 't', inMs: NaN },
    { tag: 't', inMs: Infinity },
    { tag: 't', inMs: '5000' },                     // a string is not a delay
    { tag: 't', at: 'soon' },
    { tag: 't', inMs: P.NOTIFY_AT_MAX_MS + 1 },     // past the 24h cap
    { tag: 't', inMs: 2 ** 31 },                    // the setTimeout wrap that fires INSTANTLY
    { tag: 't', at: now - 10 * 60 * 1000 },         // long past
  ];
  for (const m of bad) {
    const g = P.notifyAtPlan(m, now);
    assert.equal(g.ok, false, `must refuse ${JSON.stringify(m)}`);
    assert.equal(g.code, 'bad-request', `and with a code: ${JSON.stringify(m)}`);
    assert.match(g.error, CJK);
    assert.equal(g.rec, undefined, 'a refused plan carries no record to arm (R14)');
  }
});

test('plan: inMs and at both work, inMs wins, and the text is clamped', () => {
  const now = 1_000_000;
  assert.equal(P.notifyAtPlan({ tag: 'p', inMs: 1500 }, now).rec.at, now + 1500);
  assert.equal(P.notifyAtPlan({ tag: 'p', at: now + 2500 }, now).rec.at, now + 2500);
  assert.equal(P.notifyAtPlan({ tag: 'p', inMs: 1500, at: now + 999_999 }, now).rec.at, now + 1500,
    'a delay cannot disagree with the shell clock; the absolute time can');
  const rec = P.notifyAtPlan({ tag: 'x'.repeat(300), inMs: 0, title: 'T'.repeat(999), body: 'B'.repeat(999) }, now).rec;
  assert.ok(rec.tag.length <= 64 && rec.title.length <= 200 && rec.body.length <= 200, 'an app cannot bloat the store');
  assert.equal(P.notifyAtPlan({ tag: 'p', inMs: 0 }, now).ok, true, 'zero delay is legal — "ring now, from the shell"');
});

test('put: the same tag REPLACES — one pomodoro, one bell', () => {
  const a = { tag: 'pomodoro', at: 10 }, b = { tag: 'pomodoro', at: 99 }, other = { tag: 'tea', at: 50 };
  const list = P.notifyAtPut(P.notifyAtPut(P.notifyAtPut([], a), other), b);
  assert.equal(list.filter((r) => r.tag === 'pomodoro').length, 1, 'never two alarms under one tag');
  assert.equal(list.find((r) => r.tag === 'pomodoro').at, 99, 'and it is the NEW time that survives');
  assert.equal(list.length, 2, 'a different tag is untouched');
  assert.deepEqual(P.notifyAtDrop(list, 'pomodoro').map((r) => r.tag), ['tea']);
});

test('triage: past-due beyond the grace window is DROPPED, not fired', () => {
  const now = 1_000_000;
  const t = P.notifyAtTriage([
    { tag: 'later', at: now + 60_000 },
    { tag: 'justmissed', at: now - 5_000 },                        // the page was reloading
    { tag: 'stale', at: now - P.NOTIFY_AT_GRACE_MS - 1 },          // lunch happened
    { tag: 'corrupt', at: 'nonsense' },
    { at: now + 1000 },                                            // no tag
    null,
    { tag: 'impossible', at: now + P.NOTIFY_AT_MAX_MS + 1 },       // could not have been created
  ], now);
  assert.deepEqual(t.pending.map((r) => r.tag), ['later']);
  assert.deepEqual(t.due.map((r) => r.tag), ['justmissed']);
  assert.equal(t.stale.length, 5, 'stale, corrupt, tagless, null and impossible all get dropped');
  assert.equal(t.due.length + t.pending.length, 2, 'nothing else may ring');
});

// ── the whole thing, run ─────────────────────────────────────────────────────────────────
test('FUNCTIONAL: a scheduled notification fires at the right time, with the right content', async () => {
  const s = bootShell();
  const g = await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 25 * 60 * 1000, title: 'Focus session complete', body: '25 min done.' });
  assert.equal(g.ok, true);
  assert.equal(g.replaced, false);
  assert.equal(g.at, s.clock.now() + 25 * 60 * 1000);

  s.clock.advance(25 * 60 * 1000 - 1);
  await flush();
  assert.equal(s.shown.length, 0, 'it must not ring early');

  s.clock.advance(1);
  await flush();
  // requireInteraction: an alarm banner that fades on its own is as missable as a single beep.
  assert.deepEqual(s.shown, [{ title: 'Focus session complete', body: '25 min done.', tag: 'pomodoro', icon: undefined, requireInteraction: true }]);
  assert.deepEqual(s.store.pending(), [], 'a spent alarm removes itself, so a later reload cannot re-ring it');
});

test('FUNCTIONAL: THE POINT — the alarm fires after the app that asked for it is destroyed', async () => {
  // Leaving an app sets its iframe to about:blank: its window, its interval and its
  // AudioContext are gone. The shell instance below is untouched by that — which is the
  // entire reason this kind exists. Modelled by scheduling and then dropping every
  // reference the "app" had, before time moves at all.
  const s = bootShell();
  let app = { alive: true, timer: s.clock.setTimeout(() => { app.rang = true; }, 60_000) };
  await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 60_000, title: 'Focus session complete', body: 'x' });
  s.clock.clearTimeout(app.timer);          // the app is torn down: its own timer dies with it
  app = null;

  s.clock.advance(60_000);
  await flush();
  assert.equal(s.shown.length, 1, 'the shell rang even though the app no longer exists');
  assert.equal(s.shown[0].title, 'Focus session complete');
});

test('FUNCTIONAL: scheduling the same tag again REPLACES — restarting a pomodoro never stacks bells', async () => {
  const s = bootShell();
  await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 10_000, title: 'first', body: '' });
  const g = await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 30_000, title: 'second', body: '' });
  assert.equal(g.replaced, true, 'the reply says a pending alarm was displaced');
  assert.equal(s.store.pending().length, 1, 'one tag, one stored record');

  s.clock.advance(10_000);
  await flush();
  assert.equal(s.shown.length, 0, 'the FIRST deadline must be dead');
  s.clock.advance(20_000);
  await flush();
  assert.deepEqual(s.shown.map((n) => n.title), ['second'], 'exactly one bell, at the new time');
});

test('FUNCTIONAL: cancel actually cancels, and is idempotent', async () => {
  const s = bootShell();
  await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 10_000, title: 'nope', body: '' });
  assert.equal(s.notifyAtCancel('pomodoro'), true, 'true = something was pending');
  assert.deepEqual(s.store.pending(), [], 'and it left the store too, so a reload cannot revive it');
  assert.equal(s.notifyAtCancel('pomodoro'), false, 'a second cancel reports nothing pending — not an error');
  assert.equal(s.notifyAtCancel('never-scheduled'), false);

  s.clock.advance(60_000);
  await flush();
  assert.equal(s.shown.length, 0, 'a cancelled alarm never rings');
});

test('FUNCTIONAL: a refused schedule arms NOTHING and stores NOTHING (R14: no vacuous success)', async () => {
  const s = bootShell();
  for (const m of [{ inMs: 1000 }, { tag: 'p' }, { tag: 'p', inMs: 48 * 3600 * 1000 }, { tag: 'p', inMs: 'soon' }]) {
    const g = await s.notifyAtSchedule(m);
    assert.equal(g.ok, false, `must refuse ${JSON.stringify(m)}`);
    assert.equal(g.code, 'bad-request');
  }
  assert.equal(s.clock.armed(), 0, 'no timer was armed by any of them');
  assert.deepEqual(s.store.pending(), []);
  s.clock.advance(72 * 3600 * 1000);
  await flush();
  assert.equal(s.shown.length, 0);
});

test('FUNCTIONAL: no permission → the SCHEDULE is refused, coded, while the app is still there to be told', async () => {
  // The grant is asked for at schedule time on purpose: the tap that started the timer is
  // the only user gesture there will be — at fire time the user is somewhere else entirely.
  const s = bootShell({ permission: 'denied' });
  const g = await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 1000, title: 'x', body: '' });
  assert.equal(g.ok, false);
  assert.equal(g.code, 'denied');
  assert.equal(g.permission, 'denied');
  assert.equal(s.clock.armed(), 0, 'an alarm that can never ring must not be armed');
  assert.deepEqual(s.store.pending(), [], 'nor stored, or a reload would resurrect it');
  // …and the app is handed a sentence it can print, via the one mapper.
  const shown = relayFail(g, 0, 'content');
  assert.ok(shown.text.length > 0);
  assert.match(shown.text, CJK, 'bilingual, house style');
});

test('FUNCTIONAL: the grant is requested when it is still "default" — that is what makes the prompt possible', async () => {
  const s = bootShell({ permission: 'default' });
  s.Notification.requestPermission = async () => { s.asked.push(1); s.Notification.permission = 'granted'; return 'granted'; };
  const g = await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 1000, title: 'x', body: '' });
  assert.equal(g.ok, true);
  assert.equal(s.asked.length, 1, 'asked exactly once, at schedule time');
});

// ── persistence across a shell reload ────────────────────────────────────────────────────
test('FUNCTIONAL: a reload does not lose the alarm — a pending schedule is re-armed by the next shell', async () => {
  const first = bootShell();
  await first.notifyAtSchedule({ tag: 'pomodoro', inMs: 20 * 60 * 1000, title: 'Focus session complete', body: '25 min done.' });
  assert.equal(first.store.pending().length, 1);

  // Reload: a NEW shell instance over the SAME localStorage, 5 minutes later.
  const clock = mkClock(first.clock.now() + 5 * 60 * 1000);
  const second = bootShell({ storage: first.store, clock });
  assert.equal(second.clock.armed(), 1, 'the surviving schedule was re-armed at boot');
  assert.equal(second.shown.length, 0, 'and NOT fired early');

  second.clock.advance(15 * 60 * 1000);
  await flush();
  assert.deepEqual(second.shown.map((n) => n.title), ['Focus session complete'], 'it rang at the original deadline');
});

test('FUNCTIONAL: a past-due schedule is DROPPED at boot, not fired — a stale pomodoro bell is noise', async () => {
  const now = 1_700_000_000_000;
  const store = mkStorage([
    { tag: 'stale', at: now - 3 * 3600 * 1000, title: 'from breakfast', body: '' },
    { tag: 'pomodoro', at: now - 2_000, title: 'rang during the reload', body: '' },
    { tag: 'later', at: now + 5_000, title: 'still coming', body: '' },
  ]);
  const s = bootShell({ storage: store, clock: mkClock(now) });
  await flush();
  assert.deepEqual(s.shown.map((n) => n.title), ['rang during the reload'],
    'only the one that came due inside the grace window fires; the 3-hour-old one is dropped');
  assert.deepEqual(s.store.pending().map((r) => r.tag), ['later'], 'the store keeps only what is still pending');

  s.clock.advance(5_000);
  await flush();
  assert.deepEqual(s.shown.map((n) => n.title), ['rang during the reload', 'still coming']);
});

test('FUNCTIONAL: a corrupt or unreadable store degrades to "no alarms", never to a wrong one', async () => {
  const box = new Map([['pa_notify_at', '{not json']]);
  const store = {
    getItem: (k) => (box.has(k) ? box.get(k) : null),
    setItem: (k, v) => { box.set(k, String(v)); },
    pending: () => JSON.parse(box.get('pa_notify_at') || '[]'),
  };
  const s = bootShell({ storage: store });                       // must not throw at boot
  assert.equal(s.clock.armed(), 0);
  const g = await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 1000, title: 'ok', body: '' });
  assert.equal(g.ok, true, 'and the shell still works afterwards');
  s.clock.advance(1000);
  await flush();
  assert.equal(s.shown.length, 1);
});

test('R5: a failure at FIRE time reaches the user in shell chrome — the app that asked is gone', async () => {
  const s = bootShell();
  await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 1000, title: 'Focus session complete', body: '25 min done.' });
  s.Notification.permission = 'denied';                          // revoked while the timer ran
  s.clock.advance(1000);
  await flush();
  assert.equal(s.shown.length, 0, 'the OS notification could not be shown');
  assert.equal(s.confirms.length, 1, 'so it was surfaced in the shell instead of swallowed');
  assert.match(s.confirms[0].text, /Focus session complete/, 'the alarm still says what it was');
  assert.match(s.confirms[0].text, CJK, 'and the reason is the mapper\'s bilingual sentence');
});

test('R5: the fire-time fallback never steals a confirm the user is already answering', async () => {
  const s = bootShell();
  await s.notifyAtSchedule({ tag: 'pomodoro', inMs: 1000, title: 'x', body: '' });
  s.Notification.permission = 'denied';
  s.dialog.open = true;                                          // an approve/deny dialog is on screen
  s.clock.advance(1000);
  await flush();
  assert.equal(s.confirms.length, 0, 'a decision in progress outranks the alarm');
});

// ── the consuming side ───────────────────────────────────────────────────────────────────
// The Productivity Hub is the owner's live instance (gitignored personal data), so this pins
// it only when present — the same guard test/speech-broker.test.mjs uses for todo-voice.
test('live-instance: the Productivity Hub schedules in the shell and cancels on pause/reset', () => {
  const live = path.join(ROOT, 'workspace', 'apps', 'productivity-hub', 'index.html');
  if (!fs.existsSync(live)) return;   // fresh checkout has no instance — correct to skip
  const app = fs.readFileSync(live, 'utf8');
  const code = codeOnly(app);

  assert.match(code, /kind:'notify-at'/, 'the pomodoro must arm the SHELL timer');
  assert.match(code, /kind:'notify-cancel'/, 'and be able to disarm it');
  assert.equal(/kind:'notify'[,}]/.test(code), false,
    'the fire-now call is gone: it could only ever fire while the app was still alive');

  // The end time must survive the app being destroyed, or reopening resets the countdown.
  assert.match(code, /state\.pomo\.timer\s*=\s*\{/, 'pomoEndTime must be persisted in saved state');
  assert.match(code, /endTime:\s*pomoRunning\s*\?\s*pomoEndTime/, 'and it is the real end time that is saved');
  // Scoped to restorePomo's own body: `runPomoUntil(endTime)` elsewhere in the file would
  // otherwise be satisfied by the function's own declaration line.
  const restore = code.slice(code.indexOf('function restorePomo()'), code.indexOf('function pomoTick()'));
  assert.ok(restore.length > 100, 'restorePomo must stay findable, ahead of pomoTick');
  assert.match(restore, /t\.running/, 'the saved running flag is what decides');
  assert.match(restore, /runPomoUntil\(endTime\)/, 'a still-running pomodoro resumes rather than resetting');
  assert.match(restore, /finishPomo\(\{ alreadyRang: true \}\)/,
    'and one that came due while the app was gone settles WITHOUT ringing a second time');

  // Every path that stops the clock must also stop the alarm.
  for (const fn of ['function pausePomo()', 'function resetPomo()']) {
    const from = code.indexOf(fn);
    assert.ok(from > 0, `${fn} must stay findable`);
    const body = code.slice(from, code.indexOf('\n}', from));
    assert.match(body, /cancelPomoAlarm\(\)/, `${fn} must cancel the shell alarm`);
  }
  // …and the mode buttons stop it through resetPomo.
  const mode = code.slice(code.indexOf('function setPomoMode('), code.indexOf('function getModeSecs('));
  assert.match(mode, /resetPomo\(\)/, 'changing mode goes through resetPomo, which cancels');

  // R14: a refused schedule must not look like an armed one.
  assert.match(code, /r\.ok === false/, 'the schedule reply is checked');
  assert.match(code, /setPomoNote\(/, 'and a refusal is shown to the user, not dropped (R5)');

  // The in-app bell stays for when the app IS open, with the reason written down.
  // The app's bell was REMOVED on purpose: the shell now rings via sound:true, and it is
  // alive whether the app is open or not — keeping the app's copy double-rang (R1/R3).
  assert.equal(/function ringBell\(/.test(code), false, "the app's own bell must be gone");
    assert.match(code, /sound: state\.pomo\.alarm/, 'the app opts into a CHOSEN shell-played tone');
    assert.match(code, /'morning-bird'/, 'falling back to the default when nothing is saved');
});

// ── Why a notification was refused ──
// SCAR: a refusal reported the raw permission state ("Notification permission denied"), which
// hides which of two very different causes applied. An INSECURE ORIGIN (http://<lan-ip>:8787)
// cannot even ask — the browser auto-denies and never prompts — so telling the user to allow
// it in settings is advice they cannot act on; the fix is the https:// address. A real denial
// IS a settings change, and the browser will not re-prompt. Same split as speechReason().
test('a refusal names the remedy that actually applies', () => {
  const src = readShell(ROOT);
  const fn = src.slice(src.indexOf('async function shellNotifyPermission()'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /window\.isSecureContext/, 'the two causes must be told apart');
  assert.match(body, /https:\/\//, 'an insecure origin must be pointed at the https address');
  assert.match(body, /browser settings/, 'a real denial must be pointed at settings');
  assert.equal(/error:'Notification permission '\+perm/.test(body), false,
    'the raw permission state is not a remedy');
  for (const half of [/通知被阻止/, /通知需要安全连接/]) assert.match(body, half, 'both halves stay bilingual');
});

// ── The alarm TONE ──
// A notification's own sound is an OS setting the page cannot control, and the Notification
// API has no working custom-sound option — so "it notified you" and "you heard it" are
// different guarantees. sound:true opts a schedule into a tone the SHELL plays, for the same
// reason the shell holds the timer: by fire time the app is gone and its AudioContext with it.
test('sound is opt-in and travels with the schedule', () => {
  const now = 1000;
  assert.equal(P.notifyAtPlan({ tag: 't', inMs: 60, sound: true }, now).rec.sound, 'morning-bird', 'true means the default tone');
  assert.equal(P.notifyAtPlan({ tag: 't', inMs: 60, sound: 'ocean-wave' }, now).rec.sound, 'ocean-wave', 'a known name is honoured');
  assert.equal(P.notifyAtPlan({ tag: 't', inMs: 60 }, now).rec.sound, '', 'silent by default');
  assert.equal(P.notifyAtPlan({ tag: 't', inMs: 60, sound: 'yes' }, now).rec.sound, '',
    'an unknown name is SILENT, not a surprise substitute — a typo must be visible (R14)');
  assert.equal(P.notifyAtPlan({ tag: 't', inMs: 60, sound: true }, now).rec.repeat, 3, 'repeats by default');
  assert.equal(P.notifyAtPlan({ tag: 't', inMs: 60, sound: true, repeat: 99 }, now).rec.repeat, 10, 'capped');
  assert.equal(P.notifyAtPlan({ tag: 't', inMs: 60, sound: true, repeat: 0 }, now).rec.repeat, 3, 'nonsense falls back');
});

test('the flag survives a reload — it is part of the persisted record', () => {
  const rec = P.notifyAtPlan({ tag: 'pomodoro', inMs: 60, sound: true }, 1000).rec;
  const back = JSON.parse(JSON.stringify(P.notifyAtPut([], rec)))[0];
  assert.equal(back.sound, 'morning-bird', 'a reload must not silently downgrade the alarm to a banner');
  assert.equal(back.repeat, 3, 'nor drop the repeat that makes it hard to miss');
});

test('SOURCE: the tone is rung independently of the notification grant', () => {
  const src = readShell(ROOT);
  const fire = src.slice(src.indexOf('async function notifyAtFire(rec){'));
  const body = fire.slice(0, fire.indexOf('\n}'));
  const ring = body.indexOf('shellBell('), notify = body.indexOf('await shellNotify(');
  assert.ok(ring > 0 && notify > ring, 'ring BEFORE notifying — audio needs no permission');
  assert.match(body, /rec&&rec\.sound/, 'and only when the schedule asked for it');
  assert.match(body, /!g\.ok&&!rang/, 'the chrome fallback is for when NOTHING reached the user');
});

test('SOURCE: a blocked grant still arms a schedule that can be heard', () => {
  const src = readShell(ROOT);
  const sch = src.slice(src.indexOf('async function notifyAtSchedule(m){'));
  const body = sch.slice(0, sch.indexOf('\n}'));
  assert.match(body, /if\(!g\.ok&&!plan\.rec\.sound\) return g;/,
    'refuse only when nothing would reach the user');
  assert.match(body, /banner:g\.ok/, 'and tell the caller there will be no banner');
});

test('SOURCE: exactly one bell in the shell, and none left in the app', () => {
  const src = readShell(ROOT);
  // Count where an AudioContext is CONSTRUCTED, not the function name and not the
  // oscillators (there are many now, one per tone). A name-only pin let a renamed copy
  // through in mutation testing; this catches any second place that makes sound.
  assert.equal((src.match(/window\.AudioContext\|\|window\.webkitAudioContext/g) || []).length, 1,
    'exactly one place in the shell creates audio (R3)');
  assert.equal((src.match(/function shellBell\(/g) || []).length, 1);
  // Every offered tone must actually be playable — the names are pure data, the synthesis is not.
  const names = /const PA_TONE_NAMES=\[([^\]]+)\]/.exec(src)[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.equal(names.length, 5);
  for (const n of names) assert.ok(new RegExp("'" + n + "':\\(x,t\\)").test(src), n + ' is offered but has no synthesis');
  assert.match(src, /const PA_TONE_DEFAULT='morning-bird'/, 'the default is the bird');
  const app = path.join(ROOT, 'workspace/apps/productivity-hub/index.html');
  if (!fs.existsSync(app)) return;                       // fresh checkout: live instance absent
  const a = fs.readFileSync(app, 'utf8');
  assert.equal(/function ringBell\(/.test(a), false,
    "the app's own bell must be gone — the shell rings whether the app is open or not, so keeping it double-rings");
  assert.match(a, /sound: state\.pomo\.alarm/, 'and the app opts into a chosen tone');
});
