// Every served app page must carry the prefs listener.
//
// SCAR: A-/A+ changed only the shell's own header. The shell broadcast the scale to each app
// (sendAppPrefs → pa:'prefs'), and the CSS in every app consumed var(--fs) — but the only
// code that ever SET --fs lived in chat-ui.inline.html, so an app that does not mount PAChat
// never received it. Productivity Hub sizes everything in rem and still did not move.
// Apps cannot share a script FILE (sandbox CSP script-src has no 'self'), so the one copy is
// injected server-side into every app page, including apps written later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8'); // throws if moved (R14)

test('the prefs snippet exists and is injected unconditionally', () => {
  assert.match(WEB, /const PA_PREFS_SNIPPET =/, 'the one copy lives in web.mjs');
  assert.match(WEB, /fontScale/, 'and reads the broadcast scale');
  assert.match(WEB, /setProperty\("--fs",m\.fontScale\)/, 'setting the variable the app CSS consumes');
  assert.match(WEB, /r\.style\.zoom=m\.fontScale/, 'and zoom for apps whose CSS is absolute px');
  const fn = WEB.slice(WEB.indexOf('function sendAppHtml('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /PA_PREFS_SNIPPET/, 'every app page gets it');
  // NOT gated on a marker: that is exactly how PAChat-less apps were missed.
  const inject = body.slice(body.indexOf('PA_PREFS_SNIPPET'));
  assert.equal(/marker/i.test(inject), false, 'injection must not be conditional on a component marker');
});

test('it is injected before </body>, so the listener exists when prefs arrive', () => {
  // The shell posts prefs on iframe load; a listener added after that would miss the first one.
  assert.match(WEB, /replace\('<\/body>', snip \+ '<\/body>'\)/);
});

test('a page without </body> still gets it rather than silently losing the setting', () => {
  assert.match(WEB, /: html \+ snip/);
});

test('apps consume it: the templates key their base off var(--fs)', () => {
  for (const a of ['bible', 'notes', 'tasks', 'longevity']) {
    const p = path.join(ROOT, 'workspace.example/apps', a, 'index.html');
    if (!fs.existsSync(p)) continue;
    assert.match(fs.readFileSync(p, 'utf8'), /var\(--fs,\s*1\)/, `${a} must honour the user's font scale`);
  }
});

test('zoom and --fs are EXCLUSIVE — an app must never scale twice', () => {
  // html{font-size:calc(17px*var(--fs,1))} PLUS zoom compounds: 1.5 renders as 2.25.
  assert.match(WEB, /zoomOk \? ' r\.style\.zoom=m\.fontScale;' : ' r\.style\.setProperty\("--fs",m\.fontScale\);'/,
    'one or the other, chosen per app');
  const chat = fs.readFileSync(path.join(ROOT, 'web/chat-ui.inline.html'), 'utf8');
  assert.equal(/setProperty\('--fs',m\.fontScale\)/.test(chat), false,
    'chat-ui must not set it too — that is the second setter that caused the compounding (R3)');
});

test('a PANote app is excluded from zoom, and the decision is made before inlining', () => {
  // PANote sizes its canvas from a MEASURED element width, so zoom re-lays the page out rather
  // than magnifying it — and that path carries an ink-offset scar.
  assert.match(WEB, /const hasNote = html\.includes\(PA_NOTE_MARKER\)/, 'detected from the marker');
  const decide = WEB.indexOf('const hasNote');
  const inline = WEB.indexOf('html = html.split(c.marker)');
  assert.ok(decide > 0 && inline > decide, 'must be decided BEFORE inlining replaces the marker');
  assert.match(WEB, /PA_PREFS_SNIPPET\(!hasNote\)/, 'and drives the choice');
});

// Long-press A-/A+ returns the text size to 1.0.
// Seven steps (0.75 -> 1.75) with no indicator meant counting clicks back to normal and
// overshooting. Long-press is already this app's idiom (the version number opens the changelog
// the same way), so the reset costs no extra button.
test('long-press resets the scale, and that press does not also step it', () => {
  const SHELL = readShell(ROOT);
  assert.match(SHELL, /const FS_DEFAULT=2;/, '1.0 is the documented default index');
  assert.match(SHELL, /function fsReset\(\)/);
  assert.match(SHELL, /setTimeout\(\(\)=>\{ held=1; fsReset\(\); \},\d+\)/, 'a held press resets');
  assert.match(SHELL, /if\(held\)\{ held=0; return; \}/,
    'and the click that follows the hold must NOT also change the size');
  assert.match(SHELL, /fsBind\('\.fs-dn',-1\); fsBind\('\.fs-up',1\);/, 'both buttons, both pairs');
});

test('the scale is one GLOBAL setting, stored per device', () => {
  const SHELL = readShell(ROOT);
  // One key, in the shell. No app keeps its own, so changing it in one app changes all of them.
  assert.equal((SHELL.match(/'pa_fs'/g) || []).length >= 2, true);
  for (const a of ['bible', 'notes', 'tasks', 'longevity']) {
    const p = path.join(ROOT, 'workspace.example/apps', a, 'index.html');
    if (!fs.existsSync(p)) continue;
    assert.equal(/pa_fs/.test(fs.readFileSync(p, 'utf8')), false, `${a} must not keep its own scale`);
  }
});

test('both A-/A+ pairs advertise the long-press reset, bilingually, from one source', () => {
  // A long-press nobody knows about is not a feature. The buttons exist TWICE (main header and
  // app frame bar); the title is set in fsBind so four attributes cannot drift apart (R3).
  const SHELL = readShell(ROOT);
  assert.match(SHELL, /const FS_RESET_HINT=' — 长按恢复默认 · long-press to reset';/);
  assert.match(SHELL, /function fsTitle\(d\)\{ return \(d<0\?'缩小字号 · Smaller text':'放大字号 · Larger text'\)\+FS_RESET_HINT; \}/);
  assert.match(SHELL, /b\.title=fsTitle\(d\);/);
  // The app's own A-/A+ (ADR 0032) get the same titles through prefs, not a copy.
  assert.match(SHELL, /fsTitles:\[fsTitle\(-1\),fsTitle\(1\)\]/);
  // and NOT hardcoded back into the markup
  assert.equal(/<button class="ibtn fs-(dn|up)" title=/.test(SHELL), false,
    'titles come from fsBind, not from repeated attributes');
});
