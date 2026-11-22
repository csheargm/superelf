#!/usr/bin/env node
// Privacy scan for the PUBLIC repo · 公开仓库隐私扫描
//
// Fails on anything that would put a person or a machine into public git: real email addresses,
// Tailscale hostnames, public IPv4 literals, key-shaped strings, and the owner's own terms (names,
// school, city, hostnames). The terms are NOT in this file — a detector that carries the names it
// hunts for is itself the leak. They come from git-ignored files laid down by the private overlay:
//   privacy-terms.txt                  (from superelf-mine)   one term per line, '#' comments
//   workspace/identity-denylist.txt    (owner node)           same format
// With neither present (CI, a stranger's clone) only the generic patterns run.
//
// CLI: node tools/privacy-scan.mjs        scans `git ls-files`; exit 1 + file:line on a hit.
//      node tools/privacy-scan.mjs --pre-push   reads git's pre-push stdin and scans every OUTGOING
//      commit: its added lines, its file paths and its author/committer email (tools/pre-push.sh).
// A term line starting "re:" is a case-insensitive regular expression (e.g. a postcode range).
// Output names file:line and the RULE, never the matched text: hook output gets pasted into issues.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TERM_FILES = ['privacy-terms.txt', 'workspace/identity-denylist.txt'];
// Public-domain Scripture: a name there belongs to its text (Luke 2:36 names a prophetess).
const SKIP_PREFIXES = ['bible-data/'];
// Overlay and term-file paths (docs/repos.md): never tracked here, whatever their contents.
const RESERVED = /^(privacy-terms\.txt|workspace\/identity-denylist\.txt|ops\/private\/|docs\/private-[^/]*\.md$|test\/private-[^/]*\.test\.mjs$)/;
export const reservedPath = (f) => RESERVED.test(f);

// Fixture addresses that are obviously fake but sit on real-looking domains. Exact strings only.
const FAKE_EMAILS = new Set(['git@github.com', 'other@agentmail.to', 'node-abc@agentmail.to', 'a@b.co',
  'a@b.com', 'b@c.com', 'bank.com@evil.com', 'a.b+tag@sub.domain.co']);
const SAFE_EMAIL_DOMAIN = /(^|\.)(example(\.(com|org|net))?|invalid|test|localhost|noreply\.github\.com)$/i;
// Placeholder tailnet labels used in docs and tests; a real one is tail<hex> or a custom name.
const SAFE_TS_LABELS = new Set(['tailnet', 'tailnet-name', 'tail1234']);
// Private, loopback, link-local, documentation and broadcast ranges are not anyone's machine.
// Fixture IPs in tests (resolvers, made-up clients). Exact strings only; a real address is not here.
const FAKE_IPS = new Set(['100.64.0.0', '1.1.1.1', '2.2.2.2', '9.9.9.9', '100.1.2.3', '100.5.5.5', '100.64.0.7']);
const PRIVATE_V4 = /^(0|10|127|255)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.0\.2\.|^198\.51\.100\.|^203\.0\.113\./;

const KEY_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{10,}/, /\bsk-[A-Za-z0-9]{32,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}/, /\btskey-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{35}\b/, /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];

export function readTerms(root = ROOT) {
  const out = [];
  for (const rel of TERM_FILES) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }   // absent = not this machine's job
    for (const l of text.split('\n')) { const t = l.trim(); if (t && !t.startsWith('#')) out.push(t); }
  }
  return [...new Set(out)];
}

// ASCII term = whole word, case-insensitive ("Johnson" never fires a "John" entry). \b is ASCII-only
// in JS, so a Chinese term matches as a plain substring.
export function termMatcher(term) {
  if (term.startsWith('re:')) return new RegExp(term.slice(3), 'i');
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^[\w .-]+$/.test(term) ? new RegExp(`\\b${esc}\\b`, 'i') : new RegExp(esc, 'i');
}

function emailHits(line) {
  const hits = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) || [];
  return hits.some((e) => !FAKE_EMAILS.has(e) && !SAFE_EMAIL_DOMAIN.test(e.split('@')[1]));
}
const tsHit = (line) => [...line.matchAll(/([A-Za-z0-9-]+)\.ts\.net\b/gi)].some((m) => !SAFE_TS_LABELS.has(m[1].toLowerCase()));
// Not inside a word or number (SVG paths: "C2.6.8.8"). A CIDR is checked like any address.
const ipHit = (line) => [...line.matchAll(/(?<![\w.-])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g)]
  .some(([, ip]) => ip.split('.').every((n) => Number(n) <= 255) && !PRIVATE_V4.test(ip) && !FAKE_IPS.has(ip));

// Returns [{ file, line, rule }] — rule is a name or "term #k", never the text itself.
export function scanText(file, text, terms = []) {
  const res = terms.map(termMatcher);
  const out = [];
  text.split('\n').forEach((line, i) => {
    const at = (rule) => out.push({ file, line: i + 1, rule });
    if (emailHits(line)) at('email address');
    if (tsHit(line)) at('tailscale hostname');
    if (ipHit(line)) at('public IPv4 address');
    if (KEY_SHAPES.some((re) => re.test(line))) at('key-shaped string');
    res.forEach((re, k) => { if (re.test(line)) at(`term #${k + 1}`); });
  });
  return out;
}

