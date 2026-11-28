// The shell is assembled from many files at serve time: web/index.html with the settings dialog,
// the settings JS and the app-frame JS inlined at markers (same pattern as PA_CHAT_UI / PA_NOTE_UI for apps).
//
// It lives here, not in web.mjs, because the TESTS need the same composition. When the settings
// surface was extracted, every test that greps web/index.html for it went blind at once — 12 of
// them failed, and the rest silently stopped guarding anything. A test must read the shell the
// user actually gets.
import fs from 'node:fs';
import path from 'node:path';
import { nodeShellParts, readShellParts } from './shell-parts.mjs';

// The parts list is DATA, web/shell-parts.json (lib/shell-parts.mjs): read from the tree being assembled,
// so a self-publish copy that adds a part is drawn with it (docs/adr/0049). SHELL_PARTS is this node's
// own list, for the tests that check its order; the builder itself reads the list at use time.
export const SHELL_PARTS = nodeShellParts();

// String.replace on a MISSING marker is a silent no-op: the shell would ship with no settings
// dialog and no error anywhere. So a missing marker is a hard failure (R5).
export function inlineShellParts(root, html) {
  const web = fs.realpathSync(path.join(root, 'web'));
  for (const [marker, file] of readShellParts(root)) {
    if (!html.includes(marker)) {
      throw new Error(`web/index.html is missing ${marker} — ${file} would be dropped silently`);
    }
    // The real file must sit in web/: a copy's part may be a symlink out (a copy is agent-written, docs/adr/0049).
    const real = fs.realpathSync(path.join(web, file));
    if (path.dirname(real) !== web) throw new Error(`web/${file} points outside web/ — refused`);
    const part = fs.readFileSync(real, 'utf8');
    // A replacer FUNCTION, so `$&` / `$1` / `` $` `` inside the part are inserted literally
    // rather than being read as replacement patterns.
    html = html.replace(marker, () => part);
  }
  return html;
}

export const readShell = (root) => inlineShellParts(root, fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8'));

// The shell's build markers, filled the same way by the live server (web.mjs) and the self-publish
// preview (lib/selfpub/render.mjs) — one list, so the preview never draws a page the node would not (R3).
// A replacer FUNCTION, as above: a '$' in a value is inserted literally. notes is already template-safe.
export const fillShellMarkers = (html, { version = '', vtime = '', vdate = '', notes = '{}' } = {}) => html
  .replace('<!--APP_VERSION-->', () => version).replace('<!--APP_VTIME-->', () => vtime)
  .replace('<!--APP_VDATE-->', () => vdate).replace('<!--APP_NOTES-->', () => notes);
