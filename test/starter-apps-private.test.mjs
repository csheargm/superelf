// Starter apps are private by default · 入门应用默认不共享 (F5-14, owner decision 2026-11-23).
// workspace.example/apps seeds every new owner's and member's workspace. Three starters shipped with
// "shared": true — Diabetes (a health app) among them — so the owner's health app appeared in every
// member's Family Apps from day one. New installs now start private; the owner shares deliberately.
// Health apps are always private by default. Existing installs are not touched: an app already shared
// stays shared (only these templates change, never a live workspace).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APPS = path.join(import.meta.dirname, '..', 'workspace.example', 'apps');
const HEALTH = ['diabetes', 'longevity', 'allergy'];   // the health starters (blood glucose, longevity, pollen/allergy)

test('no starter app ships shared', () => {
  const slugs = fs.readdirSync(APPS).filter((s) => fs.existsSync(path.join(APPS, s, 'meta.json')));
  assert.ok(slugs.length >= 5, 'CONTROL: the starters are found');
  for (const s of slugs) {
    const m = JSON.parse(fs.readFileSync(path.join(APPS, s, 'meta.json'), 'utf8'));
    assert.notEqual(m.shared, true, `${s} would be shown to every member by default`);
  }
});

test('the health starters exist and are private', () => {
  for (const s of HEALTH) {
    const m = JSON.parse(fs.readFileSync(path.join(APPS, s, 'meta.json'), 'utf8'));
    assert.notEqual(m.shared, true, s);
  }
});
