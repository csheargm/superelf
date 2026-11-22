// PANote eraser: a HOVERING Apple Pencil must not erase（悬停的笔不擦除）. On M2-and-later iPads a
// Pencil held above the glass sends pointermove with buttons 0 and pressure 0. onMove used to erase
// on ANY pen move (`e.buttons||e.pointerType==='pen'`), so in the eraser tool strokes under a
// hovering nib vanished. The sequences below are SYNTHETIC, built from the recorder's own hover
// definition (web/pencil-log.inline.html: pointermove && !buttons && not touch). The harness stubs
// eraseAt, so "a stroke under the nib is kept" is "eraseAt was never called" (calls.erase === 0).
// The mutations rewrite the app's OWN onMove source and must turn a scenario red (R14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPad } from './helpers-panote-routing.mjs';

const PEN = { id: 43, pt: 'pen', y: 400 };
const HOVER = { buttons: 0, pressure: 0 };
const path = (pad, o, n = 6) => { for (let i = 0; i < n; i++) { pad.at(8); pad.move(pad.ink, { ...PEN, x: 300 + 5 * i, ...o }); } };

function hoverKeepsStrokes(o = {}) {
  const pad = runPad({ tool: 'erase', ...o });
  path(pad, HOVER);
  assert.equal(pad.calls.erase, 0, 'a hovering Pencil over a stroke erases nothing');
  assert.equal(pad.S.penId, null, 'and owns nothing');
}
function hoverAfterLiftKeepsStrokes(o = {}) {
  const pad = runPad({ tool: 'erase', ...o });
  pad.down(pad.ink, { ...PEN, x: 300 });
  path(pad, {}, 3);
  pad.up(pad.ink, { ...PEN, x: 315 });
  const erased = pad.calls.erase;
  assert.ok(erased >= 4, 'precondition: the contact erased along its path');
  path(pad, HOVER);
  assert.equal(pad.calls.erase, erased, 'the same Pencil, lifted and hovering, erases nothing more');
}
function contactsErase(o = {}) {
  const pen = runPad({ tool: 'erase', ...o });
  pen.down(pen.ink, { ...PEN, x: 300 });
  path(pen, {});
  assert.equal(pen.calls.erase, 7, 'control: a Pencil ON the glass erases at its down and every move');
  const mouse = runPad({ tool: 'erase', ...o });
  mouse.down(mouse.ink, { id: 1, pt: 'mouse', x: 300, y: 400 });
  path(mouse, { id: 1, pt: 'mouse' });
  assert.equal(mouse.calls.erase, 7, 'control: a mouse drag erases');
  const glide = runPad({ tool: 'erase', ...o });
  path(glide, { id: 1, pt: 'mouse', buttons: 0 });
  assert.equal(glide.calls.erase, 0, 'control: a mouse with no button pressed erases nothing');
}

test('eraser: a hovering Pencil (buttons 0, pressure 0) keeps the stroke under it', () => hoverKeepsStrokes());
test('eraser: a Pencil lifted after erasing, then hovering, erases nothing more', () => hoverAfterLiftKeepsStrokes());
test('eraser: contacts still erase — Pencil on the glass and a mouse drag', () => contactsErase());

const SHIPPED = 'if(e.buttons>0) eraseAt(e);';
const cut = (by) => (src) => { assert.ok(src.includes(SHIPPED), `the source still holds: ${SHIPPED}`); return src.split(SHIPPED).join(by); };
const red = (fn, o) => assert.throws(() => fn(o), assert.AssertionError);

test('MUTATION the old "any pen move erases" restored — CAUGHT by both hover scenarios', () => {
  const m = cut("if(e.buttons>0||e.pointerType==='pen') eraseAt(e);");
  contactsErase({ mutate: m });                                  // SURVIVED: contacts are not what it breaks
  red(hoverKeepsStrokes, { mutate: m });
  red(hoverAfterLiftKeepsStrokes, { mutate: m });
});
test('MUTATION the contact check removed — CAUGHT: hover and a buttonless mouse erase', () => {
  const m = cut('eraseAt(e);');
  red(hoverKeepsStrokes, { mutate: m });
  red(contactsErase, { mutate: m });
});
test('MUTATION the check reads pointerType instead of buttons — CAUGHT: a mouse drag stops erasing', () => {
  red(contactsErase, { mutate: cut("if(e.pointerType==='pen') eraseAt(e);") });
});
