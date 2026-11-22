// Note OCR（手写识别）— the node's bridge to tools/panote-ocr (Apple Vision), phase 2 of note search
// (docs/plans/note-search.md, ADR 0023). Local only: a page's strokes or picture go to a child
// process on this Mac and nowhere else.
//
// Every function resolves an OUTCOME — {ok:true,...} or {ok:false,error,code} — never a throw: the
// caller is a background queue (lib/note-ocr-queue.mjs) and a thrown error there would either take
// the process down or vanish (R5). `runner` is injectable so unit tests never need Vision; the ONE
// real-Vision test (test/note-ocr-vision.test.mjs) is gated on ocrPossible().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnSpec } from './wincmd.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOOL_DIR = path.join(ROOT, 'tools', 'panote-ocr');
export const TOOL_SRC = path.join(TOOL_DIR, 'panote-ocr.swift');
export const TOOL_BIN = path.join(TOOL_DIR, 'build', 'panote-ocr');   // gitignored; built on first use
export const OCR_TIMEOUT_MS = 30000;        // the hard cap on one Vision run (measured 0.3–1.2 s)
export const OCR_BUILD_TIMEOUT_MS = 180000;
export const OCR_ENV_RETRY_MS = 10 * 60 * 1000;   // an environmental failure (build, spawn, timeout) is retried at most this often
export const OCR_WIDTH_PX = 1600;           // ink render width (measured: 2400 px recognised no better)
export const OCR_MAX_OUTPUT = 4 * 1024 * 1024;
// Two passes over the same ink and the UNION of their lines (measured 2026-11-09 on three real pages):
// zh-Hans+en-US gets the Chinese right but garbles English words inside Chinese lines; en-US alone
// gets those words right and drops the Chinese. Neither pass alone is enough; both together are.
export const OCR_PASSES = Object.freeze([
  Object.freeze({ pass: 'zh', langs: 'zh-Hans,en-US' }),
  Object.freeze({ pass: 'en', langs: 'en-US' }),
]);
// Outcome codes, in two classes (R13 round 1 #1/#14). CONTENT failures are about the page: remembered
// per content hash by the index and not retried until the page changes. ENVIRONMENTAL failures are
// about this node right now: never written into a record, they abort the burst and are retried later.
export const OCR_UNAVAILABLE = 'ocr_unavailable';   // not macOS, or no swiftc and no built binary
export const OCR_BUILD_FAILED = 'ocr_build_failed';
export const OCR_TIMEOUT = 'ocr_timeout';
export const OCR_SPAWN_FAILED = 'ocr_spawn_failed'; // the child could not be started (ENOENT, EACCES…)
export const OCR_FAILED = 'ocr_failed';             // the tool said ok:false, or died
export const OCR_BAD_OUTPUT = 'ocr_bad_output';     // stdout was not the one JSON line
export const OCR_BAD_INPUT = 'ocr_bad_input';
export const OCR_ENV_CODES = Object.freeze([OCR_UNAVAILABLE, OCR_BUILD_FAILED, OCR_TIMEOUT, OCR_SPAWN_FAILED]);
export const isEnvFailure = (code) => OCR_ENV_CODES.includes(code);
// The child's environment: only what the tool needs (tools/panote-ocr reads OCR_LANGS/OCR_NOCORR). A
// token in the service environment must not reach a config-chosen binary (R13 round 1 #17).
export const OCR_CHILD_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG']);

const fail = (code, error) => ({ ok: false, code, error: String(error && error.message || error) });
const exists = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; /* absent or not runnable: both mean "no" */ } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; /* absent: older than anything */ } };
// The platform is read at use time so a test can stand in a Linux node (R13 round 1 #13).
export const platformNow = () => process.env.NOTE_OCR_PLATFORM || process.platform;
const childEnv = (env) => ({ ...Object.fromEntries(OCR_CHILD_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])), ...env });
// How a tool (the binary, a config `cmd`, a test's compiler) is started: NEVER through a shell. On
// Windows a .mjs stand-in (the committed fake tool) cannot be spawned directly (EFTYPE), so it runs
// through our own node with the script as argv (lib/wincmd.mjs — ONE resolver, shared with runner
// and codex). spawnSpec's shell fallback is dropped on purpose: the argv here are paths and numbers
// the server chose, and a file no shell can run either fails as a spawn error, which has its code.
const toolSpec = (bin) => { const s = spawnSpec(bin); return { file: s.file, args: s.args }; };
const runFile = (bin, args, opts, cb) => { const s = toolSpec(bin); return execFile(s.file, [...s.args, ...args], opts, cb); };

