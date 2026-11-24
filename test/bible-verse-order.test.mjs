// 经文顺序 Verse order (owner 2026-11-24): the Bible shows 中文 first. Every Bible copy kept in sync carries
// the SAME rule (orderLines + versePair) and reads the pref key from PASettingsRows (one copy, R3).
// The real-browser proof (order, the ⚙ tick, ink + highlights staying on their words) is
// test/bible-verse-order-e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './helpers-app.mjs';

const COPIES = ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html', 'shared-apps/bible/index.html'];
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

for (const f of COPIES) {
  test(`${f}: renders each verse through orderLines and copies verse text through versePair`, () => {
    const s = read(f);
    const render = s.slice(s.indexOf('function renderVerses('), s.indexOf('wrap.appendChild(chapterEnd())'));
    assert.match(render, /orderLines\(d\);/, 'the render orders the lines');
    assert.match(s, /const ORDER_KEY=window\.PASettingsRows&&PASettingsRows\.VERSE_ORDER_KEY;/, 'the key comes from the settings row');
    assert.equal(/englishFirst'/.test(s), false, 'the key string is not repeated here (R3)');
    assert.match(s, /let englishFirst=false;/, 'default: 中文 first');
    assert.equal(s.includes("v.en+'\\n'+v.zh"), false, 'no copied text hard-codes English first');
    assert.match(s, /window\.PAVerseOrderHost=true;[^\n]*\n\s*PASettings\.attach\(\{[\s\S]{0,80}onSave:readOrder/, 'the ⚙ row is shown and a Save re-reads the order');
  });
}

test('workspace/apps/bible is the shared copy, and the shared manifest hashes it', () => {
  assert.equal(read(COPIES[0]), read(COPIES[2]));
  const meta = JSON.parse(read('shared-apps/bible/meta.json'));
  assert.equal(meta.files['index.html'], crypto.createHash('sha1').update(fs.readFileSync(path.join(ROOT, COPIES[2]))).digest('hex').slice(0, 12));
});
