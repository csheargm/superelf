// web/summary-refs.inline.html — PASummaryRefs: important lines and source links in summaries
// (docs/plans/note-features.md F, ADR 0025). The shipped script is RUN (helpers-summary loadRefs): the
// note-link scheme, the numbering and Important block, the refs per scope, [n] → <a> in rendered HTML,
// the chat-ui enhance hook, the ONE click interception and PANote's tap path into it; a link's text names
// its note (`[2] Roof · 2026-11-09`); the back pill after a tap returns to the summary note the link came
// from (noteSaved). Pins: the marker drawer-summary carries, the registration, the one-line hooks in
// chat-ui, note-ui and both hosts.
// R11 — searched: "?note=", "onLink", "linkify", "PASummaryRefs", "[n]" — no earlier note-link scheme or
// [n] rewriting existed (the Bible's linkifyVerses links verse references, a different thing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRefs, REFS_HTML } from './helpers-summary.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const R = () => loadRefs({});

test('the note-link scheme: ?note=<id>&page=<p>, round-tripped through encodeURIComponent; anything else is not a note link', () => {
  const S = R();
  assert.equal(S.linkHref('a', 1), '?note=a&page=1');
  assert.equal(S.linkHref('file:42:3:v16', 0), '?note=file%3A42%3A3%3Av16&page=0', 'a Bible row id, escaped');
  assert.deepEqual(S.parseLink('?note=file%3A42%3A3%3Av16&page=0'), { id: 'file:42:3:v16', page: 0 });
  assert.deepEqual(S.parseLink(' ?note=a&page=12 '), { id: 'a', page: 12 }, 'ends trimmed, as the sanitizer hands it');
  assert.equal(S.linkHref('a', -3), '?note=a&page=0'); assert.equal(S.linkHref('a', 2.7), '?note=a&page=2'); assert.equal(S.linkHref('a', NaN), '?note=a&page=0');
  for (const bad of ['?note=a', '?note=&page=1', '?page=1&note=a', 'https://example.com/?note=a&page=1', '?note=a&page=x', '?note=a&page=1#x', '?note=a%ZZ&page=1', '?q=1', '#top', '', null])
    assert.equal(S.parseLink(bad), null, String(bad));
});

test('importantOf: one note\'s page records → its important lines in page order and the first page that has one', () => {
  const S = R();
  assert.deepEqual(S.importantOf([{ page: 0, important: [] }, { page: 1, important: [' call ', ''] }, { page: 2, important: ['pay'] }]), { lines: ['call', 'pay'], page: 1 });
  assert.deepEqual(S.importantOf([{ page: 0, src: {} }]), { lines: [], page: 0 }, 'no field (an older server): nothing, page 0');
  assert.deepEqual(S.importantOf([]), { lines: [], page: 0 });
});

test('number + section: notes are [1], [2], … in order; a group with important lines gets the block before its body; a group without an id has no ref', () => {
  const S = R();
  const groups = [{ title: 'Rent', text: 'paid', id: 'b', imp: [], page: 0, day: '2026-11-02' }, { title: 'Roof', text: 'rain', id: 'a', imp: ['call', 'fix'], page: 1, day: '2026-11-09' }, { title: '2026-03', text: 'SUM', id: null, imp: [] }];
  const refs = S.number(groups);
  assert.deepEqual(groups.map((g) => g.n), [1, 2, 3]);
  assert.deepEqual(refs, [{ n: 1, id: 'b', page: 0, title: 'Rent', day: '2026-11-02' }, { n: 2, id: 'a', page: 1, title: 'Roof', day: '2026-11-09' }]);
  // The link's text: number, title (cut at TITLE_MAX) and day; a month ref whose title IS its day says it once.
  assert.equal(S.label(refs[1]), '[2] Roof · 2026-11-09');
  assert.equal(S.label({ n: 3, title: 'A very long title that goes on and on and on past forty', day: '2026-01-01' }), '[3] A very long title that goes on and on an… · 2026-01-01');
  assert.equal(S.TITLE_MAX, 40);
  assert.equal(S.label({ n: 2, id: 's', title: '2026-10', day: '2026-10' }), '[2] 2026-10'); assert.equal(S.label({ n: 4, title: '', day: '' }), '[4]');
  assert.equal(S.section(groups[0]), '\n\n### [1] Rent\npaid');
  assert.equal(S.section(groups[1]), '\n\n### [2] Roof\nImportant · 重点:\n- call\n- fix\nrain', 'the block, bilingual heading, one line per point, before the body');
  assert.equal(S.TXT.important, 'Important · 重点', 'the one name of the marked points: the block heading (with a colon) and the prompt');
});

