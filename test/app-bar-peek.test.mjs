// The app bar gets out of the way · 应用顶栏自动隐藏
//
// The shell's app bar carried three controls and a title, and charged a whole ROW to all 19 apps
// for them. Trimming its padding (57px -> 43px) shrank the row; it did not remove it, and the row
// was the waste: every app underneath already draws its own header.
//
// It cannot be moved INTO the app. Apps are cross-origin sandboxed iframes, so the shell can
// neither draw a button inside one nor observe a touch inside one. What it CAN do is stop
// occupying layout: the bar overlays the app and slides away, and a small shell-owned grabber
// sits on top of the iframe to bring it back.
//
// Two things make that safe rather than clever, and both are pinned here:
//   1. the bar must not consume layout in peek mode, or nothing was saved at all;
//   2. the grabber shadows a patch of every app it floats over, so it must stay small and
//      CENTRED. Measured across all 19 apps, 11 anchor chrome to the top or bottom edge — always
//      full-width rows whose controls sit at the left and right ends. The centre is title text.
//      A wide grabber, or one in a corner, lands on a real button in eleven apps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL } from './helpers-app.mjs';

const CSS = SHELL.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel) => {
  const i = CSS.indexOf(`\n${sel}{`);
  assert.ok(i >= 0, `the ${sel} rule is gone`);
  return CSS.slice(i, CSS.indexOf('}', i) + 1);
};
// The handle's size lives in web/bar-handle.css as custom properties (shared with PAAppBar, R3): resolve them.
const VARS = Object.fromEntries([...CSS.matchAll(/(--pa-[\w-]+):([^;}]+)/g)].map((m) => [m[1], m[2].trim()]));
const px = (s) => Number(/(-?[\d.]+)px/.exec(s.replace(/var\((--pa-[\w-]+)\)/g, (_, v) => VARS[v] || ''))?.[1]);

test('the bar stops occupying layout — this is the entire saving', () => {
  // If it stays in the flex column, it still costs the app 43px whether it is on screen or not,
  // and every other assertion here is decoration.
  const bar = rule('#frame.peek .bar');
  assert.match(bar, /position:absolute/, 'an in-flow bar still eats the row it was removed to reclaim');
  assert.match(rule('#frame'), /flex-direction:column/, 'the iframe is the only remaining flex child');
  assert.match(rule('#frame iframe'), /flex:1/, 'so it takes the height the bar gave up');
});

test('the hidden bar clears its own height, border included', () => {
  const bar = rule('#frame.peek .bar');
  const t = /translateY\((-?[\d.]+)%\)/.exec(bar);
  assert.ok(t, 'the bar hides by transform');
  // >100%, because the bottom border sits outside the box: at exactly -100% a 1px line stays
  // parked across the top of every app and reads as a rendering fault.
  assert.ok(Number(t[1]) < -100, `must clear its border too (found ${t[1]}%)`);
  assert.match(rule('#frame.peek.barin .bar'), /translateY\(0\)/, 'and comes back to rest at the top');
});

test('the grabber is centred and bounded, or it lands on a real button in 11 apps', () => {
  const g = rule('#barpeek');
  assert.match(g, /left:50%/, 'centred horizontally');
  assert.match(g, /translateX\(-50%\)/, 'and actually centred, not offset by its own width');
  const w = px(/width:[^;]+/.exec(g)[0]), h = px(/height:[^;]+/.exec(g)[0]);
  // Owner 2026-11-13: "a little longer and thicker, easy to tap" — 120x28 (web/bar-handle.css). Still under the
  // title text at 375px and iPad widths (test/bar-handle-e2e.test.mjs measures every app); wider lands on buttons.
  assert.ok(w >= 100 && w <= 130, `easy to tap, but not wide enough to shadow the app's own controls (found ${w}px)`);
  assert.ok(h >= 24 && h <= 32, `thick enough to hit, not the whole header row (found ${h}px)`);
  const grab = rule('#barpeek::before');
  assert.ok(px(/width:[^;]+/.exec(grab)[0]) >= 50 && px(/height:[^;]+/.exec(grab)[0]) >= 5, 'the visible grabber grew with it');
  // Only the grabber intercepts taps. The bar is off-screen, so if IT still took pointer events
  // the app would have a dead full-width strip along its top edge.
  assert.match(g, /position:absolute/, 'it floats over the iframe rather than displacing it');
  assert.match(rule('#frame.peek.barin #barpeek'), /pointer-events:none/,
    'and stands down while the bar is out, where it would sit on top of "← Home"');
});

