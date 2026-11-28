// 试用 · Try it's frozen copy (docs/adr/0049): the copy's web/ files, copied ONCE when the owner taps Try it,
// and checked against the bytes the change's checks saw. Every preview answer comes from this copy, never
// from the live checkout (GPT review, R13): a follow-up turn editing the same checkout, or a git-ignored file
// under web/ (treeHash does not cover it), never reaches an open preview.
//   - the files: what git would publish under web/ (tracked + new, not ignored), regular files only (a link
//     is never served, as Publish never sends one), bounded in count and bytes;
//   - the check: treeHash before AND after the copy equals the change's verifiedHash, so a write racing the
//     copy is refused, never frozen in (an edit undone byte for byte in between is the known limit).
import fs from 'node:fs';
import path from 'node:path';
import { git, treeHash } from './checkout.mjs';
import { PublishError } from '../publish/collect.mjs';

export const DEFAULT_TRY_SNAPSHOT_MB = 32;   // ~20x today's web/ (1.7 MB): room to grow, still a bound per tap
export const MAX_TRY_SNAPSHOT_FILES = 2000;
export const snapshotsDir = (sroot) => path.join(sroot, 'try');

export function snapshotMb(cfg) {
  const m = Number(cfg && cfg.selfpub_try_snapshot_mb);
  return m > 0 && Number.isFinite(m) ? m : DEFAULT_TRY_SNAPSHOT_MB;
}

const moved = () => new PublishError('NOT_PENDING', '这个改动已有新的修改，不能试用 · This change has been edited since its checks, so it cannot be tried');

function webList(dir, maxFiles) {
  const list = [...new Set(git(dir, ['ls-files', '-co', '--exclude-standard', '-z', '--', 'web/']).split('\0').filter(Boolean))];
  if (list.length > maxFiles) throw new PublishError('TOO_MANY_FILES', `web/ 文件太多（${list.length} > ${maxFiles}） · Too many files in web/`);
  return list;
}

// → the snapshot folder (its web/ holds the copy), or throws (a PublishError the route answers with).
export function takeSnapshot(dir, sroot, verifiedHash, { maxMb = DEFAULT_TRY_SNAPSHOT_MB, maxFiles = MAX_TRY_SNAPSHOT_FILES } = {}) {
  if (treeHash(dir) !== verifiedHash) throw moved();
  fs.mkdirSync(snapshotsDir(sroot), { recursive: true, mode: 0o700 });
  const out = fs.mkdtempSync(path.join(snapshotsDir(sroot), 'snap-'));
  try {
    let bytes = 0;
    fs.mkdirSync(path.join(out, 'web'));
    for (const rel of webList(dir, maxFiles)) {
      let st; try { st = fs.lstatSync(path.join(dir, rel)); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }   // deleted by the change: not in the copy either
      if (!st.isFile()) continue;
      bytes += st.size;
      if (bytes > maxMb * (1 << 20)) throw new PublishError('CHECKOUT_TOO_BIG', `web/ 超过 ${maxMb} MB · web/ is over ${maxMb} MB`);
      fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
      fs.copyFileSync(path.join(dir, rel), path.join(out, rel));
    }
    if (treeHash(dir) !== verifiedHash) throw moved();
    return out;
  } catch (e) { dropSnapshot(out); throw e; }
}

export function dropSnapshot(snap) {
  if (snap) fs.rmSync(snap, { recursive: true, force: true });
}

// Snapshots left by an earlier process (tokens live in memory only): called when no token is live.
export const dropAllSnapshots = (sroot) => fs.rmSync(snapshotsDir(sroot), { recursive: true, force: true });