test('refs are remembered per summary scope; linkifyHtml turns [n] into note links only for known numbers, outside tags, never inside an existing <a>', () => {
  const S = R(); S.install({ onLink() {} });
  S.remember('summary:2026-11', [{ n: 1, id: 'b', page: 0, title: 'Rent', day: '2026-11-02' }, { n: 2, id: 'a', page: 1, title: 'Ro"of<b>', day: '2026-11-09' }]);
  assert.equal(S.refsOf('summary:2026-10'), null); assert.equal(S.refsOf(undefined), null);
  const refs = S.refsOf('summary:2026-11');
  assert.equal(S.linkifyHtml('<p>Rent paid [1]; roof [2] and [3] <code>[1]</code></p>', refs),
    '<p>Rent paid <a href="?note=b&amp;page=0">[1] Rent · 2026-11-02</a>; roof <a href="?note=a&amp;page=1">[2] Ro&quot;of&lt;b&gt; · 2026-11-09</a> and [3] <code><a href="?note=b&amp;page=0">[1] Rent · 2026-11-02</a></code></p>', 'the text names the note (escaped), so the reader knows what [n] is');
  assert.equal(S.linkifyHtml('<a href="https://x.y/">see [1]</a> [1]', refs), '<a href="https://x.y/">see [1]</a> <a href="?note=b&amp;page=0">[1] Rent · 2026-11-02</a>', 'inside a link nothing changes');
  assert.equal(S.linkifyHtml('<span title="[1]">x</span>', refs), '<span title="[1]">x</span>', 'an attribute is not text');
  assert.equal(S.linkifyHtml('plain [1]', null), 'plain [1]'); assert.equal(S.linkifyHtml('plain [1]', []), 'plain [1]'); assert.equal(S.linkifyHtml(null, refs), '');
  // chat-ui's hook: a bubble under the scope is rewritten in place; no refs, untouched.
  const el = { innerHTML: '<p>roof [2]</p>' };
  assert.equal(S.enhance(el, 'summary:2026-11'), true); assert.equal(el.innerHTML, '<p>roof <a href="?note=a&amp;page=1">[2] Ro&quot;of&lt;b&gt; · 2026-11-09</a></p>');
  const other = { innerHTML: '<p>roof [2]</p>' };
  assert.equal(S.enhance(other, 'note:e0'), false); assert.equal(other.innerHTML, '<p>roof [2]</p>');
  assert.equal(S.enhance(null, 'summary:2026-11'), false);
});

test('CONTROL: with no onLink installed, linkifyHtml and enhance write no link — [n] stays text in the rail and the saved note', () => {
  const S = R();
  const refs = [{ n: 1, id: 'b', page: 0, title: 'Rent' }];
  S.remember('summary:2026-11', refs);
  assert.equal(S.linkifyHtml('<p>Rent paid [1]</p>', refs), '<p>Rent paid [1]</p>', 'a link would go nowhere');
  const el = { innerHTML: '<p>roof [1]</p>' };
  assert.equal(S.enhance(el, 'summary:2026-11'), false); assert.equal(el.innerHTML, '<p>roof [1]</p>');
  assert.deepEqual(S.refsFor(el, 'summary:2026-11'), refs, 'the bubble still binds the refs it was painted with');
  S.install({ onLink() {} });
  assert.equal(S.linkifyHtml('<p>Rent paid [1]</p>', refs), '<p>Rent paid <a href="?note=b&amp;page=0">[1] Rent</a></p>', 'once a host passed the hook, links are written');
});

