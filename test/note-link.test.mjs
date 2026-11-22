// Links in a note · 笔记链接 — the URL rule, the sanitizer's <a>, and the shell's open-url gate.
//
// The owner asked for a Link button beside B / I / U / S in the Journal. A link is the one thing
// in a note that can point OUT of it, so the address is the attack surface: javascript:, data:,
// vbscript: and file: must never reach an href, however they are spelled. ONE rule decides it,
// safeLinkHref in the DOM-free core of web/note-ui.inline.html, and the Link button, the sanitizer
// and the opener all call it. The shell re-checks the scheme on its own (it never trusts an app).
//
// What runs here is EXTRACTED from the shipped files and executed — nothing is re-implemented.
// The real-DOM half (the parser, contenteditable, the shell opening a tab) is
// test/note-link-e2e.test.mjs, in Chromium.
// R11 — searched: "safeLinkHref", "LINK_SCHEMES", "open-url", "OPEN_URL_OK", "createLink",
//   "allow-popups", "_blank" — no earlier link rule or opener existed (the shell's renderMd builds
//   its own <a> for chat answers in the TOP window, where there is no sandbox to cross).
//   The app gate: "open_url_apps", "links", "LINK_APPS", "frameUid" — no earlier per-app list existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, api } from './helpers-web.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

