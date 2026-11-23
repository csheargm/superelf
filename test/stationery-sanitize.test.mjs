// Stationery templates are UNTRUSTED markup · 信纸模板是不可信的标记
//
// A bundled design is ours, but "My templates" can come from anywhere, an AI included, and every
// one of them is turned into an image inside the journal page. PAStationery.sanitize is a strict
// ALLOW-LIST over a parsed tree: every attack below is REJECTED, never repaired, and what it returns
// is RE-SERIALISED from the checked tree, so the bytes rendered are the bytes checked. (A HARMLESS
// attribute off the list is dropped instead: test/stationery-sanitize-attrs.test.mjs, ADR 0003.)
// Every rejection below names the attack it stands for; the key ones are mutation-tested — the
// rule is deleted from the shipped source and the same input is shown to get through.
// The render-cost budget (stationery-cost) is tested in test/stationery-sanitize-cost.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStationery, loadStill, withDesigns, svg, VB, scriptBody, GEOM_HTML, COST_HTML, SIMP_HTML, SAN_HTML, STN_HTML } from './helpers-stationery.mjs';

const S = loadStationery();

// The shared contract's allow-list, restated HERE on purpose: it is the designers' contract, and
// this test is what proves the sanitizer honours every word of it.
const CONTRACT_ATTRS = ('fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity '
  + 'fill-opacity stroke-opacity transform d x y x1 y1 x2 y2 cx cy r rx ry width height points offset stop-color '
  + 'stop-opacity gradientUnits gradientTransform patternUnits patternTransform viewBox id clip-path mask filter '
  + 'fill-rule stdDeviation baseFrequency numOctaves seed type values in in2 operator k1 k2 k3 k4 result mode '
  + 'scale xChannelSelector yChannelSelector dx dy flood-color flood-opacity preserveAspectRatio').split(' ');
const EVERY_ELEMENT = svg(
  '<defs><linearGradient id="lg" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient>'
  + '<radialGradient id="rg"><stop offset="1" stop-color="#eee" stop-opacity=".5"/></radialGradient>'
  + '<clipPath id="cp"><rect width="10" height="10"/></clipPath><mask id="mk"><circle r="4"/></mask>'
  + '<pattern id="pt" width="8" height="8" patternUnits="userSpaceOnUse"><ellipse rx="2" ry="1"/></pattern>'
  + '<filter id="fl"><feGaussianBlur stdDeviation="2"/><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="3"/>'
  + '<feDisplacementMap in="SourceGraphic" in2="t" scale="4" xChannelSelector="R" yChannelSelector="G"/>'
  + '<feColorMatrix type="saturate" values=".3"/><feOffset dx="1" dy="2"/><feBlend mode="multiply"/>'
  + '<feComposite operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/></filter>'
  // a second filter: one filter may hold at most 8 steps (the render-cost rules)
  + '<filter id="fl2"><feFlood flood-color="#fff" flood-opacity=".2" result="f"/><feMerge><feMergeNode in="f"/></feMerge></filter>'
  + '<g id="star" filter="url(#fl2)"><path d="M0 0L5 5Z"/></g></defs>'
  + '<g transform="translate(1 2)" clip-path="url(#cp)" mask="url(#mk)" filter="url(#fl)">'
  + '<line x1="0" y1="0" x2="9" y2="9" stroke="#000" stroke-width="1" stroke-dasharray="2 2"/>'
  + '<polyline points="0,0 5,5" fill="none"/><polygon points="0,0 5,5 0,5" fill="url(#pt)"/>'
  + '<rect x="1" y="1" width="5" height="5" rx="1" fill="url(#lg)"/><use href="#star" x="10" y="10"/>'
  + '<svg viewBox="0 0 10 10" width="10" height="10"><circle cx="5" cy="5" r="5" fill="url(#rg)"/></svg></g>');

test('every allow-listed element is accepted, and comes back re-serialised', () => {
  const r = S.sanitize(EVERY_ELEMENT);
  assert.equal(r.reason, '');
  assert.ok(r.ok);
  assert.equal(S.sanitize(r.svg).svg, r.svg, 'sanitizing the output is a no-op (it is canonical)');
  assert.match(r.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="816" height="1056" viewBox=/, 'root normalised');
});

test('every allow-listed attribute is accepted', () => {
  const val = (a) => (a === 'id' ? 'x1' : a === 'transform' ? 'scale(1)' : a === 'viewBox' ? '0 0 1 1' : '1');
  const attrs = CONTRACT_ATTRS.map((a) => `${a}="${val(a)}"`).join(' ');
  const r = S.sanitize(svg(`<g ${attrs}/>`));
  assert.ok(r.ok, r.reason);
});