// swiftc on PATH, looked up once per process (the toolchain does not appear mid-run).
let swiftcPath;
export function swiftc() {
  if (swiftcPath !== undefined) return swiftcPath;
  swiftcPath = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'swiftc')).find(exists) || null;
  return swiftcPath;
}

// `cmd` is config `note_ocr_cmd`: an executable that stands in for the built tool (a test's fake
// runner, read at use time so no restart). Without it the tool is the real one, macOS only.
// ocrPossible: there is something to TRY (a binary, or swiftc to build one). ocrAvailable: PROVEN —
// a binary exists or a build succeeded in this process. /usr/bin/swiftc exists on every Mac as
// Apple's xcode-select shim even without the Command Line Tools, so swiftc's presence alone proves
// nothing: the route says 'building' on the first kick and 'failed' with the compiler's words after.
export function ocrPossible({ cmd = '', platform = platformNow() } = {}) {
  if (cmd) return exists(cmd);
  return platform === 'darwin' && (exists(TOOL_BIN) || !!swiftc());
}
export function ocrAvailable({ cmd = '', platform = platformNow() } = {}) {
  if (cmd) return exists(cmd);
  return platform === 'darwin' && exists(TOOL_BIN);
}
export const needsBuild = (bin = TOOL_BIN, src = TOOL_SRC) => !exists(bin) || mtime(src) > mtime(bin);

// Compile once, `swiftc -O`, into the gitignored build dir; again when the .swift is newer than the
// binary. One build at a time per process (the promise is shared). A FAILED build is cached — the
// compiler runs once per failure, not once per page — until the .swift changes or OCR_ENV_RETRY_MS
// passed. Without a compiler an existing (even stale) binary is used. `building()` is what the
// route reports. `bin`/`src`/`compiler` are the real tool's unless a test stands them in.
let buildP = null;
let buildFailed = null;   // {outcome, bin, srcMtime, at}
export const building = () => !!buildP;
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
export function ensureBuilt({ cmd = '', now = Date.now, bin = TOOL_BIN, src = TOOL_SRC, compiler = swiftc(), platform = platformNow() } = {}) {
  if (cmd) return Promise.resolve(exists(cmd) ? { ok: true, bin: cmd } : fail(OCR_UNAVAILABLE, `note_ocr_cmd ${cmd} is not an executable`));
  if (platform !== 'darwin' || (!exists(bin) && !compiler)) return Promise.resolve(fail(OCR_UNAVAILABLE, 'handwriting OCR needs macOS with swiftc or a built tools/panote-ocr'));
  if (!needsBuild(bin, src) || !compiler) return Promise.resolve({ ok: true, bin });
  if (buildP) return buildP;
  if (buildFailed && buildFailed.bin === bin && buildFailed.srcMtime === mtime(src) && now() - buildFailed.at < OCR_ENV_RETRY_MS) return Promise.resolve(buildFailed.outcome);
  buildFailed = null;
  buildP = new Promise((resolve) => {
    try { fs.mkdirSync(path.dirname(bin), { recursive: true }); } catch (e) { return resolve(fail(OCR_BUILD_FAILED, e)); }
    runFile(compiler, ['-O', '-o', bin, src], { env: childEnv({}), timeout: OCR_BUILD_TIMEOUT_MS, maxBuffer: OCR_MAX_OUTPUT }, (err, _out, stderr) => {
      resolve(err ? fail(OCR_BUILD_FAILED, `swiftc: ${firstLine(stderr) || err.message}`.slice(0, 300)) : { ok: true, bin });
    });
  }).then((o) => { if (!o.ok) buildFailed = { outcome: o, bin, srcMtime: mtime(src), at: now() }; return o; }).finally(() => { buildP = null; });
  return buildP;
}

