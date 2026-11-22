// Nothing personal in the starter apps · 入门应用不含个人信息
// workspace.example/apps is copied into every demo visitor's workspace (and every new member's on an
// owner node), so it must carry no owner data. Same rules as the whole-repo scan (tools/privacy-scan.mjs);
// the owner's own terms (names, places) come from the overlay's git-ignored term file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanText, readTerms, ROOT } from '../tools/privacy-scan.mjs';

const APPS = path.join(ROOT, 'workspace.example', 'apps');
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));

test('the seeded starter apps carry no owner names, city or email', () => {
  const terms = readTerms();
  const hits = [];
  for (const f of files(APPS)) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(APPS, f);
    for (const h of scanText(rel, text, terms)) hits.push(`${rel}:${h.line} ${h.rule}`);
  }
  assert.deepEqual(hits, []);
});
