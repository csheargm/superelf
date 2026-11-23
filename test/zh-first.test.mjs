// 中文-first invariant (owner rule, 2026-11 sweep): every user-visible bilingual pair reads
// "中文 · English", never "English · 中文". This scans the shipped UI source (web/, the lib
// *-ui modules, the shipped apps) for a string literal or HTML text node whose clause is
// Latin text, then " · ", then Chinese — the English-first order.
//
// KNOWN LIMITS (a regex scan, not a parser): it sees only pairs joined by " · " inside ONE
// literal on ONE line. It misses pairs split across concatenations ('Save' + ' · ' + zh),
// across elements (<b>Save</b> <i>保存</i>), other joiners ("Save 保存", "Save / 保存"), and
// strings built at run time. Comment lines are skipped; a quote inside a trailing comment
// can still confuse it. Server-side lib text (reports, emails, error bodies) is out of its
// scope. Its pinned cases below prove it catches the forms it claims, and the allowlist
// names every deliberate English-first string with its reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_APPS = new Set(['church', 'rise']);   // not part of this sweep (owner-managed apps)
const HAN = /[一-鿿]/;
const CJK = /[　-〿㐀-鿿＀-￯]/;
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`|>[^<>\n]+</g;
const CLAUSE_SEP = /(?: — | – |: |\. |; |\\n|。|\(|\))/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|<!--)/;

// Deliberate English-first strings: each reads a format already stored in users' data.
const ALLOW = [
  /LEGACY_TXT=/,                                   // web/summary-title: old stored labels, read only
  /LEGACY_FIRST_LINE=/,                            // web/drawer-summary: old stored first line, read only
  /oldTitle:'Summary · 总结 \{p\}'/,               // web/summary-title: pre-2026-11-11 label, read only
  /English-first "Summary · 总结/,                // web/summary-title: the comment naming that legacy label
  /stationery · 信纸/,                             // web/stationery-studio: a gloss inside an English prompt to the model
  /name:'AI · 科技 · Tesla FSD'/,
  /const READOUT=/,                                // web/ink-anchor: a debug readout of "word 词" labels, not pairs                  // daily-digest: a topic name, not an EN/中文 pair
];

// One clause is English-first when its head (before the first " · ") has Latin letters and no
// CJK at all, and its tail has Chinese.
export function englishFirst(clause) {
  const i = clause.indexOf(' · ');
  if (i < 0) return false;
  const head = clause.slice(0, i), tail = clause.slice(i + 3);
  return /[A-Za-z]{2}/.test(head) && !CJK.test(head) && !/['"`]/.test(head) && HAN.test(tail.split(' · ')[0]);
}

export function scanLine(line) {
  if (COMMENT_LINE.test(line) || ALLOW.some((re) => re.test(line))) return [];
  const hits = [];
  for (const lit of line.match(LITERAL) || []) {
    if (!lit.includes(' · ') || !HAN.test(lit)) continue;
    for (const clause of lit.slice(1, -1).split(CLAUSE_SEP)) {
      const c = clause.replace(/^\s*(?:· )?/, '');
      if (englishFirst(c)) hits.push(c.trim());
    }
  }
  return hits;
}

function sources() {
  const out = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) if (f !== 'node_modules') walk(path.join(p, f)); }
    else if (/\.(m?js|html)$/.test(p)) out.push(p);
  };
  walk(path.join(ROOT, 'web'));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (/-ui\.mjs$/.test(f)) out.push(path.join(ROOT, 'lib', f));
  // shared-apps/ is left out: a shelf copy is a hashed, versioned snapshot (meta.json manifest), changed
  // only by promoting its workspace app, so its strings follow on the next promotion.
  for (const base of ['workspace/apps', 'workspace.example/apps']) {
    const dir = path.join(ROOT, base);
    if (!fs.existsSync(dir)) continue;
    for (const app of fs.readdirSync(dir)) if (!SKIP_APPS.has(app)) walk(path.join(dir, app));
  }
  return out;
}

test('the scanner catches the English-first forms it claims (pinned cases)', () => {
  assert.deepEqual(scanLine(`  label:'Save · 保存',`), ['Save · 保存']);
  assert.deepEqual(scanLine('<button>Cancel · 取消</button>'), ['Cancel · 取消']);
  assert.deepEqual(scanLine(`t='Microphone blocked · 麦克风被阻止 — turn it on · 请开启'`), ['Microphone blocked · 麦克风被阻止', 'turn it on · 请开启']);
  assert.deepEqual(scanLine('x=`${n} selected · 已选 ${n}`'), ['${n} selected · 已选 ${n}']);
});

test('the scanner passes 中文-first pairs, comments and the allowlist', () => {
  assert.deepEqual(scanLine(`  label:'保存 · Save',`), []);
  assert.deepEqual(scanLine('<button>取消 · Cancel</button>'), []);
  assert.deepEqual(scanLine(`t='麦克风被阻止 · Microphone blocked — 请开启 · turn it on'`), []);
  assert.deepEqual(scanLine(`  // the old 'Save · 保存' label`), []);
  assert.deepEqual(scanLine(`  oldTitle:'Summary · 总结 {p}' });`), []);
  assert.deepEqual(scanLine(`t='打印 PDF · Print PDF'`), [], 'a Chinese head with a Latin word is still 中文 first');
});

test('every bilingual pair in the shipped UI reads 中文 first', () => {
  const found = [];
  for (const file of sources()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const hit of scanLine(line)) found.push(`${path.relative(ROOT, file)}:${i + 1}: ${hit}`);
    });
  }
  assert.deepEqual(found, [], `English-first pairs (write them "中文 · English"):\n${found.join('\n')}`);
});
