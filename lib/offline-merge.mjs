// Rule A（冲突规则 A）for Node: the SAME web/offline-merge.js the shell inlines (lib/shellhtml.mjs),
// evaluated here so the sync's tests and any server-side caller run one implementation (R3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'offline-merge.js');
const NAMES = ['mergeNotebook', 'mergeIndex', 'mergeOffline', 'mergeTitle', 'mergeStamp', 'OFF_CONFLICT_TITLE', 'OFF_FROM_LOCAL', 'OFF_FROM_REMOTE'];
// eslint-disable-next-line no-new-func
const api = new Function(`${fs.readFileSync(SRC, 'utf8')}\nreturn { ${NAMES.join(', ')} };`)();
for (const n of NAMES) if (api[n] === undefined) throw new Error(`web/offline-merge.js no longer defines ${n}`);

export const { mergeNotebook, mergeIndex, mergeOffline, mergeTitle, mergeStamp, OFF_CONFLICT_TITLE, OFF_FROM_LOCAL, OFF_FROM_REMOTE } = api;
