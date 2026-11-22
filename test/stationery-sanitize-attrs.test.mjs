// Stationery attributes off the list · 信纸属性：保留、丢弃、拒绝 (ADR 0003, amendment 2026-10-12)
//
// SCAR (measured 2026-10-12, real CLI, Journal "Design with AI"): one Sonnet design in 14 was
// REJECTED — "attribute transform-origin is not allowed" — for three star paths written as
// transform="scale(0.7)" transform-origin="96.5 89.5". The person saw "Rejected · 已拒绝" and paid
// another ~2 minutes for Try again.
//
// The rule now gives every attribute one of three verdicts, and this file pins each:
//   KEPT     — on the list. transform-origin, transform-box, vector-effect and paint-order joined it,
//              each only in a plain keywords-and-numbers form (no URL, script or reference can fit).
//   DROPPED  — off the list and harmless (class, version, stroke-miterlimit …): left out of the output.
//   REJECTED — anything that could run code or reach outside the document, on ANY attribute, listed or
//              not. The danger rules run before the drop, so dropping never launders an attack.
// Fidelity (R14): the SHIPPED sanitizer, studio and picker run (helpers-stationery). Every danger case
// below is a CONTROL design that is accepted on its own, plus one dangerous attribute — so the
// rejection is the danger's doing, not the control's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStationery, loadStudio, mountStudio, scriptBody, DESIGNS_HTML, svg } from './helpers-stationery.mjs';
import { PROTO_KEYS } from './helpers-proto.mjs';

const S = loadStationery();
const flush = () => new Promise((r) => setImmediate(r));

// Run A's three stars, verbatim from the rejected reply, on a page background.
const STARS = [['M95,88 L96.5,84 L98,88 L102,89.5 L98,91 L96.5,95 L95,91 L91,89.5 Z', '0.7', '96.5 89.5'],
  ['M200,80 L201.5,76 L203,80 L207,81.5 L203,83 L201.5,87 L200,83 L196,81.5 Z', '0.8', '201.5 81.5'],
  ['M605,80 L606.5,76 L608,80 L612,81.5 L608,83 L606.5,87 L605,83 L601,81.5 Z', '0.8', '606.5 81.5']];
const RUN_A = svg('<rect width="816" height="1056" fill="#fbf8ff"/>'
  + STARS.map(([d, k, o]) => `<path d="${d}" transform="scale(${k})" transform-origin="${o}"/>`).join(''));

test('run A: transform-origin is KEPT and the design comes back intact, nothing dropped', () => {
  const r = S.sanitize(RUN_A);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.dropped, []);
  for (const [d, k, o] of STARS) assert.ok(r.svg.includes(`<path d="${d}" transform="scale(${k})" transform-origin="${o}"/>`), `star at ${o} unchanged`);
  assert.equal(S.sanitize(r.svg).svg, r.svg, 'the output is canonical');
});
test('run A through the user flow: Design → the draft is DRAWN, no "Rejected"', async () => {
  const { btn, say, drawn } = mountStudio(undefined, undefined, async () => ({ ok: true, text: 'Here it is:\n' + RUN_A, convoId: 'c1' }));
  btn('✨').click(); btn('Design ·').click(); await flush();
  assert.equal(drawn(), true, 'the preview is painted');
  assert.equal(say(), '', 'no message — before the fix this read "Rejected · 已拒绝 — attribute transform-origin is not allowed"');
});
test('MUTATION: without the transform-origin entry the origin is DROPPED — each star would move', () => {
  const M = loadStationery({ mutate: (s) => s.replace("'transform-origin':words(", "'x-origin':words(") });
  const r = M.sanitize(RUN_A);
  assert.deepEqual(r.dropped, ['transform-origin']);
  assert.doesNotMatch(r.svg, /transform-origin/, 'scale(0.7) about 0,0 puts the star at ~67,62 instead of 96.5,89.5');
});

// ── KEPT: the four presentation attributes, in their plain form ─────────────────────────────
const SHAPED_OK = { 'transform-origin': ['96.5 89.5', 'center', '50% 50%', 'left top', '10px 20px 0', '-3 .5', 'CENTER', '50PX 2', '1e2 2', '+5 2'],
  'transform-box': ['fill-box', 'view-box'], 'vector-effect': ['non-scaling-stroke', 'none'],
  'paint-order': ['stroke', 'stroke fill markers', 'normal'] };
