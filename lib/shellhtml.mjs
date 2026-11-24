// The shell is assembled from five files at serve time: web/index.html with the settings dialog,
// the settings JS and the app-frame JS inlined at markers (same pattern as PA_CHAT_UI / PA_NOTE_UI for apps).
//
// It lives here, not in web.mjs, because the TESTS need the same composition. When the settings
// surface was extracted, every test that greps web/index.html for it went blind at once — 12 of
// them failed, and the rest silently stopped guarding anything. A test must read the shell the
// user actually gets.
import fs from 'node:fs';
import path from 'node:path';

export const SHELL_PARTS = [
  ['/* PA_BAR_HANDLE_CSS */', 'bar-handle.css'],   // the top-centre handle's size, shared with PAAppBar (R3)
  ['<!--PA_SETTINGS_DIALOG-->', 'settings-dialog.html'],
  ['/* PA_SETTINGS_JS */', 'settings.js'],
  ['/* PA_SETTINGS_HEAD_JS */', 'settings-head.js'],   // Settings' sticky title + Save + ✕ and the unsaved-edits guard
  ['/* PA_ACTIVITY_JS */', 'activity-log.js'],   // Settings → Activity log dialog (F5-10)
  ['/* PA_APP_FRAME_JS */', 'app-frame.js'],
  ['/* PA_UPDATE_JS */', 'update.js'],
  ['/* PA_PUBLISH_JS */', 'publish.js'],   // PAPublish: the owner's ⋯ → Publish (docs/adr/0039)
  ['/* PA_APP_EDIT_JS */', 'app-edit.js'],   // PAAppEdit: ⋯ → 改这个应用 · Change this app (docs/adr/0040)
  ['/* PA_SW_CLIENT_JS */', 'sw-client.js'],   // PASW, after PAUpdate: both read the footer line (offline-first)
  ['/* PA_OFFLINE_JS */', 'offline-client.js'],   // PAOffline, after PASW: it borrows PASW's per-device memory (offline-first §2)
  ['/* PA_MERGE_JS */', 'offline-merge.js'],   // rule A, pure (offline-first §4); lib/offline-merge.mjs runs the same file in Node
  ['/* PA_ORIGIN_JS */', 'offline-origin.js'],   // PAOrigin, after PAOffline: the home-node fallback (offline-first §6); PASync asks it
  ['/* PA_SYNC_JS */', 'offline-sync.js'],   // PASync, after PAOffline and the merge: the drain of the queue (offline-first §3)
];

// String.replace on a MISSING marker is a silent no-op: the shell would ship with no settings
// dialog and no error anywhere. So a missing marker is a hard failure (R5).
export function inlineShellParts(root, html) {
  for (const [marker, file] of SHELL_PARTS) {
    if (!html.includes(marker)) {
      throw new Error(`web/index.html is missing ${marker} — ${file} would be dropped silently`);
    }
    const part = fs.readFileSync(path.join(root, 'web', file), 'utf8');
    // A replacer FUNCTION, so `$&` / `$1` / `` $` `` inside the part are inserted literally
    // rather than being read as replacement patterns.
    html = html.replace(marker, () => part);
  }
  return html;
}

export const readShell = (root) => inlineShellParts(root, fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8'));
