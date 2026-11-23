// The meal-photo surface INSIDE superelf（拍照记录饮食 · the in-app way in）.
//
// WHY THIS FILE EXISTS
// The meal pipeline (lib/meals.mjs — vision extraction, storage, month cap, retention)
// was complete and well tested, but reachable only by an iOS Shortcut posting a token.
// Wiring it to an app added three seams that lib/meals.mjs's own tests cannot see, and
// every one of them failed the SAME way — silently:
//
//   (a) the app's recent-meals list called a broker kind `meals` THAT DID NOT EXIST, and
//       there was no GET route behind it either. loadMeals() reads
//       `if(!r.ok || !Array.isArray(r.meals)) { box.innerHTML=''; return; }`, so an
//       unknown kind — which the shell never answers at all — rendered an empty box
//       forever. No error, no console line, no failing test. A write-only pipeline.
//   (b) the `meal-photo` kind read the ingest reply as relayCall(...,'json','meal photo'),
//       which WRAPS the server's own {ok,record} envelope under that key. The app saw
//       r.ok===true and r.record===undefined, so `r.record && r.record.analyzed===false`
//       was false and the UI printed a clean "logged · 已记录" for a photo whose analysis
//       had been dropped — the exact lie R14 forbids.
//   (c) mealCard() read rec.takenAt (never stored) and hunted TOP-LEVEL booleans for the
//       dietary flags, which found the record's own `isFood:true` and printed "isFood"
//       as a flag while the four REAL flags — nested under rec.flags — were never shown.
//
// So the tests below do not grep for a feature and call it present. They RUN the real
// card against records the REAL lib/meals.mjs stored, and they drive a REAL web.mjs over
// HTTP. The rules pinned here: the read path exists end to end; the SERVER owns every
// guard (an app cannot bypass the photo cap or the month cap by asking differently); an
// unanalyzed photo is visibly unanalyzed, never a silent "saved"; and the two committed
// copies of the longevity app carry byte-identical meal code, because that drift has
// already produced repeat bugs here.
process.env.TZ = 'Asia/Shanghai';   // slot/date bucketing is local-time; pin it so asserts hold anywhere
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { readShell } from '../lib/shellhtml.mjs';        // the shell AS SERVED — settings parts inlined
import { ingestMealPhoto, appendMeal, recentMeals, MEAL_FLAGS, MAX_PHOTO_BYTES,
  MAX_MEALS_PER_MONTH, MEALS_MAX_DAYS } from '../lib/meals.mjs';
import { localDateStr } from '../lib/schedule.mjs';
import { rmTemp } from './helpers-tmp.mjs';   // TODO(R4 seam): this file is over budget; split by test group (one describe per file)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'); // throws if moved — a renamed file fails here, never passes vacuously (R14)
const SHELL = readShell(ROOT);
const APP_TEMPLATE = 'workspace.example/apps/longevity/index.html';
const APP_LIVE = 'workspace/apps/longevity/index.html';   // gitignored owner instance — present on a live node only

// Smallest thing lib/meals.mjs's sniffImage accepts as a real image: the PNG magic bytes.
const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const VISION_OK = JSON.stringify({ is_food: true, items: ['蒸饭 rice', 'bok choy'],
  carb_heavy: true, fried: false, sugary_drink: false, vegetables_present: true });
const mkUser = (id = 'owner') => ({ id, workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'mealsui-')) });

// A real web.mjs on an ephemeral port, throwaway root, throwaway workspace.
// `vision_default` is pointed at a lane that does not exist ON PURPOSE: that is the
// genuine state of a node with no vision lane configured, it makes mealVision throw
// with NO network call at all (hermetic), and it exercises the honest-degrade path —
// the photo is still stored, as { analyzed:false, reason }. Never a stub of our own.
async function withWeb(fn) {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { vision_default: 'no-vision-lane-configured' } });
  const inst = startWeb(root);
  try { await waitReady(port); await fn({ port, root }); }
  finally { await stopWeb(inst); rmTemp(root); }
}