// The same DOM-free slice the other engine suites run (test/note-paste.test.mjs coreFrom).
function coreFrom(src) {
  const from = src.indexOf('  const SCHEMA=');
  const to = src.indexOf('\n  function Note(host, opts){');
  assert.ok(from > 0 && to > from, 'the engine core must stay a DOM-free block above function Note()');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(from, to)}
    return {safeLinkHref,linkInText,LINK_SCHEMES,LINK_TXT,LINK_REQ,cleanInto,HTML_TAGS};`)();
}
const G = coreFrom(ENGINE);

// ── The URL rule ─────────────────────────────────────────────────────────────────────────────
const ALLOWED = [
  ['https://example.com', 'https://example.com/'],
  ['http://example.com/a?b=1#c', 'http://example.com/a?b=1#c'],
  ['HTTPS://EXAMPLE.COM/Path', 'https://example.com/Path'],                  // mixed-case scheme is still https
  ['example.com', 'https://example.com/'],                                  // a bare domain becomes https://
  ['www.example.com/docs?q=1', 'https://www.example.com/docs?q=1'],
  ['example.com:8080/x', 'https://example.com:8080/x'],                     // host:port, not a scheme "example.com:"
  ['  https://example.com  ', 'https://example.com/'],                      // only the ENDS are trimmed
  ['mailto:someone@example.com', 'mailto:someone@example.com'],
  ['someone@example.com', 'mailto:someone@example.com'],                    // a bare address becomes mailto:
  ['例子.中国', 'https://xn--fsqu00a.xn--fiqs8s/'],                          // an IDN domain, punycoded by the URL parser
];
const REFUSED = [
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)',
  'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\u0000script:alert(1)',   // the URL parser would STRIP these
  '​javascript:alert(1)', 'java​script:alert(1)', 'https://exa​mple.com',   // invisible characters
  'https://exa mple.com', 'https://example.com/a b',                       // a space inside
  '&#106;avascript:alert(1)', '%6Aavascript:alert(1)',                      // entities / escapes typed literally
  'javascript://example.com/%0Aalert(1)', 'javascript.com:alert(1)',
  'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
  'blob:https://example.com/x', 'ftp://example.com', 'tel:123',
  '//evil.com', '/relative/path', './x', '../x', '?q=1', '#top',
  'https://bank.com@evil.com', 'https://user:pw@example.com',               // userinfo hides where it goes
  'hello', 'localhost:3000', 'mailto:', 'mailto:nobody', 'http://', '',
  null, undefined, 'https://example.com/' + 'a'.repeat(2100),
];

test('allowed addresses pass, normalised', () => {
  for (const [raw, want] of ALLOWED) assert.equal(G.safeLinkHref(raw), want, JSON.stringify(raw));
});

test('every unsafe or relative address is refused — javascript:, data:, vbscript:, file:, whitespace and entity tricks', () => {
  for (const raw of REFUSED) assert.equal(G.safeLinkHref(raw), null, JSON.stringify(raw));
});

test('CONTROL: the tab trick really is dangerous without the rule — the URL parser strips it to javascript:', () => {
  // Why LINK_BAD_CHAR refuses instead of trusting new URL(): the parser removes tabs and newlines.
  assert.equal(new URL('java\tscript:alert(1)').protocol, 'javascript:');
  assert.equal(new URL(' javascript:alert(1)').protocol, 'javascript:');
});

test('the rule is idempotent: a normalised href passes unchanged (so the sanitizer is a fixpoint on links)', () => {
  for (const [, want] of ALLOWED) assert.equal(G.safeLinkHref(want), want);
});

test('only http:, https: and mailto: — and the shell gate agrees with the note rule', () => {
  assert.deepEqual(G.LINK_SCHEMES, ['http:', 'https:', 'mailto:']);
  const m = /const OPEN_URL_OK=(\/[^\n]+\/);/.exec(SHELL);
  assert.ok(m, 'web/index.html must define OPEN_URL_OK');
  const shellOk = new Function(`return ${m[1]}`)();   // eslint-disable-line no-new-func
  for (const s of G.LINK_SCHEMES) assert.ok(shellOk.test(s), `the shell opens ${s}`);
  for (const s of ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'ftp:', 'tel:', 'httpx:', 'xhttps:'])
    assert.equal(shellOk.test(s), false, `the shell refuses ${s}`);
});

// ── A selection that IS an address fills the field ───────────────────────────────────────────
// The owner's journal holds raw pasted addresses, e.g. "Here's the summary (https://…):". Selecting
// one by dragging takes the brackets and the colon along; the field must open already holding the
// address, so one Apply links it. Only a FILL: Apply still runs safeLinkHref.
const pick = (t) => { const r = G.linkInText(t); return r ? t.slice(r.a, r.b) : null; };
const OWNER_URL = 'https://www.the-independent.com/life-style/happiness-researchers-relationships-wellbeing-health-b3074121.html';

test('a selected address is found, with its brackets, punctuation and spaces trimmed', () => {
  for (const [sel, want] of [
    [`(${OWNER_URL}):`, OWNER_URL],                                         // the owner's screenshot
    [` ${OWNER_URL} `, OWNER_URL], [`${OWNER_URL}.`, OWNER_URL], [`<${OWNER_URL}>`, OWNER_URL],
    ['(https://en.wikipedia.org/wiki/Foo_(bar))', 'https://en.wikipedia.org/wiki/Foo_(bar)'],   // its OWN ")" is kept
    ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['“example.com”,', 'example.com'], ['（https://例子.中国/路径）。', 'https://例子.中国/路径'],
    ['www.bbc.co.uk/news;', 'www.bbc.co.uk/news'], ['mailto:a@b.com', 'mailto:a@b.com'], ['(someone@example.com)', 'someone@example.com'],
  ]) assert.equal(pick(sel), want, JSON.stringify(sel));
});

test('words that are not an address fill nothing — and nothing the rule refuses is ever offered', () => {
  for (const sel of [`Here's the summary (${OWNER_URL}):`, 'hello', 'e.g.', '3.14', 'Version 2.0', '()', '', '   ', null,
    'javascript:alert(1)', '(javascript:alert(1))', 'data:text/html,x', 'https://bank.com@evil.com', 'https://exa mple.com'])
    assert.equal(pick(sel), null, JSON.stringify(sel));
});

test('a found address always passes the rule — the fill can never be one Apply refuses', () => {
  for (const sel of [`(${OWNER_URL}):`, 'www.example.com', 'example.com:8080/x)', '(someone@example.com)'])
    assert.ok(G.safeLinkHref(pick(sel)), JSON.stringify(sel));
});