test('the back pill: a tap on a link shows ONE fixed pill that returns to the summary note the link came from (the bubble\'s scope → noteSaved), else the last saved; a link to that note itself needs none; the tap hides it', async () => {
  const body = { kids: [], appendChild(k) { this.kids.push(k); return k; } };
  const mk = () => { const o = { cls: new Set(), classList: { add: (c) => o.cls.add(c), remove: (c) => o.cls.delete(c), contains: (c) => o.cls.has(c) } }; return o; };
  const doc = { body, createElement: mk, addEventListener() {} };
  const S = loadRefs({}, doc);
  const opened = []; S.install({ onLink: (l) => { opened.push(l); } });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  assert.equal(S.noteSaved('summary:2026-11', 'n-nov'), true); assert.equal(S.noteSaved('summary:2026-10', 'n-oct'), true);
  assert.equal(S.noteSaved('', 'x'), false); assert.equal(S.noteSaved('summary:2026-09', null), false, 'a host answer without an id names no note');
  assert.equal(body.kids.length, 0, 'no pill until a tap needs one');
  // A tap in PANote's own path (no element): the last saved summary is the way back.
  assert.equal(S.open('?note=a&page=1'), true); await flush();
  assert.equal(body.kids.length, 1); const pill = body.kids[0];
  assert.equal(pill.className, 'psr-back'); assert.equal(pill.textContent, '← Back to summary · 返回总结'); assert.equal(pill.type, 'button');
  assert.equal(pill.classList.contains('show'), true); assert.equal(S.backTarget(), 'n-oct');
  // A tap inside a bubble enhance painted under the November scope: November's note.
  S.remember('summary:2026-11', [{ n: 1, id: 'b', page: 0, title: 'Rent', day: '2026-11-02' }]);
  const bubble = { innerHTML: '<p>[1]</p>' }; S.enhance(bubble, 'summary:2026-11');
  const a = { getAttribute: () => '?note=b&page=0', closest: () => null, parentNode: { parentNode: bubble } };
  S.onClick({ target: { closest: (s) => (s === 'a[href]' ? a : null) }, preventDefault() {}, stopPropagation() {} }); await flush();
  assert.deepEqual(opened.at(-1), { id: 'b', page: 0 }); assert.equal(S.backTarget(), 'n-nov'); assert.equal(body.kids.length, 1, 'the ONE pill, reused');
  // The pill: hides itself and opens the summary note on page 0 through the same host hook; the rail is never touched here.
  assert.equal(pill.onclick(), true); await flush();
  assert.deepEqual(opened.at(-1), { id: 'n-nov', page: 0 }); assert.equal(pill.classList.contains('show'), false); assert.equal(S.backTarget(), null);
  assert.equal(S.goBack(), false, 'nothing to go back to');
  // A link to the summary note itself (a year's month link opening that note): no pill.
  S.open('?note=n-oct&page=0'); await flush(); assert.equal(pill.classList.contains('show'), false);
  S.hideBack(); assert.equal(S.showBack('z'), true); assert.equal(pill.classList.contains('show'), true); S.hideBack(); assert.equal(pill.classList.contains('show'), false);
  const bare = loadRefs({}, { createElement: () => ({}) }); bare.install({ onLink() {} });
  assert.equal(bare.noteSaved('summary:1', 'q'), true); assert.equal(bare.open('?note=a&page=0'), true, 'no document body (a test window): the tap still opens, with no pill');
});

test('a bubble keeps the refs it was first painted with: a later turn remembered under the same scope relinks neither it nor its Save as note (refsFor), only new bubbles', () => {
  const S = R(); S.install({ onLink() {} });
  const A = [{ n: 1, id: 'a', page: 1, title: 'Roof' }], B = [{ n: 1, id: 'z', page: 0, title: 'Zinc' }];
  S.remember('summary:2026-11', A);
  const el = { innerHTML: '<p>see [1]</p>' };
  assert.equal(S.enhance(el, 'summary:2026-11'), true); assert.match(el.innerHTML, /note=a&amp;page=1/);
  S.remember('summary:2026-11', B);
  assert.deepEqual(S.refsFor(el, 'summary:2026-11'), A, 'the old bubble answers with its own refs');
  assert.equal(S.enhance(el, 'summary:2026-11'), false, 'and is not rewritten');
  assert.match(el.innerHTML, /note=a&amp;page=1/); assert.doesNotMatch(el.innerHTML, /note=z/);
  const fresh = { innerHTML: '<p>see [1]</p>' };
  assert.deepEqual(S.refsFor(fresh, 'summary:2026-11'), B, 'a bubble never painted falls back to the scope');
  assert.equal(S.enhance(fresh, 'summary:2026-11'), true); assert.match(fresh.innerHTML, /note=z&amp;page=0/);
  assert.deepEqual(S.refsFor(null, 'summary:2026-11'), B); assert.equal(S.refsFor(undefined, 'note:1'), null);
});

