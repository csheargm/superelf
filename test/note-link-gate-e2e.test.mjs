// Which apps may open links · 哪些应用能打开链接 — in a REAL browser.
//
// The owner's choice (2026-10-27): one tap, the Journal and the Bible notes ONLY; every other app
// stays sealed. The shell decides it from the server's list (web.mjs openUrlApps, /api/apps `links`)
// and its own reading of which page asks (web/index.html, the open-url branch). The control is the
// SAME Journal under a slug that is not on the list, so the only difference is the gate (R14).
// The harness, and how to run it with Playwright, is test/helpers-note-link.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, TARGET, setup, teardown, newContext, openJournal } from './helpers-note-link.mjs';

before(() => setup({ slugs: ['notes', 'scratch'] }));
after(teardown);

test('only the listed apps open links: the same Journal under another slug is refused, and nothing opens', { skip, timeout: 60000 }, async () => {
  // The owner's choice (2026-10-27): the Journal and the Bible notes, every other app sealed. The
  // ask is posted straight to the broker, as an app the agent built could; the reply is read back.
  const ask = (frame, url) => frame.evaluate((u) => new Promise((done) => {
    const id = 'gate-' + Math.random();
    addEventListener('message', function on(e) { const m = e.data;
      if (m && m.pa === 'res' && m.id === id) { removeEventListener('message', on); done({ ok: m.ok, text: m.text || '' }); } });
    parent.postMessage({ pa: 'req', id, kind: 'open-url', url: u }, '*');
  }), url);
  const ctx = await newContext(); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  // CONTROL (R14): the listed Journal's same ask is let through to the opener.
  let frame = await openJournal(page);
  const [tab] = await Promise.all([ctx.waitForEvent('page'), ask(frame, TARGET).then((r) => assert.deepEqual(r, { ok: true, text: '' }))]);
  await tab.close();
  frame = await openJournal(page, { slug: 'scratch' });
  const opened = []; ctx.on('page', (t) => opened.push(t.url()));
  assert.deepEqual(await ask(frame, TARGET), { ok: false, text: '此应用不能打开链接 · This app cannot open links' });
  await page.waitForTimeout(300);
  assert.deepEqual(opened, [], 'nothing was opened');
  assert.deepEqual(errors, []);
  await ctx.close();
});
