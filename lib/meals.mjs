// Meal photo logging（拍照记录饮食）— PLAN.md capability #3. A family member
// deliberately shares ONE meal photo from the iPhone share sheet (the Shortcut
// is named "Analyze meal · 分析饮食"); the endpoint stores the photo in the
// existing uploads store, makes ONE vision extraction call at INGEST, and
// appends a small structured record to workspace/<user>/meals/YYYY-MM.json.
// The weekly 健康简报 section (lib/meals-brief.mjs) is PURE aggregation of
// those records — no LLM at brief time, no daily nagging, no calorie theater.
//
// PRIVACY — CONSENT-BY-ACTION（隐私 · 主动分享即同意）: the extraction uses
// cfg.vision_default (an Ollama *-cloud lane by default), so the PHOTO leaves
// the machine for that one call. Nothing is auto-collected — the user's
// deliberate share of each photo IS the consent for its analysis. Recipe +
// notice: docs/design/meal-photo-shortcut.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DAY_MS, localDateStr } from './schedule.mjs';
import { writeJsonFile, writeFileAtomic, sanitizeLine, safeJoin, decodeBase64Strict, CODE_TOO_LARGE, humanBytes } from './webutil.mjs';
import { readJson, readJsonForUpdate } from './readjson.mjs';

// ── Caps（上限, abuse-safety like lib/health.mjs） ───────────────────────────
export const MEAL_MAX_BODY_BYTES = 9 * 1024 * 1024; // JSON body cap: base64 inflates 4/3 over MAX_PHOTO_BYTES
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;     // decoded photo cap (a ~1280px JPEG is ~0.5 MB; headroom for unresized shares)
export const MAX_MEALS_PER_MONTH = 400;             // at the cap the ingest REFUSES (429, audited) — never a silent eviction
export const MEALS_RETAIN_MONTHS = 3;               // this month + 2 prior; older month files AND their photos are pruned at ingest
export const MEALS_WINDOW_DAYS = 7;                 // the brief's week (lib/meals-brief.mjs) and the takenAt plausibility bound
const MAX_ITEMS = 8;                                // extracted food names per record
const ITEM_MAX_CHARS = 40;                          // per extracted name (sanitizeLine cap)
const ITEM_MAX_RAW_CHARS = 120;                     // longer = "short names" schema violation → reject the reply
const NOTE_MAX_CHARS = 200;                         // optional user note
const REASON_MAX_CHARS = 200;                       // lane error text is untrusted remote output — sanitized + capped
const TAKEN_AT_FUTURE_MS = 10 * 60000;              // clock-skew allowance on a client-supplied takenAt

// ── Meal slots（用餐时段）by local time — named boundaries, minutes-of-day ───
// BOUNDARY DECISION（边界决定）: dinner runs to MIDNIGHT — a 23:30 meal is a
// late dinner, the very signal 晚餐偏晚 exists to catch; classifying it 加餐
// would mask the worst cases. Past midnight counts as snack: crossing the
// date line would move the meal into the next day's stats (named tradeoff).
const SLOTS = [
  { name: 'breakfast', from: 4 * 60, to: 10 * 60 + 30 },   // [04:00, 10:30) 早餐
  { name: 'lunch', from: 10 * 60 + 30, to: 15 * 60 },      // [10:30, 15:00) 午餐
  { name: 'dinner', from: 16 * 60 + 30, to: 24 * 60 },     // [16:30, 24:00) 晚餐
];                                                         // everything else: snack 加餐
export function mealSlot(d) {
  const m = d.getHours() * 60 + d.getMinutes();
  const s = SLOTS.find((x) => m >= x.from && m < x.to);
  return s ? s.name : 'snack';
}

// The extraction's flag set — SINGLE source (R3): the prompt schema + rules +
// not-food example, the parse guard, and the weekly aggregation (which load-
// asserts its rule keys against MEAL_FLAGS) ALL derive from this table.
const FLAG_DEFS = {
  carb_heavy: 'refined carbs (rice / noodles / bread / pastry) dominate the meal',
  fried: 'any deep-fried item visible',
  sugary_drink: 'a soda or other sweetened drink visible',
  vegetables_present: 'non-starchy vegetables visible',
};
export const MEAL_FLAGS = Object.keys(FLAG_DEFS);
const emptyFlags = () => Object.fromEntries(MEAL_FLAGS.map((f) => [f, false]));

// ── Vision extraction（视觉提取）— ONE call per photo, at ingest only ────────
export const MEAL_PROMPT =
  'You are analyzing ONE photo of a meal for a private family food log. Reply with STRICT JSON ' +
  'only — one object, no markdown fence, no commentary. Schema: {"is_food": boolean, ' +
  '"items": [string], ' + MEAL_FLAGS.map((f) => `"${f}": boolean`).join(', ') + '}. ' +
  `Rules: items = up to ${MAX_ITEMS} short names of foods actually visible; ` +
  MEAL_FLAGS.map((f) => `${f} = ${FLAG_DEFS[f]}`).join('; ') + '. ' +
  'If the photo is not food, reply ' + JSON.stringify({ is_food: false, items: [], ...emptyFlags() }) +
  '. Never name items you cannot actually see.';
