// Postcode + country mapping (lib/postcode-country.mjs). Synthetic values only, no user data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normCountry, localeRegion, countryFor, postcodeQuery, locationLine } from '../lib/postcode-country.mjs';
import { buildResolvePrompt } from '../lib/jobs/resolve.mjs';

test('normCountry keeps two-letter codes only', () => {
  assert.equal(normCountry(' us '), 'US'); assert.equal(normCountry('USA'), ''); assert.equal(normCountry(''), ''); assert.equal(normCountry(null), '');
});
test('localeRegion reads a locale or an Accept-Language header', () => {
  assert.equal(localeRegion('en-US'), 'US'); assert.equal(localeRegion('zh-Hans-CN'), 'CN');
  assert.equal(localeRegion('en-US,en;q=0.9'), 'US'); assert.equal(localeRegion('fr'), ''); assert.equal(localeRegion(''), '');
  assert.equal(localeRegion('fr,en-US;q=0.5'), '');   // only the FIRST preference counts
});
test('countryFor: explicit wins; US inferred only for a ZIP shape AND a US locale; else blank (ask)', () => {
  assert.equal(countryFor({ postcode: '12345', country: 'fr', locale: 'en-US' }), 'FR');
  assert.equal(countryFor({ postcode: '12345', locale: 'en-US' }), 'US');
  assert.equal(countryFor({ postcode: '12345-6789', locale: 'en-US,en;q=0.9' }), 'US');
  assert.equal(countryFor({ postcode: '12345', locale: 'fr-FR' }), '');   // a French 5-digit code is not a ZIP
  assert.equal(countryFor({ postcode: '12345', locale: 'en' }), '');
  assert.equal(countryFor({ postcode: 'AB1 2CD', locale: 'en-US' }), '');
  assert.equal(countryFor({}), '');
});
test('postcodeQuery never yields a bare postcode', () => {
  assert.equal(postcodeQuery('12345', 'us'), '12345,US');
  assert.equal(postcodeQuery('12345', ''), null); assert.equal(postcodeQuery('', 'US'), null);
});
test('locationLine tells the agent the country, or to ask', () => {
  assert.match(locationLine({ postcode: '12345', country: 'US' }), /country: US.*"12345,US"/);
  assert.match(locationLine({ postcode: '12345' }), /country: unknown \(ask/);
  assert.equal(locationLine({}), '');
});
test('the resolver prompt carries the country with the postcode', () => {
  const p = buildResolvePrompt('pollen alert', { tools: {}, runnable: [], profile: { postcode: '12345', country: 'US' } });
  assert.match(p, /postcode: 12345, country: US/);
  assert.match(buildResolvePrompt('x', { tools: {}, runnable: [], profile: { postcode: '12345' } }), /ask which country/);
});
test('the agent prompt template tells it to send postcode WITH country', async () => {
  const fs = await import('node:fs');
  const md = fs.readFileSync(new URL('../workspace.example/CLAUDE.md', import.meta.url), 'utf8');
  assert.match(md, /ALWAYS send both together/); assert.match(md, /never guess one/);
});