test('the form fills from the selection only for a NEW link, and narrows the link to the address', () => {
  const fn = /function openLinkForm\(\)\{[\s\S]*?\n    function closeLinkForm/.exec(ENGINE);
  assert.ok(fn, 'openLinkForm must be findable');
  assert.match(fn[0], /const t=linkEl\?'':r\.toString\(\), sp=t&&linkInText\(t\)/, 'an existing link keeps its own href; a new one reads the selection');
  assert.match(fn[0], /if\(sp&&n===r\.endContainer&&n\.nodeType===3\)\{ r\.setEnd\(n,o\+sp\.b\); r\.setStart\(n,o\+sp\.a\); \}/, 'the brackets stay outside the link');
  // Its definition and this one call, nothing else: no typing or paste path guesses links (out of scope by the owner's ask).
  assert.equal((ENGINE.match(/linkInText\(/g) || []).length, 2, 'linkInText is called only by the Link button');
});

// ── The sanitizer's <a> ──────────────────────────────────────────────────────────────────────
// A minimal element stub: cleanInto reads childNodes / nodeType / tagName / getAttribute / style and
// writes through doc.createElement / setAttribute / appendChild. The HTML PARSER half (entities,
// serialisation, the fixpoint) is proved in Chromium by the e2e file.
const el = (tag, attrs = {}, kids = []) => ({ nodeType: 1, tagName: tag.toUpperCase(), childNodes: kids,
  getAttribute: (k) => (k in attrs ? attrs[k] : null), style: { getPropertyValue: () => '' } });
const txt = (t) => ({ nodeType: 3, nodeValue: t });
const doc = { createTextNode: (t) => ({ text: t }),
  createElement: (tag) => ({ tag, attrs: {}, kids: [], style: { setProperty() {} },
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); } }) };
const ser = (n) => (n.text != null ? n.text
  : `<${n.tag}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n.kids.map(ser).join('')}</${n.tag}>`);
const clean = (core, ...nodes) => { const out = doc.createElement('div'); core.cleanInto(el('div', {}, nodes), out, doc); return out.kids.map(ser).join(''); };

test('a safe link keeps ONLY its checked href plus the note\'s own target/rel', () => {
  const a = el('a', { href: 'example.com', onclick: 'steal()', target: '_self', rel: 'opener', style: 'x', id: 'i' }, [txt('site')]);
  assert.equal(clean(G, a), '<a href="https://example.com/" target="_blank" rel="noopener noreferrer">site</a>');
  const m = el('a', { href: 'mailto:a@b.co' }, [el('b', {}, [txt('mail')])]);
  assert.equal(clean(G, m), '<a href="mailto:a@b.co" target="_blank" rel="noopener noreferrer"><b>mail</b></a>', 'formatting inside a link is kept');
});

test('a NOTE link (?note=<id>&page=<p>, ADR 0025) is kept only when PASummaryRefs is on the page to parse it; without it, it is a relative address and refused', () => {
  assert.equal(G.safeLinkHref('?note=a&page=1'), null, 'the DOM-free core alone: no PASummaryRefs, refused like ?q=1');
  const src = ENGINE.slice(ENGINE.indexOf('  const SCHEMA='), ENGINE.indexOf('\n  function Note(host, opts){'));
  // eslint-disable-next-line no-new-func
  const withRefs = new Function('window', `${src}\n return {safeLinkHref};`)({ PASummaryRefs: { parseLink: (h) => (/^\?note=[^&]+&page=\d+$/.test(h) ? {} : null) } });
  assert.equal(withRefs.safeLinkHref('?note=a&page=1'), '?note=a&page=1', 'kept as written');
  assert.equal(withRefs.safeLinkHref('?note=a&page=1&x=javascript:alert(1)'), null, 'only the exact shape');
  assert.equal(withRefs.safeLinkHref('?q=1'), null); assert.equal(withRefs.safeLinkHref('javascript:alert(1)'), null, 'everything else still goes through the URL rule');
});

test('an unsafe or missing href unwraps the link: the words stay, the link goes', () => {
  for (const href of ['javascript:alert(1)', ' JAVASCRIPT:x', 'data:text/html,x', 'vbscript:x', 'file:///x', '/rel', null])
    assert.equal(clean(G, el('a', href == null ? {} : { href }, [txt('words')])), 'words', String(href));
  assert.equal(clean(G, el('a', { href: 'javascript:x' }, [txt('a '), el('i', {}, [txt('b')])])), 'a <i>b</i>');
});

test('MUTATION: without the rule in cleanInto, a javascript: href survives — the test above would go red', () => {
  const from = 'const href=tag===\'a\'?safeLinkHref(node.getAttribute(\'href\')):null;';
  assert.ok(ENGINE.includes(from), 'mutation target present');
  const bad = coreFrom(ENGINE.replace(from, 'const href=tag===\'a\'?node.getAttribute(\'href\'):null;'));
  assert.match(clean(bad, el('a', { href: 'javascript:alert(1)' }, [txt('x')])), /href="javascript:alert\(1\)"/);
});

