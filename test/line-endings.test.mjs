// Tracked bytes must survive a Windows checkout · 跨平台字节必须一致
//
// superelf fingerprints file BYTES: shared-apps/<slug>/meta.json carries a sha1 manifest
// (lib/sharedapps.mjs fileManifest) and web.mjs appHash hashes index.html, both compared against
// the file on disk to answer "is there an update" and "did the user edit this".
//
// Git for Windows defaults to core.autocrlf=true. Measured on bible/index.html: a971ec9c441d as
// committed, 005ef9694e52 once LF becomes CRLF — so without .gitattributes every shelf app on a
// Windows clone reads as permanently modified, and the shell scripts stop running under Git Bash.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileManifest } from '../lib/sharedapps.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha12 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);

test('.gitattributes pins the working tree to LF', () => {
  const ga = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  assert.match(ga, /^\* text=auto eol=lf$/m, 'every text file checks out LF, on every platform');
  assert.match(ga, /^\*\.sh text eol=lf$/m, 'shell scripts especially — CRLF makes them unrunnable');
});

test('every shelf manifest still matches the files on disk', () => {
  // The real invariant. If a checkout ever mutates these bytes, this fails on that machine.
  const shelf = path.join(ROOT, 'shared-apps');
  const slugs = fs.readdirSync(shelf).filter((d) => !d.startsWith('.'));
  assert.ok(slugs.length >= 2, `expected promoted apps, found ${slugs.length}`);
  for (const slug of slugs) {
    const meta = JSON.parse(fs.readFileSync(path.join(shelf, slug, 'meta.json'), 'utf8'));
    assert.ok(meta.files && Object.keys(meta.files).length, `${slug}: meta carries a manifest`);
    assert.deepEqual(fileManifest(path.join(shelf, slug)), meta.files,
      `${slug}: bytes on disk no longer hash to what the manifest recorded`);
  }
});

test('CONTROL: CRLF really would break the manifest', () => {
  // Without this, the test above could pass on a machine where nothing is ever converted, and
  // prove nothing about the hazard it exists for.
  const f = path.join(ROOT, 'shared-apps', 'bible', 'index.html');
  const lf = fs.readFileSync(f);
  const crlf = Buffer.from(lf.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
  assert.notEqual(sha12(crlf), sha12(lf), 'converting line endings changes the fingerprint');
});

test('no tracked text file has CRLF today, except where .gitattributes asks for it', () => {
  // A file committed with CRLF would be normalised on the next checkout and change hash then.
  // The exceptions are READ FROM .gitattributes rather than listed here: when the two were
  // maintained separately, adding the first Windows launcher under an `eol=crlf` rule would have
  // failed this test for doing exactly what the config asked.
  const crlfExts = crlfExtsFromAttributes();
  const tracked = execFileSyncList().filter((f) => !crlfExts.some((e) => f.toLowerCase().endsWith(e)));
  const offenders = [];
  for (const rel of tracked) {
    const p = path.join(ROOT, rel);
    let buf; try { buf = fs.readFileSync(p); } catch { continue; }
    if (buf.includes(0)) continue;                       // binary
    if (buf.includes(Buffer.from('\r\n'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'these are stored with CRLF and will change on checkout');
});

// Every extension .gitattributes marks eol=crlf, e.g. "*.cmd text eol=crlf" -> ".cmd".
function crlfExtsFromAttributes() {
  const txt = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
  return txt.split('\n')
    .filter((l) => !l.trim().startsWith('#') && /eol=crlf/.test(l))
    .map((l) => (/^\*(\.[A-Za-z0-9]+)\b/.exec(l.trim()) || [])[1])
    .filter(Boolean);
}

function execFileSyncList() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((f) => !/\.(png|jpg|jpeg|gif|webp|ico|woff2?|pdf)$/i.test(f));
}