test('a comment and an XML declaration are allowed and DROPPED; a scaled viewBox is allowed', () => {
  const r = S.sanitize('<?xml version="1.0" encoding="UTF-8"?>' + svg('<!-- note --><rect width="1" height="1"/>'));
  assert.ok(r.ok, r.reason);
  assert.doesNotMatch(r.svg, /note|<\?xml/);
  assert.ok(S.sanitize(svg('<rect width="1" height="1"/>', 'viewBox="0 0 408 528"')).ok, 'half scale is the same page');
});

const REJECT = {
  'script element': svg('<script>alert(1)</script>'),
  'empty script element': svg('<script/>'),
  'nested svg with script': svg('<svg viewBox="0 0 1 1"><script/></svg>'),
  'on* attribute': svg('<rect onclick="alert(1)" width="1"/>'),
  'on* on the root': svg('', VB + ' onload="alert(1)"'),
  foreignObject: svg('<foreignObject width="9" height="9"/>'),
  image: svg('<image width="9" height="9"/>'),
  'use href to http': svg('<use href="http://evil.example/x.svg#a"/>'),
  'use href javascript:': svg('<use href="javascript:alert(1)"/>'),
  'entity-encoded javascript:': svg('<use href="&#106;avascript:alert(1)"/>'),
  'xlink:href (namespaced)': svg('<g id="a"/><use xlink:href="#a"/>'),
  'href on a non-use element': svg('<g id="a"/><rect href="#a"/>'),
  'use pointing at nothing': svg('<use href="#nope"/>'),
  'style element': svg('<style>rect{fill:red}</style>'),
  'style attribute': svg('<rect style="fill:red"/>'),
  'url(http...)': svg('<rect fill="url(http://evil.example/p.svg#g)"/>'),
  'url(data:...)': svg('<rect fill="url(data:image/svg+xml,abc)"/>'),
  'url(relative file)': svg('<rect fill="url(p.svg#g)"/>'),
  'url with quotes': svg('<rect fill="url(\'#a\')"/>'),
  'CSS escape': svg('<rect fill="u\\72l(http://x)"/>'),
  'javascript: in any value': svg('<feColorMatrix values="javascript:alert(1)"/>'),
  DOCTYPE: '<!DOCTYPE svg [<!ENTITY x "y">]>' + svg('<rect fill="&x;"/>'),
  'unknown entity': svg('<rect fill="&xxe;"/>'),
  'bare ampersand': svg('<rect fill="a & b"/>'),
  'CDATA with script': svg('<![CDATA[<script>alert(1)</script>]]>'),
  'processing instruction': '<?xml-stylesheet href="http://x/s.css"?>' + svg(''),
  'namespaced attribute': svg('<rect foo:bar="1"/>'),
  'namespaced element': svg('<svg:rect/>'),
  'xmlns:xlink': svg('', VB + ' xmlns:xlink="http://www.w3.org/1999/xlink"'),
  'foreign xmlns': '<svg xmlns="http://www.w3.org/1999/xhtml" ' + VB + '/>',
  'text element': svg('<text>I love you</text>'),
  'stray text': svg('hello'),
  'duplicate attribute': svg('<rect fill="#000" fill="#fff"/>'),
  'more than 64 attributes on one element': svg(`<rect ${Array.from({ length: 65 }, (_, i) => `a${i}="1"`).join(' ')}/>`),
  'wrong root': '<g ' + VB + '/>',
  'html root': '<html><svg ' + VB + '/></html>',
  'two roots': svg('') + svg(''),
  'missing viewBox': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'wrong page shape': svg('', 'viewBox="0 0 1056 816"'),
  'offset viewBox': svg('', 'viewBox="10 0 816 1056"'),
  'unclosed element': '<svg ' + VB + '><g>',
  // wide, not deep (12 hops, inside the depth cap): it is the COST rule that must stop it
  'use expansion bomb': svg('<path id="l0" d="M0 0"/>' + Array.from({ length: 12 }, (_, i) =>
    `<g id="l${i + 1}"><use href="#l${i}"/><use href="#l${i}"/></g>`).join('') + '<use href="#l12"/>'),
  'use cycle': svg('<g id="a"><use href="#a"/></g>'),
  // over 300 KB in an attribute that is dropped (harmless otherwise): only the size cap refuses it
  oversize: svg(`<rect width="9" height="9" data-pad="${'x'.repeat(310 * 1024)}"/>`),
  'not a string': null,
};

