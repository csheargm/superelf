// lib/note-ocr.mjs — the bridge to the Vision tool, with Vision stood in for: an injected `runner`
// (pure unit) and the committed fake tool (test/fixtures/fake-panote-ocr.mjs) through the REAL
// execFile path (argv, env, timeout, JSON-line parsing, outcome codes). The one test that needs Vision
// itself is test/note-ocr-vision.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ocrInk, ocrImage, ocrAvailable, ocrPossible, ensureBuilt, runTool, unionText, isEnvFailure, OCR_PASSES, OCR_WIDTH_PX, OCR_ENV_RETRY_MS, OCR_CHILD_ENV_KEYS,
  OCR_UNAVAILABLE, OCR_TIMEOUT, OCR_FAILED, OCR_BAD_OUTPUT, OCR_BAD_INPUT, OCR_BUILD_FAILED, OCR_SPAWN_FAILED } from '../lib/note-ocr.mjs';
import { FAKE_OCR_CMD } from './helpers-web.mjs';
import { execFileSync } from 'node:child_process';
import { spawnSpec } from '../lib/wincmd.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const strokes = [{ c: '#141414', w: 0.002, p: [[0.1, 0.2, 0.5], [0.2, 0.2, 0.5]] }];
const line = (t, c = 0.5, box = [0.1, 0.1, 0.5, 0.1]) => ({ t, c, box });
// A runner that answers per pass (by OCR_LANGS) and records every call.
function fakeRunner(byLangs) {
  const calls = [];
  const runner = async (args, { env }) => { calls.push({ args, env }); const a = byLangs[env.OCR_LANGS]; return typeof a === 'function' ? a() : a; };
  return { runner, calls };
}

test('ocrInk: two passes over the same strokes file, lines tagged by pass, text = the union with duplicates once', async () => {
  const { runner, calls } = fakeRunner({
    'zh-Hans,en-US': { ok: true, ms: 700, text: [line('手写笔记 #墨水'), line('Satuday pollen'), line('shared')], labels: [] },
    'en-US': { ok: true, ms: 800, text: [line('Saturday pollen moderate'), line('shared'), line('  '), { t: 5 }], labels: [] },
  });
  const r = await ocrInk(strokes, { runner });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.env.OCR_LANGS), OCR_PASSES.map((p) => p.langs), 'pass A zh-Hans+en-US, pass B en-US, in that order');
  assert.deepEqual(calls.map((c) => c.args[0]), ['ink', 'ink']);
  assert.equal(calls[0].args[1], calls[1].args[1], 'the SAME temp strokes file for both passes');
  assert.deepEqual(calls.map((c) => c.args[2]), [String(OCR_WIDTH_PX), String(OCR_WIDTH_PX)]);
  assert.deepEqual(r.lines.map((l) => [l.t, l.pass]), [['手写笔记 #墨水', 'zh'], ['Satuday pollen', 'zh'], ['shared', 'zh'], ['Saturday pollen moderate', 'en'], ['shared', 'en']], 'blank and off-type lines dropped; boxes kept per pass');
  assert.equal(r.text, '手写笔记 #墨水\nSatuday pollen\nshared\nSaturday pollen moderate', 'the union: both passes\' words, a line both saw once');
  assert.equal(r.ms, 1500, 'the two passes\' time added');
  assert.ok(!fs.existsSync(calls[0].args[1]), 'the temp strokes file is removed');
  assert.equal(unionText([line('a'), line('b'), line('a')]), 'a\nb');
});

test('ocrInk: a failed pass is the outcome (no second pass), a thrown runner is an outcome too, no strokes is refused', async () => {
  const { runner, calls } = fakeRunner({ 'zh-Hans,en-US': { ok: false, code: OCR_TIMEOUT, error: 'no answer within 30000 ms' } });
  const r = await ocrInk(strokes, { runner });
  assert.deepEqual(r, { ok: false, code: OCR_TIMEOUT, error: 'no answer within 30000 ms' });
  assert.equal(calls.length, 1, 'pass B is not attempted after pass A failed');
  assert.ok(!fs.existsSync(calls[0].args[1]), 'the temp file is removed on failure too');
  const thrown = await ocrInk(strokes, { runner: async () => { throw new Error('spawn EACCES'); } });
  assert.deepEqual(thrown, { ok: false, code: OCR_FAILED, error: 'spawn EACCES' });
  assert.equal((await ocrInk([], { runner })).code, OCR_BAD_INPUT);
  assert.equal((await ocrInk('nope', { runner })).code, OCR_BAD_INPUT);
});

test('ocrImage: one pass, text lines plus the labels as plain words', async () => {
  const { runner, calls } = fakeRunner({ 'zh-Hans,en-US': { ok: true, ms: 300, text: [line('Receipt total 12.50')], labels: [{ l: 'document', c: 0.8 }, { l: 'receipt', c: 0.5 }, { c: 0.9 }] } });
  const r = await ocrImage('/ws/uploads/1_a.jpg', { runner });
  assert.deepEqual(r, { ok: true, lines: [line('Receipt total 12.50')], text: 'Receipt total 12.50', labels: ['document', 'receipt'], ms: 300 });
  assert.deepEqual(calls[0].args, ['image', '/ws/uploads/1_a.jpg']);
  assert.equal((await ocrImage('', { runner })).code, OCR_BAD_INPUT);
  assert.equal((await ocrImage('/x', { runner: async () => ({ ok: false, code: OCR_FAILED, error: 'cannot read image' }) })).error, 'cannot read image');
});

