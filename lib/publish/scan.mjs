// Privacy gate for Publish · 发布前隐私检查 (docs/adr/0039 §3). FAIL CLOSED.
// One scanner (R3): the generic rules and owner terms come from tools/privacy-scan.mjs. This file
// adds only (a) the strict term loader — on a publishing node BOTH term files must exist and carry
// at least one term, or Publish refuses — and (b) a PII heuristic for what a code scan for keys and
// emails misses: phone numbers and street addresses. A hit carries the line text: it goes to the
// OWNER's browser only (their own code on screen), never to a log.
import fs from 'node:fs';
import path from 'node:path';
import { TERM_FILES, scanText } from '../../tools/privacy-scan.mjs';
import { PublishError } from './collect.mjs';

// Phone: +country or (area) groups, 10+ digits in total. Version strings and dates are not phones:
// they lack the separators-between-3/4-digit-groups shape this demands.
const PHONE = /(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{3}[ .-])\d{3,4}[ .-]\d{4}(?![\w.])/;
const CN_MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const STREET = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place)\b\.?/;
const CN_ADDRESS = /[一-鿿]{2,}(?:路|街|大道)\d+号/;
export const PII_RULES = [['phone number', PHONE], ['phone number', CN_MOBILE], ['street address', STREET], ['street address', CN_ADDRESS]];

// A /g or /y rule keeps lastIndex between .test() calls and would skip the next line's match:
// every PII test starts from 0, whatever flags a rule carries.
export const ruleHits = (re, text) => { re.lastIndex = 0; const hit = re.test(text); re.lastIndex = 0; return hit; };

// Throws PRIVACY_TERMS_MISSING unless every term file exists and holds a term.
export function loadTermsStrict(root) {
  const terms = [];
  for (const rel of TERM_FILES) {
    let text;
    try { text = fs.readFileSync(path.join(root, rel), 'utf8'); }
    catch { throw new PublishError('PRIVACY_TERMS_MISSING', `隐私词表缺失 · Privacy terms missing: ${rel}`); }
    const got = text.split('\n').map((l) => l.trim()).filter((t) => t && !t.startsWith('#'));
    if (!got.length) throw new PublishError('PRIVACY_TERMS_MISSING', `隐私词表为空 · Privacy terms empty: ${rel}`);
    terms.push(...got);
  }
  return [...new Set(terms)];
}

const isText = (buf) => !buf.subarray(0, 512).includes(0);

// files: [{ path, content: Buffer }] → [{ file, line, rule, text }]
export function scanFiles(files, terms) {
  if (!Array.isArray(terms) || !terms.length) throw new PublishError('PRIVACY_TERMS_MISSING', '隐私词表缺失 · Privacy terms missing');
  const hits = [];
  for (const f of files) {
    for (const h of scanText(`${f.path} (path)`, f.path, terms)) hits.push({ ...h, text: f.path });
    if (!isText(f.content)) continue;   // a PNG: no prose to leak
    const lines = f.content.toString('utf8').split('\n');
    for (const h of scanText(f.path, lines.join('\n'), terms)) hits.push({ ...h, text: lines[h.line - 1].slice(0, 300) });
    lines.forEach((l, i) => {
      for (const [rule, re] of PII_RULES) if (ruleHits(re, l)) hits.push({ file: f.path, line: i + 1, rule, text: l.slice(0, 300) });
    });
  }
  return hits;
}

// labels: { name: text } — the strings that go public beside the files. Same rules as a file line.
export function scanLabels(labels, terms) {
  const hits = [];
  for (const [name, text] of Object.entries(labels)) {
    for (const h of scanText(`(${name})`, String(text), terms)) hits.push({ ...h, text: String(text).slice(0, 300) });
    for (const [rule, re] of PII_RULES) if (ruleHits(re, String(text))) hits.push({ file: `(${name})`, line: 1, rule, text: String(text).slice(0, 300) });
  }
  return hits;
}
