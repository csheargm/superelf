# Meal Photo Logging · 拍照记录饮食 — Shortcut recipe (design)

Status: **shipped with capability #3** (PLAN.md Part III, Phase B). Companion:
`docs/design/ios-health-ingestion.md` (the health ingest path whose setup —
URL + Bearer token · 令牌 — this feature reuses).

## 1. What it is · 是什么

A family member deliberately shares ONE meal photo from the iPhone share sheet
（分享菜单）; superelf analyzes it ONCE at ingest with the configured vision lane
（视觉通道, `cfg.vision_default`）and stores a small structured record
(`workspace/<user>/meals/YYYY-MM.json`). The weekly 健康简报 gains a 2–3 line
**Meals · 饮食** section — pure aggregation（纯聚合）of those records, no LLM at
brief time. No daily nagging, no calorie theater — P2 (less screen time) holds:
the only recurring surface is the existing weekly brief.

**Deliberately share-sheet only · 仅限手动分享:** there is NO daily automation,
no background collection, no camera-roll scanning. Every logged meal is one
deliberate share, each time. That framing is the feature, not a limitation.

## 2. Privacy notice · 隐私声明 (consent-by-action · 主动分享即同意)

> The analysis call sends THE PHOTO to the configured vision lane —
> `cfg.vision_default`, by default `glm-5.3-flash:cloud` via Ollama cloud — so
> the photo leaves the machine for that ONE call. Sharing a photo to the
> Shortcut named "Analyze meal · 分析饮食" is the explicit consent for exactly
> that analysis. Nothing is auto-collected. The stored record keeps only:
> timestamp, meal slot (早餐/午餐/晚餐/加餐 by local time), the structured
> extraction (items · 食物 + flags 标记), and the photo path in the user's own
> gitignored `uploads/` store.

Vision failure is stored honestly as `{ analyzed:false, reason }`, and the
weekly line reports coverage ("5 of 7 photos analyzed") — R14.

## 3. Endpoint · 接口

`POST /api/meals/ingest` — Bearer per-user, exactly like `/api/health/ingest`.

```json
{ "data": "<base64 JPEG/PNG/HEIC>", "name": "meal.jpg",
  "takenAt": "<photo creation date, ISO 8601 — optional>",
  "note": "optional note · 可选备注" }
```

- Caps: 9 MB JSON body / 6 MB decoded photo (`lib/meals.mjs` constants).
  Strict base64 AND image magic bytes (JPEG/PNG/HEIC) are checked BEFORE
  anything is stored or any vision call is made.
- `takenAt`（拍照时间）: slot/date derive from the photo's creation time when
  it is plausible (not future beyond clock skew, not older than the weekly
  window), so a dinner shared late from the camera roll still counts as
  dinner; absent or implausible → ingest time.
- Response: `{ ok: true, record }` — `record.analyzed` says whether the vision
  extraction succeeded; `400` bad payload, `413` oversized, `429` refused —
  either the monthly cap (`MAX_MEALS_PER_MONTH` = 400, nothing stored, no
  vision call, audited) or one ingest already in flight for this user
  (per-user guard; the vision call also rides web.mjs's `MAX_CONCURRENT`
  enqueue gate). Refusals are honest: records are NEVER silently evicted.
- Retention（保留期）: month files older than `MEALS_RETAIN_MONTHS` (3) are
  deleted together with their photos at ingest time, audited — disk use is
  bounded and no photo ever outlives its record.
- Record shape: `{ id, ts, date, time, slot, photo, note?, analyzed, isFood?,
  items?, flags? { carb_heavy, fried, sugary_drink, vegetables_present } }` —
  `id` and the photo filename carry a random suffix, so same-millisecond
  double-POSTs can never clobber each other.

## 4. Setup — reuse the Health QR · 复用健康接入

The profile's existing **Health setup · 健康接入** section already hands each
member their own ingest URL + Bearer token (QR or copyable text). The SAME
URL + token pair serves this endpoint — replace the path `/api/health/ingest`
with `/api/meals/ingest` in the Shortcut below. No new UI, no new dots.

## 5. The share-sheet Shortcut · 快捷指令

Create in the Shortcuts app; name it **"Analyze meal · 分析饮食"** — the name
carries the consent notice (§2): sharing to it = asking for analysis.

1. **Shortcut details → Show in Share Sheet** ON; accepted types: **Images**.
2. **Receive** Images from Share Sheet（接收分享的图片）.
3. **Resize Image** — 1280 px longest side（缩放到最长边约1280像素）; keeps
   the upload small and is plenty for food recognition.
4. **Convert Image** to JPEG (quality ~0.8).
5. **Base64 Encode** the JPEG.
6. **Get Details of Images → Creation Date**（获取图片的创建日期）on the
   share-sheet input, formatted as ISO 8601 — this becomes `takenAt`, so a
   photo shared late from the camera roll keeps its true meal time.
7. **Get Contents of URL**:
   - URL: `<your node>/api/meals/ingest` (the Health-setup URL with the path
     swapped; Tailscale/LAN carries it — never a third-party relay)
   - Method: POST
   - Headers: `Authorization: Bearer <that member's token from Health setup>`,
     `Content-Type: application/json`
   - Request Body (JSON): `{ "data": "<Base64 Encoded output>", "name": "meal.jpg",
     "takenAt": "<Creation Date from step 6>" }`
8. (Optional) **Show Result** — the JSON echoes the stored record, so the user
   sees `analyzed: true/false` immediately.

Each family member builds it once with their OWN token — data lands in their
own workspace, like health.

## 6. Weekly brief section · 每周小结

Deterministic lines (`lib/meals-brief.mjs mealsBriefLines`, thresholds are
named constants), rendered under **Meals · 饮食** in the weekly 健康简报:

```
## Meals · 饮食
- 8 of 9 photos analyzed this week · 本周9张照片中已分析8张
- dinner avg 20:40 over 4 dinners, later than 20:00 · 晚餐偏晚 (平均20:40，4次晚餐)
- carb-heavy 5/8 · 碳水偏多
```

- The week is **calendar days ending yesterday**（自然日，截至昨天）— the same
  DAY convention as the health trends, so counts never drift between sections
  or double-count a meal across two weekly runs.
- 0 photos → section omitted; 1 photo → one honest "too few to see a pattern ·
  照片不足" line; otherwise a coverage line + at most 2 pattern lines, and
  pattern lines require ≥ `MIN_PATTERN_PHOTOS` (2) **analyzed food** records —
  the denominators' own population — else the coverage line stands alone.
- Rules in priority order: dinner-late（晚餐偏晚, avg later than 20:00, needs
  ≥ `MIN_DINNERS` (2) dinners and states its n）→ carb-heavy（碳水偏多,
  >1/2）→ vegetables-low（蔬菜偏少, <1/2）→ sugary drinks（含糖饮料, any）→
  fried（油炸偏多, >1/3）.
- Slot boundaries（用餐时段）: dinner runs 16:30–24:00 — a 23:30 meal is a
  LATE dinner (the signal 晚餐偏晚 exists to catch), never reclassified 加餐;
  past midnight counts as snack on the next calendar day (named tradeoff).
- Non-food photos count toward coverage, never toward pattern denominators;
  analysis failures AND malformed on-disk records count as photos, never as
  data (read-back shape guard).