// The real execFile path, against the committed fake tool.
test('runTool through `cmd`: argv and env reach the child, the JSON line comes back, each failure has its code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ocr-'));
  const f = path.join(dir, 's.json'); fs.writeFileSync(f, JSON.stringify(strokes));
  const ok = await runTool(['ink', f, '1600'], { cmd: FAKE_OCR_CMD, env: { OCR_LANGS: 'en-US' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.text.map((l) => l.t), ['Saturday pollen moderate 1'], 'pass B through the real child process');
  const failed = await runTool(['ink', f], { cmd: FAKE_OCR_CMD, env: { FAKE_OCR_FAIL: 'vision: boom' } });
  assert.deepEqual(failed, { ok: false, code: OCR_FAILED, error: 'panote-ocr ink: vision: boom' });
  const garbage = await runTool(['ink', f], { cmd: FAKE_OCR_CMD, env: { FAKE_OCR_GARBAGE: '1' } });
  assert.equal(garbage.code, OCR_BAD_OUTPUT); assert.match(garbage.error, /not a JSON line: not json/);
  const slow = await runTool(['ink', f], { cmd: FAKE_OCR_CMD, env: { FAKE_OCR_HANG: '1' }, timeoutMs: 300 });
  assert.deepEqual(slow, { ok: false, code: OCR_TIMEOUT, error: 'panote-ocr ink: no answer within 300 ms' });
  const missing = await runTool(['ink', f], { cmd: path.join(dir, 'no-such-tool') });
  assert.equal(missing.code, OCR_UNAVAILABLE);
  // The whole ocrInk through the fake: the union is what phase 2 indexes.
  const r = await ocrInk(strokes, { cmd: FAKE_OCR_CMD });
  assert.equal(r.text, '手写笔记 #墨水 1\nSatuday pollen\nSaturday pollen moderate 1');
  const img = await ocrImage(f, { cmd: FAKE_OCR_CMD });
  assert.deepEqual(img.labels, ['document', 'receipt']);
  rmTemp(dir);
});

