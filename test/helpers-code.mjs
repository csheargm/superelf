// Comments are not code（注释不是代码）— stripped by SCANNING, not by regex.
//
// WHY (2026-10-12): the regex stripper `s.replace(/\/\*[\s\S]*?\*\//g, '')` cannot tell the `/*`
// in `accept='image/*'` from a comment opener, so it dropped everything up to the next `*/`.
// Measured: web/note-ui.inline.html lines 3879-4046 (from `accept:'image/*'` to the next comment),
// plus spans of chat-ui and photo-ui, were invisible to every check that used it — a static guard
// with holes it could not report.
//
// This scanner copies strings, template literals (with their ${…} code) and regex literals through
// VERBATIM and removes only comments. A quoted string or regex literal ends at its line if it is
// not closed, so a misread literal cannot run on. Most misreadings KEEP text, so they fail loudly
// on a comment rather than pass over code. The known exception: a regex literal right after a
// keyword (`return /\/*/`) reads as division, and a comment opener inside it still drops code.
// HTML <!-- --> comments go too, except the PA_ component markers the app contract looks for.
// TODO(R3): six tests still carry a copy of the old two-step regex stripper: node-restart, notify-at,
// signin-legibility, speech-broker, photo-component (named stripComments) and chat-image-lane (inline).
// shell-home and shell-inert (JS), app-bar-peek and shell-layout (CSS) run the block-comment regex
// over the WHOLE shell, so web/index.html's `accept="image/*"` hole applies to them too.
// Move them here in their own session (R8). A regex over one <style> block alone is not a copy.

const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%<>~^']);   // a `/` after one of these opens a regex

export function stripJsComments(src) {
  const n = src.length;
  let i = 0, out = '';
  const quoted = (q) => {                      // '…', "…" or /…/ from src[i], through its close
    let j = i + 1, cls = false;
    for (; j < n; j++) {
      const d = src[j];
      if (d === '\\') { j++; continue; }
      if (d === '\n') break;
      if (q === '/') { if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; }
      else if (d === q) break;
    }
    out += src.slice(i, j + 1); i = j + 1;
  };
  const template = () => {                     // `…` from src[i]; ${…} is code again
    out += '`'; i++;
    while (i < n) {
      const d = src[i];
      if (d === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (d === '`') { out += d; i++; return; }
      if (d === '$' && src[i + 1] === '{') { out += '${'; i += 2; code(true); continue; }
      out += d; i++;
    }
  };
  const code = (inExpr) => {                   // until the `}` that closes a ${…}, or the end
    let depth = 0, last = '';
    while (i < n) {
      const c = src[i], nx = src[i + 1];
      if (inExpr && c === '}' && depth === 0) { out += c; i++; return; }
      if (c === '/' && nx === '/' && src[i - 1] !== ':') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && nx === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
      if (c === '`') { template(); last = c; continue; }
      if (c === '"' || c === "'" || (c === '/' && (last === '' || REGEX_AFTER.has(last)))) { quoted(c); last = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c; i++;
      if (!/\s/.test(c)) last = c;
    }
  };
  code(false);
  return out;
}

export const codeOnly = (html) =>
  stripJsComments(html.replace(/<!--[\s\S]*?-->/g, (m) => (m.startsWith('<!--PA_') ? m : '')));
