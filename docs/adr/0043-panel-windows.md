# ADR 0043 — Side panels are independent windows (PAWin)

Date: 2026-11-25 · Status: accepted (branch feat/panel-windows) · Supersedes ADR 0031

## Context

Owner 2026-11-25 on the Bible (John 3 + Ask AI): the panel placement is clunky. Opening Ask AI also showed
a "Note · 笔记" strip (both were slots of one PASplit rail, and a collapsed slot kept its header), and the
header controls ↓ ⤢ ⧉ ✕ (split-ui's dock / maximise, PAPaneChrome's float / close) were not understood.
Wanted: independent panels; drag the title bar to float; resize from edges and corners; minimise,
maximise, restore with familiar buttons; dock with snap targets (right, left, top, bottom, top-right,
bottom-right); remembered per device; a full-screen sheet on a phone.

## Decision

1. One generic component, `web/panel-window.inline.html` (PAWin, marker PA_PANEL_WINDOW_UI, carried by
   split-ui so every PASplit page has it). Each panel is its own window: `PAWin.create({key,title,…})`.
2. PASplit keeps the gate (one matchMedia, `onGate`) and the rail handle apps already call
   (`open/expand/collapse/isCollapsed/setTitle/destroy`), now mapped one slot → one window. No app
   change was needed; Bible (all copies) and Journal get the windows through the same handle.
3. Title bar: title, — 最小化 · Minimize, □ 最大化 · Maximize / ❐ 还原 · Restore, ✕ 关闭 · Close (中文 first,
   tooltip = aria-label). Docking is by drag only (no dock button). Double-click the title maximises.
   A minimised window is a pill at the bottom right. The surface's own ✕ is hidden; the window ✕ runs it
   (closeSel), so a note still flushes first (R3: one close path).
4. Drag starts after 6px on the title bar; a docked window tears off under the pointer. Targets: edges
   32px, corners 48px, with a preview rectangle; Esc cancels. The bar and handles are touch-action:none and
   stop their touch events, so a finger or Pencil drag never page-flips or inks.
5. Docked right/left/top/bottom push the page (margins sideways as before; body padding up/down, plus a
   margin on the shared full-screen surfaces). Corners and floats sit over the page. Two windows on one
   edge share it.
6. Layout per device class (phone | tablet | desktop) in `appPrefs.paneLayout2[class][key]`, as viewport
   ratios (rotation still fits), via PAAppPrefs (localStorage throws at the app frame's opaque origin).
   The old `paneLayout` migrates once and is dropped. A refused read or write shows on the title bar (R5).
7. Phones (below PASplit's 820x600 gate) keep the full-screen sheet; no windows.

## Consequences

- Deleted (R1): web/pane-chrome.inline.html + its test; split-ui's collapse headers, ⤓/⤒, ⤢, bottom zone,
  stacked-slot dividers and its own push (543 → 130 lines).
- Tests: test/panel-window.test.mjs (geometry, snap, migration, labels), test/split-view.test.mjs (the rail
  handle over windows), test/panel-window-e2e.test.mjs (real browser: Chromium and WebKit).
- Known limits: a window docked left and the ☰ drawer docked left both push with margin-left; the drawer
  rule wins while both are open. Keyboard: Alt+arrows move, Alt+Shift+arrows resize, Esc restores.