export function trackedFiles(root = ROOT) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
    .filter((f) => !SKIP_PREFIXES.some((p) => f.startsWith(p)));
}

export function scanRepo(root = ROOT, terms = readTerms(root)) {
  const out = [];
  for (const f of trackedFiles(root)) {
    if (reservedPath(f)) out.push({ file: f, line: 0, rule: 'reserved overlay path' });
    out.push(...scanText(`${f} (path)`, f, terms));
    let s;
    try { s = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }   // indexed but deleted: nothing to push
    if (/\0/.test(s.slice(0, 512))) continue;                                       // binary: not prose
    out.push(...scanText(f, s, terms));
  }
  return out;
}

const git = (args, root) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const ZERO = /^0+$/;

// Every commit a push would send: added lines, paths, and identity. `refs` = git's pre-push stdin.
// `remote` is the push destination (the hook's $1): only ITS refs count as already published, so a
// commit known to some other (private) remote is still scanned.
export function scanPush(refs, root = ROOT, terms = readTerms(root), remote = '') {
  const out = [];
  for (const l of refs.split('\n').filter(Boolean)) {
    const [, local] = l.split(/\s+/);
    if (!local || ZERO.test(local)) continue;                                   // a delete sends no content
    const [, , ref, rsha] = l.split(/\s+/);
    out.push(...scanText(`ref ${ref}`, ref || '', terms));
    const range = ZERO.test(rsha || '0') ? [local, '--not', remote ? `--remotes=${remote}` : '--remotes'] : [`${rsha}..${local}`];
    for (const c of git(['rev-list', ...range], root).split('\n').filter(Boolean)) out.push(...scanCommit(c, root, terms));
  }
  return out;
}

export function scanCommit(c, root = ROOT, terms = readTerms(root)) {
  const out = [];
  const id = `commit ${c.slice(0, 8)}`;
  const [ae, ce] = git(['show', '-s', '--format=%ae%n%ce', c], root).trim().split('\n');
  for (const e of [ae, ce]) if (scanText('', e, []).length && !/noreply\.github\.com$/i.test(e)) out.push({ file: id, line: 0, rule: 'author/committer email' });
  // Names and the message are published too.
  out.push(...scanText(`${id} (names, message)`, git(['show', '-s', '--format=%an%n%cn%n%B', c], root), terms).map((h) => ({ ...h, line: 0 })));
  for (const f of git(['-c', 'core.quotePath=false', 'show', '--format=', '--name-only', '-z', '--no-renames', '--diff-merges=first-parent', c], root).split('\0').filter(Boolean)) {
    out.push(...scanText(`${f} (path)`, f, terms));
    if (reservedPath(f)) out.push({ file: f, line: 0, rule: 'reserved overlay path' });
  }
  let file = '';
  let n = 0;
  const diff = ['-c', 'core.quotePath=false', 'show', '--format=', '-U0', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-merges=first-parent', c];
  // --text: a `-diff` attribute cannot hide a hunk. A "+++ " line is a header only right after "--- ",
  // so added content that itself starts with "++ " is still scanned.
  let prev = '';
  for (const line of git(diff, root).split('\n')) {
    const header = line.startsWith('+++ ') && prev.startsWith('--- ');
    prev = line;
    if (header) { file = line.replace(/^\+\+\+ (b\/)?/, ''); n = 0; continue; }
    if (SKIP_PREFIXES.some((p) => file.startsWith(p))) continue;
    if (line.startsWith('+')) { n += 1; out.push(...scanText(`${c.slice(0, 8)} ${file} +${n}`, line.slice(1), terms).map((h) => ({ ...h, line: 0 }))); }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const terms = readTerms();
  const at = process.argv.indexOf('--pre-push');
  // The owner's push must carry the owner's terms: zero loaded is a failed scan, not a clean one
  // (R14). Someone without the overlay opts out explicitly with PRIVACY_SCAN_NO_TERMS=1.
  if (at > -1 && !terms.length && process.env.PRIVACY_SCAN_NO_TERMS !== '1') {
    process.stderr.write('privacy-scan: no private terms loaded (run the overlay, or set PRIVACY_SCAN_NO_TERMS=1)\n');
    process.exit(1);
  }
  const hits = at > -1 ? scanPush(fs.readFileSync(0, 'utf8'), ROOT, terms, process.argv[at + 1] || '') : scanRepo(ROOT, terms);
  for (const h of hits) process.stderr.write(`${h.file}:${h.line}  ${h.rule}\n`);
  process.stderr.write(`privacy-scan: ${hits.length} hit(s); ${terms.length} private term(s) loaded\n`);
  process.exit(hits.length ? 1 : 0);
}
