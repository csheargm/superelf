// Bible top bar (plan-bible-panes items 1, 2, 5, 6): Note · 笔记 and Ask AI · 问一问 sit beside ⚙ in
// #nav and toggle their panes; with verses selected they act on the selection (the old fab paths);
// Highlight · 高亮 sits there too (disabled until a selection); there is no bottom bar (a second tap on the verse clears it); narrow screens open full screen;
// first-use tips bible-top-panes and bible-highlight. Driven on BOTH copies of the real host source.
import { test } from 'node:test';
import assert from 'node:assert/strict'; import fs from 'node:fs';
import { APP_SRC, startHarness, runApp, until, settle } from './helpers-app.mjs';

const WIDE = (src) => src.replace('const splitOn=()=>!!(window.PASplit&&PASplit.available&&PASplit.gateOpen());', 'const splitOn=()=>true;');
const EXPORTS = ['TOP', 'selV', 'selectVerse', 'syncTopBtns', 'VM', 'markVerses', 'syncMarkBtn', 'updateFab', '_booted:()=>_booted'];
const tipsStub = () => { const regs = []; return { regs, register: (o) => regs.push(o) }; };
const verse = () => ({ classList: { toggle() {}, add() {} } });

async function boot(app, opts) {
  const h = await startHarness('bible');
  const PATips = tipsStub();
  const A = runApp(app, h.relay, EXPORTS, { clampTimers: true, globals: { PATips }, ...opts });
  await until(() => A._booted(), 'boot');
  await settle();
  return { h, A, PATips };
}

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: markup — Note and Ask AI in the top bar, not in #fab; Highlight label`, () => {
    const src = APP_SRC[app];
    const nav = src.slice(src.indexOf('<div id="nav">'), src.indexOf('<div id="daily-banner">'));
    assert.match(nav, /id="top-note"[^>]*>Note · 笔记</);
    assert.match(nav, /id="top-ai"[^>]*>Ask AI · 问一问</);
    assert.match(nav, /id="top-mark" data-short="高亮" disabled><\/button><button class="top-pane" id="top-note"/, 'Highlight sits first, disabled until a selection; no Pen in the bar — the pen is the floating round button (owner 2026-11-13)');
    assert.doesNotMatch(src, /id="fab/, 'no bottom bar markup at all (owner 2026-11-13)');
    assert.doesNotMatch(src, /getElementById\('fab-(note|ai)'\)/, 'no handler left on a removed control');
  });

  test(`${app}: a word selection alone enables Highlight and opens the sheet on its verse (the tip's promise)`, async () => {
    const { h, A } = await boot(app);
    try {
      A.VM.selection = () => null; A.syncMarkBtn();
      assert.deepEqual(A.markVerses(), [], 'no verse, no words: nothing to mark');
      A.VM.selection = () => ({ n: 7, lang: 'en', start: 0, end: 4, quote: 'word' });
      assert.deepEqual(A.markVerses(), [7], 'words only: the verse holding them');
      A.selectVerse(16, verse());
      assert.deepEqual(A.markVerses(), [16], 'tapped verses win over a stray word selection');
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: no bottom bar, selected or not — never a strip over the text (owner 2026-11-13)`, async () => {
    const { h, A } = await boot(app);
    try {
      // The fake DOM answers any id, so absence is pinned by the markup test above; here: the gesture.
      A.selectVerse(1, verse());
      assert.equal(A.selV.size, 1);
      A.selectVerse(1, verse());
      assert.equal(A.selV.size, 0, 'a second tap clears the selection (what the ✕ used to do)');
      A.stopPads && A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: phone CSS — the top bar wraps instead of clipping at 375px`, () => {
    assert.match(APP_SRC[app], /@media\(max-width:600px\)\{[^@]*#nav\{flex-wrap:wrap/);
  });

  test(`${app}: wide — toggles open/close their panes, pressed state follows, selection asks about the verses`, async () => {
    const { h, A, PATips } = await boot(app, { mutate: WIDE });
    try {
      const rail = A.captured.splits[0], chat = A.captured.panels.find((p) => p.kind === 'chat').chat;
      assert.ok(rail, 'the rail is mounted');
      assert.equal(A.TOP.note.classList.contains('on'), false, 'boot: nothing pressed');
      await A.TOP.chat.onclick();
      assert.equal(rail.isCollapsed('chat'), false, 'Ask AI opens the chat pane');
      assert.equal(A.TOP.chat.classList.contains('on'), true, 'and shows pressed');
      assert.equal(chat.sent.length, 0, 'no selection: nothing is asked on its own');
      await A.TOP.chat.onclick();
      assert.equal(rail.isCollapsed('chat'), true, 'a second tap closes it');
      assert.equal(A.TOP.chat.classList.contains('on'), false);
      await A.TOP.note.onclick();
      assert.equal(rail.isCollapsed('note'), false, 'Note opens the note pane');
      assert.equal(A.TOP.note.classList.contains('on'), true);
      rail.collapse('note'); rail.opts.onToggle('note', false);   // the pane header's own Close
      assert.equal(A.TOP.note.classList.contains('on'), false, 'a close from the pane clears the pressed state');
      A.selectVerse(16, verse());
      await A.TOP.chat.onclick();
      assert.equal(rail.isCollapsed('chat'), false);
      assert.equal(chat.sent.length, 1, 'with a selection, Ask AI asks about it');
      assert.match(chat.sent[0], /3:16/, 'about the selected verse');
      await A.TOP.chat.onclick();
      assert.equal(rail.isCollapsed('chat'), false, 'with a selection a tap acts, it never closes');
      assert.deepEqual(PATips.regs.map((r) => r.id), ['bible-top-panes', 'bible-highlight', 'bible-history']);
      assert.match(PATips.regs[2].text, /history.* · .*阅读历史/, 'the history tip (anchored to Search)');
      assert.equal(PATips.regs[0].anchor(), A.TOP.note);
      assert.match(PATips.regs[0].text, / · .*面板/); assert.match(PATips.regs[1].text, /highlight.* · .*高亮/);
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: narrow — the top-bar buttons open the full-screen surfaces, no rail`, async () => {
    const { h, A } = await boot(app, { viewportWidth: 375, viewportHeight: 812, pointer: 'coarse' });
    try {
      assert.equal(A.captured.splits.length, 0, 'no rail on a phone');
      const full = A.captured.chats[0]; let opened = 0; full.open = () => { opened++; };
      await A.TOP.chat.onclick();
      assert.equal(opened, 1, 'Ask AI opens the full-screen chat');
      const pad = A.captured.pads[A.captured.pads.length - 1], real = pad.open; let padOpens = 0;
      pad.open = (f) => { padOpens++; return real(f); };
      await A.TOP.note.onclick();
      assert.equal(padOpens, 1, 'Note opens the full-screen pad');
      assert.equal(A.TOP.note.classList.contains('on'), false, 'no pressed state without a rail');
      A.stopPads();
    } finally { await h.stop(); }
  });
}

test('no ‹ › chapter arrows in the top bar: the chapter drop-down replaces them (owner 2026-11-15)', async () => {
  const fs = await import('node:fs');
  for (const p of ['../workspace/apps/bible/index.html', '../workspace.example/apps/bible/index.html']) {
    const S = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.doesNotMatch(S, /ch-prev|ch-next/, p);
    assert.match(S, /<select id="ch-label"/, p);
  }
});
test('GPT 2026-11-15: a chapter change drops the old undo history before the annotation read', () => {
  for (const p of ['../workspace/apps/bible/index.html', '../workspace.example/apps/bible/index.html']) {
    const S = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.match(S, /INK\.load\(\[\]\);[^\n]*\n  const annOk=await loadAnn\(\);/, p);
  }
});
test('GPT 2026-11-15: a stale annotation read never lands in ANN or the ink layer', () => {
  for (const p of ['../workspace/apps/bible/index.html', '../workspace.example/apps/bible/index.html']) {
    const S = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.match(S, /const r=await DATA\.read\(p\);\n  if\(s!==_annSeq\) return false;/, p);
    assert.match(S, /ANN_LOADING=false; return true;/, p);
    assert.match(S, /if\(_rhBoot\) await restoreReading\(g\);[^\n]*\n  if\(g!==_loadSeq\) return false;/, p);
    assert.match(S, /const annOk=await loadAnn\(\); if\(g!==_loadSeq\) return false;[^\n]*\n  if\(annOk\) INK\.load\(ANN\.ink\);/, p);
  }
});
test('GPT 2026-11-15: a ☰ delete re-read that was superseded leaves the ink to the newer read', () => {
  for (const p of ['../workspace/apps/bible/index.html', '../workspace.example/apps/bible/index.html']) {
    const S = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.match(S, /n\.chapter===chapter&&await loadAnn\(\)\)\{ renderDots\(\);/, p);
    assert.doesNotMatch(S, /\{ await loadAnn\(\); renderDots\(\)/, p);
  }
});
test('GPT round 10: load() resolves false when superseded, and every load().then that acts on the chapter stops on it', () => {
  for (const p of ['../workspace/apps/bible/index.html', '../workspace.example/apps/bible/index.html']) {
    const S = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    const body = S.slice(S.indexOf('async function load(){'), S.indexOf('\n}\n', S.indexOf('async function load(){')));
    assert.doesNotMatch(body, /_loadSeq\) return;/, p);
    const thens = S.split('\n').filter((l) => /load\(\)\.then\(/.test(l) && !/_booted=true/.test(l));
    assert.equal(thens.length, 4, p);
    for (const l of thens) assert.match(l, /ok===false|ok!==false/, `${p}: ${l.trim().slice(0, 60)}`);
  }
});
