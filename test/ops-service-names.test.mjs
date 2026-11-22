// The ops scripts' names and process patterns have ONE home · 运维脚本的名称与进程模式只定义一次
//
// Split out of test/linux-service.test.mjs (R4). These read the scripts as text; the behaviour they
// protect is driven for real in linux-service.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Executable lines only — the scripts' comments NAME the old patterns while explaining the scar.
const code1 = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// The service names live in ONE file (R3), sourced by all four scripts: a script that spelled its
// own copy could disagree with the others about who owns web.mjs.
test('ops/service.sh names both owners once, and every ops script sources it', () => {
  const svc = code1('ops/service.sh');
  assert.match(svc, /WEB_SVC="com\.superelf\.web"/, 'macOS: the launchd label');
  assert.match(svc, /WEB_UNIT="superelf-web"/, 'Linux: the systemd user unit');
  for (const f of ['install.sh', 'start.sh', 'stop.sh', 'run.sh']) {
    assert.match(code1(f), /^\. ops\/service\.sh/m, `${f} sources ops/service.sh`);
    assert.ok(!/com\.superelf\.web"|="superelf-web"/.test(code1(f)), `${f} does not redefine a name`);
  }
});

// ENUMERATED, not patched at one site: the full-path pattern used to be the literal
// "personal_agent/…" — the author's checkout name — so on a fresh clone into "superelf" status
// lied and strays survived stop. No ops script, doc or test may hard-code a checkout name again.
test('no ops script hard-codes a checkout directory name in a process pattern', () => {
  for (const f of ['start.sh', 'stop.sh', 'run.sh', 'install.sh', 'ops/service.sh',
    'start.ps1', 'stop.ps1', 'run.ps1', 'install.ps1']) {
    assert.ok(!/(personal_agent|superelf)[/\\]\(?(web|bot)/.test(code1(f)), `${f} hard-codes a checkout name`);
  }
  assert.match(code1('ops/service.sh'), /basename "\$SUPERELF_ROOT"/, 'derived from the checkout itself');
  assert.match(code1('ops/service.sh'), /_ere_escape/, 'and regex-escaped');
});