// CI (windows-latest): "spawn EFTYPE" — a .mjs cannot be spawned directly there. The tool goes through
// lib/wincmd.mjs spawnSpec, whose Windows shape is our own node with the script as argv; that shape is
// driven here from a Mac and RUN, so the Windows path is proven short of the runner itself.
test('on Windows the fake tool is run through our own node (spawnSpec shim shape), and that shape answers the JSON line', async () => {
  const spec = spawnSpec(FAKE_OCR_CMD, { platform: 'win32' });
  assert.deepEqual(spec, { file: process.execPath, args: [FAKE_OCR_CMD], shell: false, how: 'shim' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ocr-win-'));
  const f = path.join(dir, 's.json'); fs.writeFileSync(f, JSON.stringify(strokes));
  const out = execFileSync(spec.file, [...spec.args, 'ink', f, '1600'], { env: { PATH: process.env.PATH, OCR_LANGS: 'en-US' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim()).text.map((l) => l.t), ['Saturday pollen moderate 1']);
  rmTemp(dir);
});

test('availability: a `cmd` that exists is available anywhere; one that does not is not, and ensureBuilt says so with a code', async () => {
  assert.equal(ocrAvailable({ cmd: FAKE_OCR_CMD }), true);
  assert.equal(ocrAvailable({ cmd: '/no/such/tool' }), false);
  assert.deepEqual(await ensureBuilt({ cmd: FAKE_OCR_CMD }), { ok: true, bin: FAKE_OCR_CMD });
  assert.equal((await ensureBuilt({ cmd: '/no/such/tool' })).code, OCR_UNAVAILABLE);
  if (process.platform !== 'darwin') assert.equal(ocrAvailable(), false, 'without a cmd, only macOS has Vision');
});

// R13 round 1 #13: the PLATFORM branch (cmd ''), on any machine — injected, and through the env hook
// the route suite uses to stand in a Linux node.
test('a Linux node without a cmd: nothing possible, nothing available, ensureBuilt unavailable — by injection and by NOTE_OCR_PLATFORM', async () => {
  assert.equal(ocrPossible({ cmd: '', platform: 'linux' }), false);
  assert.equal(ocrAvailable({ cmd: '', platform: 'linux' }), false);
  assert.equal((await ensureBuilt({ cmd: '', platform: 'linux', compiler: '/usr/bin/true' })).code, OCR_UNAVAILABLE);
  process.env.NOTE_OCR_PLATFORM = 'linux';
  try {
    assert.equal(ocrPossible(), false, 'read at use time: the env hook stands in the platform');
    assert.equal(ocrAvailable(), false);
    assert.equal((await ensureBuilt()).code, OCR_UNAVAILABLE);
  } finally { delete process.env.NOTE_OCR_PLATFORM; }
  assert.equal(ocrPossible({ cmd: FAKE_OCR_CMD, platform: 'linux' }), true, 'CONTROL: a cmd is platform-free');
});

// R13 round 1 #1/#14: availability is PROVEN by a binary, not by swiftc's presence (the xcode-select
// shim exists on every Mac); a failed build is cached per process (one compiler run per failure, not
// per page) until the source changes or OCR_ENV_RETRY_MS passed; without a compiler a built binary
// is used as it is.
test('ensureBuilt: a binary proves availability; a failed build runs the compiler ONCE and is retried after the source moves or the window passes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ocr-build-'));
  const src = path.join(dir, 'tool.swift'); fs.writeFileSync(src, '// not swift');
  const bin = path.join(dir, 'build', 'tool');
  const count = path.join(dir, 'runs');
  // A node script, not a shell one: it runs on Windows too (through our own node, lib/wincmd.mjs).
  const compiler = path.join(dir, 'swiftc.mjs');
  fs.writeFileSync(compiler, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(count)}, 'run\\n');\nprocess.stderr.write('error: no toolchain here\\nsecond line\\n');\nprocess.exit(1);\n`, { mode: 0o755 });
  const runs = () => { try { return fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; /* never ran */ } };
  let t = 1_000_000; const now = () => t;
  const o = { bin, src, compiler, platform: 'darwin', now };
  assert.equal(ocrAvailable({ cmd: '', platform: 'darwin' }) , fs.existsSync(new URL('../tools/panote-ocr/build/panote-ocr', import.meta.url)), 'available means the real binary exists, whatever swiftc says');
  const first = await ensureBuilt(o);
  assert.deepEqual(first, { ok: false, code: OCR_BUILD_FAILED, error: 'swiftc: error: no toolchain here' }, 'the compiler\'s first stderr line is the reason');
  assert.ok(isEnvFailure(first.code));
  const again = await ensureBuilt(o);
  assert.deepEqual(again, first, 'the same outcome from the cache');
  assert.equal(runs(), 1, 'the compiler ran ONCE for two calls (one per page would be 50 runs for 50 pages)');
  t += OCR_ENV_RETRY_MS;
  await ensureBuilt(o);
  assert.equal(runs(), 2, 'after the retry window it is tried again');
  const later = fs.statSync(src).mtimeMs + 5000; fs.utimesSync(src, later / 1000, later / 1000);
  await ensureBuilt(o);
  assert.equal(runs(), 3, 'a changed source is tried at once');
  // A binary and no compiler: used as it is, even though the source is newer.
  fs.mkdirSync(path.dirname(bin), { recursive: true }); fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(await ensureBuilt({ ...o, compiler: null }), { ok: true, bin }, 'without swiftc the built binary is the tool');
  assert.deepEqual(await ensureBuilt({ ...o, bin: path.join(dir, 'none'), compiler: null }), { ok: false, code: OCR_UNAVAILABLE, error: 'handwriting OCR needs macOS with swiftc or a built tools/panote-ocr' });
  assert.equal(runs(), 3, 'no compiler, no run');
  rmTemp(dir);
});

// R13 round 1 #17: the child sees a minimal environment, never the server's. The fake tool fails on
// FAKE_OCR_FAIL from its environment: set in THIS process (not in the call's env) it must not arrive.
test('the child\'s env is PATH/HOME/TMPDIR/LANG plus the call\'s own keys: a marker in process.env does not reach the tool', async () => {
  assert.deepEqual([...OCR_CHILD_ENV_KEYS], ['PATH', 'HOME', 'TMPDIR', 'LANG']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ocr-env-'));
  const f = path.join(dir, 's.json'); fs.writeFileSync(f, JSON.stringify(strokes));
  process.env.FAKE_OCR_FAIL = 'the server environment leaked into the child';
  try {
    const r = await runTool(['ink', f, '1600'], { cmd: FAKE_OCR_CMD, env: { OCR_LANGS: 'en-US' } });
    assert.equal(r.ok, true, `the marker did not reach the tool: ${JSON.stringify(r)}`);
    const leaked = await runTool(['ink', f, '1600'], { cmd: FAKE_OCR_CMD, env: { FAKE_OCR_FAIL: 'passed on purpose' } });
    assert.equal(leaked.error, 'panote-ocr ink: passed on purpose', 'CONTROL: a key the call names does arrive');
  } finally { delete process.env.FAKE_OCR_FAIL; }
  // A spawn failure (a directory passes the X_OK check but cannot be run) is an ENVIRONMENTAL code.
  const spawn = await runTool(['ink', f], { cmd: dir });
  assert.equal(spawn.code, OCR_SPAWN_FAILED, JSON.stringify(spawn));
  assert.ok(isEnvFailure(spawn.code) && isEnvFailure(OCR_TIMEOUT) && isEnvFailure(OCR_UNAVAILABLE) && !isEnvFailure(OCR_FAILED) && !isEnvFailure(OCR_BAD_OUTPUT));
  rmTemp(dir);
});
