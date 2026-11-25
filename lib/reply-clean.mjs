// 回答清理 · The server half of web/reply-clean.js: the SAME file PAChat inlines, evaluated here (R3,
// the lib/offline-merge.mjs pattern), plus the one thing only the server knows — where the workspace
// lives on disk, so a reply never shows a user the node's internal paths.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'reply-clean.js');
const NAMES = ['cleanReply', 'shownUserText', 'REPLY_EMPTY_TEXT'];
// eslint-disable-next-line no-new-func
const api = new Function(`${fs.readFileSync(SRC, 'utf8')}\nreturn { ${NAMES.join(', ')} };`)();
for (const n of NAMES) if (api[n] === undefined) throw new Error(`web/reply-clean.js no longer defines ${n}`);
export const { cleanReply, shownUserText, REPLY_EMPTY_TEXT } = api;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Every spelling of the workspace (as configured, and its real path) → relative words: an uploaded
// picture is "your screenshot", anything else is named from the workspace down (apps/<slug>/index.html).
export function scrubPaths(text, wsDir) {
  let s = String(text || '');
  const roots = new Set([wsDir]);
  try { roots.add(fs.realpathSync(wsDir)); } catch { /* no such dir: the configured spelling is enough */ }
  for (const r of [...roots].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const base = esc(r.replace(/[\\/]+$/, ''));
    s = s.replace(new RegExp(`${base}[\\\\/]uploads[\\\\/][^\\s)\`'"<>]*[^\\s)\`'"<>.,;:]`, 'g'), '你的截图 · your screenshot')
      .replace(new RegExp(`${base}[\\\\/]?`, 'g'), '');
  }
  return s;
}

// The live stream of an edit turn, scrubbed the same way: a path holds no whitespace, so text is let out
// up to its last whitespace and the rest waits for the next chunk (or flush() at the end of the turn).
export function pathScrubStream(wsDir, emit) {
  let held = '';
  return {
    push(t) { held += String(t || ''); const i = Math.max(held.lastIndexOf(' '), held.lastIndexOf('\n'), held.lastIndexOf('\t')); if (i < 0) return; emit(scrubPaths(held.slice(0, i + 1), wsDir)); held = held.slice(i + 1); },
    flush() { if (held) emit(scrubPaths(held, wsDir)); held = ''; },
  };
}
