// loadConfig(root, { readOnly: true }) writes NOTHING (docs/adr/0011 item 4) — the load the
// config.json watcher reloads with. Unit level, on throwaway roots; the end-to-end half (a real
// server, a users[] edit caught mid-save) is test/config-live-reload.test.mjs.
//
// SCAR (R13 finding, confirmed): the watcher's reload ran the full loadConfig, whose resolveUsers
// normalizes users[] and writes it back — so a hand edit caught mid-save (the owner's role mistyped)
// was persisted by a reload nobody asked for. Each fixture below is something a full load REWRITES;
// the control proves it, so the read-only assertion can never pass on a fixture that writes nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-cfg-readonly-'));
after(() => rmTemp(tmp));

// A throwaway root with a config.json (and its project dir); returns the root.
let seq = 0;
function root(extra) {
  const r = path.join(tmp, `root-${++seq}`);
  fs.mkdirSync(path.join(r, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(r, 'config.json'), JSON.stringify({ default_project: 'assistant', projects: { assistant: { dir: 'workspace' } }, ...extra }, null, 2));
  return r;
}

const FIXTURES = {
  'a token to generate and a workspace to provision': { users: [{ id: 'owner', role: 'owner', token: 'GENERATE', workspace: 'ws-owner' }] },
  'an owner role mistyped mid-edit': { users: [{ id: 'kid', role: 'member', token: 'k'.repeat(32), workspace: 'workspace' }, { id: 'owner', role: 'ownr', token: 'o'.repeat(32), workspace: 'ws-owner' }] },
  'a legacy config with no users[]': { web_token: 'w'.repeat(32) },
};

test('readOnly: config.json byte-identical, nothing provisioned, no session store — the accounts still resolve in memory (control: a full loadConfig rewrites the file)', async () => {
  for (const [what, extra] of Object.entries(FIXTURES)) {
    const r = root(extra);
    const p = path.join(r, 'config.json');
    const bytes = fs.readFileSync(p);
    const cfg = await loadConfig(r, { readOnly: true });
    assert.ok(fs.readFileSync(p).equals(bytes), `${what}: config.json was rewritten`);
    assert.ok(!fs.existsSync(path.join(r, 'ws-owner')), `${what}: a workspace was provisioned`);
    assert.ok(cfg.users.some((u) => u.role === 'owner'), `${what}: the accounts are still resolved in memory`);
    assert.equal(cfg.sessions, undefined, `${what}: no session store`);
    await loadConfig(r);   // CONTROL: the full load (boot, the admin reload) writes it
    assert.ok(!fs.readFileSync(p).equals(bytes), `${what}: CONTROL: the full load rewrote config.json`);
  }
});
