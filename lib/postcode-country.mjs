// Postcode + country（邮编 + 国家）— a bare postcode is ambiguous: owner iPhone 2026-11-25, the
// main chat's weather lookup "by postcode matched a town in France". Every location lookup pairs the
// postcode with an ISO 3166-1 alpha-2 country; with no country we ASK, never guess (R14).
// Pure, so test/postcode-country.test.mjs pins it.

const ISO2_RE = /^[A-Z]{2}$/;
const US_ZIP_RE = /^\d{5}(-\d{4})?$/;

// A stored/typed country code, normalised; '' when absent or not two letters.
export function normCountry(v) {
  const c = String(v || '').trim().toUpperCase();
  return ISO2_RE.test(c) ? c : '';
}

// The region of a BCP 47 locale ('en-US' → 'US', 'zh-Hans-CN' → 'CN'), or of the FIRST entry of an
// Accept-Language header ('en-US,en;q=0.9' → 'US'); '' when it has none.
export function localeRegion(locale) {
  const first = String(locale || '').split(',')[0].split(';')[0].trim();
  const parts = first.split(/[-_]/).slice(1);
  const r = parts.find((p) => /^[A-Za-z]{2}$/.test(p));
  return r ? r.toUpperCase() : '';
}

// The country for a postcode: the explicit one wins; otherwise US ONLY when the postcode is a US ZIP
// shape AND the locale says US. Anything else is '' — the caller asks.
export function countryFor({ postcode = '', country = '', locale = '' } = {}) {
  const explicit = normCountry(country);
  if (explicit) return explicit;
  if (US_ZIP_RE.test(String(postcode).trim()) && localeRegion(locale) === 'US') return 'US';
  return '';
}

// The query string a weather/geocoding lookup gets: 'postcode,CC'. null when either half is missing,
// so a caller can never send a bare postcode by accident.
export function postcodeQuery(postcode, country) {
  const p = String(postcode || '').trim(), c = normCountry(country);
  return p && c ? `${p},${c}` : null;
}

// The line the agent's prompts carry about the user's location.
export function locationLine({ postcode = '', country = '' } = {}) {
  const p = String(postcode || '').trim(); if (!p) return '';
  const c = normCountry(country);
  return c ? `postcode: ${p}, country: ${c} (always look it up as "${p},${c}")`
    : `postcode: ${p}, country: unknown (ask which country before any lookup by postcode)`;
}