test('the ONE click interception: install takes the host\'s onLink; a tap on a note link (outside PANote\'s text layer) is intercepted and opens it; other links and pad links pass', async () => {
  const listeners = [];
  const doc = { createElement: () => ({}), addEventListener: (t, fn, cap) => listeners.push([t, fn, cap]) };
  const S = loadRefs({}, doc);
  const opened = [];
  assert.equal(S.install(null), false); assert.equal(S.install({ saveNote() {} }), false, 'no onLink, nothing installed');
  assert.equal(listeners.length, 0);
  assert.equal(S.install({ onLink: (l) => { opened.push(l); } }), true);
  assert.equal(S.install({ onLink: (l) => { opened.push(l); } }), true);
  assert.deepEqual(listeners.map(([t, , c]) => [t, c]), [['click', true]], 'ONE capture listener on the document, however often install runs');
  const fire = (href, inPad = false) => { const a = { getAttribute: () => href, closest: (s) => (s === '.pan-textlayer' && inPad ? {} : null) };
    const e = { target: { closest: (s) => (s === 'a[href]' ? a : null) }, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    listeners[0][1](e); return e; };
  const e1 = fire('?note=a&page=1');
  assert.equal(e1.prevented, true); assert.equal(e1.stopped, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(opened, [{ id: 'a', page: 1 }], 'the host opened it');
  const e2 = fire('https://example.com/');
  assert.equal(e2.prevented, false, 'an outside link is not ours');
  const e3 = fire('?note=a&page=1', true);
  assert.equal(e3.prevented, false, 'inside PANote\'s text layer the pad\'s own tap path decides');
  listeners[0][1]({ target: { closest: () => null } }); listeners[0][1]({ target: null });   // a tap on no link
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(opened.length, 1);
  // PANote's path: open(href) — true (handled) for a note link, false for anything else.
  assert.equal(S.open('?note=b&page=0'), true); assert.equal(S.open('https://example.com/'), false); assert.equal(S.open('?note=x'), false);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(opened.at(-1), { id: 'b', page: 0 });
  const fresh = R();
  assert.equal(fresh.open('?note=b&page=0'), false, 'no host hook installed: not handled (PANote then refuses it as a bad link)');
});

test('pins: drawer-summary carries the marker above its script; web.mjs registers the file last; chat-ui, note-ui and both copies of both hosts carry the one-line hooks', () => {
  const SUM = read('web/drawer-summary.inline.html'), WEB = read('web.mjs'), CHAT = read('web/chat-ui.inline.html'), ENGINE = read('web/note-ui.inline.html');
  assert.ok(SUM.indexOf('<!--PA_SUMMARY_REFS_UI-->') > 0 && SUM.indexOf('<!--PA_SUMMARY_REFS_UI-->') < SUM.indexOf('<script id="pds-script">'), 'the marker sits before drawer-summary\'s script, so PASummaryRefs exists when it runs');
  assert.ok(REFS_HTML.includes('<script id="psr-script">'));
  const comps = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  assert.match(comps, /\{ marker: '<!--PA_SUMMARY_REFS_UI-->', file: 'summary-refs\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SUMMARY_TITLE_UI-->', file: 'summary-title\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_DRAWER_GROUPS_UI-->', file: 'drawer-groups\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SUMMARY_IMAGES_UI-->', file: 'summary-images\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SUMMARY_FOLLOWUP_UI-->', file: 'summary-followup\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_ANCHOR_UI-->', file: 'ink-anchor\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_PEN_UI-->', file: 'ink-pen\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_APP_PREFS_UI-->', file: 'app-prefs\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SETTINGS_ROWS-->', file: 'settings-rows\.inline\.html' \},\n(?:  \/\/[^\n]*\n)+  \{ marker: '<!--PA_TIPS_UI-->', file: 'tips\.inline\.html' \},\n(?:  \/\/[^\n]*\n)*  \{ marker: '<!--PA_PANE_CHROME_UI-->', file: 'pane-chrome\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_APP_BAR_UI-->', file: 'app-bar\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '\/\* PA_BAR_HANDLE_CSS \*\/', file: 'bar-handle\.css' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_READING_HISTORY_UI-->', file: 'reading-history\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_FRAME_UI-->', file: 'ink-frame\.inline\.html' \},\n$/, 'registered after drawer-summary, before the title, groups, images and follow-up components which came later (the append-only rule)');
  assert.match(CHAT, /const enh=el=>\{ try\{ if\(window\.PASummaryRefs\) window\.PASummaryRefs\.enhance\(el,key\);/, 'every rendered bubble passes through enhance with the thread key, inside the one guarded hook');
  assert.match(ENGINE, /function openLink\(raw\)\{ if\(window\.PASummaryRefs&&window\.PASummaryRefs\.open\(raw\)\) return;/, 'PANote\'s tap on a link asks PASummaryRefs first');
  assert.match(ENGINE, /if\(typeof window!=='undefined'&&window\.PASummaryRefs&&window\.PASummaryRefs\.parseLink\(s\)\) return s;/, 'the sanitizer keeps a note link (and only through parseLink)');
  assert.match(SUM, /R\(\)\.install\(c\.hooks\);/); assert.match(SUM, /R\(\)\.install\(x\.hooks\);/, 'attach and decorate hand the host hooks to install');
  assert.match(SUM, /fields:\['src','important'\]/, 'the local ask carries the important lines');
  const hook = { notes: "  onLink:({id,page})=>openEntry(id,{page},{keepRail:true}),", bible: "  onLink:async({id,page})=>{ const row=(await chatData.listAugment()).find(r=>r.id===id); if(row) row.onClick(id,{page}); }," };
  for (const app of ['notes', 'bible']) {
    const live = read(`workspace/apps/${app}/index.html`), tpl = read(`workspace.example/apps/${app}/index.html`);
    for (const [name, src] of [['live', live], ['template', tpl]]) {
      const i = src.indexOf(hook[app]);
      assert.ok(i > 0, `${app} ${name} carries the onLink hook`);
      assert.equal(src.indexOf(hook[app], i + 1), -1, `${app} ${name}: once`);
      const block = src.slice(src.lastIndexOf(app === 'notes' ? 'const SUMMARY_HOOKS={' : 'const BIBLE_SUMMARY={', i), i);
      assert.ok(block.length > 0 && !block.includes('\n};'), `${app} ${name}: inside the summary hooks object`);
    }
    const line = (s) => s.split('\n').find((l) => l.startsWith(hook[app]));
    assert.equal(line(live), line(tpl), `${app}: the hook line is byte-identical in both copies`);
  }
});

// Owner 2026-11-11: `[1] New Note 新笔记 · 11/10 10:28 · 2026-11-10` said the date twice, and an older summary
// cited as `[2] Summary · 总结 2026-W46 · 2026-11-11` showed the raw week id.
test('label: the day is left out when the title already says it (m/d, ISO, month name) or names a period; a saved summary\'s raw W title reads as its human title', () => {
  const S = loadRefs({ PA_SUMMARY_NOW: new Date(2026, 10, 11, 12, 0, 0).getTime() });
  assert.equal(S.label({ n: 1, title: 'New Note 新笔记 · 11/10 10:28', day: '2026-11-10' }), '[1] New Note 新笔记 · 11/10 10:28', 'the default note title (m/d hh:mm)');
  assert.equal(S.label({ n: 1, title: 'New Note 新笔记 · 11/09 10:28', day: '2026-11-10' }), '[1] New Note 新笔记 · 11/09 10:28 · 2026-11-10', 'CONTROL: another day is still said');
  assert.equal(S.label({ n: 2, title: 'Roof', day: '2026-11-09' }), '[2] Roof · 2026-11-09', 'a plain title keeps its day');
  assert.equal(S.label({ n: 3, title: 'Trip 2026-11-09', day: '2026-11-09' }), '[3] Trip 2026-11-09');
  assert.equal(S.label({ n: 4, title: 'Nov 9 walk', day: '2026-11-09' }), '[4] Nov 9 walk');
  assert.equal(S.label({ n: 4, title: 'Nov 19 walk', day: '2026-11-09' }), '[4] Nov 19 walk · 2026-11-09', 'CONTROL: Nov 19 is not Nov 9');
  assert.equal(S.label({ n: 5, title: '2026-10', day: '2026-10' }), '[5] 2026-10', 'a month ref says it once');
  assert.equal(S.label({ n: 6, title: 'Summary · 总结 2026-W46', day: '2026-11-11' }), '[6] This week · 本周 Nov 9–15, 2026', 'an old raw summary title shows the human title, no day');
  assert.equal(S.label({ n: 7, title: 'This week · 本周 Nov 9–15, 2026', day: '2026-11-11' }), '[7] This week · 本周 Nov 9–15, 2026');
  assert.equal(S.titleHasDate('Oct 2026 plan', '2026-10'), true); assert.equal(S.titleHasDate('Roof', 'bad'), false);
});
