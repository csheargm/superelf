import { PLAIN_WORDS_RULE } from '../app-edit-confirm.mjs';

// 审查与核实的提示词 · The review and verify prompts, and their strict parsers (docs/adr/0046).
// Every prompt string lives here once (R3). A reply that does not parse is a FAILED review, never
// "no findings" (R14): zero findings is valid only as a parsed empty list.

export const REVIEW_PROMPT = [
  'You are reviewing a git diff of the repository in the current folder (checked out at the diff\'s tip).',
  'Review it for security, correctness and cross-feature interactions. You may read any file here for context.',
  'Report only real defects you can point to in the code; cite only code in this diff or this repository.',
  'Reply with ONLY a JSON array and nothing else. Each item: {"file": "path", "line": 123, "severity": "high|medium|low",',
  '"claim": "one sentence: what is wrong", "evidence": "the code or the scenario that shows it"}.',
  'No defects: reply with [] exactly.',
].join('\n');

export const VERIFY_PROMPT = [
  'Another reviewer claims the defect below in the repository in the current folder. Check it against the code',
  'with the file tools (read only). The FIRST line of your reply must be exactly CONFIRMED or REJECTED.',
  'The second line: one sentence of reason, naming the code you checked.',
].join('\n');

export function reviewPrompt({ repo, range, commits, chunk, part, parts }) {
  return [REVIEW_PROMPT, '',
    `Repository: ${repo}. Range ${range}, ${commits} commit(s). Diff part ${part} of ${parts}.`,
    ...(chunk.cut.length ? [`These files' diffs were cut at the size cap (review what is shown): ${chunk.cut.join(', ')}`] : []),
    '', '```diff', chunk.text, '```'].join('\n');
}

export const verifyPrompt = (f) => [VERIFY_PROMPT, '', `File: ${f.file}${f.line ? `:${f.line}` : ''}`, `Severity: ${f.severity}`,
  `Claim: ${f.claim}`, `Evidence: ${f.evidence || '(none given)'}`].join('\n');

const SEVERITIES = ['high', 'medium', 'low'];
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

// The reply must be ONE JSON array (a code fence around it is allowed). Throws otherwise,
// or when an item has no claim: the caller turns that into "REVIEW FAILED".
export function parseFindings(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('empty reply');
  const body = t.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();   // the WHOLE reply is the array (an error text quoting [] is not "no findings")
  if (!body.startsWith('[') || !body.endsWith(']')) throw new Error('the reply is not only a JSON array');
  let arr;
  try { arr = JSON.parse(body); } catch (err) { throw new Error(`reply is not a JSON array: ${err.message}`); }
  if (!Array.isArray(arr)) throw new Error('reply is not a JSON array');
  return arr.map((x, i) => {
    if (!x || typeof x !== 'object' || !str(x.claim, 400)) throw new Error(`finding ${i + 1} has no claim`);
    const line = Number.isInteger(x.line) && x.line > 0 ? x.line : null;
    return { file: str(x.file, 200) || '?', line, severity: SEVERITIES.includes(x.severity) ? x.severity : 'medium',
      claim: str(x.claim, 400), evidence: str(x.evidence, 600) };
  });
}

// { verdict: 'confirmed'|'rejected'|'unverified', reason }. Anything but the exact first word is unverified.
export function parseVerdict(text) {
  const lines = String(text || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const head = (lines[0] || '').replace(/[*_`.:]/g, '').trim().toUpperCase();
  const reason = str(lines.slice(1).join(' '), 300);
  if (head === 'CONFIRMED') return { verdict: 'confirmed', reason };
  if (head === 'REJECTED') return { verdict: 'rejected', reason };
  return { verdict: 'unverified', reason: 'verifier reply did not start with CONFIRMED or REJECTED' };
}

// The core-lane request for a superelf fix: the confirmed findings, each fixed narrowly with a test.
export const FIX_REQUEST_MAX = 4000;
export function fixRequest(findings, date) {
  const items = findings.map((f, i) => `${i + 1}. ${f.file}${f.line ? `:${f.line}` : ''} [${f.severity}] ${f.claim} (verified: ${f.reason})`);
  return [`Nightly review fixes ${date}. Fix each confirmed finding below with the smallest change, and add a regression test for each.`,
    'Change nothing else.', ...items].join('\n').slice(0, FIX_REQUEST_MAX);
}

// 说人话 · The plain-words pass: each confirmed finding rewritten for the owner, who does not code.
export const PLAIN_PROMPT = [
  'Below are confirmed code defects from last night\'s review. The owner reading the morning email does not code.',
  'For each, write ONE short sentence of what a user of the app could see go wrong (if only the developers\' tests',
  'are affected, say that plainly). ' + PLAIN_WORDS_RULE,
  'Reply with ONLY a JSON array, one item per defect: {"n": <its number>, "impact": "the sentence",',
  '"severity": "high|medium|low", "rank": <1 = matters most to users>}. Do not read any files.',
].join('\n');

export const plainPrompt = (findings) => [PLAIN_PROMPT, '',
  ...findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.claim}${f.reason ? ` (checked: ${f.reason})` : ''}`)].join('\n');

// Strict: one array, every finding exactly once, each with an impact sentence. Throws otherwise and
// the caller falls back to the technical text (a finding is never dropped).
export function parsePlain(text, count) {
  const body = String(text || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (!body.startsWith('[') || !body.endsWith(']')) throw new Error('the reply is not only a JSON array');
  const arr = JSON.parse(body);
  if (!Array.isArray(arr) || arr.length !== count) throw new Error(`expected ${count} items`);
  const out = new Array(count);
  for (const x of arr) {
    const n = x && x.n;
    if (!Number.isInteger(n) || n < 1 || n > count || out[n - 1]) throw new Error(`bad or repeated item number ${n}`);
    const impact = str(x.impact, 240);
    if (!impact) throw new Error(`item ${n} has no impact`);
    out[n - 1] = { impact, severity: SEVERITIES.includes(x.severity) ? x.severity : null, rank: Number.isInteger(x.rank) ? x.rank : count + n };
  }
  return out;
}
