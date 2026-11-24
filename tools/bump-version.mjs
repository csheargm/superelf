#!/usr/bin/env node
// Bump the version from the merges on main · 按合并自动升级版本 (docs/adr/0038).
//   node tools/bump-version.mjs            write package.json + version-notes.json for every merge
//                                          since the newest release; prints the new version
//   node tools/bump-version.mjs --check    change nothing; exit 1 if merges are not yet released
//                                          (deploy-vm.sh and tools/pre-push.sh run this)
//   node tools/bump-version.mjs --dry-run  print the entries it would write
// Idempotent: with no merge since the last entry's `through` commit it changes nothing.
// Ship flow: merge → `node tools/bump-version.mjs` → commit "release: vX.Y.Z" on main → push → deploy.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pendingMerges, planReleases, applyReleases } from '../lib/version-bump.mjs';

export const FIX_COMMAND = 'node tools/bump-version.mjs && git commit -am "release: v$(node -p \'require(\\"./package.json\\").version\')"';

export function run(root, argv, exec = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  const pkgFile = path.join(root, 'package.json'), notesFile = path.join(root, 'version-notes.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const notesNow = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
  const newest = Object.keys(notesNow).filter((k) => notesNow[k] && notesNow[k].through)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const { merges } = pendingMerges(root, exec);
  // Plan from the newest release ENTRY (the cursor), so an interrupted bump re-runs to the same result.
  const releases = planReleases(newest ? newest.slice(1) : pkg.version, merges);
  if (argv.includes('--check')) {
    // An interrupted bump (one file written, the other not) must not pass as "covered".
    if (newest && newest !== `v${pkg.version}`) return { code: 1, out: `package.json v${pkg.version} != newest release ${newest}.\nFix: set package.json to ${newest.slice(1)} and commit` };
    // The bump must be COMMITTED: a working-tree-only bump would pass while the push sends the old files.
    let dirty = '';
    try { dirty = exec(['status', '--porcelain', '--', 'package.json', 'version-notes.json']).trim(); } catch (e) { throw new Error(`cannot read git status: ${e.message}`); }
    if (dirty) return { code: 1, out: `package.json / version-notes.json have uncommitted changes.\nFix: ${FIX_COMMAND}` };
    if (!releases.length) return { code: 0, out: `version v${pkg.version} covers every merge` };
    return { code: 1, out: `${merges.length} merge(s) since v${pkg.version} are not in the release notes.\nFix: ${FIX_COMMAND}` };
  }
  if (!releases.length && newest && newest !== `v${pkg.version}`) {   // finish an interrupted bump
    pkg.version = newest.slice(1);
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    return { code: 0, out: `v${pkg.version}` };
  }
  if (!releases.length) return { code: 0, out: `v${pkg.version} (nothing new)` };
  if (argv.includes('--dry-run')) return { code: 0, out: JSON.stringify(releases, null, 2) };
  pkg.version = releases[releases.length - 1].version;
  // Notes (the cursor) first: a crash before package.json is finished by the next run, and --check
  // refuses the mismatch meanwhile.
  fs.writeFileSync(notesFile, JSON.stringify(applyReleases(notesNow, releases), null, 2) + '\n');
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  return { code: 0, out: `v${pkg.version}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  try {
    const r = run(root, process.argv.slice(2));
    (r.code ? process.stderr : process.stdout).write(r.out + '\n');
    process.exit(r.code);
  } catch (e) {
    process.stderr.write(`bump-version: ${e.message}\n`);   // R5: a failure is loud and non-zero, never "nothing new"
    process.exit(2);
  }
}