test('the notch is still cleared, and counted once', () => {
  // The bar used to hold the safe-area inset. Now that it is absolutely positioned it holds
  // nothing, so the FRAME has to take that over or the app renders under the camera.
  assert.match(rule('#frame.peek'), /padding-top:env\(safe-area-inset-top/, 'the frame clears the notch');
  const bar = rule('#frame.peek .bar');
  assert.doesNotMatch(bar, /env\(safe-area-inset-top/,
    'the peek bar must NOT add the inset again — it is positioned inside the frame padding box');
});

// ── behaviour ────────────────────────────────────────────────────────────────────────────────
// The handlers are run, not read. A source-only test here would pass against a bar that shows and
// never hides, which is the whole feature.
function barModule() {
  // Ends on the blur REGISTRATION, not on the first ';' — the handler body contains one, so a
  // lazier pattern stopped mid-arrow and every behavioural test below failed to parse rather
  // than failing to hold.
  // Starts at the CONSTANT, not at the first statement: the retract delay is declared just above
  // and the handlers close over it, so an extraction that skipped it left them unrunnable.
  const src = /const BAR_IDLE_MS=[\s\S]*?addEventListener\('blur',\(\)=>\{[^}]*\}\);/.exec(SHELL);
  assert.ok(src, 'the bar behaviour must be extractable');
  const frame = { cls: new Set(), listeners: {} };
  // One node per selector, so a handler set as a PROPERTY (#fr's onfocus: a fresh #fr carries it,
  // web/app-frame.js) is found again by fire().
  const nodes = {};
  const node = (name) => nodes[name] || (nodes[name] = {
    classList: {
      add: (c) => frame.cls.add(c), remove: (c) => frame.cls.delete(c),
      contains: (c) => frame.cls.has(c),
    },
    style: {},
    addEventListener: (ev, fn) => { frame.listeners[name + ':' + ev] = fn; },
    querySelector: () => node('bar'),
  });
  const $ = (sel) => node(sel);
  const win = { addEventListener: (ev, fn) => { frame.listeners['win:' + ev] = fn; } };
  const timers = new Map(); let seq = 0;
  const api = new Function('$', 'addEventListener', 'setTimeout', 'clearTimeout', `
    ${src[0]}
    return { barShow, barHide, barShowTemporarily, frameOpen, peek:$('#barpeek') };`)(
    $, win.addEventListener,
    (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; },
    (id) => timers.delete(id),
  );
  return {
    ...api, frame, timers,
    shown: () => frame.cls.has('barin'),
    open: () => { frame.cls.add('peek'); },   // an app opens with the bar already away
    fire: (k) => { const [n, ev] = k.split(':'); const fn = frame.listeners[k] || (nodes[n] && nodes[n]['on' + ev]); return fn && fn(); },
    runTimers: () => { for (const t of [...timers.values()]) t.fn(); },
  };
}

test('an app opens with the bar already out of the way', () => {
  // It was shown on open at first, to teach the grabber. In use that was the wrong trade: it put
  // the row back on screen for every launch of every app, which is the cost this change removes.
  const open = /function openApp\([\s\S]*?\n\}/.exec(SHELL) || /function openApp\(.*/.exec(SHELL);
  assert.ok(open, 'openApp must be findable');
  assert.match(open[0], /classList\.add\('peek'\)/, 'the frame enters peek mode');
  assert.doesNotMatch(open[0], /'barin'/, 'and the bar is NOT shown with it');
  const m = barModule();
  m.open();
  assert.equal(m.shown(), false, 'so nothing is covering the app at launch');
});

test('the bar does not linger — a lingering bar reads as permanent', () => {
  // This is a discoverability argument, not a tidiness one. A bar that sits there sends the user
  // hunting for the way to dismiss it; one that leaves promptly teaches that it leaves.
  const ms = /const BAR_IDLE_MS=(\d+);/.exec(SHELL);
  assert.ok(ms, 'the delay is a named constant, not a literal buried in a setTimeout');
  assert.ok(Number(ms[1]) <= 3000, `must retract promptly (found ${ms[1]}ms)`);
  assert.ok(Number(ms[1]) >= 1200, `but long enough to read and aim at (found ${ms[1]}ms)`);
});

test('touching the app puts the bar away early — by two independent signals', () => {
  // A click into a cross-origin iframe is not observable from the shell; focus CROSSING into one
  // is, and two separate things report it. The iframe element's focus event is the one that can
  // be exercised by automation at all, so it must never be the missing half.
  // NEITHER fires for a tap on the note itself — the pad preventDefaults touchstart for the iOS
  // handwriting fix, and a default-prevented touch moves no focus. That is why the timer above
  // is the real dismissal path and these two are only an early exit.
  for (const signal of ['#fr:focus', 'win:blur']) {
    const m = barModule();
    m.open();
    m.barShowTemporarily();                                   // the user pulled it down
    assert.equal(m.shown(), true, 'the grabber shows it');
    m.fire(signal);
    assert.equal(m.shown(), false, `${signal} must put the bar away`);
  }
});

test('nothing hides the bar when no app is open', () => {
  // #frame's display:none lives in CSS, so an inline-style test answers "open" for a frame that
  // has never been opened, and a stray tab switch would fire barHide against Home.
  const m = barModule();
  assert.equal(m.frameOpen(), false, 'a frame with no app open is not open');
  m.fire('win:blur');
  assert.equal(m.shown(), false);
});

test('the grabber brings it back, and it leaves again by itself', () => {
  // On touch there is no pointerleave to hide on, and a bar needing a second tap to dismiss costs
  // more than it saves.
  const m = barModule();
  m.frame.cls.add('peek');
  m.barShowTemporarily();
  assert.equal(m.shown(), true, 'the grabber shows it');
  assert.equal(m.timers.size, 1, 'on a timer');
  m.runTimers();
  assert.equal(m.shown(), false, 'and it goes away unaided');
});

test('adjusting A-/A+ restarts the clock instead of vanishing mid-run', () => {
  const m = barModule();
  m.frame.cls.add('peek');
  m.barShowTemporarily();
  const first = [...m.timers.keys()][0];
  m.fire('bar:pointerdown');
  const now = [...m.timers.keys()];
  assert.equal(now.length, 1, 'still exactly one timer');
  assert.notEqual(now[0], first, 'but a fresh one — the countdown restarted');
  assert.equal(m.shown(), true, 'and the bar stayed');
});

test('a bar shown WITHOUT a countdown does not acquire one from a press inside it', () => {
  // The scar in miniature: clearTimeout leaves the id truthy, so after one use of the grabber the
  // "is it on a timer" flag never went false again, and a press inside a permanently-shown bar
  // started a 5s countdown against it.
  const m = barModule();
  m.open();
  m.barShowTemporarily(); m.runTimers();      // one earlier grabber use, now finished
  m.barShow();                                 // reopened, shown permanently
  m.fire('bar:pointerdown');
  assert.equal(m.timers.size, 0, 'a permanently-shown bar must not acquire a countdown');
  assert.equal(m.shown(), true);
});

// ── mutation guards ──────────────────────────────────────────────────────────────────────────
// Each pairs a mutation that MUST fail with a control that must NOT, so a guard that has stopped
// reading anything cannot pass by accident (R14).
const reruns = (src) => {
  const s = SHELL.replace(/\/\*[\s\S]*?\*\//g, '');
  return (mut) => {
    const after = s.replace(src, mut);
    assert.notEqual(after, s, `the mutation target is stale: ${src}`);
    return after;
  };
};

test('MUTATION — an in-flow bar is caught', () => {
  const mutate = reruns('#frame.peek .bar{ position:absolute;');
  const broken = mutate('#frame.peek .bar{ position:relative;');
  assert.doesNotMatch(
    broken.slice(broken.indexOf('\n#frame.peek .bar{')).split('}')[0],
    /position:absolute/, 'the mutation really removed it');
  // control
  assert.match(CSS.slice(CSS.indexOf('\n#frame.peek .bar{')).split('}')[0], /position:absolute/);
});

test('MUTATION — a grabber widened to the full bar is caught', () => {
  const g = rule('#barpeek');
  const widened = g.replace(/width:var\(--pa-handle-w\)/, 'width:100%');
  assert.notEqual(widened, g, 'the width declaration is still there to widen');
  assert.ok(!(px(/width:[^;]+/.exec(widened)[0]) <= 130), 'the widened grabber fails the bound');
  const w = px(/width:[^;]+/.exec(g)[0]);
  assert.ok(w <= 130, 'control: the real grabber is still bounded');
});