// Harmless but not the plain form: dropped (a browser would ignore such a value anyway).
const SHAPED_ODD = { 'transform-origin': ['banana', '1 2 3 4', 'calc(1px)', 'url(#a)'], 'transform-box': ['padding-box'],
  'vector-effect': ['url(#m)'], 'paint-order': ['fill fill fill fill'] };
test('the four presentation attributes are on the contract the AI is given', () => {
  for (const a of Object.keys(SHAPED_OK)) assert.ok(S.ATTRS.includes(a), a);
  const m = loadStudio(S).designPrompt('x');
  for (const a of Object.keys(SHAPED_OK)) assert.ok(m.includes(' ' + a + ' ') || m.includes(' ' + a + ';'), `${a} in the prompt`);
});
test('a presentation attribute in its plain form is kept; any other form is dropped', () => {
  for (const [a, vs] of Object.entries(SHAPED_OK)) for (const v of vs) {
    const r = S.sanitize(svg(`<rect width="9" height="9" ${a}="${v}"/>`));
    assert.ok(r.ok && r.svg.includes(`${a}="${v}"`) && !r.dropped.length, `${a}="${v}" kept — ${r.reason}`);
  }
  for (const [a, vs] of Object.entries(SHAPED_ODD)) for (const v of vs) {
    const r = S.sanitize(svg(`<rect width="9" height="9" ${a}="${v}"/>`));
    assert.ok(r.ok, r.reason); assert.deepEqual(r.dropped, [a], `${a}="${v}"`); assert.ok(!r.svg.includes(a), `${a}="${v}" left out`);
  }
});
test('MUTATION: without the plain-form check, a reference rides in a kept attribute', () => {
  const M = loadStationery({ mutate: (s) => s.replace("SHAPED[name](v)?'':DROP", "''") });
  assert.match(M.sanitize(svg('<rect width="9" height="9" vector-effect="url(#m)"/>')).svg, /vector-effect="url\(#m\)"/);
});
// SCAR (R13 review): a first draft's /[a-z][a-z0-9+.-]*:\/\// took 11 s on the minified path below and 47 s on
// the letters, on the main thread, for a design that is otherwise fine. Each must be checked in linear time.
// (fill="none": the check is the point here; 70,000 segments drawn would be priced as an outline, ADR 0003 amendment 3)
const LONG = { 'a minified path (on the list)': `<path fill="none" d="M0-0${'l1-1'.repeat(70000)}"/>`,
  'letters in an off-list attribute': `<rect data-x="${'a'.repeat(290000)}"/>`,
  'digits in transform-origin': `<rect transform-origin="${'1'.repeat(290000)}x"/>` };
// R13 round 2: the duplicate-attribute check is quadratic per element, so an element may carry at most 64.
test('30,000 attributes on one element (290 KB) are refused at once, not checked pairwise', () => {
  const t0 = Date.now(), r = S.sanitize(svg(`<rect ${Array.from({ length: 30000 }, (_, i) => `a${i}=""`).join(' ')}/>`));
  assert.match(r.reason, /more than 64 attributes/); assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});
for (const [what, inner] of Object.entries(LONG)) {
  test(`300 KB of ${what} is checked in linear time`, () => {
    const t0 = Date.now(), r = S.sanitize(svg(inner)); assert.ok(r.ok, r.reason); assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  });
}

