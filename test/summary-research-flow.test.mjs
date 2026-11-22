// The automatic research after a summary, end to end on the Journal (owner 2026-11-11: "I'm not seeing
// automatic research"). The REAL notes host (helpers-app runApp, a real server) saves the summary note and
// opens it on the pad; the REAL client PASummaryFollowup asks the broker, answered by the REAL lib
// buildFollowup over the summary text (research stubbed: no network, no owner data); its quiet second save
// appends the block to the SAME entry. THE BUG: quiet skipped the reopen, so the pad kept showing the page
// without the block although it was on disk. Now the note on the pad is reloaded in place; a note NOT on
// the pad is written and the pad is left where it is (CONTROL). Template and live copies are both run.
// R11 — searched: "curId===e.id", "fasting research", "quiet" — no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHarness, runApp, until, settle } from './helpers-app.mjs';
import { loadFollowup } from './helpers-summary.mjs';
import { buildFollowup, FOLLOWUP_HEADING } from '../lib/summary-followup.mjs';

const SUMMARY = '## Week\n- Walked a lot\n\n## Open to-dos · 待办\n- fasting research [2]\n';
const research = async (q) => ({ ok: true, text: 'Intermittent fasting: 16:8 is the common pattern for ' + q, sources: [{ url: 'https://www.example.org/a' }] });
const mkEl = (tag) => { const kids = []; return { tagName: tag, className: '', textContent: '', children: kids, appendChild(k) { kids.push(k); return k; }, setAttribute(k, v) { this['@' + k] = v; } }; };
const gate = (src) => src.replace('const splitOn=()=>!!(window.PASplit&&PASplit.available&&PASplit.gateOpen());', 'const splitOn=()=>true;');

for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: a summary whose to-dos include 'fasting research' gets the research block appended to its saved note, and the pad showing it reloads (CONTROL: another note on the pad stays)`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'Note 0', created: 1, updated: 2, preview: 'p' }] });
      h.put('entry-e0.json', { v: 2, id: 'e0', pages: [{ id: 'p0', strokes: [], pageHtml: '<div>landlord</div>', images: [] }] });
      const A = runApp(app, h.relay, ['S', 'SUMMARY_HOOKS', 'boot', 'openEntry', 'curId:()=>curId'], { clampTimers: true, mutate: gate });
      await until(() => A.S.entries.length === 1, 'boot to load the index'); await settle();
      const pad = A.captured.pads[0], asks = [];
      const html = '<div>AI summary · AI 总结 — This week · 本周 Nov 9–15, 2026 #summary #ai</div><p>Week</p>';
      const saved = await A.SUMMARY_HOOKS.saveNote({ title: 'This week · 本周 Nov 9–15, 2026', html, period: '2026-W46', scope: 'summary:2026-W46', convoId: 'c-1' });
      assert.equal(A.curId(), saved.id, 'the first save opened the summary note');
      const win = { PAStore: { ask: async (m) => { asks.push(m); return buildFollowup(m.text, { research, suggest: async () => 'x', perItemTimeoutMs: 1000 }); } } };
      const F = loadFollowup(win, { createElement: mkEl });
      const r = await F.run({ answer: SUMMARY, html, period: '2026-W46', scope: 'summary:2026-W46', title: 'This week · 本周 Nov 9–15, 2026', id: saved.id, convoId: 'c-1', hooks: A.SUMMARY_HOOKS, bar: mkEl('div') });
      assert.equal(asks.length, 1, 'one broker ask'); assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.status, 'Follow-up added · 已添加跟进 — 1 to-dos · 1 项待办');
      const onDisk = JSON.parse(fs.readFileSync(h.file('entry-' + saved.id + '.json'), 'utf8')).pages[0].pageHtml;
      assert.ok(onDisk.startsWith(html) && onDisk.includes('<h3>' + FOLLOWUP_HEADING + '</h3>') && onDisk.includes('fasting research') && onDisk.includes('16:8'), 'the block is in the saved note');
      await settle();
      assert.equal(A.curId(), saved.id); assert.equal(pad.nb.pages[0].pageHtml, onDisk, 'the pad shows the note WITH the block (the bug: the page without it)');
      // CONTROL: the owner moved on to another note; the quiet save writes and leaves the pad there.
      await A.openEntry('e0'); await settle();
      const r2 = await F.run({ answer: SUMMARY, html, period: '2026-W46', scope: 'summary:2026-W46', title: 'This week · 本周 Nov 9–15, 2026', id: saved.id, convoId: 'c-1', hooks: A.SUMMARY_HOOKS, bar: mkEl('div') });
      assert.equal(r2.ok, true); assert.equal(A.curId(), 'e0', 'quiet: the pad is not moved'); assert.equal(pad.nb.pages[0].pageHtml, '<div>landlord</div>');
      A.stopPads();
    } finally { await h.stop(); }
  });
}