// ── Wiring the user flow depends on ──────────────────────────────────────────────────────────
test('the Link button sits with the format buttons, titled bilingually, and never uses prompt()', () => {
  assert.match(ENGINE, /data-cmd="strikeThrough"[^\n]*\n\s*'<button class="pan-fmtbtn pan-flink" title="Link · 链接" aria-label="Link">'\+ico\('link'\)/);
  assert.match(ENGINE, /'<div class="pan-linkpop">'\+\s*'<input class="pan-linkurl"/, 'an address field of its own, under the button');
  const code = ENGINE.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bprompt\(/, 'prompt() returns null in the sandbox (no allow-modals)');
  for (const k of ['select', 'bad', 'failed', 'noShell']) assert.match(G.LINK_TXT[k], / · .*[一-鿿]/, `${k} is bilingual`);
});

test('the read-state tap asks the SHELL, synchronously, with the checked href', () => {
  const open = /function openLink\(raw\)\{[\s\S]*?\n    ink\.addEventListener/.exec(ENGINE);
  assert.ok(open, 'openLink must exist');
  assert.match(open[0], /const href=safeLinkHref\(raw\);/, 'the stored href is re-checked before it leaves');
  assert.match(open[0], /parent\.postMessage\(\{pa:'req',id:LINK_REQ,kind:'open-url',url:href\},'\*'\)/);
  assert.doesNotMatch(open[0], /\bawait\b|\.then\(/, 'no await: the tap\'s user activation must still hold when the shell opens');
  assert.match(ENGINE, /e\.pointerType==='touch'\?!fingerDraw:e\.pointerType==='mouse'&&tool==='select'/, 'a finger, or a mouse in Select — never the Pencil');
  assert.match(ENGINE, /linkTap=\(!txtEdit&&!penNear\(\)&&/, 'never while editing, never a palm beside the pen');
  assert.match(ENGINE, /if\(m&&m\.pa==='res'&&m\.id===LINK_REQ&&m\.ok===false\) flash\(/, 'a shell refusal is shown, not swallowed (R5)');
});

test('the shell opens it before any await, noopener+noreferrer, and checks the scheme itself', () => {
  const head = SHELL.indexOf("window.addEventListener('message',async(e)=>{");
  const branch = SHELL.indexOf("m.kind==='open-url'", head);
  assert.ok(head > 0 && branch > head, 'the broker has an open-url branch');
  const before = SHELL.slice(head, branch).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(before, /\bawait\b/, 'an await before the branch would spend the tap\'s activation');
  const body = SHELL.slice(branch, SHELL.indexOf('} else if(', branch));
  assert.match(body, /if\(!u\|\|!OPEN_URL_OK\.test\(u\.protocol\)\) return reply\(\{ok:false/);
  assert.match(body, /window\.open\(u\.href,'_blank','noopener,noreferrer'\);/);
});

// ── Which apps may ask (the owner's choice, 2026-10-27: the Journal and the Bible notes only) ─────
test('the shell asks WHICH app before it opens anything: the page in #fr, the user\'s own, on the list', () => {
  const branch = SHELL.indexOf("m.kind==='open-url'");
  const body = SHELL.slice(branch, SHELL.indexOf('} else if(', branch));
  const gate = body.indexOf("if(fr.held||frameUid()!==UID||!LINK_APPS.has(appSlug)) return reply({ok:false");
  assert.ok(gate > 0 && gate < body.indexOf('window.open('), 'refused before window.open, not after');
  assert.match(SHELL, /LINK_APPS=new Set\(ownApps\.filter\(a=>a\.links===true\)\.map\(a=>a\.name\)\);/, 'the list is the server\'s, own apps only');
  assert.match(SHELL, /^let LINK_APPS=new Set\(\);$/m, 'empty until /api/apps answers: refused closed');
});

// The server's half, RUN: a throwaway root (never the live node) with three own apps.
async function appLinks(extraConfig) {
  const port = await freePort(); const root = mkWebRoot({ port, extraConfig });
  for (const slug of ['notes', 'bible', 'scratch']) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><title>x</title><!--PA_NOTE_UI-->');   // all three mount PANote
  }
  const web = startWeb(root);
  try { await waitReady(port); return Object.fromEntries((await (await api(port, '/api/apps')).json()).map((a) => [a.name, a.links])); }
  finally { await stopWeb(web); }
}
test('/api/apps marks the Journal and the Bible as link apps; a third app that mounts PANote stays sealed', { timeout: 30000 }, async () => {
  assert.deepEqual(await appLinks({}), { notes: true, bible: true, scratch: false });
});
test('config open_url_apps replaces the list', { timeout: 30000 }, async () => {
  assert.deepEqual(await appLinks({ open_url_apps: ['scratch'] }), { notes: false, bible: false, scratch: true });
});