// ── filter / mask / clip-path: the budget sees an effect only through url(#id) (R13 round 2) ──
// filter="blur(30px) …" x80 is 1 KB and drew for 51 s in Chromium; the budget priced it as one element.
const BLUR = svg(`<rect width="816" height="1056" filter="${'blur(30px) '.repeat(80).trim()}"/>`);
test('a CSS function in filter, mask or clip-path is DROPPED; none and one url(#id) are kept', () => {
  const r = S.sanitize(BLUR); assert.equal(r.ok, true, r.reason); assert.deepEqual(r.dropped, ['filter']); assert.doesNotMatch(r.svg, /blur/);
  for (const [a, v] of [['mask', 'radial-gradient(red,transparent)'], ['clip-path', 'circle(40%)'], ['filter', 'url(#f) url(#f)']]) {
    assert.deepEqual(S.sanitize(svg(`<filter id="f"><feOffset dx="1"/></filter><rect width="9" height="9" ${a}="${v}"/>`)).dropped, [a], `${a}="${v}"`);
  }
  for (const v of ['none', 'url(#f)', ' url( #f ) ']) {
    const k = S.sanitize(svg(`<filter id="f"><feOffset dx="1"/></filter><rect width="9" height="9" filter="${v}"/>`));
    assert.ok(k.ok && !k.dropped.length && k.svg.includes(`filter="${v}"`), `filter="${v}" kept — ${k.reason}`);
  }
});
test('MUTATION: without the none-or-url(#id) form, the 51-second blur is kept', () => {
  const M = loadStationery({ mutate: (s) => s.replace("for(const k of ['filter','mask','clip-path']) SHAPED[k]=", 'for(const k of []) SHAPED[k]=') });
  assert.match(M.sanitize(BLUR).svg, /filter="blur\(30px\)/);
});

// ── DROPPED: off the list and harmless ─────────────────────────────────────────────────────
const HARMLESS = 'class="star" data-name="Layer 1" version="1.1" stroke-miterlimit="4" shape-rendering="crispEdges" filterUnits="userSpaceOnUse" marker-end="url(#m)"';
const CONTROL = svg(`<g ${HARMLESS} transform-origin="center"><rect width="9" height="9" fill="#fee" tabindex="0"/></g>`);
test('CONTROL: harmless off-list attributes are dropped, named, and the rest of the design is kept', () => {
  const r = S.sanitize(CONTROL);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.dropped, ['class', 'data-name', 'version', 'stroke-miterlimit', 'shape-rendering', 'filterUnits', 'marker-end', 'tabindex']);
  assert.match(r.svg, /<g transform-origin="center"><rect width="9" height="9" fill="#fee"\/><\/g>/);
  assert.deepEqual(S.sanitize(r.svg).dropped, [], 'the output is exactly on the list');
});
test('a scheme counts only at a boundary: "Metadata: v1" is text, dropped — not a data: URL', () => {
  assert.deepEqual(S.sanitize(svg('<rect width="9" height="9" aria-label="Metadata: v1"/>')).dropped, ['aria-label']);
});
test('MUTATION: without node.attrs=keep, the dropped attributes would be emitted', () => {
  const M = loadStationery({ mutate: (s) => s.replace('node.attrs=keep;', '') });
  assert.match(M.sanitize(CONTROL).svg, /class="star"/);
});
test('every bundled design is exactly on the list: nothing dropped', () => {
  let raw = []; new Function('PAStationery', scriptBody(DESIGNS_HTML))({ bundle: (l) => { raw = l; } });
  assert.ok(raw.length >= 10);
  for (const t of raw) assert.deepEqual(S.sanitize(t.svg, { maxBytes: S.BUNDLED_MAX_BYTES }).dropped, [], t.id);
});

