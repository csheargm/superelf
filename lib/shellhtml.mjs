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
  ['/* PA_THEME_TOKENS_CSS */', 'theme-tokens.css'],   // the ONE palette; web.mjs injects the same file into every app (R3)
  ['/* PA_TOUCH_BASE_CSS */', 'touch-base.css'],   // the touch floor (16px inputs, 44px taps); web.mjs ships it to every app too (R3)
  ['/* PA_SHELL_LOOK_CSS */', 'shell-look.css'],   // the shell chrome's look, last in <style> so it restyles the rules above
  ['/* PA_HOME_V2_CSS */', 'home-v2.css'],   // PAHome's look: header ⋯, greeting, ask ring, Start here tiles, dock (after shell-look)
  ['/* PA_ICONS_JS */', 'icons.js'],   // PAIcons: the inline line-icon set + each app tile's coloured icon
  ['/* PA_HOME_LOOK_JS */', 'home-look.js'],   // PAHomeLook: greeting/date line, chats by day, the Aa control
  ['/* PA_DRAWER_SECTIONS_JS */', 'drawer-sections.js'],   // PADrawerSections: the ☰ section headers, closed by default, remembered on the account
  ['/* PA_HOME_V2_JS */', 'home-v2.js'],   // PAHome: the ask-first home + the header's ⋯ menu
  ['<!--PA_SETTINGS_DIALOG-->', 'settings-dialog.html'],
  ['/* PA_SETTINGS_JS */', 'settings.js'],
  ['/* PA_TIPS_STORE_JS */', 'tips-store.js'],   // PATipsStore: the shell's tips 'seen' on the account (profile.tipsSeen)
  ['<!--PA_TIPS_UI-->', 'tips.inline.html'],   // PATips, the ONE first-use tip mechanism, also in the shell (ADR 0030)
  ['/* PA_SETTINGS_HEAD_JS */', 'settings-head.js'],   // Settings' sticky title + Save + ✕ and the unsaved-edits guard
  ['/* PA_ACTIVITY_JS */', 'activity-log.js'],   // Settings → Activity log dialog (F5-10)
  ['/* PA_OWNER_ALERTS_JS */', 'owner-alerts.js'],   // PAOwnerAlerts: the owner's ☰ attention dot + Needs attention card (docs/adr/0041)
  ['/* PA_POPOVER_JS */', 'popover.js'],   // the shared ⋯-popover close: outside / frame tap / Escape / anchor gone (R3)
  ['/* PA_APP_FRAME_JS */', 'app-frame.js'],
  ['/* PA_UPDATE_JS */', 'update.js'],
  ['/* PA_PUBLISH_JS */', 'publish.js'],   // PAPublish: the owner's ⋯ → Publish (docs/adr/0039)
  ['/* PA_SELFPUB_JS */', 'selfpub.js'],   // PASelfPub: 发布 · Publish under a 改 superelf reply (docs/adr/0044), after PAPublish (it reuses its sheet)
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
