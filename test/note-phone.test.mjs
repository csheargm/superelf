// PANotePhone's two-finger tracker and phone-mode switch, without a browser · 手机模式的两指跟踪
// The component's own script, run against a stub window; the real pad is driven by note-phone-e2e.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../web/note-phone.inline.html', import.meta.url), 'utf8');
const JS = SRC.slice(SRC.indexOf('<script id="pnp-script">') + 24, SRC.lastIndexOf('</script>'));
function load(phone) {
  const window = { matchMedia: (q) => ({ matches: phone && q.includes('767.98px') && q.includes('coarse'), addEventListener() {} }), addEventListener() {} };
  new Function('window', JS)(window);
  return window.PANotePhone;
}
const ev = (type, id, x, y, isPrimary = false) => ({ type, pointerType: 'touch', pointerId: id, clientX: x, clientY: y, isPrimary, cancelable: true, preventDefault() {} });
function rig(P, allowed = true) {
  const log = { begin: 0, pan: [0, 0], zoom: [], end: 0 };
  const g = P.gesture({ allowed: () => allowed, begin: () => { log.begin++; return true; }, zoomNow: () => 1,
    pan: (dx, dy) => { log.pan[0] += dx; log.pan[1] += dy; }, zoom: (z) => log.zoom.push(z), end: () => { log.end++; } });
  return { g, log };
}

test('phone mode needs width under 768 AND a coarse pointer; it is false without matchMedia', () => {
  assert.equal(load(true).isPhone(), true);
  assert.equal(load(false).isPhone(), false);
  const w = {}; new Function('window', JS)(w); assert.equal(w.PANotePhone.isPhone(), false);
  assert.match(load(true).PHONE_MQ, /\(max-width: 767\.98px\) and \(pointer: coarse\)/);
});

test('one finger is never consumed; a second starts the gesture and every touch is its until all lift', () => {
  const { g, log } = rig(load(true));
  assert.equal(g.down(ev('pointerdown', 1, 100, 100, true)), false, 'one finger: the host routes it (ink)');
  assert.equal(g.move(ev('pointermove', 1, 101, 101)), false);
  assert.equal(g.down(ev('pointerdown', 2, 200, 100)), true, 'second finger: consumed');
  assert.equal(log.begin, 1, 'the host was told to drop what the first finger started');
  g.move(ev('pointermove', 1, 101, 50)); g.move(ev('pointermove', 2, 200, 50));
  assert.ok(log.pan[1] > 40, 'fingers moving up scroll down (positive dy)');
  assert.deepEqual(log.zoom, [], 'a parallel move does not zoom');
  assert.equal(g.up(ev('pointerup', 2, 200, 50)), true);
  assert.equal(g.move(ev('pointermove', 1, 101, 20)), true, 'the finger left down is still the gesture\'s, never a stroke');
  assert.equal(g.up(ev('pointerup', 1, 101, 20)), true); assert.equal(log.end, 1);
  assert.equal(g.down(ev('pointerdown', 3, 100, 100, true)), false, 'afterwards one finger inks again');
});

test('pinch: slop first, then clamped to fit..3x', () => {
  const P = load(true); const { g, log } = rig(P);
  g.down(ev('pointerdown', 1, 100, 100, true)); g.down(ev('pointerdown', 2, 200, 100));
  g.move(ev('pointermove', 2, 205, 100));
  assert.deepEqual(log.zoom, [], `under ${P.PINCH_SLOP * 100}% spread: no zoom`);
  g.move(ev('pointermove', 2, 220, 100)); g.move(ev('pointermove', 2, 340, 100));
  assert.ok(log.zoom.length && log.zoom.at(-1) > 1.9 && log.zoom.at(-1) <= 2.01, `2x (${log.zoom.at(-1)})`);
  g.move(ev('pointermove', 2, 2000, 100)); assert.equal(log.zoom.at(-1), 3, 'never past 3x');
  g.move(ev('pointermove', 2, 101, 100)); assert.equal(log.zoom.at(-1), 1, 'never under fit');
  assert.equal(P.clampZoom(NaN), 1); assert.equal(P.clampZoom(-2), 1); assert.equal(P.clampZoom(9), 3);
});

