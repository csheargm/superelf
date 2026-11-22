// The pollen tool. Offline by construction: every test injects fetchImpl, so the suite stays
// runnable with no network and no dependence on today's actual pollen.
//
// Two scars are pinned here. (1) The published skill this idea came from HARDCODED one
// postcode, so it reported one town's pollen to everyone — and a wrong pollen reading looks
// exactly like a right one. (2) The app this replaces asked a model and regex-matched JSON
// out of the reply, so a bad parse was indistinguishable from a calm day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollenToday, pollenBrief, parseForecast, levelFor, atOrAbove, rankOf,
  BANDS, LEVELS, MANIFEST, POLLEN_MAX_BYTES } from '../lib/tools/pollen.mjs';

const FIXTURE = { Location: { DisplayLocation: 'Springfield, ZZ', periods: [
  { Type: 'Yesterday', Index: 1.0, Triggers: [{ Name: 'Grasses' }] },
  { Type: 'Today', Index: 9.0, Triggers: [{ Name: 'Elm' }, { Name: 'Grasses' }] },
  { Type: 'Tomorrow', Index: 7.7, Triggers: [] } ] } };
const okFetch = (body = FIXTURE, status = 200) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

test('levels follow Pollen.com\'s own bands, at the exact edges', () => {
  assert.deepEqual(LEVELS, ['low', 'low-medium', 'medium', 'medium-high', 'high']);
  for (const [n, want] of [[0, 'low'], [2.4, 'low'], [2.5, 'low-medium'], [4.8, 'low-medium'],
    [4.9, 'medium'], [7.2, 'medium'], [7.3, 'medium-high'], [9.6, 'medium-high'], [9.7, 'high'], [12, 'high']]) {
    assert.equal(levelFor(n), want, `index ${n}`);
  }
  assert.equal(BANDS.at(-1).max, Infinity, 'the top band must be open — an index above 12 is still high');
});

test('a MISSING reading is neither high nor low — it is unknown', () => {
  // Treat absent as low and the alert goes silent forever; treat it as high and it cries
  // wolf. Both are worse than saying "no reading".
  for (const bad of [null, undefined, '', 'soon', NaN, -1]) assert.equal(levelFor(bad), null, String(bad));
  assert.equal(atOrAbove(null, 'high'), null);
  assert.equal(atOrAbove('high', 'nonsense'), null);
  assert.equal(rankOf('nope'), -1);
});

test('the postcode is required and never defaulted — the hardcoded-ZIP bug cannot recur', async () => {
  for (const bad of [undefined, null, '', '940', '940400', 'abcde', '9404a']) {
    await assert.rejects(() => pollenToday(bad, { fetchImpl: okFetch() }), /5-digit US postcode/, `zip ${JSON.stringify(bad)}`);
  }
  // and the postcode actually reaches the request, rather than a constant
  let seen = '';
  await pollenToday('12345', { fetchImpl: async (u) => { seen = u; return { ok: true, status: 200, text: async () => JSON.stringify(FIXTURE) }; } });
  assert.match(seen, /\/12345$/, `the requested URL must carry the caller's postcode: ${seen}`);
});

test('a real-shaped reply parses to the documented contract', () => {
  const r = parseForecast(FIXTURE, { zip: '12345' });
  assert.deepEqual(r, { zip: '12345', place: 'Springfield, ZZ', index: 9, level: 'medium-high',
    triggers: ['Elm', 'Grasses'], source: 'https://www.pollen.com/forecast/current/pollen/12345' });
  for (const k of Object.keys(MANIFEST.outputs)) assert.ok(k in r, `manifest promises ${k}`);
});

test('a reply that cannot be trusted FAILS — it never becomes a calm day', async () => {
  const cases = [
    ['no Today period', { Location: { periods: [{ Type: 'Tomorrow', Index: 2 }] } }, /no "Today" period/],
    ['no periods at all', { Location: {} }, /no "Today" period/],
    ['unusable index', { Location: { periods: [{ Type: 'Today', Index: 'high-ish' }] } }, /unusable index/],
    ['empty body', {}, /no "Today" period/],
  ];
  for (const [name, body, re] of cases) {
    await assert.rejects(() => pollenToday('12345', { fetchImpl: okFetch(body) }), re, name);
  }
  await assert.rejects(() => pollenToday('12345', { fetchImpl: okFetch(FIXTURE, 403) }), /answered 403/, 'a 403 is reported, not swallowed');
  await assert.rejects(() => pollenToday('12345', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>nope' }) }),
    /not JSON/, 'an HTML error page is not a reading');
});

test('the network is bounded — timeout and size', async () => {
  await assert.rejects(() => pollenToday('12345', { timeoutMs: 5, fetchImpl: (u, o) =>
    new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }),
    /no answer in 5ms/, 'a hung host must not hang the job');
  await assert.rejects(() => pollenToday('12345', { maxBytes: 10, fetchImpl: okFetch() }), /over 10 bytes/);
  assert.ok(POLLEN_MAX_BYTES >= 64 * 1024, 'the real cap is generous enough for a real reply');
});

test('the brief is silent below the threshold and specific above it', () => {
  const r = parseForecast(FIXTURE, { zip: '12345' });           // medium-high
  assert.equal(pollenBrief(r, 'high'), null, 'below threshold = say nothing');
  assert.equal(pollenBrief(null), null, 'no reading = say nothing, never a placeholder');
  // An UNKNOWN level must be silent too. `hit` is three-valued (true/false/null) and the
  // guard has to be `!== true`: `=== false` would let null through and alert on no data.
  assert.equal(pollenBrief({ ...r, level: null }, 'high'), null, 'unknown level must not alert');
  assert.equal(pollenBrief(r, 'not-a-level'), null, 'an unknown THRESHOLD must not alert either');
  const b = pollenBrief(r, 'medium-high');
  assert.ok(b && b.body, 'at threshold it reports');
  assert.match(b.body, /花粉预警 · Pollen Alert/, 'bilingual title');
  assert.match(b.body, /medium-high/);
  assert.match(b.body, /Elm, Grasses/, 'names the allergens, not just a level');
  assert.match(b.body, /Springfield, ZZ/, 'names the place, so a wrong postcode is VISIBLE');
  assert.match(b.body, /pollen\.com/, 'cites its source');
});

test('the manifest is honest about what this tool does', () => {
  assert.equal(MANIFEST.effects, 'read-only', 'read-only is what lets a job run unattended');
  assert.equal(MANIFEST.keyless, true);
  assert.deepEqual(MANIFEST.needs, []);
  assert.match(MANIFEST.inputs.zip, /required/);
});
