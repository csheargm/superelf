// PAPhoneUI — the ONE phone bottom sheet and the phone list sizes (journal-iphone step 3) · 手机底部面板
// No browser: the source contracts that keep iPad/desktop unchanged. The flows are in test/phone-sheet-e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (f) => fs.readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const SRC = read('phone-ui.inline.html'), CHAT = read('chat-ui.inline.html'), NU = read('note-ui.inline.html'), NP = read('note-phone.inline.html');
const WEB = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');

test('every rule of the sheet sits inside the phone media query: nothing applies off a phone', () => {
  const css = /<style id="pap-style">([\s\S]*?)<\/style>/.exec(SRC)[1].trim();
  assert.match(css, /^@media \(max-width:767\.98px\) and \(pointer:coarse\)\{[\s\S]*\}$/, 'one block, the phone query');
  let depth = 0, closedAt = -1;
  for (let i = 0; i < css.length; i++) { if (css[i] === '{') depth++; else if (css[i] === '}') { depth--; if (depth === 0) { closedAt = i; break; } } }
  assert.equal(closedAt, css.length - 1, 'the media block closes at the very end: no rule outside it');
});

test('isPhone reads the same breakpoint as PANotePhone, at use time', () => {
  const js = /<script id="pap-script">([\s\S]*?)<\/script>/.exec(SRC)[1];
  const mk = (m) => { const w = { matchMedia: (q) => ({ matches: m(q) }) }; vm.runInNewContext(js, { window: w }); return w.PAPhoneUI; };
  const NPQ = /const PHONE_MQ='([^']+)'/.exec(NP)[1];
  assert.equal(mk(() => false).MQ, NPQ, 'one breakpoint for both modules');
  assert.equal(mk((q) => q === NPQ).isPhone(), true);
  assert.equal(mk(() => false).isPhone(), false);
  const w = { matchMedia: () => { throw new Error('x'); } }; vm.runInNewContext(js, { window: w });
  assert.equal(w.PAPhoneUI.isPhone(), false, 'no matchMedia: the iPad/desktop path');
});

test('registered last, carried by chat-ui once', () => {
  assert.match(WEB, /\{ marker: '<!--PA_NOTE_PHONE_UI-->', file: 'note-phone\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_PHONE_UI-->', file: 'phone-ui\.inline\.html' \},\n\];/);
  assert.equal(CHAT.split('<!--PA_PHONE_UI-->').length, 2, 'chat-ui carries the marker once');
  assert.ok(!NU.includes('<!--PA_PHONE_UI-->'), 'note-ui does not (it would inline twice on the Journal)');
});

test('chat-ui: only a phone turns a menu into the sheet or closes the list on a row tap; a chat opening closes sheets', () => {
  assert.match(CHAT, /const phone=!!\(window\.PAPhoneUI&&window\.PAPhoneUI\.isPhone\(\)\); if\(phone\) anchor=null;/);
  assert.match(CHAT, /box\.className='pac-mbox'\+\(phone\?' pa-sheet':''\)/);
  assert.match(CHAT, /if\(window\.PAPhoneUI&&window\.PAPhoneUI\.isPhone\(\)\) close\(\);\n    \}\);/);
  assert.match(CHAT, /el\.inp\.focus\(\); drawer\.close\(\); closeSheets\(\);/);
});

test('the phone strip: ⋯ and the hidden controls are phone-only CSS; sheet labels are 中文 first', () => {
  assert.match(NP, /\.pan-toolmore\{display:none\}\n\.pan-phone \.pan-tools \.pan-toolmore\{display:flex\}/);
  for (const rule of NP.match(/^\.pan-phone[^\n]*$/gm).filter((l) => /display:none/.test(l) && /pan-tools/.test(l))) assert.match(rule, /^\.pan-phone /);
  const txt = /const SHEET_TXT=\{([\s\S]*?)\};/.exec(NP)[1];
  for (const [, k, v] of txt.matchAll(/(\w+):'([^']*)'/g)) assert.match(v, /^[一-鿿].* · [A-Z]/, `${k} is 中文 first`);
  assert.match(NU, /PANotePhone\.SHEET_TXT\.tip,when:phoneOn/, 'its first-use tip is phone-only');
  assert.match(NU, /const c=host\.classList\.contains\('pan-phone'\)\?toolsClearance\(\):barClearance\(\)/, 'only a phone gives the hidden bar room back');
});