const RETRY_NOTE = ' Your previous reply was not valid JSON matching the schema. Reply with ONLY the JSON object.';

// Schema guard: strict JSON, every field present and correctly typed. Items
// are REJECTED, never absorbed: a non-string entry, an oversized name, more
// than MAX_ITEMS, or a name that sanitizes away to nothing all return null, so
// extractMeal's one retry fires and a still-bad reply lands as an HONEST
// analyzed:false — never a guessed or blanked record (R14). is_food:false
// FORCES the empty non-food shape: a hostile "non-food" reply cannot smuggle
// items or flags into the store (prompt-injection surface).
export function parseMealReply(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let j; try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  if (typeof j.is_food !== 'boolean' || !Array.isArray(j.items)) return null;
  const flags = {};
  for (const f of MEAL_FLAGS) { if (typeof j[f] !== 'boolean') return null; flags[f] = j[f]; }
  if (!j.is_food) return { isFood: false, items: [], flags: emptyFlags() };
  if (j.items.length > MAX_ITEMS) return null;
  const items = [];
  for (const s of j.items) {
    if (typeof s !== 'string' || s.length > ITEM_MAX_RAW_CHARS) return null;
    const clean = sanitizeLine(s, ITEM_MAX_CHARS);
    if (!clean) return null; // whitespace/control-only "name" would store ''
    items.push(clean);
  }
  return { isFood: true, items, flags };
}

// deps-injected vision(prompt, imageB64) → reply text. Lane errors and twice-
// unparseable replies both land as { analyzed:false, reason } — the record is
// still saved and the weekly line reports coverage honestly (R14). The reason
// embeds LANE ERROR TEXT (untrusted remote output) → sanitized + capped like
// every other string at this storage boundary.
export async function extractMeal(vision, imageB64) {
  const fail = (msg) => ({ analyzed: false, reason: sanitizeLine(msg, REASON_MAX_CHARS) });
  if (typeof vision !== 'function') return fail('no vision lane injected · 未配置视觉通道');
  let reply;
  try { reply = await vision(MEAL_PROMPT, imageB64); }
  catch (e) { return fail(`vision lane failed · 视觉通道失败: ${String(e && e.message || e)}`); }
  let parsed = parseMealReply(reply);
  if (!parsed) {
    try { reply = await vision(MEAL_PROMPT + RETRY_NOTE, imageB64); }
    catch (e) { return fail(`vision lane failed on retry · 视觉通道重试失败: ${String(e && e.message || e)}`); }
    parsed = parseMealReply(reply);
  }
  if (!parsed) return fail('vision reply failed the JSON schema guard twice · 视觉回复两次未通过格式校验');
  return { analyzed: true, ...parsed };
}

// ── Record store（记录存储）: workspace/<user>/meals/YYYY-MM.json ────────────
const mealsDir = (user) => path.join(user.workspace, 'meals');
const monthFile = (user, ym) => path.join(mealsDir(user), `${ym}.json`);
// READ-ONLY (briefs, recentMeals): a damaged month reads as empty rather than
// breaking a summary. NEVER use it read-before-write — see below.
const monthRows = (user, ym) => { const l = readJson(monthFile(user, ym), []); return Array.isArray(l) ? l : []; };
// READ-BEFORE-WRITE. EMPTY-OVERWRITE CLASS (2026-09-02 round 2): the lenient
// reader turned a damaged YYYY-MM.json into [], and the append below then
// stored a ONE-record month over every meal already logged that month —
// answered 200 ok:true. Throws (file_unreadable → 500) instead.
const monthRowsForUpdate = (user, ym) => readJsonForUpdate(monthFile(user, ym), [], { expect: Array.isArray });

// Append REFUSES at the cap — the ingest checks first and answers 429; this
// throw is the loud backstop (R5). The old slice(-cap) silently destroyed the
// oldest records while answering 200 — an invisible data loss, never again.
export function appendMeal(user, record) {
  const ym = record.date.slice(0, 7);
  const rows = monthRowsForUpdate(user, ym);
  if (rows.length >= MAX_MEALS_PER_MONTH) throw new Error(`meals: month ${ym} at cap ${MAX_MEALS_PER_MONTH} — refuse, never evict`);
  rows.push(record);
  writeJsonFile(monthFile(user, ym), rows); // atomic write
  return record;
}

