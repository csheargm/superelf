// lib/offline.mjs offlineAppsFor (F4-4): the offline prefetch asks only for app pages that exist for
// this user — their own copy first, else the family shelf's — never a slug that would 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { offlineAppsFor } from '../lib/offline.mjs';

const app = (dir, slug) => { fs.mkdirSync(path.join(dir, slug), { recursive: true }); fs.writeFileSync(path.join(dir, slug, 'index.html'), '<p>x'); };

test('own copy wins, the shelf fills in, a missing slug is left out', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-oaf-'));
  try {
    const own = path.join(t, 'own'), shelf = path.join(t, 'shelf');
    app(own, 'notes'); app(shelf, 'notes'); app(shelf, 'bible');
    fs.mkdirSync(path.join(own, 'empty'), { recursive: true });   // a folder with no page is not an app
    assert.deepEqual(offlineAppsFor(['notes', 'bible', 'gone', 'empty'], own, shelf), { apps: ['notes'], shelf_apps: ['bible'] });
    assert.deepEqual(offlineAppsFor(['notes', 'bible'], path.join(t, 'none'), null), { apps: [], shelf_apps: [] }, 'no workspace apps and no shelf (demo): nothing to ask for');
  } finally { fs.rmSync(t, { recursive: true, force: true }); }
});