// ── Run the app's REAL card, not a copy of it ────────────────────────────────────────────
// The app is inline <script> HTML and cannot be imported, so the card is EXTRACTED from the
// committed template and run — the technique test/broker-relay.test.mjs uses for the shell's
// relay core. A hand-written re-implementation here would be a lenient harness testing
// itself, which is how (c) above survived in the first place.
function loadMealCard(rel) {
  const html = read(rel);
  const esc = /function esc\(s\)\{[^\n]*\n/.exec(html);
  const from = html.indexOf('const MEAL_FLAG_LABELS');
  const to = html.indexOf('async function mealSend');
  assert.ok(esc, `${rel}: the esc() helper the card escapes with must be present`);
  assert.ok(from > 0 && to > from, `${rel}: MEAL_FLAG_LABELS…mealCard must stay one contiguous block`);
  const src = esc[0] + html.slice(from, to);
  assert.ok(/function mealCard\(/.test(src), `${rel}: the extracted block must actually contain mealCard`);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {mealCard,MEAL_FLAG_LABELS};`)();
}

// The app's whole meal region: the 饮食 banner down to the top-level `loadMeals();` that
// kicks it off. Anchored at a LINE START — `loadMeals();` also appears indented inside
// mealSend, and matching that one silently truncated the block to half its size, which is
// the vacuous-pass shape (R14) the length assertion below also guards.
// One broker branch: from its `m.kind==='x'` test to the start of the NEXT kind. Sliced by
// the dispatcher's own `} else if(m.kind===` shape rather than by naming a neighbouring
// kind, so a test about THIS branch cannot be made to fail by an edit to some other one.
function brokerBranch(kind) {
  // `if(m.kind==='x')` — the DISPATCHER's shape. A bare `m.kind==='x'` also appears in the
  // relayKindWhat ternary above the dispatcher, and matching that instead silently handed
  // every assertion below the wrong 100 characters of source.
  const from = SHELL.indexOf(`if(m.kind==='${kind}')`);
  assert.ok(from > 0, `the shell must carry a dispatcher branch for kind '${kind}'`);
  const rest = SHELL.slice(from + kind.length + 12);
  const next = rest.indexOf('else if(m.kind===');
  return next < 0 ? rest : rest.slice(0, next);
}

function mealBlock(s) {
  const from = s.indexOf('/* ── 饮食 · Meals');
  const to = s.indexOf('\nloadMeals();', from);
  assert.ok(from > 0 && to > from, 'the meal block must stay one contiguous, findable region');
  return s.slice(from, to);
}

/* ══ PART A — the broker kinds exist, and relay to the right routes ═════════════════════ */

test('A1 — the shell answers kind "meals", relaying GET /api/meals', () => {
  // THE reported bug. loadMeals() has always called broker({kind:'meals'}); the shell had
  // no such branch, so the request fell through the dispatcher and the app's list stayed
  // empty forever with nothing anywhere to see. An empty result is a legitimate answer
  // here ("no meals yet"), which is exactly why the missing kind was invisible.
  assert.match(SHELL, /m\.kind==='meals'/, 'the kind the longevity app calls must be answered by the shell');
  // Through relayCall, like every other read: a 401 (restarted server), a 500 or a dropped
  // socket must arrive at the app as its own code and NEVER as "no meals logged yet".
  assert.match(SHELL, /relayCall\('\/api\/meals\?days='/, 'relayed to the read route through the shared failure mapper');
  assert.match(SHELL, /encodeURIComponent\(m\.days\|\|3\)/, 'days is URL-encoded and defaulted — an app-supplied value never lands raw in a URL');
  assert.match(SHELL, /'json','meals'\)/, "keyed as `meals`, which is the field loadMeals() reads");
});

test('A2 — kind "meal-photo" hands the ingest envelope back VERBATIM', () => {
  assert.match(SHELL, /m\.kind==='meal-photo'/);
  assert.match(SHELL, /relayCall\('\/api\/meals\/ingest',\{method:'POST'/, 'relayed to the real ingest route');
  // 'raw' is load-bearing (bug (b)). /api/meals/ingest authors its OWN {ok,record,pruned}
  // envelope — like /api/ask — so it must pass through untouched. Read as 'json' with a
  // key, the envelope gets nested and r.record is undefined for every caller: the app then
  // cannot tell an analyzed meal from a dropped analysis, and prints "logged" for both.
  const branch = brokerBranch('meal-photo');
  assert.match(branch, /'raw'\)/, "the ingest reply is passed through verbatim ('raw'), never re-wrapped under a key");
  assert.ok(!/'json','meal/.test(branch), 'wrapping the envelope under a key hides record.analyzed from the app');
  // A failed photo WRITE must be described as a photo that was not uploaded. Defaulted to
  // 'content', the shell's noun table renders "not loaded" — the wrong side of the exchange.
  assert.match(SHELL, /m\.kind==='meal-photo'\?'photo'/, "a meal photo is a PHOTO in the failure-noun table, not generic 'content'");
});

test('A3 — the shell relays and nothing more: no guard of its own', () => {
  // Every cap lives on the server (Part B proves it enforces them). A cap re-implemented in
  // the shell would be a SECOND source of truth that drifts, and — worse — could be read as
  // the enforcement, which a sandboxed app can never be trusted to provide.
  for (const kind of ['meal-photo', 'meals']) {
    assert.ok(!/MAX_MEALS_PER_MONTH|month_cap|MAX_PHOTO_BYTES|MEAL_MAX/.test(brokerBranch(kind)),
      `kind '${kind}': the shell must not carry the month cap or the photo cap — the server owns them`);
  }
});

/* ══ PART B — the SERVER owns the guards; the app cannot ask its way past one ═══════════ */

test('B1 — the photo cap is enforced by the server, whatever the app sends', async () => {
  await withWeb(async ({ port, root }) => {
    // The app shrinks to ~1280px and checks MEAL_MAX_BYTES before sending. That check is an
    // ACCELERATOR (instant feedback, no MB pushed over cellular to earn a 413) — never the
    // enforcement. A forked app, an old cached app, or a hand-crafted post skips it, so the
    // server must refuse on its own.
    const over = Buffer.alloc(MAX_PHOTO_BYTES + 1024, 0x41);
    const res = await api(port, '/api/meals/ingest', { method: 'POST', body: JSON.stringify({ data: over.toString('base64') }) });
    assert.equal(res.status, 413, 'oversized photo refused by the server itself');
    const j = await res.json();
    assert.equal(j.limit, MAX_PHOTO_BYTES, 'and it names the cap, so the app can say what to do about it');
    assert.equal(fs.existsSync(path.join(root, 'workspace', 'uploads')), false, 'nothing stored for a refused photo');
    assert.equal(fs.existsSync(path.join(root, 'workspace', 'meals')), false, 'and no record either');
  });
});

test('B1b — the app\'s pre-flight cap is the SERVER\'s number, in both copies', () => {
  // Drift here is silent in the dangerous direction: an app constant larger than the
  // server's turns an instant local message into a wasted upload and an opaque 413.
  for (const rel of [APP_TEMPLATE, ...(fs.existsSync(path.join(ROOT, APP_LIVE)) ? [APP_LIVE] : [])]) {
    const m = /const MEAL_MAX_BYTES = ([^;]+);/.exec(read(rel));
    assert.ok(m, `${rel}: the app must declare the cap it pre-checks against`);
    // eslint-disable-next-line no-new-func
    assert.equal(new Function(`return ${m[1]}`)(), MAX_PHOTO_BYTES, `${rel}: pre-flight cap must equal lib/meals.mjs MAX_PHOTO_BYTES`);
  }
});

test('B2 — the month cap is enforced by the server, and refuses rather than evicting', async () => {
  await withWeb(async ({ port, root }) => {
    // Seed this month to the cap through the REAL appendMeal, then post a perfectly valid
    // photo the way the app does. The app has no cap logic at all, so this is the only
    // thing standing between a runaway client and an unbounded month file.
    const user = { id: 'owner', workspace: path.join(root, 'workspace') };
    const date = localDateStr(new Date());
    for (let i = 0; i < MAX_MEALS_PER_MONTH; i++) {
      appendMeal(user, { id: `seed-${i}`, ts: Date.now(), date, time: '12:00', slot: 'lunch', photo: 'x', analyzed: false, reason: 'seed' });
    }
    const res = await api(port, '/api/meals/ingest', { method: 'POST', body: JSON.stringify({ data: PNG_B64 }) });
    assert.equal(res.status, 429, 'at the cap the ingest REFUSES — a 200 here would mean a silent eviction');
    assert.equal((await res.json()).code, 'month_cap', 'with the stable machine-readable code, so the app can say which limit was hit');
    const stored = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'meals', `${date.slice(0, 7)}.json`), 'utf8'));
    assert.equal(stored.length, MAX_MEALS_PER_MONTH, 'nothing appended past the cap');
    assert.equal(stored[0].id, 'seed-0', 'and nothing evicted from the front to make room');
  });
});

/* ══ PART C — the real user flow: photo in, list back, and an HONEST card ═══════════════ */

test('C1 — photo in → stored → read back through the SAME route the app reads', async () => {
  await withWeb(async ({ port }) => {
    const res = await api(port, '/api/meals/ingest', { method: 'POST', body: JSON.stringify({ data: PNG_B64, name: 'meal.jpg' }) });
    assert.equal(res.status, 200);
    const ing = await res.json();
    assert.equal(ing.ok, true, JSON.stringify(ing));
    // This node has no vision lane, so the analysis genuinely could not run. The photo is
    // still LOGGED, and the record says so — that is the whole contract (R14).
    assert.equal(ing.record.analyzed, false, 'no vision lane configured → analyzed:false, not a fabricated analysis');
    assert.ok(ing.record.reason, 'and it carries WHY, so a broken lane is diagnosable from the record itself');

    // The read half — the bug that started this file. Before the route existed this was a 404.
    const list = await api(port, '/api/meals?days=3');
    assert.equal(list.status, 200, 'the read route the `meals` broker kind relays to must EXIST');
    const rows = await list.json();
    assert.ok(Array.isArray(rows), 'a bare array, the same shape /api/health answers (R3)');
    assert.equal(rows.length, 1, 'the meal just logged is readable back');
    assert.equal(rows[0].id, ing.record.id, 'and it is the same record, not a re-derived summary');

    // …and the app's card, run for real, tells the user the analysis did not happen.
    const { mealCard } = loadMealCard(APP_TEMPLATE);
    const html = mealCard(rows[0]);
    assert.match(html, /未分析|not analyzed/, 'an unanalyzed meal must SAY it was not analyzed');
    assert.match(html, /已记录|logged/, 'while still confirming the photo was logged — both facts, not one');
    assert.ok(!/undefined|NaN/.test(html), 'and no field may render as undefined/NaN');
  });
});

test('C2 — an ANALYZED record renders the fields the store actually writes', async () => {
  // Records built by the REAL ingest with a stubbed vision lane at the deps seam (no
  // network). If lib/meals.mjs ever renames a stored field, this fails — which is the
  // point: the card must describe the record on disk, not one we imagined.
  const u = mkUser();
  const now = new Date(2026, 8, 15, 19, 20);   // 19:20 → dinner 晚餐
  const r = await ingestMealPhoto(u, { data: PNG_B64, note: 'with family' }, { vision: async () => VISION_OK, now });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.analyzed, true);

  const { mealCard } = loadMealCard(APP_TEMPLATE);
  const html = mealCard(r.record);
  assert.match(html, /蒸饭 rice/, 'the extracted item names are shown');
  assert.match(html, /精制碳水偏多/, 'a TRUE flag from rec.flags is shown…');
  assert.ok(!/油炸/.test(html), '…and a FALSE one is not');
  assert.match(html, /有蔬菜/, 'every true flag, not just the first');
  assert.match(html, /2026-09-15/, 'the date is shown — rec.takenAt does not exist, so reading it showed no time at all');
  assert.match(html, /19:20/, 'with the server-local time, which is the time `slot` was decided from');
  assert.match(html, /dinner/, 'and the slot');
  assert.match(html, /with family/, 'the optional note travels too');

  // The precise regressions of bug (c):
  assert.ok(!/isFood/.test(html), '`isFood` is a record field, NOT a dietary flag — printing it as one is the bug this pins');
  assert.ok(!/undefined|NaN|Invalid Date/.test(html), 'no field may render as undefined/NaN/Invalid Date');
  assert.ok(!/未分析|not analyzed/.test(html), 'an analyzed meal must NOT be labelled unanalyzed');
});

test('C3 — an analyzed NON-food photo is its own outcome, not an empty meal', async () => {
  // Three states must stay distinguishable: analyzed food, analyzed non-food, and not
  // analyzed. Collapsing the last two would report a broken vision lane as "not food".
  const u = mkUser();
  const notFood = JSON.stringify({ is_food: false, items: [], ...Object.fromEntries(MEAL_FLAGS.map((f) => [f, false])) });
  const r = await ingestMealPhoto(u, { data: PNG_B64 }, { vision: async () => notFood, now: new Date(2026, 8, 15, 12, 0) });
  const { mealCard } = loadMealCard(APP_TEMPLATE);
  const html = mealCard(r.record);
  assert.equal(r.record.analyzed, true, 'the analysis DID run — it just found no food');
  assert.match(html, /非食物|not food/, 'said plainly');
  assert.ok(!/未分析|not analyzed/.test(html), 'and never confused with a failed analysis');
});

test('C4 — vision-lane text is escaped: a hostile item name cannot inject markup', () => {
  // Item names are remote model output. sanitizeLine (lib/meals.mjs) strips control
  // characters but NOT `<` or `>`, and the card writes into innerHTML — so escaping is the
  // app's job, with the esc() helper it already uses everywhere else.
  const { mealCard } = loadMealCard(APP_TEMPLATE);
  const html = mealCard({ date: '2026-09-15', time: '12:00', slot: 'lunch', analyzed: true, isFood: true,
    items: ['<img src=x onerror=alert(1)>'], flags: {}, note: '<b>note</b>' });
  assert.ok(!/<img/.test(html), 'a model-authored tag must never reach the DOM as markup');
  assert.ok(!/<b>note<\/b>/.test(html), 'nor a user-authored one');
  assert.match(html, /&lt;img/, 'it is shown as text instead — escaped, not dropped');
});

test('C5 — the card\'s flag table is pinned to lib/meals.mjs MEAL_FLAGS', () => {
  // A browser file cannot import the module, so the labels are a COPY — the same pattern
  // as RELAY_LIMITS in the shell, pinned by test rather than trusted. A flag added to
  // MEAL_FLAGS and not to the app would simply never be shown to anyone.
  const { MEAL_FLAG_LABELS } = loadMealCard(APP_TEMPLATE);
  assert.deepEqual(Object.keys(MEAL_FLAG_LABELS).sort(), [...MEAL_FLAGS].sort(),
    'every extracted flag has a label, and no label names a flag that does not exist');
  for (const [k, v] of Object.entries(MEAL_FLAG_LABELS)) {
    assert.match(v, /[一-鿿]/, `${k}: labels are bilingual — this UI is read in both languages`);
  }
});

test('C6 — the read route answers a missing or absurd ?days= honestly', async () => {
  // recentMeals takes `days` straight from a query string. Unclamped, `i <= null` is false
  // on the first iteration and the function returns [] — so a request with no ?days= would
  // render "No meals logged yet" over a full month of records: the silent-empty failure
  // this whole surface exists to refuse. The upper bound stops ?days=1e9 walking a million
  // month keys, and past the retention horizon there is nothing left to find anyway.
  const u = mkUser();
  appendMeal(u, { id: 'm1', ts: Date.now(), date: localDateStr(new Date()), time: '12:00', slot: 'lunch', photo: 'x', analyzed: false, reason: 'seed' });
  for (const days of [undefined, null, '', 'abc', 0, -5]) {
    assert.equal(recentMeals(u, days).length, 1, `days=${JSON.stringify(days)} must fall back to the window, never to an empty list`);
  }
  assert.equal(recentMeals(u, 1e9).length, 1, 'an absurd request is clamped, not walked');
  assert.ok(MEALS_MAX_DAYS > 0 && MEALS_MAX_DAYS < 1000, 'and the horizon is a real bound');

  await withWeb(async ({ port }) => {
    await api(port, '/api/meals/ingest', { method: 'POST', body: JSON.stringify({ data: PNG_B64 }) });
    const noParam = await (await api(port, '/api/meals')).json();
    assert.equal(noParam.length, 1, 'GET /api/meals with no ?days= must not answer an empty list');
  });
});

/* ══ PART D — the two committed copies must not drift ══════════════════════════════════ */

test('D1 — both longevity copies carry byte-identical meal code', () => {
  // workspace.example/ is the committed template; workspace/ is the owner's live instance
  // (gitignored personal data). They are edited by hand, one at a time, and a fix applied
  // to only one of them is a bug that comes back as a fresh report weeks later. Everything
  // between the 饮食 banner and loadMeals() must match exactly — the sections around it
  // legitimately differ (the live copy is personalised), so only the meal block is pinned.
  const live = path.join(ROOT, APP_LIVE);
  if (!fs.existsSync(live)) return;   // fresh checkout: template-only is correct
  const a = mealBlock(read(APP_TEMPLATE));
  const b = mealBlock(fs.readFileSync(live, 'utf8'));
  assert.ok(a.length > 500, 'the extracted block must be the real thing, not an empty match (R14)');
  assert.equal(b, a, 'the live longevity app has drifted from the template — fix BOTH, always');
});

test('D2 — the app talks to the node ONLY through the broker', () => {
  // A sandboxed app has no network of its own; a fetch() here would be dead code that
  // looks like a working path. Both broker kinds must be present, and no fetch.
  const meals = mealBlock(read(APP_TEMPLATE));
  assert.match(meals, /kind:'meal-photo'/, 'the write goes through the broker');
  assert.match(meals, /kind:'meals'/, 'and so does the read');
  assert.ok(!/\bfetch\(|XMLHttpRequest/.test(meals), 'an app never reaches the network directly');
  assert.match(meals, /暂无记录 · No meals logged yet/, 'and the empty state is bilingual and explicit');
});

test('D3 — the photo is read, downscaled and pre-flighted by PAPhoto, not by a fourth private copy', () => {
  // 2026-09-11 (camera-as-input): this card owned the ONLY resize in the tree — a private
  // canvas downscale plus its own `b64.length*3/4 > cap` arithmetic — which is precisely why a
  // phone photo worked here and blew the cap in chat, in the note pad and in the shell. Both
  // halves now come from PAPhoto. Pinned because the failure mode of losing them again is
  // SILENT: an unresized 8MB photo still uploads, just slowly, until one day it does not.
  const meals = mealBlock(read(APP_TEMPLATE));
  assert.match(meals, /PAPhoto\.toBase64\(file, \{ maxEdge:MEAL_PICK_EDGE, maxBytes:MEAL_MAX_BYTES/,
    'the read + downscale + pre-flight is ONE call into the shared component');
  assert.match(meals, /PAPhoto\.pick\(\{ camera:true \}\)/, 'and the picker is the shared one, camera-first');
  assert.equal(/new FileReader\(|toDataURL\(|createObjectURL\(/.test(meals), false,
    'no private reader, canvas resize or object URL survives in the app (R1)');
  // The cap it passes is this ROUTE's, and it must still be the server's number — not a guess.
  assert.match(meals, /MEAL_MAX_BYTES = 6 \* 1024 \* 1024/, 'the local mirror is still declared');
  assert.equal(MAX_PHOTO_BYTES, 6 * 1024 * 1024,
    'and it still equals lib/meals.mjs MAX_PHOTO_BYTES — a drifted mirror refuses photos the node would take');
});
