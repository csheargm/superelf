// The weekly model watch (tools/ollama-model-watch.mjs) and the bench's own checks: new catalog
// names are benched and REPORTED, the recorded list moves on only when the bench ran, an empty
// catalog is a failure, and nothing touches the demo config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffModels, fetchCatalog, watch } from '../tools/ollama-model-watch.mjs';
import { scriptErrors, appPoints, summarize, summaryTable } from '../tools/demo-model-bench.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));

test('diff, and a watch run benches only the new names and records them', async () => {
  assert.deepEqual(diffModels(['a', 'b'], ['b', 'c']), { added: ['c'], removed: ['a'] });
  const dir = tmp(), known = path.join(dir, 'known.json');
  fs.writeFileSync(known, JSON.stringify(['a', 'b']));
  const asked = [];
  const bench = async ({ models }) => { asked.push(...models); return { summary: summarize([], [{ model: 'c', wantsSearch: false, turns: [{ ok: true, firstTextMs: 1500 }] }]) }; };
  const file = await watch({ knownFile: known, reportDir: dir, catalog: ['b', 'c'], bench, now: new Date('2026-11-21T00:00:00Z') });
  assert.deepEqual(asked, ['c']);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /New · 新增: c/); assert.match(text, /Gone · 下架: a/); assert.match(text, /\| c \| 0\/0 /); assert.match(text, /no model was switched/);
  assert.deepEqual(JSON.parse(fs.readFileSync(known, 'utf8')), ['b', 'c']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed bench is reported and the names stay new; an empty catalog throws', async () => {
  const dir = tmp(), known = path.join(dir, 'known.json');
  fs.writeFileSync(known, JSON.stringify(['a']));
  const file = await watch({ knownFile: known, reportDir: dir, catalog: ['a', 'z'], bench: async () => { throw new Error('upstream 503'); } });
  assert.match(fs.readFileSync(file, 'utf8'), /Bench failed · 评测失败: upstream 503/);
  assert.deepEqual(JSON.parse(fs.readFileSync(known, 'utf8')), ['a']);
  const dead = async ({ models }) => ({ summary: models.map((m) => ({ model: m, appBuilt: 0, chatOk: 0 })) });
  await watch({ knownFile: known, reportDir: dir, catalog: ['a', 'z'], bench: dead });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'known-failures.json'), 'utf8')), { z: 1 }, 'a dead model is counted, still new');
  const empty = async () => ({ ok: true, json: async () => ({ models: [] }) });
  await assert.rejects(fetchCatalog('http://x', empty), /no models/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bench checks: script compile errors, points, table', () => {
  assert.equal(scriptErrors('<script>ok()</script><script type="application/json">{</script>').length, 0);
  assert.equal(scriptErrors('<script>a(</script>').length, 1);
  assert.equal(appPoints({ ok: true, compiles: true, controls: true, saves: false, feature: true, askAi: true }), 5);
  assert.equal(appPoints({ ok: false }), 0);
  assert.match(summaryTable([{ model: 'm', appPoints: 3, appMax: 6, appBuilt: 1, appRetries: 1, appMedianS: 12.34, chatOk: 1, chatTurns: 1, chatFirstTextS: null, searchedWhenNeeded: true }]),
    /\| m \| 3\/6 \| 1 \| 1 \| 12.3 \| 1\/1 \| — \| yes \|/);
});
