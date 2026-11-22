#!/usr/bin/env node
// A stand-in for tools/panote-ocr (config `note_ocr_cmd`): the same argv, env and ONE-JSON-line
// contract, deterministic answers, no Vision. helpers-web mkWebRoot points every harness server at
// it so no test ever compiles or runs the real tool in the background (the way ollama_url points at
// a refusing port). Pass A (OCR_LANGS starting zh) garbles the English word the way Vision did on
// real pages; pass B (en-US) gets it right and drops the Chinese — so a test can prove the UNION.
import fs from 'node:fs';
const [mode, file] = process.argv.slice(2);
const say = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(o.ok ? 0 : 1); };
if (process.env.FAKE_OCR_FAIL) say({ ok: false, error: process.env.FAKE_OCR_FAIL });
if (process.env.FAKE_OCR_GARBAGE) { process.stdout.write('not json\n'); process.exit(0); }
if (process.env.FAKE_OCR_HANG) setTimeout(() => say({ ok: true, ms: 0, text: [], labels: [] }), 60000);
else if (mode === 'ink') {
  let strokes;
  try { strokes = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { say({ ok: false, error: `cannot read strokes: ${e.message}` }); }
  const n = Array.isArray(strokes) ? strokes.length : 0;
  const zh = String(process.env.OCR_LANGS || '').startsWith('zh');
  const lines = zh ? [`手写笔记 #墨水 ${n}`, 'Satuday pollen'] : [`Saturday pollen moderate ${n}`];
  say({ ok: true, ms: 3, text: lines.map((t, i) => ({ t, c: 0.5, box: [0.1, 0.1 + i * 0.2, 0.6, 0.1] })), labels: [] });
} else if (mode === 'image') {
  if (!fs.existsSync(file)) say({ ok: false, error: 'cannot read image' });
  say({ ok: true, ms: 2, text: [{ t: 'Receipt total 12.50', c: 0.9, box: [0.1, 0.1, 0.5, 0.1] }], labels: [{ l: 'document', c: 0.8 }, { l: 'receipt', c: 0.5 }] });
} else if (mode === 'text') say({ ok: true, ms: 1, text: [], labels: [] });
else say({ ok: false, error: `unknown mode ${mode}` });