// Reading back past MEALS_MAX_DAYS can only ever return nothing — pruneMealMonths has
// already deleted those months — so a caller asking for more is answered honestly with
// the horizon rather than made to walk months that no longer exist.
export const MEALS_MAX_DAYS = MEALS_RETAIN_MONTHS * 31;

export function recentMeals(user, days, now = new Date()) {
  // CLAMP (R14): `days` arrives from a query string, so it may be null, '', 'abc' or
  // '99999'. Unclamped, `i <= null` is false on the first iteration and the function
  // returns [] — a missing ?days= would render "No meals logged yet" over a full month
  // of records, the silent-empty failure this whole surface is built to refuse. The
  // upper bound stops a hostile ?days=1e9 from walking a million month keys.
  days = Math.max(1, Math.min(Number(days) || MEALS_WINDOW_DAYS, MEALS_MAX_DAYS));
  const months = new Set();
  for (let i = 0; i <= days; i++) months.add(localDateStr(new Date(now.getTime() - i * DAY_MS)).slice(0, 7));
  const cutoff = now.getTime() - days * DAY_MS;
  const out = [];
  for (const ym of [...months].sort()) {
    for (const r of readJson(monthFile(user, ym), [])) {
      if (r && typeof r.ts === 'number' && r.ts >= cutoff && r.ts <= now.getTime()) out.push(r);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ── Retention（保留期）— rides ingest, like lib/health.mjs pruneSampleFiles ──
// Month files older than MEALS_RETAIN_MONTHS are deleted WITH their photos
// (fs.rmSync precedent). Eviction is gone (appendMeal above), so every stored
// photo belongs to exactly one record and dies with its month file — no
// orphans. Returns { months, photos } counts; the route audits them.
export function pruneMealMonths(user, now = new Date()) {
  let names; try { names = fs.readdirSync(mealsDir(user)); } catch { return { months: 0, photos: 0 }; } // no store yet — nothing to prune
  const keep = new Date(now.getFullYear(), now.getMonth() - (MEALS_RETAIN_MONTHS - 1), 1);
  const keepYm = `${keep.getFullYear()}-${String(keep.getMonth() + 1).padStart(2, '0')}`;
  let months = 0, photos = 0;
  for (const n of names) {
    const m = /^(\d{4}-\d{2})\.json$/.exec(n);
    if (!m || m[1] >= keepYm) continue;
    for (const r of readJson(path.join(mealsDir(user), n), [])) {
      // safeJoin: a corrupt/hand-edited row can never aim the delete outside the workspace.
      const p = (r && typeof r.photo === 'string') ? safeJoin(user.workspace, r.photo) : null;
      if (p && fs.existsSync(p)) { fs.rmSync(p); photos++; }
    }
    fs.rmSync(path.join(mealsDir(user), n), { force: true }); months++;
  }
  return { months, photos };
}

// ── Photo payload guard（照片校验）— fail cheap, BEFORE disk and vision ──────
// STRICT base64 (decodeBase64Strict, lib/webutil.mjs — Node's own decoder
// silently truncates at interior '=' padding, the 'QUJD=' scar; that guard now
// lives in ONE place and /api/upload uses the same one, R3) AND real image
// magic bytes: a garbage payload never reaches the uploads store and never
// burns a paid cloud vision call.
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'heif', 'mif1', 'msf1'];
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
export function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && HEIC_BRANDS.includes(buf.toString('latin1', 8, 12))) return 'heic';
  return null;
}
// Each refusal carries the SAME machine-readable shape every other route answers (R3):
// `code` for the client to branch on, `status` for the HTTP answer, and — for the size
// case — `limit`, so the message can name the cap.
// ROUND-3 LEFTOVER (e): this used to answer a bare `photo too large · 照片过大` with no
// code, no limit, and HTTP 400 — indistinguishable, to any client, from "that file is not
// an image". A size rejection is a 413 with CODE_TOO_LARGE everywhere in this codebase,
// including here, and the sentence states the cap so a user knows what to do about it.
function decodePhoto(data) {
  const buf = decodeBase64Strict(data);
  if (!buf) return { error: 'missing or invalid base64 photo data · 缺少或无效的照片数据', code: 'bad_base64' };
  if (!buf.length) return { error: 'empty photo · 空照片', code: 'empty_photo' };
  if (buf.length > MAX_PHOTO_BYTES) {
    return { error: `Photo too large · 照片过大 (max ${humanBytes(MAX_PHOTO_BYTES)}) — ${humanBytes(buf.length)} sent · 已发送. Pick a smaller photo, or crop it · 请选择更小的照片或裁剪后重试。`,
      code: CODE_TOO_LARGE, status: 413, limit: MAX_PHOTO_BYTES };
  }
  if (!sniffImage(buf)) return { error: 'not a recognized image (JPEG/PNG/HEIC) · 无法识别的图片格式', code: 'not_an_image' };
  return { buf };
}

