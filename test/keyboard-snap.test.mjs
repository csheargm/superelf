// The shell must not scroll away from a box the user just tapped · 不要把刚点的输入框滚走
//
// visualViewport fires `resize` when the keyboard OPENS as well as when it closes. Apps live in an
// iframe, so the shell's activeElement is the IFRAME (verified in a real browser), which passed the
// old `not INPUT, not TEXTAREA` guard — and the handler scrolled to 0,0 while a keyboard opened.
// NOTE: this was believed to be the cause of "the keyboard covers the composer until I type". It
// was not — the symptom was unchanged on device after v3.6.2. The gate stays because scrolling
// while the keyboard is up is never wanted; these tests pin that decision, not a bug fix.
//
// These tests RUN the shipped handler against a stubbed window, because the thing being pinned is
// a decision — scroll or not — under specific viewport states, not a spelling.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);

// The handler as it existed before this fix, verbatim — the CONTROL arm.
const ORIGINAL = `(function(){
  const snap=()=>{ const t=document.activeElement?.tagName; if(t!=='INPUT'&&t!=='TEXTAREA') window.scrollTo(0,0); };
  window.visualViewport?.addEventListener('resize', ()=>setTimeout(snap,60));
  document.addEventListener('focusout', ()=>setTimeout(snap,60));
})();`;

const shipped = () => {
  const m = /\(function\(\)\{\n  \/\/ The visual viewport shrinks[\s\S]*?\n\}\)\(\);/.exec(SHELL);
  assert.ok(m, 'the shipped snap handler must be findable');
  return m[0];
};

// Run a handler source against a stubbed page and fire one viewport event. Returns how many times
// it scrolled. `innerHeight` vs `vvHeight` is the keyboard: a big gap means it is up.
function scrollsWhen(src, { innerHeight, vvHeight, activeTag, event = 'resize' }) {
  let scrolls = 0;
  const handlers = {};
  const vv = { height: vvHeight, addEventListener: (e, f) => { handlers['vv:' + e] = f; } };
  const win = { innerHeight, visualViewport: vv, scrollTo: () => { scrolls += 1; } };
  const doc = { activeElement: { tagName: activeTag }, addEventListener: (e, f) => { handlers['doc:' + e] = f; } };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', src)(win, doc, (f) => f());
  const fire = event === 'resize' ? handlers['vv:resize'] : handlers['doc:focusout'];
  assert.ok(fire, `the handler registered for ${event}`);
  fire();
  return scrolls;
}

const IPHONE = 844;               // layout viewport, keyboard or not
const KB_UP = 844 - 336;          // a typical iPhone software keyboard
const KB_DOWN = 844;

test('CONTROL: the original handler really did scroll away from a box inside an app', () => {
  // If this stops scrolling, the fix below is being measured against nothing.
  assert.equal(scrollsWhen(ORIGINAL, { innerHeight: IPHONE, vvHeight: KB_UP, activeTag: 'IFRAME' }), 1,
    'keyboard opening for a box inside an app -> scrollTo(0,0) -> the box is hidden again');
});

test('the keyboard opening for a box inside an app no longer scrolls', () => {
  assert.equal(scrollsWhen(shipped(), { innerHeight: IPHONE, vvHeight: KB_UP, activeTag: 'IFRAME' }), 0);
});

test('the reason the handler exists still works: it snaps back once the keyboard CLOSES', () => {
  // WebKit can leave the page panned after the keyboard goes away, showing a black band. That fix
  // must survive, or this change trades one iOS bug for an older one.
  assert.equal(scrollsWhen(shipped(), { innerHeight: IPHONE, vvHeight: KB_DOWN, activeTag: 'IFRAME' }), 1,
    'keyboard gone, focus left behind in the iframe -> snap back');
  assert.equal(scrollsWhen(shipped(), { innerHeight: IPHONE, vvHeight: KB_DOWN, activeTag: 'BODY', event: 'focusout' }), 1,
    'focus leaving an input with the keyboard down -> snap back');
});

test('a box in the shell itself is still never scrolled away from', () => {
  // The original guard, preserved: the shell's own inputs were never the problem.
  for (const tag of ['INPUT', 'TEXTAREA']) {
    assert.equal(scrollsWhen(shipped(), { innerHeight: IPHONE, vvHeight: KB_DOWN, activeTag: tag }), 0, tag);
  }
});

test('small viewport changes do not count as a keyboard', () => {
  // Safari's collapsing toolbar and an iPad hardware keyboard's shortcut bar shrink the visual
  // viewport too, by well under 100px. Treating those as "keyboard open" would switch the
  // black-band fix off for no reason.
  assert.equal(scrollsWhen(shipped(), { innerHeight: IPHONE, vvHeight: IPHONE - 60, activeTag: 'IFRAME' }), 1,
    'a 60px toolbar change still snaps back');
});
