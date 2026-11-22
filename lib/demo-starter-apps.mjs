// Starter apps for EXISTING demo workspaces · 为已有演示工作区补充入门应用
// A new visitor's workspace is a copy of workspace.example (web.mjs provisionWorkspace). When a
// starter app is added there later, a returning visitor gets it on their next visit: copied only if
// they have no app of that slug, and only ONCE — a starter they deleted is never brought back.
// <workspace>/.starter-apps.json records the slugs already offered.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from './atomicwrite.mjs';
import { readJsonState, FILE_OK } from './readjson.mjs';

export const STARTER_MARKER = '.starter-apps.json';
// The starters every workspace seeded before the marker existed was given (workspace.example at that time).
const LEGACY_STARTERS = ['bible', 'diabetes', 'longevity', 'notes', 'tasks'];

const appSlugs = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);

// Returns the slugs copied in. Throws on a filesystem error (the caller decides how to report it).
export function addMissingStarterApps(exampleDir, workspace) {
  const marker = path.join(workspace, STARTER_MARKER);
  const mine = path.join(workspace, 'apps');
  const r = readJsonState(marker);
  const had = r.state === FILE_OK && Array.isArray(r.value?.offered);
  const offered = new Set(had ? r.value.offered
    : [...LEGACY_STARTERS, ...appSlugs(mine)]);   // no (or a damaged) marker: assume the original set was given
  const starters = appSlugs(path.join(exampleDir, 'apps'));
  const before = offered.size, added = [];
  for (const slug of starters) {
    if (offered.has(slug)) continue;
    const to = path.join(mine, slug);
    if (fs.existsSync(to)) { offered.add(slug); continue; }   // never overwrite an app of theirs
    const tmp = path.join(workspace, `.starter-${slug}.tmp`);   // copied whole, then renamed: a failed copy leaves no half app
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.cpSync(path.join(exampleDir, 'apps', slug), tmp, { recursive: true }); fs.mkdirSync(mine, { recursive: true }); fs.renameSync(tmp, to); }
    catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }   // no partial copy left to count against the quota
    offered.add(slug); added.push(slug);
  }
  if (!had || offered.size !== before) writeJsonFile(marker, { offered: [...offered] });
  return added;
}