// Run the tool once: execFile (no shell), minimal env, hard timeout, stdout parsed as the ONE JSON
// line. The default `runner` for ocrInk/ocrImage; a test passes its own.
export function runTool(args, { env = {}, cmd = '', timeoutMs = OCR_TIMEOUT_MS } = {}) {
  return ensureBuilt({ cmd }).then((b) => (b.ok ? new Promise((resolve) => {
    runFile(b.bin, args, { env: childEnv(env), timeout: timeoutMs, maxBuffer: OCR_MAX_OUTPUT }, (err, stdout, stderr) => {
      if (err && err.killed) return resolve(fail(OCR_TIMEOUT, `panote-ocr ${args[0]}: no answer within ${timeoutMs} ms`));
      if (err && typeof err.code === 'string' && err.syscall) return resolve(fail(OCR_SPAWN_FAILED, `panote-ocr ${args[0]}: ${err.code} ${err.syscall}`));   // never started
      const line = String(stdout || '').trim().split('\n').pop();
      let out;
      try { out = JSON.parse(line); } catch { out = null; /* judged just below: not JSON is the failure reported */ }
      if (!out || typeof out !== 'object') return resolve(fail(err ? OCR_FAILED : OCR_BAD_OUTPUT, err ? `panote-ocr ${args[0]}: ${String(stderr || err.message).slice(0, 300)}` : `panote-ocr ${args[0]}: not a JSON line: ${line.slice(0, 120)}`));
      if (out.ok !== true) return resolve(fail(OCR_FAILED, `panote-ocr ${args[0]}: ${out.error || 'failed'}`));
      resolve(out);
    });
  }) : b));
}

// The tool's text lines, typed: [{t,c,box}] with t a string, c a number, box four numbers.
const lineOk = (l) => l && typeof l === 'object' && typeof l.t === 'string' && typeof l.c === 'number'
  && Array.isArray(l.box) && l.box.length === 4 && l.box.every((n) => typeof n === 'number');
const linesOf = (out) => (Array.isArray(out.text) ? out.text.filter(lineOk).map(({ t, c, box }) => ({ t: t.trim(), c, box })).filter((l) => l.t) : []);
const labelsOf = (out) => (Array.isArray(out.labels) ? out.labels.filter((l) => l && typeof l.l === 'string').map((l) => l.l) : []);
// The searchable text of a set of lines: each distinct string once (the two ink passes agree on
// many lines), in order of first appearance.
export const unionText = (lines) => [...new Set(lines.map((l) => l.t))].join('\n');

// Handwriting: strokes → two Vision passes → {ok, lines:[{t,c,box,pass}], text, ms}. The strokes go
// to the tool through a private temp file (argv has a size limit; stdin would need a second
// protocol), removed whatever happens.
export async function ocrInk(strokes, { width = OCR_WIDTH_PX, runner = runTool, cmd = '', timeoutMs } = {}) {
  if (!Array.isArray(strokes) || !strokes.length) return fail(OCR_BAD_INPUT, 'ocrInk: no strokes');
  let dir;
  try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panote-ocr-')); } catch (e) { return fail(OCR_FAILED, e); }
  const file = path.join(dir, 'strokes.json');
  try {
    fs.writeFileSync(file, JSON.stringify(strokes), { mode: 0o600 });
    const lines = [];
    let ms = 0;
    for (const { pass, langs } of OCR_PASSES) {
      const out = await runner(['ink', file, String(width)], { env: { OCR_LANGS: langs }, cmd, timeoutMs });
      if (!out.ok) return out;
      ms += Number(out.ms) || 0;
      lines.push(...linesOf(out).map((l) => ({ ...l, pass })));
    }
    return { ok: true, lines, text: unionText(lines), ms };
  } catch (e) { return fail(OCR_FAILED, e); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A stored picture: {ok, lines:[{t,c,box}], text, labels:[string], ms}. `absPath` was judged by the
// caller (inside <ws>/uploads, no link on the way): this function only runs the tool on it.
export async function ocrImage(absPath, { runner = runTool, cmd = '', timeoutMs } = {}) {
  if (typeof absPath !== 'string' || !absPath) return fail(OCR_BAD_INPUT, 'ocrImage: no path');
  try {
    const out = await runner(['image', absPath], { env: { OCR_LANGS: OCR_PASSES[0].langs }, cmd, timeoutMs });
    if (!out.ok) return out;
    const lines = linesOf(out);
    return { ok: true, lines, text: unionText(lines), labels: labelsOf(out), ms: Number(out.ms) || 0 };
  } catch (e) { return fail(OCR_FAILED, e); }
}