// Client-supplied takenAt (the photo's creation date — the Shortcut sends it,
// docs §5) beats ingest time for slot/date math: a dinner photographed at
// 18:30 but shared from the camera roll at 22:50 must not read as a 22:50
// dinner. TRADEOFF: absent or implausible (future beyond clock skew, or older
// than the weekly window — where a stale or hostile date would misfile records
// into dead months) → ingest time, the honest fallback we can always vouch for.
function effectiveTime(takenAt, now) {
  if (takenAt == null) return now;
  const t = new Date(takenAt);
  if (isNaN(t)) return now;
  if (t.getTime() > now.getTime() + TAKEN_AT_FUTURE_MS) return now;
  if (t.getTime() < now.getTime() - (MEALS_WINDOW_DAYS + 1) * DAY_MS) return now;
  return t;
}

// ── Ingest core（摄取核心）— deps = { vision, enqueue?, now? } ───────────────
// Per-user in-flight guard（单用户串行）: ONE ingest at a time per user — a
// concurrent second POST answers 429 busy instead of doubling ~MB buffers and
// cloud calls (a Shortcut retry storm stays one request wide). The vision call
// itself ALSO runs inside deps.enqueue — the SAME MAX_CONCURRENT gate every
// other model call in web.mjs goes through.
const inFlight = new Set();

export async function ingestMealPhoto(user, body, deps = {}) {
  // `status` is the HTTP answer, `code` the STABLE machine-readable string every other
  // route in this codebase answers with (R3 — this module used to put the HTTP number in
  // `code`, so a client that branched on `code` here read a different vocabulary than
  // everywhere else and could not recognise a size rejection at all).
  if (inFlight.has(user.id)) return { ok: false, status: 429, code: 'busy', error: 'a meal photo is already being analyzed — retry shortly · 上一张照片仍在分析中，请稍后重试' };
  inFlight.add(user.id);
  try { return await ingestLocked(user, body, deps); }
  finally { inFlight.delete(user.id); }
}

async function ingestLocked(user, body, deps) {
  // The payload guard's code/status/limit travel OUT with the refusal — a client that can
  // only print `error` still reads a specific sentence, and one that branches on `code`
  // can tell a 6MB photo from a corrupt one (R3: the same contract as every other route).
  const { buf, error, code, status, limit } = decodePhoto(body && body.data);
  if (error) return { ok: false, status: status || 400, code, error, ...(limit ? { limit } : {}) };
  const now = deps.now || new Date();
  const when = effectiveTime(body.takenAt, now);
  const pruned = pruneMealMonths(user, now);   // retention rides ingest (lib/health.mjs precedent); route audits counts
  const withPrune = pruned.months ? { pruned } : {};
  // Month cap BEFORE the photo write and BEFORE the vision call — refuse cheap
  // and early (429, audited), never evict. 上限即拒绝，绝不静默淘汰。
  // monthRowsForUpdate, not monthRows: this is the same read the append will
  // do, so a damaged month is refused here — before a photo is stored and
  // before a cloud vision call is spent on a record that cannot be saved.
  if (monthRowsForUpdate(user, localDateStr(when).slice(0, 7)).length >= MAX_MEALS_PER_MONTH) {
    return { ok: false, status: 429, code: 'month_cap', ...withPrune, error: `monthly meal cap reached (${MAX_MEALS_PER_MONTH}) · 本月饮食记录已达上限(${MAX_MEALS_PER_MONTH})` };
  }
  // Same store + naming mechanics as web.mjs /api/upload PLUS a random suffix
  // (web.mjs newId precedent): two same-millisecond POSTs — a double-fired or
  // retrying Shortcut always sends name "meal.jpg" — must never clobber.
  const rid = crypto.randomBytes(4).toString('hex');
  const safe = path.basename(String(body.name || 'meal.jpg')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const rel = `uploads/${when.getTime()}_meal_${rid}_${safe}`;
  const dest = path.join(user.workspace, rel);
  writeFileAtomic(dest, buf);   // tmp+rename, like /api/upload (R3): a killed process never leaves a half-written photo
  const gate = deps.enqueue || ((fn) => fn());  // web.mjs passes its MAX_CONCURRENT enqueue
  const extraction = await gate(() => extractMeal(deps.vision, buf.toString('base64')));
  const p2 = (n) => String(n).padStart(2, '0');
  const record = {
    id: `meal-${when.getTime()}-${rid}`, ts: when.getTime(), date: localDateStr(when),
    time: `${p2(when.getHours())}:${p2(when.getMinutes())}`, slot: mealSlot(when), photo: rel,
    ...(typeof body.note === 'string' && body.note.trim() ? { note: sanitizeLine(body.note, NOTE_MAX_CHARS) } : {}),
    ...extraction,
  };
  return { ok: true, ...withPrune, record: appendMeal(user, record) };
}
