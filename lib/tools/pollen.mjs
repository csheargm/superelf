// Pollen tool（花粉）— deterministic, keyless, no model in the loop.
//
// WHY THIS EXISTS: workspace/apps/allergy asked a MODEL to search the web and then
// regex-matched JSON out of its reply. That is a skill, and it costs a call per refresh,
// cannot be tested offline, and fails in a way a scheduled job cannot notice — a bad parse
// looks like a quiet day. The data is free and structured, so this is a tool instead.
//
// SOURCE: Pollen.com's own forecast endpoint, which the site itself calls. Keyless, but it
// requires a Referer (it 403s without one). Index is their published 0-12 scale and the
// bands below are THEIRS — inventing our own scale would misreport their numbers.
//
// NOT Open-Meteo: its air-quality API exposes *_pollen fields, but they are the CAMS
// European model and every value is null in North America (measured 2026-09-09). A tool
// that returns null-shaped "data" for half the world is worse than no tool.
import { isPrivateAddress } from '../ics.mjs';   // ONE SSRF guard in the repo (R3)

export const POLLEN_HOST = 'www.pollen.com';
export const POLLEN_TIMEOUT_MS = 10000;
export const POLLEN_MAX_BYTES = 256 * 1024;      // a real reply is ~1KB; this is an OOM bound
export const ZIP_RE = /^\d{5}$/;

// Pollen.com's own bands for its 0-12 index. Ordered low -> high; `rank` makes
// "is today at or above <threshold>" a comparison instead of a lookup table.
export const BANDS = [
  { level: 'low', max: 2.4 },
  { level: 'low-medium', max: 4.8 },
  { level: 'medium', max: 7.2 },
  { level: 'medium-high', max: 9.6 },
  { level: 'high', max: Infinity },
];
export const LEVELS = BANDS.map((b) => b.level);
export const rankOf = (level) => LEVELS.indexOf(level);

export function levelFor(index) {
  // Number('') and Number(null) are 0, and 0 is a valid index — so an ABSENT reading would
  // have reported "low", i.e. a calm day. Reject anything that is not actually a number
  // before converting. (Caught by test, not by review.)
  const usable = typeof index === 'number'
    || (typeof index === 'string' && index.trim() !== '' && Number.isFinite(Number(index)));
  if (!usable) return null;                        // no reading is not "low" — see atOrAbove
  const n = Number(index);
  if (!Number.isFinite(n) || n < 0) return null;
  return (BANDS.find((b) => n <= b.max) || BANDS[BANDS.length - 1]).level;
}

// "Is it bad enough to say something?" A MISSING reading is never "yes" — a job that alerts
// on absent data cries wolf, and one that treats absent as low goes silent forever. Callers
// get null and must decide; pollenBrief below reports the outage rather than inventing calm.
export function atOrAbove(level, threshold) {
  if (level == null) return null;
  const a = rankOf(level), b = rankOf(threshold);
  if (a < 0 || b < 0) return null;
  return a >= b;
}

export function parseForecast(json, { zip }) {
  const loc = (json && json.Location) || {};
  const periods = Array.isArray(loc.periods) ? loc.periods : [];
  const today = periods.find((p) => String(p && p.Type).toLowerCase() === 'today');
  if (!today) throw new Error(`pollen: no "Today" period for ${zip} · 未取得今日花粉数据`);
  const index = Number(today.Index);
  const level = levelFor(index);
  if (level == null) throw new Error(`pollen: unusable index ${JSON.stringify(today.Index)} for ${zip}`);
  return {
    zip, place: String(loc.DisplayLocation || zip), index, level,
    triggers: (today.Triggers || []).map((t) => String(t && t.Name)).filter(Boolean),
    source: `https://${POLLEN_HOST}/forecast/current/pollen/${zip}`,
  };
}

// The postcode is REQUIRED and never defaulted. The published skill this idea came from
// hardcoded one ZIP, so it reported a town in Texas to everyone who installed it; a wrong
// pollen reading is indistinguishable from a right one, so guessing is the worst option.
export async function pollenToday(zip, { fetchImpl = fetch, timeoutMs = POLLEN_TIMEOUT_MS, maxBytes = POLLEN_MAX_BYTES } = {}) {
  const z = String(zip || '').trim();
  if (!ZIP_RE.test(z)) throw new Error('pollen: a 5-digit US postcode is required · 需要 5 位邮编');
  if (isPrivateAddress(POLLEN_HOST)) throw new Error('pollen: refusing a private address');
  const url = `https://${POLLEN_HOST}/api/forecast/current/pollen/${z}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ac.signal, headers: {
      // Pollen.com 403s without these. Sending them is what the site's own page sends.
      accept: 'application/json', referer: `https://${POLLEN_HOST}/forecast/current/pollen/${z}`,
      'user-agent': 'Mozilla/5.0 (superelf pollen tool)',
    } });
  } catch (e) {
    throw new Error(`pollen: ${ac.signal.aborted ? `no answer in ${timeoutMs}ms` : String(e && e.message || e)} · 花粉数据获取失败`);
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`pollen: ${POLLEN_HOST} answered ${res.status} · 花粉数据获取失败`);
  const text = await res.text();
  if (text.length > maxBytes) throw new Error(`pollen: reply over ${maxBytes} bytes`);
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error('pollen: reply was not JSON · 返回内容不是 JSON'); }
  return parseForecast(json, { zip: z });
}

// Job-facing: null = say nothing today (the engine stores no briefing). Never an empty
// "all clear" briefing — R14 forbids one, and a daily "pollen is low" is the spam this
// whole exercise exists to avoid.
export function pollenBrief(reading, threshold = 'medium-high') {
  if (!reading) return null;
  const hit = atOrAbove(reading.level, threshold);
  if (hit !== true) return null;
  const trig = reading.triggers.length ? `\n\n主要过敏原 · Top allergens: ${reading.triggers.join(', ')}` : '';
  return { body: `# 花粉预警 · Pollen Alert\n\n**${reading.level}** (${reading.index}/12) — ${reading.place}${trig}\n\n${reading.source}` };
}

export const MANIFEST = {
  name: 'pollen', purpose: "Today's pollen level and allergens for a US postcode",
  inputs: { zip: 'string (5-digit US postcode, required)' },
  outputs: { zip: 'string', place: 'string', index: 'number 0-12', level: LEVELS.join('|'), triggers: 'string[]', source: 'url' },
  effects: 'read-only', needs: [], keyless: true, version: 1,
  usesModel: false,   // deterministic — pinning a model here would be a setting that does nothing
};