for (const [name, input] of Object.entries(REJECT)) {
  test(`rejects: ${name}`, () => {
    const r = S.sanitize(input);
    assert.equal(r.ok, false, `${name} must be rejected`);
    assert.ok(r.reason, 'with a reason');
    assert.equal(r.svg, undefined, 'and no output at all — rejected, not repaired');
  });
}

test('modest <use> nesting is fine (a motif reused inside a reused corner)', () => {
  const r = S.sanitize(svg('<g id="leaf"><path d="M0 0L4 4"/></g><g id="corner"><use href="#leaf"/><use href="#leaf" x="9"/></g>'
    + '<use href="#corner"/><use href="#corner" transform="scale(-1 1)"/>'));
  assert.ok(r.ok, r.reason);
});

test('a bundled design may be at most 12 KB', () => {
  const big = svg(`<path d="M0 0${' L1 1'.repeat(3000)}"/>`);
  assert.ok(S.sanitize(big).ok, 'fine as a user template');
  assert.equal(S.sanitize(big, { maxBytes: S.BUNDLED_MAX_BYTES }).ok, false, 'too big to ship inline');
});

// ── Mutation tests: delete one rule from the SHIPPED source, show the attack gets through ──
const MUTANTS = [
  ['the element allow-list', (s) => s.replace("if(!ELEMENTS.has(m[1])) return err('element <'+m[1]+'> is not allowed');", ''), REJECT['empty script element']],
  // url(http…) also trips the external-URL rule, so the url() rule is shown on a relative reference only it catches
  ['the url() rule', (s) => s.replace("if(/url\\s*\\(/i.test(v.replace(", 'if(false&&(v.replace('), REJECT['url(relative file)']],
  // an off-list attribute is DROPPED when harmless, so the on* rule is the ONE thing that rejects a handler
  ['the event-handler rule', (s) => s.replace("if(/^on/i.test(name)) return 'event handler attribute '+name;", ''), REJECT['on* attribute']],
  ['the href rule', (s) => s.replace("el==='use'&&/^#[A-Za-z_][A-Za-z0-9_.-]*$/.test(v)?'':'href to anything but #id'", "''"), REJECT['href on a non-use element']],
  ['the script-URL rule', (s) => s.replace('if(/(?:^|[^a-z0-9+.-])(?:javascript|vbscript|data):/i.test(u))', 'if(false)'), REJECT['javascript: in any value']],
  ['the attribute cap', (s) => s.replace("if(node.attrs.length>=MAX_ATTRS) return", 'if(false) return'), REJECT['more than 64 attributes on one element']],
  ['the size cap', (s) => s.replace('if(byteLen(svg)>max)', 'if(false)'), REJECT.oversize],
  ['the use-bomb rule', (s) => s.replace('if(!(total(m)<=MAX_COST))', 'if(false)'), REJECT['use expansion bomb']],
];
for (const [rule, mutate, attack] of MUTANTS) {
  test(`mutation: without ${rule}, the attack gets through (so the rule is what stops it)`, () => {
    assert.equal(S.sanitize(attack).ok, false, 'shipped: rejected');
    assert.equal(loadStationery({ mutate }).sanitize(attack).ok, true, 'mutant: accepted');
  });
}
test('mutation: the <!DOCTYPE> and url() rules are the ones that answer', () => {
  // Each is also caught by a later layer, so the mutation is shown by the REASON changing.
  assert.match(S.sanitize(REJECT.DOCTYPE).reason, /DOCTYPE/);
  const m2 = loadStationery({ mutate: (s) => s.replace("if(src.startsWith('<!',i)) return err(", "if(false) return err(") });
  assert.doesNotMatch(m2.sanitize(REJECT.DOCTYPE).reason || '', /DOCTYPE/);
  assert.match(S.sanitize(REJECT['url(http...)']).reason, /url\(\) to anything but #id/);
  const m3 = loadStationery({ mutate: (s) => s.replace("if(/url\\s*\\(/i.test(v.replace(", 'if(false&&(v.replace(') });
  assert.match(m3.sanitize(REJECT['url(http...)']).reason, /external URL/, 'url(http…) is still refused, by the external-URL rule');
});

// ── The bundled designs obey the same contract ───────────────────────────────────────────
test('every bundled design passes the sanitizer at the 12 KB cap, and none was rejected', () => {
  const D = withDesigns(loadStationery());
  assert.deepEqual(D.rejected, [], 'no bundled design was rejected');
  const ids = D.list().map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const t of D.list()) {
    assert.match(t.name, /^[^A-Za-z]*[一-鿿][^·]* · [A-Za-z]/, `${t.id}: bilingual '中文 · English' name`);
    assert.ok(t.safe.w >= 300 && t.safe.h >= 300, `${t.id}: a real writing area`);
    assert.equal(t.dark, false);
    if (t.audience === 'teen') assert.doesNotMatch(t.svg, /<text\b/, `${t.id}: no pre-printed text for a teen`);
  }
});

