// Run now（立即运行）— the three things that made it unreadable.
//
// SCAR: a user pressed Run now and the row said "running · 运行中…" indefinitely. The job had
// finished minutes earlier. Three separate defects, and they compounded:
//   1. the status element was captured by INDEX and re-rendering the list orphaned it, so the
//      final update landed on a detached node while the visible row kept saying "running";
//   2. no elapsed time, so "working" and "hung" looked identical — which is precisely the
//      question the user asked ("not sure how long it will run");
//   3. no timeout at all, so a request that never returns claims to be running for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);

test('the status slot is addressed by JOB NAME, never a list index', () => {
  // An index is valid only until the list re-renders. Measured in a browser: after
  // loadJobs() the captured node is detached (document.contains === false) while a
  // name-addressed lookup still finds the live row.
  assert.match(SHELL, /<span data-jr="\$\{esc\(r\.name\)\}"><\/span>/, 'the slot carries the job name');
  assert.ok(!/data-ji="\$\{i\}"/.test(SHELL), 'the index-keyed attribute is gone');
  assert.match(SHELL, /const say=\(t\)=>\{ const el=\$\('#jobsList'\)\.querySelector\(`\[data-jr="\$\{CSS\.escape\(jobName\)\}"\]`\)/,
    'and it is RE-FOUND on each update rather than held');
  assert.ok(!/const slot=\$\('#jobsList'\)\.querySelector/.test(SHELL), 'no captured reference survives');
});

test('elapsed time is shown while it runs', () => {
  // A research job does a web search, scrapes pages and calls a model. Tens of seconds is
  // normal, so the honest answer to "how long?" is to show the time passing.
  // Asserted on BEHAVIOUR, not an exact expression: the first version pinned the literal
  // `const tick=setInterval(...)` and my own control mutation — inserting a no-op `0||`,
  // which changes nothing — failed it. A test that breaks on a harmless edit reports
  // regressions that are not there.
  assert.match(SHELL, /setInterval\([\s\S]{0,40}running · 运行中…[\s\S]{0,40}took\([\s\S]{0,30}\),\s*1000\s*\)/,
    'a counter updates the row with the elapsed time, about once a second, while it runs');
  assert.match(SHELL, /clearInterval\(tick\)/, 'and stops when the answer arrives');
  // took() is the shell's ONE elapsed formatter (R3) — the same one chat uses for "took Xs".
  assert.equal((SHELL.match(/function took\(ms\)\{/g) || []).length, 1, 'one formatter, not a second copy here');
});

test('there is a real ceiling on the wait', () => {
  assert.match(SHELL, /const RUN_NOW_TIMEOUT_MS=\d+\*60\*1000/, 'the timeout is a named constant');
  assert.match(SHELL, /const ac=new AbortController\(\)[\s\S]{0,200}setTimeout\(\(\)=>ac\.abort\(\),RUN_NOW_TIMEOUT_MS\)/,
    'the request is actually abortable');
  assert.match(SHELL, /signal:ac\.signal/, 'and the signal reaches fetch');
  assert.match(SHELL, /timedOut=ac\.signal\.aborted/, 'a timeout is distinguished from any other failure');
  assert.match(SHELL, /gave up after \$\{elapsed\} · 超时未完成 — it may still finish/,
    'and it says the job may still be running server-side, because it is — the ceiling is on the WAIT, not the job');
});

test('every terminal state reports how long it took', () => {
  // Otherwise a fast failure and a slow one read the same, and neither tells you whether it
  // was worth waiting.
  for (const state of ['✓ ran · 已运行', 'ran again today · 已再次运行', 'no report today · 今日无简报']) {
    const i = SHELL.indexOf(state);
    assert.ok(i > 0, `missing state: ${state}`);
    assert.ok(SHELL.slice(i, i + 40).includes('${elapsed}'), `${state} must carry the elapsed time`);
  }
});

test('a failure still reports the SERVER\'s reason', () => {
  // The row must not flatten a 409/400 into a generic "failed" — the server's sentence is the
  // only thing that tells the user what to change.
  assert.match(SHELL, /✗ failed · 失败\$\{j&&j\.error\?': '\+j\.error:''\}/, 'the server error is shown when there is one');
});
