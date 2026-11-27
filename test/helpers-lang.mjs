// The side of a "中文 · English" string a one-language page shows (ADR 0048), from the REAL web/lang.js (PALang.t)
// run in a vm, so suites assert what a 中文 device sees without a copy of the split rule (R3).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'lang.js'), 'utf8');
const ctx = { navigator: { language: 'zh-CN', languages: ['zh-CN'] }, localStorage: { getItem: () => null, setItem() {} },
  document: { readyState: 'complete', documentElement: null }, addEventListener() {}, setTimeout };
ctx.window = ctx;
vm.runInNewContext(SRC, ctx);
const L = ctx.PALang;
export const zh = (s) => L.t(s, 'zh');
export const en = (s) => L.t(s, 'en');
