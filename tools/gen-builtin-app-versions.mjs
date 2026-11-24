// Regenerates lib/builtin-app-versions.json: every sha256 any repo commit ever had for
// workspace/apps/<slug>/index.html, workspace.example/apps/<slug>/index.html or shared-apps/<slug>/index.html,
// keyed by slug. lib/builtin-app-update.mjs replaces an installed copy only when its hash is listed.
// Run after changing a built-in app (test/builtin-app-update.test.mjs fails until you do).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAST_VERSIONS } from '../lib/builtin-app-past-versions.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 1 << 28 });
const RE = /^(?:workspace\/apps|workspace\.example\/apps|shared-apps)\/([^/]+)\/index\.html$/;
const out = {};
const add = (slug, buf) => { (out[slug] ||= new Set()).add(crypto.createHash('sha256').update(buf).digest('hex')); };
for (const c of git('log', '--format=%H', '--', 'workspace/apps', 'workspace.example/apps', 'shared-apps').toString().trim().split('\n').filter(Boolean)) {
  for (const line of git('ls-tree', '-r', c, '--', 'workspace/apps', 'workspace.example/apps', 'shared-apps').toString().split('\n')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/); const s = m && m[2].match(RE);
    if (s) add(s[1], git('cat-file', 'blob', m[1]));
  }
}
for (const root of ['workspace/apps', 'workspace.example/apps', 'shared-apps']) {   // the working tree too: a not-yet-committed edit
  const d = path.join(REPO, root);
  if (fs.existsSync(d)) for (const slug of fs.readdirSync(d)) { const f = path.join(d, slug, 'index.html'); if (fs.existsSync(f)) add(slug, fs.readFileSync(f)); }
}
for (const [slug, hashes] of Object.entries(PAST_VERSIONS)) for (const h of hashes) (out[slug] ||= new Set()).add(h);   // originals from before the repo had them
const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, [...out[k]].sort()]));
fs.writeFileSync(path.join(REPO, 'lib', 'builtin-app-versions.json'), JSON.stringify(sorted, null, 1) + '\n');
console.log(`${Object.keys(sorted).length} apps, ${Object.values(sorted).reduce((n, v) => n + v.length, 0)} versions`);
