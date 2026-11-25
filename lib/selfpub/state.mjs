// 自我发布的状态 · Core-change state (docs/adr/0043): the changes waiting for the owner's tap, and each
// publish's progress. Kept in <selfpub_root>/state.json (mode 600, the one atomic JSON writer) because the publish ENDS with a
// deploy that restarts this node: the new process reads it back and can say "已上线 · Live" honestly.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from '../atomicwrite.mjs';

const file = (root) => path.join(root, 'state.json');

export function loadState(root) {
  try { const s = JSON.parse(fs.readFileSync(file(root), 'utf8')); return { changes: s.changes || {} }; }
  catch { return { changes: {} }; /* first run, or a broken file: no pending change is the safe state */ }
}

function save(root, s) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeJsonFile(file(root), s);
  fs.chmodSync(file(root), 0o600);
}

export const getChange = (root, id) => loadState(root).changes[id] || null;

export function putChange(root, id, patch) {
  const s = loadState(root);
  s.changes[id] = { ...(s.changes[id] || {}), ...patch, id, at: Date.now() };
  save(root, s);
  return s.changes[id];
}

// The newest change of this conversation still waiting for Publish (a typed 发布 · publish maps to it).
export function pendingFor(root, { who, convo }) {
  const list = Object.values(loadState(root).changes).filter((c) => c.who === who && c.convo === convo && c.state === 'ready');
  return list.sort((a, b) => b.at - a.at)[0] || null;
}
