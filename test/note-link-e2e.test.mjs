// Links in a note, in a REAL browser · 笔记链接（真实浏览器）
//
// The user flow (R6), end to end: the REAL web.mjs on a throwaway root (test/helpers-web.mjs —
// never the live node, never live data), the real shell (web/index.html) in Chromium, and the
// shipped Journal (shared-apps/notes) in the shell's sandboxed iframe with PANote inlined by the
// server. Type, select a word, press Link, type an address, Apply: the note on DISK holds the link;
// reload and it is still there; a click in the read state opens it in a new tab THROUGH the shell
// (the app's sandbox has no allow-popups); edit it, remove it; javascript: is refused at the button
// and again at the shell. The sanitizer runs here too, because entities and serialisation are the
// HTML parser's, which test/note-link.test.mjs cannot run.
//
// The harness, and how to run it with Playwright (PA_PLAYWRIGHT), is test/helpers-note-link.mjs.
// The tests share one throwaway root and run in order: the first writes the note
// ("Visit example today") that the others open. Which apps may open links: note-link-gate-e2e.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, TARGET, SAVED, port, setup, teardown, onDisk, indexed, newContext, openJournal, wordAt,
  layerHtml, flashText, linking, lit, textMode, selectWord } from './helpers-note-link.mjs';

before(() => setup());
after(teardown);

