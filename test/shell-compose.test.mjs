// The shell is assembled from three files at serve time. Two things must stay true, and neither
// announces itself when it breaks.
//
// SCAR: extracting the settings dialog and settings JS out of web/index.html was committed as
// "zero behavior change". It broke 12 tests and silently blinded ~19 more: they grep the RAW
// index.html, so everything that moved out simply stopped being guarded — assertions that pass
// because the text is not there to contradict them. Tests now read the composed shell.
//
// The second hazard is quieter: String.replace on a MISSING marker is a no-op. Drop the marker
// while editing index.html and the shell ships with no settings dialog, no error, nothing in the
// console — the failure only shows when a user taps the gear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell, inlineShellParts, SHELL_PARTS } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

test('every extracted part is really inlined, and no marker survives', () => {
  const shell = readShell(ROOT);
  for (const [marker, file] of SHELL_PARTS) {
    assert.ok(RAW.includes(marker), `web/index.html lost ${marker} — ${file} would vanish silently`);
    assert.ok(!shell.includes(marker), `${marker} survived composition — ${file} was not inlined`);
    const part = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
    assert.ok(part.trim().length > 100, `${file} is empty — composition would succeed with nothing in it`);
    assert.ok(shell.includes(part.trim().split('\n')[0].trim()), `${file}'s content is missing from the shell`);
  }
  assert.ok(shell.length > RAW.length, 'the composed shell must be larger than index.html alone');
});

test('a missing marker FAILS instead of silently dropping the part', () => {
  for (const [marker, file] of SHELL_PARTS) {
    assert.throws(() => inlineShellParts(ROOT, RAW.replace(marker, '')),
      new RegExp(file.replace('.', '\\.')), `dropping ${marker} must throw, not no-op`);
  }
});

test('the settings surface is reachable from the composed shell, not just from a file', () => {
  const shell = readShell(ROOT);
  // A sample of what the extraction moved. If a test greps the raw index.html for any of these it
  // is asserting against text that is no longer there.
  for (const needle of ['id="cfg"', 'id="pName"', 'id="pBriefEmail"', 'function loadProfile', 'doNodeRestart']) {
    assert.ok(shell.includes(needle), `the composed shell must carry ${needle}`);
  }
});

test('the composed shell still parses', () => {
  const blocks = [...readShell(ROOT).matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
  const real = blocks[blocks.length - 1][1];       // the shell's own script, after composition
  assert.ok(real.length > 10000, 'found the shell script block');
  new Function(real);                              // throws on a syntax error introduced by composition
});

test('web.mjs serves the SAME composition the tests read', () => {
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(web, /readShell\(ROOT\)/, 'the server must use the shared composition');
  for (const [marker] of SHELL_PARTS) {
    assert.ok(!web.includes(`.replace('${marker}'`), `web.mjs kept its own copy of the ${marker} inlining`);
  }
});
