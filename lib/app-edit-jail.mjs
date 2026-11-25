// 改应用只限本应用 · The owner's app-chat change stays in the app (ADR 0042 addendum).
//
// The CLI's permission rules are the wall (lib/agent-origin.mjs appJailArgs). This is the server's
// backstop after the turn, fail-closed: the turn is rolled back when
//   - any file tool call (Write, Edit, MultiEdit, NotebookEdit) named a path outside apps/<slug>/,
//     or a dot-name or an agent instruction file (CLAUDE.md, AGENTS.md, …) inside it — even a call
//     the CLI denied: an agent that tried is not trusted with the rest of its change; or
//   - the app folder holds a new or changed file with such a name, however it got there.
// Rolled back = the app restored from its undo copy (lib/app-edit.mjs), and an outside file the turn
// CREATED is moved aside into the app's undo folder (<ws>/.app-versions/<slug>/.outside-<time>/), never
// deleted: absent when the call was seen AND born after it. Another request could still have made that
// same file in the meantime (GPT review r2), so it is kept, not destroyed, and named in the reply. Known limit: an outside file that existed and was
// changed cannot be restored (no copy of it was taken); its name is said in the reply. A file system
// with no birth time (0) counts every file as old, so it is named, never removed. Bash is never offered on this lane, so
// file tools are the only write path the backstop has to watch.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_INSTRUCTION_FILES } from './appdata.mjs';

const CLOCK_SLACK_MS = 1000;   // file-system time stamps vs Date.now(): a coarse clock must not make a new file look old
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); /* absent: as written */ } };
// The real form of a path that may not exist yet: its nearest existing parent made real. An existing
// path is resolved whole, so a link inside the app that points outside counts as outside (GPT review).
function realTarget(p) {
  if (fs.existsSync(p)) return realOr(p);
  let dir = path.dirname(p);
  const tail = [path.basename(p)];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) { tail.unshift(path.basename(dir)); dir = path.dirname(dir); }
  return path.join(realOr(dir), ...tail);
}
// A path segment the jail never lets the agent write: a dot-name, or an instruction file of a CLI.
export const badJailName = (rel) => rel.split(/[\\/]/).some((seg) => seg.startsWith('.') || AGENT_INSTRUCTION_FILES.has(seg.toLowerCase()));

// One turn's watch. onTool(name, brief, input) is the runner's tool callback (lib/runner.mjs).
// ws: the workspace a file outside the app is named from (a user never sees the node's own paths).
export function makeJailWatch(appDir, cwd, ws = cwd) {
  const root = realOr(appDir);
  const wsReal = realOr(ws);
  const outsideName = (abs) => { const r = path.relative(wsReal, abs); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : '本工作区以外的文件 · a file outside your workspace'; };
  const tried = [];
  const start = Date.now() - CLOCK_SLACK_MS;
  return {
    tried, start,
    onTool(name, _brief, input) {
      if (!FILE_TOOLS.has(name)) return;
      const raw = input && (input.file_path || input.notebook_path);
      if (typeof raw !== 'string' || !raw) return;
      const abs = realTarget(path.resolve(cwd, raw));
      const rel = path.relative(root, abs);
      const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      if (inside && !badJailName(rel)) return;
      tried.push({ abs, inside: !!inside, shown: inside ? `apps/${path.basename(root)}/${rel}` : outsideName(abs), existed: fs.existsSync(abs), at: Date.now() - CLOCK_SLACK_MS });
    },
  };
}

// What breaks the jail this turn: [] = clean. before/after are lib/app-versions.mjs treeStamp()s of the app.
export function jailProblems(watch, before, after) {
  const out = (watch ? watch.tried : []).map((t) => `tried to write ${t.shown} · 试图写入本应用以外或受保护的文件`);
  for (const rel of Object.keys(after)) {
    if (badJailName(rel) && after[rel] !== before[rel]) out.push(`wrote apps/…/${rel} · 写了受保护的文件`);
  }
  return [...new Set(out)];
}

// The outside half of the rollback: files the turn created are removed; changed ones are named.
export function undoOutside(watch, asideDir) {
  const left = [], moved = [];
  for (const t of watch ? watch.tried : []) {
    if (t.inside) continue;   // the app folder itself was restored whole from its undo copy
    let st; try { st = fs.lstatSync(t.abs); } catch { continue; /* nothing there: nothing to undo */ }
    if (!t.existed && st.isFile() && st.birthtimeMs >= t.at && asideDir) {
      fs.mkdirSync(asideDir, { recursive: true });
      fs.renameSync(t.abs, path.join(asideDir, `${moved.length + 1}-${path.basename(t.abs)}`));
      moved.push(t.shown);
    }
    else if (st.mtimeMs >= watch.start || st.ctimeMs >= watch.start) left.push(t.shown);
  }
  return { left: [...new Set(left)], moved };
}

export const jailNote = (problems, { left, moved }) => [
  '⚠ 这次修改超出了本应用的范围，已整体撤回，应用保持原样 · This change reached outside the app, so the whole turn was rolled back; the app is as it was:',
  ...problems.map((p) => '- ' + p),
  ...(moved.length ? [`本次新建的文件已移到撤销文件夹 · New files moved to the undo folder: ${moved.join(', ')}`] : []),
  ...(left.length ? [`这些文件已被改动、无法自动还原，请检查 · Changed and not restorable, please check: ${left.join(', ')}`] : []),
].join('\n');