// ── REJECTED: a danger mixed with harmless attributes still rejects the WHOLE design ───────
const DANGER = {
  'event handler': 'onclick="alert(1)"', 'event handler, upper case': 'ONLOAD="alert(1)"',
  'style attribute': 'style="fill:red"', 'style, upper case': 'STYLE="fill:red"', 'src to the web': 'src="https://evil.example/t.png"',
  'src, relative': 'src="t.png"', 'href off <use>': 'href="#a"', 'xlink:href': 'xlink:href="#a"', 'xml:base': 'xml:base="http://evil.example/"',
  'off-list url(http)': 'cursor="url(http://evil.example/c.cur)"', 'off-list url(relative)': 'cursor="url(c.svg#c)"',
  'off-list javascript:': 'data-x="javascript:alert(1)"', 'off-list data:': 'data-x="data:text/html,x"',
  'off-list bare URL': 'requiredExtensions="http://evil.example/x"', 'off-list //host': 'data-x="//evil.example/x"',
  'off-list CSS escape': 'data-x="u\\72l(x)"', 'off-list control char': 'data-x="a&#1;b"',
  'kept attribute, javascript:': 'transform-origin="javascript:alert(1)"', 'kept attribute, url(http)': 'paint-order="url(http://evil.example/p)"',
  'off-list java<TAB>script:': 'data-x="java&#9;script:alert(1)"', 'kept attribute, java<LF>script:': 'fill="java&#10;script:alert(1)"',
  'https: without slashes': 'data-x="https:evil.example"', 'C1 control': 'data-x="a&#x85;b"', 'DEL': 'data-x="a&#x7f;b"',
  srcset: 'srcset="t.png 1x"',
};
const placements = (d) => ({
  before: svg(`<g ${d} ${HARMLESS}><rect width="9" height="9"/></g>`),
  after: svg(`<g ${HARMLESS} ${d}><rect width="9" height="9"/></g>`),
  'deeper in the tree': svg(`<g ${HARMLESS}><g class="a"><rect width="9" height="9" vector-effect="none" ${d}/></g></g>`),
});
for (const [name, d] of Object.entries(DANGER)) {
  test(`rejects: ${name}, before, after or below harmless attributes`, () => {
    const control = placements('');
    for (const [where, input] of Object.entries(placements(d))) {
      assert.equal(S.sanitize(control[where]).ok, true, `CONTROL ${where}: the same tree without the danger is accepted`);
      const r = S.sanitize(input);
      assert.equal(r.ok, false, `${where}: rejected`); assert.ok(r.reason, where); assert.equal(r.svg, undefined, `${where}: no output at all`);
    }
  });
}
test('rejects: a forbidden ELEMENT beside harmless attributes is never dropped, the design is refused', () => {
  for (const el of ['<script/>', '<foreignObject/>', '<image width="9" height="9"/>', '<style/>', '<text>hi</text>', '<animate/>']) {
    const r = S.sanitize(svg(`<g ${HARMLESS}>${el}</g>`)); assert.equal(r.ok, false, el); assert.equal(r.svg, undefined, el);
  }
});
// Names an attacker controls must not find an object's PROTOTYPE (R13 review): `constructor` once
// matched a kept attribute, and `&constructor;` a known entity.
const PROTO = PROTO_KEYS.filter((n) => /^[A-Za-z]/.test(n));   // an attribute NAME starts with a letter
const PROTO_SVG = svg(`<g ${PROTO.map((n) => `${n}="transform-box"`).join(' ')}><rect width="9" height="9" constructor="1"/></g>`);
const namesOut = (out) => [...out.matchAll(/\s([A-Za-z][\w:.-]*)="/g)].map((m) => m[1]);
test('INVARIANT: every attribute in the output is on the list — prototype names included', () => {
  const r = S.sanitize(PROTO_SVG); assert.equal(r.ok, true, r.reason);
  for (const n of namesOut(r.svg)) assert.ok(S.ATTRS.includes(n) || n === 'xmlns' || n === 'href', `${n} is on the list`);
  assert.deepEqual(r.dropped, PROTO);
  for (const n of namesOut(S.sanitize(CONTROL).svg)) assert.ok(S.ATTRS.includes(n) || n === 'xmlns', n);
});
test('an entity named after a prototype member is unknown: rejected', () => {
  // decodeEnt reads at most 12 characters of a name; a longer one is a bare & whatever ENT holds, so it proves nothing.
  for (const e of PROTO_KEYS.filter((n) => n.length <= 12)) assert.match(S.sanitize(svg(`<rect fill="&${e};"/>`)).reason, new RegExp(`entity &${e};`), `&${e};`);
});
test('MUTATION: with a prototype, `constructor` is KEPT and `&constructor;` decodes to a function', () => {
  const M1 = loadStationery({ mutate: (s) => s.replace('const SHAPED=Object.assign(Object.create(null),', 'const SHAPED=Object.assign({},') });
  assert.match(M1.sanitize(PROTO_SVG).svg, /constructor="transform-box"/);
  const M2 = loadStationery({ mutate: (s) => s.replace('const ENT=Object.assign(Object.create(null),', 'const ENT=Object.assign({},') });
  assert.match(M2.sanitize(svg('<rect fill="&constructor;"/>')).svg, /fill="function Object\(\)/);
});
const ORDER = (s) => s.replace('const why=valueOk(name,v); if(why) return why;', 'if(!ATTRS.has(name)) return DROP; const why=valueOk(name,v); if(why) return why;');
const MUTANTS = [
  ['the style/src name rule', (s) => s.replace("if(/^(?:href|src|srcset|style)$/i.test(name)) return", 'if(false) return'), DANGER['style attribute']],
  ['the external-URL rule', (s) => s.replace("if(u.includes('://')||/", 'if(false&&/'), DANGER['off-list bare URL']],
  ['danger-before-drop (an off-list attribute dropped unchecked)', ORDER, DANGER['off-list url(http)']],
  ['danger-before-drop, javascript:', ORDER, DANGER['off-list javascript:']],
  ['stripping TAB/LF/CR before the scheme check', (s) => s.replace("const u=v.replace(/[\\t\\n\\r]/g,'');", 'const u=v;'), DANGER['off-list java<TAB>script:']],
];
for (const [rule, mutate, d] of MUTANTS) {
  test(`MUTATION: without ${rule}, the dangerous attribute is DROPPED and the design accepted`, () => {
    const input = placements(d).after;
    assert.equal(S.sanitize(input).ok, false, 'shipped: rejected');
    const r = loadStationery({ mutate }).sanitize(input); assert.equal(r.ok, true, 'mutant: accepted — ' + r.reason);
  });
}
