// 应用对话自测修复 · App chat self-test fixes, the UI half (2026-11-24 sweep: F4 F5 F6 F7 F10 F11 F12).
// F6 runs the real PASnap in a browser; the rest pin the shared components the sweep found wrong.
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { skip, chromium } from './helpers-note-link.mjs';
import { planPrompt, editSystemPrompt, earlierShotsLine } from '../lib/app-edit.mjs';
import { PLAIN_WORDS_RULE, ON_SCREEN_RULE } from '../lib/app-edit-confirm.mjs';
import { saidOf, CHANGED_FALLBACK } from '../lib/app-edit-lane.mjs';
import { OVERRIDABLE_PROMPT_MAX } from '../lib/config.mjs';
import { editUnchangedNote, EDIT_UNCHANGED_NOTE } from '../lib/app-chat-honesty.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
let browser;
after(async () => { if (browser) await browser.close(); });

test('F6: a fixed bottom bar is drawn at the bottom of the auto-shot, where the user sees it', { skip }, async () => {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 400, height: 600 } });
  const snap = read('web/snap.inline.html');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><p>No tasks found.</p>
    <div style="position:fixed;left:0;right:0;bottom:0;height:60px;background:rgb(255,0,0)"></div>${snap}</body></html>`);
  const at = await page.evaluate(async () => {
    const url = await PASnap.shot(); const im = new Image(); im.src = url; await im.decode();
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const px = (y) => Array.from(g.getImageData(Math.floor(c.width / 2), Math.floor(y * c.height), 1, 1).data.slice(0, 3));
    return { top: px(0.02), bottom: px(0.98) };
  });
  assert.deepEqual(at.bottom, [255, 0, 0], `the bar at the bottom: ${JSON.stringify(at)}`);
  assert.notDeepEqual(at.top, [255, 0, 0], 'CONTROL: not at the top');
});

test('F1: an unconfirmed turn (a question) never gets the "not changed" note; an Apply turn still does', () => {
  assert.equal(editUnchangedNote('这个应用已添加任务列表', { changed: false }, false), '');
  assert.equal(editUnchangedNote('Done — added the week view.', { changed: false }, true), EDIT_UNCHANGED_NOTE);
});

test('F2: the member lane keeps the model\'s plain sentence, never code', () => {
  assert.equal(saidOf('The Add button is now dark green.\n```html\n<html></html>\n```'), 'The Add button is now dark green.');
  assert.equal(saidOf('```html\n<html></html>\n```'), '', 'no sentence: the fallback is used');
  assert.ok(CHANGED_FALLBACK.length > 0);
});

test('F4 + F5: plans and Apply turns are told to use plain words and to check the screen', () => {
  for (const r of [PLAIN_WORDS_RULE, ON_SCREEN_RULE]) assert.ok(planPrompt('todo').includes(r));
  assert.ok(editSystemPrompt({ slug: 'todo', confirmed: true, plan: 'p' }).includes(PLAIN_WORDS_RULE));
  assert.match(PLAIN_WORDS_RULE, /file names[\s\S]*line numbers[\s\S]*CSS[\s\S]*UTC/);
  assert.ok(editSystemPrompt({ slug: "todo", dir: "/x/apps/todo", confirmed: false }).length <= OVERRIDABLE_PROMPT_MAX, "the whole edit line fits the one prompt cap (it was cut, losing its last rule)");
  assert.doesNotMatch(planPrompt('todo'), /never show file paths beyond apps/, 'the old rule allowed apps/x/index.html');
});

test('F9: earlier pictures are a fact on later turns', () => {
  assert.match(earlierShotsLine([{ role: 'me', text: 'hi', attachments: [{ path: 'uploads/s.png' }] }]), /1 picture\(s\).*uploads\/s\.png/);
  assert.equal(earlierShotsLine([{ role: 'me', text: 'hi' }]), '');
});

test('F7 + F10 + F11 + F12: PAChat and the panel', () => {
  const ui = read('web/chat-ui.inline.html'), ae = read('web/app-edit.js');
  assert.match(ui, /\.pac-m img\{max-width:min\(120px,50%\);max-height:120px;/, 'F7: a small thumbnail in the bubble');
  assert.match(ui, /el\.inp\.value=el\.inp\.placeholder; h=Math\.max\(h,el\.inp\.scrollHeight\)/, 'F10: the empty box fits its placeholder');
  assert.match(ui, /if\(!_doneFailed\) _addTook/, 'F11: no "took" under a refusal');
  assert.match(ae, /function undoLeft\(n\)\{ if\(S&&n===0\)/, 'F11: Undo hides at 0 left');
  assert.match(ae, /'<button data-a="edit-app" id="aeItem">'\+ITEM\+'<\/button>'/, 'F12: the item\'s text is its action; the tip is a separate PATips bubble');
});