test('select a word, Link, type an address, Apply: the note on disk holds the link — and after a reload too', { skip, timeout: 90000 }, async () => {
  const ctx = await newContext(); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  let frame = await openJournal(page);
  await textMode(frame);
  await frame.locator('.pan-textlayer').click();
  await page.keyboard.type('Visit example today');
  await selectWord(page, frame, 'example');
  await frame.locator('.pan-flink').click();
  assert.equal(await linking(frame), true, 'the address field opens under the button');
  assert.equal(await frame.locator('.pan-linkrm').isVisible(), false, 'a new link offers no Remove');
  await page.keyboard.type('example.com');                                   // the field has focus: type straight in
  await page.keyboard.press('Enter');
  assert.equal(await linking(frame), false, 'Enter applied and closed the form');
  assert.match(await layerHtml(frame), /Visit <a href="https:\/\/example\.com\/">example<\/a> today/, 'exactly the selected word is linked, bare domain made https://');
  assert.equal(await lit(frame, '.pan-flink'), true, 'the Link button now says the selection is a link');
  assert.equal(await lit(frame, '[data-cmd="underline"]'), false, 'and a link does not read as underlined text (U stays off)');
  await onDisk((h) => h.includes(`Visit ${SAVED} today`), 'the sanitized link on disk');
  await indexed();

  await page.reload();
  frame = await openJournal(page);
  assert.ok((await layerHtml(frame)).includes(SAVED), 'the link survives a reload, with target/rel');

  // Read state (Select, the desktop opening tool): a click on the link opens it in a NEW TAB,
  // through the shell — the app frame itself cannot (no allow-popups).
  const p = await wordAt(page, frame, 'example');
  const [tab] = await Promise.all([ctx.waitForEvent('page'), page.mouse.click(p.x, p.y)]);
  await tab.waitForLoadState();
  assert.equal(tab.url(), TARGET, 'the tapped link opened in a new tab');
  assert.equal(await tab.evaluate(() => window.opener), null, 'noopener: the tab cannot reach back into superelf');
  await tab.close();
  assert.equal(page.url(), `http://127.0.0.1:${port}/`, 'the shell itself did not navigate');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('iPad flow: a FINGER tap on a link in the pen tool opens it; the pad stays on the pen', { skip, timeout: 60000 }, async () => {
  const ctx = await newContext({ hasTouch: true, isMobile: true, viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const frame = await openJournal(page, { touch: true });
  assert.equal(await frame.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'CONTROL: a touch device, so the Journal opened on the pen');
  assert.deepEqual(await frame.evaluate(() => [...document.querySelectorAll('.pan-tool.on')].map((b) => b.dataset.tool)), ['pen']);
  const p = await wordAt(page, frame, 'example');
  const [tab] = await Promise.all([ctx.waitForEvent('page'), page.touchscreen.tap(p.x, p.y)]);
  await tab.waitForLoadState();
  assert.equal(tab.url(), TARGET);
  await tab.close();
  assert.deepEqual(await frame.evaluate(() => [...document.querySelectorAll('.pan-tool.on')].map((b) => b.dataset.tool)), ['pen'], 'still on the pen');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('on a phone the address strip fits the screen, though the docked bar is a scrolling sliver', { skip, timeout: 60000 }, async () => {
  // Found by looking (390 px): an address field INSIDE the docked bar showed "ple.com" and pushed
  // Apply and ✕ out of reach. The strip is its own fixed element now; every control must be on screen.
  const ctx = await newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await textMode(frame);
  await page.waitForTimeout(200);                                            // T mode's own caret-to-end lands first
  await frame.evaluate(() => { const tl = document.querySelector('.pan-textlayer'); tl.focus();
    const it = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
    for (let n; (n = it.nextNode());) { const i = n.nodeValue.indexOf('today'); if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 5); getSelection().removeAllRanges(); getSelection().addRange(r); return; } });
  await frame.locator('.pan-flink').tap();
  assert.equal(await linking(frame), true, `the strip opened (flash: "${await flashText(frame)}")`);
  const boxes = await frame.evaluate(() => ['.pan-linkurl', '.pan-linkok', '.pan-linkx'].map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [s, b.left, b.right, b.width]; }));
  for (const [s, l, r, w] of boxes) assert.ok(l >= 0 && r <= 390 && w > 20, `${s} is on screen (${l.toFixed(0)}..${r.toFixed(0)})`);
  await ctx.close();
});

test('edit a link (prefilled), Remove it; javascript: is refused at the button and again at the shell', { skip, timeout: 90000 }, async () => {
  const ctx = await newContext(); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const frame = await openJournal(page);
  await textMode(frame);
  // Editing: a click in a link places the caret (it does NOT open it) and lights the button.
  let p = await wordAt(page, frame, 'example');
  const opened = []; ctx.on('page', (t) => opened.push(t.url()));
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
  assert.deepEqual(opened, [], 'while editing, a click places the caret instead of opening');
  assert.equal(await frame.evaluate(() => document.querySelector('.pan-flink').classList.contains('on')), true, 'the button says the caret is in a link');
  await frame.locator('.pan-flink').click();
  assert.equal(await frame.locator('.pan-linkurl').inputValue(), TARGET, 'the form opens prefilled');
  assert.equal(await frame.locator('.pan-linkrm').isVisible(), true, 'and offers Remove');
  // Replace it the way a user does: drag across the old address in the field, type the new one.
  const fb = await frame.locator('.pan-linkurl').boundingBox(), fy = fb.y + fb.height / 2;
  await page.mouse.move(fb.x + fb.width - 4, fy); await page.mouse.down(); await page.mouse.move(fb.x + 2, fy, { steps: 8 }); await page.mouse.up();
  await page.keyboard.type('https://example.org/docs');
  assert.equal(await frame.locator('.pan-linkurl').inputValue(), 'https://example.org/docs', 'the old address could be selected and replaced');
  await frame.locator('.pan-linkok').click();
  await onDisk((h) => h.includes('<a href="https://example.org/docs" target="_blank" rel="noopener noreferrer">example</a>'), 'the edited address on disk');

  p = await wordAt(page, frame, 'example');
  await page.mouse.click(p.x, p.y);
  await frame.locator('.pan-flink').click();
  await frame.locator('.pan-linkrm').click();
  await onDisk((h) => h.includes('Visit example today') && !h.includes('<a '), 'the link removed on disk, the words kept');

  // javascript: — refused with a bilingual message, the form stays open, nothing is linked.
  await selectWord(page, frame, 'today');
  await frame.locator('.pan-flink').click();
  await page.keyboard.type('javascript:alert(1)');
  await page.keyboard.press('Enter');
  assert.match(await flashText(frame), /Only web or email links · 只能用网页或邮件链接/);
  assert.equal(await linking(frame), true, 'the form stays open to fix the address');
  assert.doesNotMatch(await layerHtml(frame), /<a /);
  await page.keyboard.press('Escape');
  assert.equal(await linking(frame), false, 'Esc cancels');

  // No selection: one short bilingual hint, no form.
  p = await wordAt(page, frame, 'Visit');
  await page.mouse.click(p.x, p.y);
  await frame.locator('.pan-flink').click();
  assert.match(await flashText(frame), /Select text to link · 请先选择文字/);
  assert.equal(await linking(frame), false);

  // The shell never takes the app's word for it: a javascript: ask straight to the broker is refused.
  await frame.evaluate(() => parent.postMessage({ pa: 'req', id: 'panlink', kind: 'open-url', url: 'javascript:alert(1)' }, '*'));
  await frame.waitForFunction(() => /Only web or email links open/.test((document.querySelector('.pan-flash.on') || {}).textContent || ''));
  // CONTROL (R14): why the shell does the opening at all — the app frame cannot open a tab itself.
  assert.equal(await frame.evaluate(() => window.open('https://example.com/', '_blank')), null, 'the sandbox blocks the app\'s own popup');
  await page.waitForTimeout(200);
  assert.deepEqual(opened, [], 'nothing was opened');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a pasted raw URL: select it with its brackets, Link opens filled, ONE Apply links just the URL, and it wraps', { skip, timeout: 90000 }, async () => {
  // The owner's screenshot: a journal line holding a raw pasted address in brackets with a colon
  // after it. Selecting it by dragging takes the brackets along; the field must already hold the
  // address, Apply must link the address alone, and the long address must wrap inside the page.
  const URL_ = 'https://www.the-independent.com/life-style/happiness-researchers-relationships-wellbeing-health-b3074121.html';
  const ctx = await newContext({ viewport: { width: 700, height: 850 } }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const frame = await openJournal(page);
  await textMode(frame);
  await page.waitForTimeout(200);                                            // T mode's own caret-to-end lands first
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(`Here's the summary (${URL_}):`);          // a paste, as the owner did
  // Drag from just before "(" to just after ":" — the brackets and the colon come along, as they do by hand.
  const box = await page.locator('#fr').boundingBox();
  const ends = await frame.evaluate((u) => {
    const tl = document.querySelector('.pan-textlayer'), it = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
    for (let n; (n = it.nextNode());) { const i = n.nodeValue.indexOf('(' + u); if (i < 0) continue;
      const at = (k) => { const r = document.createRange(); r.setStart(n, k); r.setEnd(n, k + 1); return r.getClientRects()[0]; };
      const a = at(i), b = at(i + u.length + 2);                             // "(" and ":"
      return { x0: a.left + 1, y0: a.top + a.height / 2, x1: b.right - 1, y1: b.top + b.height / 2 }; }
    return null; }, URL_);
  assert.ok(ends, 'the pasted line is on the page');
  await page.mouse.move(box.x + ends.x0, box.y + ends.y0); await page.mouse.down();
  await page.mouse.move(box.x + ends.x1, box.y + ends.y1, { steps: 12 }); await page.mouse.up();
  assert.match(await frame.evaluate(() => getSelection().toString()), /^\(https:\/\/www\.the-independent\.com\/.*\):$/, 'CONTROL: the drag took the brackets and the colon along');
  await frame.locator('.pan-flink').click();
  assert.equal(await linking(frame), true, `the address field opened (flash: "${await flashText(frame)}")`);
  assert.equal(await frame.locator('.pan-linkurl').inputValue(), URL_, 'the field already holds the selected address, brackets and colon trimmed');
  await frame.locator('.pan-linkok').click();                                // ONE press
  assert.equal(await linking(frame), false, 'Apply closed the form');
  assert.ok((await layerHtml(frame)).includes(`(<a href="${URL_}">${URL_}</a>):`), 'the address alone is linked; the brackets and colon stay outside');
  await onDisk((h) => h.includes(`(<a href="${URL_}" target="_blank" rel="noopener noreferrer">${URL_}</a>):`), 'the linked address on disk');
  // A second long address with NO hyphen: the owner's breaks at its hyphens on its own, so only this
  // one proves the page wraps an unbreakable address. Selected exactly, then linked.
  const LONG = 'https://example.com/' + 'x'.repeat(160);
  // Caret to the end of the page first: Apply leaves the new link SELECTED, and Enter would replace it
  // (End cannot be used to collapse it: on macOS it scrolls and leaves the selection where it is).
  await frame.evaluate(() => { const tl = document.querySelector('.pan-textlayer'), r = document.createRange();
    r.selectNodeContents(tl); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(LONG);
  await frame.evaluate((u) => { const tl = document.querySelector('.pan-textlayer'), it = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
    for (let n; (n = it.nextNode());) { const i = n.nodeValue.indexOf(u); if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + u.length); getSelection().removeAllRanges(); getSelection().addRange(r); return; } }, LONG);
  await frame.locator('.pan-flink').click();
  assert.equal(await frame.locator('.pan-linkurl').inputValue(), LONG, 'filled again');
  await frame.locator('.pan-linkok').click();
  // It WRAPS where it is READ: out of text mode, because an editable element gets overflow-wrap from
  // Chromium's own stylesheet and would pass whatever the pad's CSS said. More than one line box,
  // every one inside the page, and nothing scrolls sideways.
  await frame.locator('.pan-mtext').click();
  await frame.waitForFunction(() => !document.querySelector('.pan-textlayer.pan-txted'));
  const fit = await frame.evaluate((us) => us.map((u) => {
    const tl = document.querySelector('.pan-textlayer'), a = [...tl.querySelectorAll('a')].find((x) => x.getAttribute('href') === u);
    if (!a) return { u, lines: 0 };
    const L = tl.getBoundingClientRect(), rs = [...a.getClientRects()];
    return { u, lines: rs.length, inside: rs.every((r) => r.left >= L.left - 0.5 && r.right <= L.right + 0.5), sw: tl.scrollWidth, cw: tl.clientWidth }; }), [URL_, LONG]);
  for (const f of fit) {
    assert.ok(f.lines >= 2, `CONTROL: the address is linked and longer than a line (${f.lines} line boxes): ${f.u.slice(0, 40)}…`);
    assert.ok(f.inside, `every line of the link sits inside the page: ${f.u.slice(0, 40)}…`);
    assert.ok(f.sw <= f.cw, `no sideways overflow (scrollWidth ${f.sw} > clientWidth ${f.cw})`);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the sanitizer in a real DOM: safe links kept with fixed target/rel, unsafe ones unwrapped, a fixpoint', { skip, timeout: 60000 }, async () => {
  const ctx = await newContext(); const page = await ctx.newPage();
  const frame = await openJournal(page);
  const KEEP = '" target="_blank" rel="noopener noreferrer">';
  const cases = [
    ['<a href="https://x.com/a" onclick="alert(1)" target="_self" rel="opener" id="i">t</a>', '<a href="https://x.com/a' + KEEP + 't</a>'],
    ['<a href="example.com">t</a>', '<a href="https://example.com/' + KEEP + 't</a>'],
    ['<a href="mailto:a@b.co"><b>m</b></a>', '<a href="mailto:a@b.co' + KEEP + '<b>m</b></a>'],
    ['<a href="https://x.com/" style="color:red;position:fixed">t</a>', '<a href="https://x.com/' + KEEP.slice(0, -1) + ' style="color: red;">t</a>'],
    ['<a href="https://x.com/"><img src=x onerror="alert(1)">t</a>', '<a href="https://x.com/' + KEEP + 't</a>'],
    ['<a href="javascript:alert(1)">t</a>', 't'],
    ['<a href="&#106;avascript:alert(1)">t</a>', 't'],                       // entity-decoded by the parser, then refused
    ['<a href="java&#x09;script:alert(1)">t</a>', 't'],                     // a decoded TAB
    ['<a href=" JAVASCRIPT:alert(1)">t</a>', 't'],
    ['<a href="data:text/html,<script>alert(1)</script>">t</a>', 't'],
    ['<a href="vbscript:x">t</a>', 't'], ['<a href="file:///etc/passwd">t</a>', 't'], ['<a href="/rel">t</a>', 't'],
    ['<a>t</a>', 't'],
    ['<svg><a href="https://x.com/">t</a></svg>', 't'],                     // an SVG <a> is not an HTML link
    // The Bible pane's paste: the shell's renderMd output, re-sanitized here.
    ['<p>see <a href="https://x.com" target="_blank" rel="noopener noreferrer">x</a></p>', '<p>see <a href="https://x.com/' + KEEP + 'x</a></p>'],
  ];
  const got = await frame.evaluate((cs) => cs.map(([i]) => { const once = PANote.sanitizeHtml(i); return [once, PANote.sanitizeHtml(once)]; }), cases);
  cases.forEach(([input, want], k) => {
    assert.equal(got[k][0], want, input);
    assert.equal(got[k][1], got[k][0], `fixpoint: ${input}`);
  });
  await ctx.close();
});