// R13 round 4: the viewBox is read as a list, as every list in the budget is (CSS whitespace or commas). That
// accepts a leading or trailing comma, which main refused, and refuses a no-break space, which main read.
// Chromium reads none of these spellings: it ignores the viewBox and draws at scale 1 (getScreenCTM), so the
// budget, which prices the viewBox as written, never prices less than Chromium draws.
test('a root viewBox with a leading or trailing comma is accepted (Chromium ignores it: scale 1)', () => {
  for (const vb of [',0 0 816 1056', '0 0 816 1056,']) { const r = S.sanitize(svg('<rect width="9" height="9"/>', `viewBox="${vb}"`)); assert.ok(r.ok, `${vb}: ${r.reason}`); }
});
test('a root viewBox separated by no-break spaces is refused (Chromium ignores it: scale 1)', () => {
  for (const vb of ['0&#160;0&#160;816&#160;1056', '0&#8195;0&#8195;816&#8195;1056']) assert.match(S.sanitize(svg('<rect width="9" height="9"/>', `viewBox="${vb}"`)).reason, /viewBox/, vb);
});
// R13 round 4: FAIL CLOSED. Each component is its own <script>, and one that throws does not stop the next, as in a
// browser. Left without its readers or its budget, the chain throws and PAStationery is never defined, so no design
// can be drawn unchecked. The full set is the control: the same runner defines it.
test('fail closed: with stationery-geometry or stationery-cost left out, PAStationery is not defined', () => {
  const run = (parts) => { const window = { devicePixelRatio: 1 }, errors = [];
    for (const html of parts) { try { new Function('window', 'Image', 'document', scriptBody(html))(window, class {}, {}); } catch (e) { errors.push(e); } }
    return { window, errors }; };
  const all = run([GEOM_HTML, COST_HTML, SIMP_HTML, SAN_HTML, STN_HTML]);
  assert.deepEqual(all.errors, []); assert.equal(typeof all.window.PAStationery.sanitize, 'function', 'all five: defined');
  for (const [left, parts] of [['stationery-geometry', [COST_HTML, SIMP_HTML, SAN_HTML, STN_HTML]], ['stationery-cost', [GEOM_HTML, SIMP_HTML, SAN_HTML, STN_HTML]]]) {
    const r = run(parts); assert.equal(r.window.PAStationery, undefined, `without ${left}`); assert.ok(r.errors.length >= 1, `without ${left}: a script threw`);
  }
});
// simplify()'s steps carry no rule: a page served without them (web.mjs listing the new component only after a restart) still
// checks every design, and an over-budget draft is refused with sanitize()'s own reason, as before ADR 0003 amendment 5.
test('without stationery-simplify every design is still checked; an over-budget draft keeps sanitize()\'s own refusal', () => {
  const window = { devicePixelRatio: 1 };
  for (const html of [GEOM_HTML, COST_HTML, SAN_HTML, STN_HTML]) new Function('window', 'Image', 'document', scriptBody(html))(window, class {}, {});
  const S = window.PAStationery, over = svg('<g opacity="0.5"><circle cx="40" cy="40" r="9" fill="#fcc"/></g>'.repeat(460)), a = S.sanitize(over);
  assert.equal(S.sanitize(svg('<rect width="9" height="9"/>')).ok, true); assert.equal(a.over, true);
  assert.deepEqual(S.simplify(over), { ok: false, reason: a.reason, cost: a.cost }, 'no `over`: shown after "Rejected", never drawn');
  assert.equal(loadStill().simplify(over).ok, true, 'control: with the steps (and a clock that never moves — the deadline is proven in -deadline), the same draft is simplified');
});
test('mutation: sanitize never throws — a fault inside the checker is a reason, not an exception', () => {
  const M = loadStationery({ mutate: (s) => s.replace('function check(svg,o){', "function check(svg,o){ throw new RangeError('Maximum call stack size exceeded');") });
  const r = M.sanitize(svg('')); assert.equal(r.ok, false); assert.match(r.reason, /too complex to check/);
  const N = loadStationery({ mutate: (s) => s.replace('try{ return check(svg,o); }', 'return check(svg,o); try{ }')
    .replace('function check(svg,o){', "function check(svg,o){ throw new RangeError('boom');") });
  assert.throws(() => N.sanitize(svg('')), /boom/, 'without the catch, the same fault escapes to the caller');
});