test('not allowed (iPad, desktop, a pen down): nothing is consumed', () => {
  const { g, log } = rig(load(false), false);
  assert.equal(g.down(ev('pointerdown', 1, 100, 100, true)), false);
  assert.equal(g.down(ev('pointerdown', 2, 200, 100)), false);
  assert.equal(g.move(ev('pointermove', 2, 300, 100)), false);
  assert.equal(g.up(ev('pointerup', 2, 300, 100)), false);
  assert.equal(log.begin, 0);
  const pen = { ...ev('pointerdown', 9, 1, 1, true), pointerType: 'pen' };
  assert.equal(rig(load(true)).g.down(pen), false, 'a pen is never the tracker\'s');
});

test('a lost pointerup cannot leave a ghost finger: a primary down starts over', () => {
  const { g, log } = rig(load(true));
  g.down(ev('pointerdown', 1, 100, 100, true));            // its up never arrives
  assert.equal(g.down(ev('pointerdown', 2, 100, 100, true)), false, 'the next first finger is one finger, not a pinch');
  assert.equal(log.begin, 0);
});

test('note-ui wires it: the routing asks the tracker first, and k carries the zoom only through zoomNow()', () => {
  const NU = fs.readFileSync(new URL('../web/note-ui.inline.html', import.meta.url), 'utf8');
  assert.match(NU, /<!--PA_NOTE_PHONE_UI-->/, 'note-ui carries the marker');
  assert.match(NU, /if\(phoneGest&&phoneGest\.down\(e\)\)\{ e\.preventDefault\(\); return; \}/);
  assert.match(NU, /if\(phoneGest&&phoneGest\.move\(e\)\) return;/);
  assert.match(NU, /if\(gestUp\) return;/);
  assert.match(NU, /k=kFit\*zoomNow\(\)/);
  assert.match(NU, /if\(!phoneOn\(\)\|\|!window\.PANotePhone\) return 1;/, 'off a phone the zoom is always 1');
  const WEB = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(WEB, /\{ marker: '<!--PA_NOTE_PHONE_UI-->', file: 'note-phone\.inline\.html' \}/);
});

test('GPT r1: the order two parallel moves arrive in never reads as a pinch', () => {
  const { g, log } = rig(load(true));
  g.down(ev('pointerdown', 1, 100, 300, true)); g.down(ev('pointerdown', 2, 200, 300));
  for (let y = 240; y >= 0; y -= 60) { g.move(ev('pointermove', 1, 100, y)); g.move(ev('pointermove', 2, 200, y)); }
  assert.deepEqual(log.zoom, [], 'one finger 60px ahead of the other is not a change of spread');
  assert.ok(log.pan[1] > 200, 'it is a scroll');
});

test('GPT r1: a pinch belongs to the note it started on; a pen mid-gesture freezes the page', () => {
  const NU = fs.readFileSync(new URL('../web/note-ui.inline.html', import.meta.url), 'utf8');
  assert.match(NU, /if\(!NB\|\|NB\.id!==id\)\{ liveZoom=0; return; \}/, 'endZoom drops a pinch whose note was replaced');
  assert.match(NU, /pan:\(dx,dy\)=>\{ if\(penId!==null\) return;/);
  assert.match(NU, /zoom:\(z,cx,cy\)=>\{ if\(penId!==null\|\|!NB\|\|NB\.id!==zoomId\) return;/);
  assert.match(NU, /const gestUp=e\.pointerType==='touch'&&!!phoneGest&&phoneGest\.up\(e\);[^\n]*\n\s+if\(tool==='select'\)\{/, 'a lift in Select still reaches the tracker');
});
