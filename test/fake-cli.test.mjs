// The test fakes launch through the REAL Windows path · 假 CLI 走真实的 Windows 启动路径
//
// The agent-lane confinement suites failed on windows-latest, all 16 with "Cannot run …\fakebin\claude
// safely on Windows": the fake was an extensionless POSIX script, which lib/wincmd.mjs rightly
// refuses. writeFakeCli now lays the fake out as npm does (JS entry + .cmd shim) on win32. These
// pin that the layout resolves through spawnSpec exactly like a real install — from any OS, so a
// Mac or Linux run catches a broken shim before a Windows runner does — and that the fake still
// receives argv and stdin verbatim, which is what the confinement assertions read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnSpec, findOnPath } from '../lib/wincmd.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ECHO = '#!/usr/bin/env node\nlet s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>'
  + 'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),stdin:s})));\n';
const HOSTILE = ['--append-system-prompt', 'line one\nline two & whoami & <!--PA_CHAT_UI--> "q"', '--flag'];
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-fakecli-'));

const runVia = (spec, stdin) => {
  const r = spawnSync(spec.file, [...spec.args, ...HOSTILE], { input: stdin, encoding: 'utf8', shell: spec.shell });
  assert.equal(r.status, 0, `the fake must run: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

test('win32 layout: the .cmd shim resolves to node + the JS entry, shell:false, argv and stdin verbatim', () => {
  const dir = mk();
  try {
    const cmd = writeFakeCli(dir, 'claude', ECHO, { platform: 'win32' });
    assert.equal(path.basename(cmd), 'claude.cmd', 'claude_cmd points at the shim, as on a real install');
    assert.ok(!fs.existsSync(path.join(dir, 'claude')), 'no extensionless file: Windows cannot run one');
    const spec = spawnSpec(cmd, { platform: 'win32', execPath: process.execPath, env: { PATH: '' } });
    assert.equal(spec.how, 'shim');
    assert.equal(spec.shell, false);
    assert.deepEqual(spec.args, [path.join(dir, 'claude.mjs')]);
    assert.deepEqual(runVia(spec, 'STDIN 中文\n'), { argv: HOSTILE, stdin: 'STDIN 中文\n' });

    // By NAME on PATH, which is how web.mjs finds `codex`. PATHEXT spelled as the shim's case, so
    // the lookup does not depend on this disk being case-insensitive.
    writeFakeCli(dir, 'codex', ECHO, { platform: 'win32' });
    assert.equal(findOnPath('codex', { pathEnv: dir, pathext: '.exe;.cmd' }), path.join(dir, 'codex.cmd'));
    const byName = spawnSpec('codex', { platform: 'win32', execPath: process.execPath, env: { PATH: dir, PATHEXT: '.exe;.cmd' } });
    assert.equal(byName.how, 'shim');
    assert.deepEqual(runVia(byName, 'x'), { argv: HOSTILE, stdin: 'x' });
  } finally { rmTemp(dir); }
});

test('this OS: the fake writeFakeCli lays down is launched by the real spawnSpec, argv and stdin verbatim', () => {
  // No platform override: on windows-latest this is the shim, on Linux/macOS the shebang script.
  const dir = mk();
  try {
    const cmd = writeFakeCli(dir, 'claude', ECHO);
    const spec = spawnSpec(cmd);
    assert.notEqual(spec.how, 'unresolved', 'never the shell fallback: the confinement suites would refuse to run');
    assert.equal(spec.shell, false);
    assert.deepEqual(runVia(spec, 'hello'), { argv: HOSTILE, stdin: 'hello' });
  } finally { rmTemp(dir); }
});
