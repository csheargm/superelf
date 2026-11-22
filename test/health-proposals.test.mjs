// The approval loop's first PRODUCER: the weekly health brief's deterministic
// proposals (lib/health-analyze.mjs healthProposals / healthBriefBody). R14:
// flags decide WHAT is proposed — every number in the why sentence comes from
// the analysis, never from an LLM. Workspaces are throwaway mkdtemp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeHealth, healthProposals, healthBriefBody } from '../lib/health-analyze.mjs';
import { ingestHealth } from '../lib/health.mjs';

const NOW = new Date(2026, 7, 30, 12);
const THRESH = { steps_min_daily: 5000, sleep_min_minutes: 360, weight_delta_kg_7d: 1.5 };
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() - n); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const mkUser = () => ({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'hprop-')), id: 'owner' });

// Same construction as test/health-analyze.test.mjs synthRows: steps windows
// end yesterday, sleep on even offsets, weight drifting slowly.
function rows({ steps = 6000, sleep = true } = {}) {
  const out = [];
  for (let n = 29; n >= 0; n--) {
    const r = { date: day(n), steps: n === 0 ? 500 : steps };
    if (sleep && n % 2 === 0) r.sleepMinutes = 400;
    r.weight = 70;
    out.push(r);
  }
  return out;
}

test('breaching steps → exactly one create-reminder proposal citing the aggregate', () => {
  const a = analyzeHealth(rows({ steps: 4000 }), { thresholds: THRESH, now: NOW });
  const props = healthProposals(a);
  assert.equal(props.length, 1);
  const p = props[0];
  assert.equal(p.type, 'create-reminder');
  assert.match(p.title, /每日散步提醒/);
  assert.match(p.summary, /^why: steps 7d avg 4000 < 5000 threshold/, 'why cites the exact aggregate numbers');
  assert.match(p.summary, /步数7日均值4000低于阈值5000/);
  assert.deepEqual(p.payload, { flag: 'steps_min_daily', text: 'Walk 20 minutes · 散步20分钟', time: '18:00' });
});

test('sleep gap → weekly Shortcut-check proposal; both breaches cap at 2', () => {
  const a = analyzeHealth(rows({ steps: 4000, sleep: false }), { thresholds: THRESH, now: NOW });
  const props = healthProposals(a);
  assert.equal(props.length, 2, 'steps flag + sleep gap, capped at 2');
  const gap = props.find((p) => p.payload.flag === 'gap_sleep');
  assert.match(gap.summary, /no sleep data this week · 本周无睡眠数据/);
  assert.equal(gap.payload.day, 6, 'weekly Saturday check');
  assert.equal(gap.payload.time, '09:00');
});

test('healthy data → zero proposals; suppressed flags (denied/pending) are skipped', () => {
  const healthy = analyzeHealth(rows(), { thresholds: THRESH, now: NOW });
  assert.deepEqual(healthProposals(healthy), []);
  const breach = analyzeHealth(rows({ steps: 4000, sleep: false }), { thresholds: THRESH, now: NOW });
  const suppressed = healthProposals(breach, { isSuppressed: (f) => f === 'steps_min_daily' });
  assert.equal(suppressed.length, 1, 'only the non-suppressed flag proposes');
  assert.equal(suppressed[0].payload.flag, 'gap_sleep');
  assert.deepEqual(healthProposals(breach, { isSuppressed: () => true }), [], 'all suppressed → ask nothing');
});

test('healthBriefBody carries the proposals alongside the digest body', async () => {
  const u = mkUser();
  for (const r of rows({ steps: 4000 })) ingestHealth(u, { date: r.date, ...r });
  const seen = [];
  const out = await healthBriefBody(u, { llm: async (p) => { seen.push(p); return '- walk 散步'; },
    thresholds: THRESH, now: NOW, manual: false, isSuppressed: () => false });
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].type, 'create-reminder');
  assert.match(out.body, /健康简报/);
  assert.ok(!seen[0].includes('create-reminder'), 'the LLM prompt never sees the proposals — it only phrases suggestions');
});
