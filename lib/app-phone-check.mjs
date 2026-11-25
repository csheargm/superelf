// Phone check（手机检查）— a static scan of an app page for the three phone faults the 2026-11-24
// audit found: the page scrolls sideways, a field iOS zooms into, a button too small to tap.
//
// WHY static: app-postcheck, the edit gate and the demo maker all run with no browser. The shared
// touch base (web/touch-base.css) already lifts inputs to 16px and buttons to 44px on touch screens,
// so only what can beat it is flagged: a fixed width wider than a phone and a size forced with
// !important. No viewport-line check: an app runs in the shell's iframe, which takes the shell's
// width. Known limits: a width set from JS, a wide image or a long unbroken word is not seen; a wide
// box inside its own scroll container is flagged anyway.

// The rule told to the app maker and to the edit lane (ONE place, R3).
export const PHONE_FIRST_RULE = 'Phone first: the app must work on a 390px-wide phone with no sideways scroll. '
  + 'Never set a fixed width or min-width over 390px (use max-width:100% or a media query); '
  + 'never force input text under 16px or a button under 44px with !important.';

export const PHONE_MAX_PX = 390;   // the narrowest phone the audit measured (iPhone 390x844)
const INPUT_MIN_PX = 16, TAP_MIN_PX = 44;

// The CSS of a page: <style> bodies and style="" attributes, with `@media (min-width…)` blocks
// dropped (they never apply on a phone).
export function pageCss(html) {
  const parts = [];
  html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '');   // a commented-out block never applies (GPT review)
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) parts.push(`x{${m[2] ?? m[3]}}`);
  return parts.join('\n').replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/@media[^{]*min-width[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, '');
}

const rules = (css) => [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const px = (body, prop, important) => [...body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\s*(!important)?`, 'gi'))]
  .filter((m) => !important || m[2]).map((m) => Number(m[1]));

// Only a forced min-height/min-width can beat the shared min-height:44px!important; a forced height cannot.
// The phone faults one page has, as bilingual lines ([] when none).
export function phoneProblems(html) {
  const out = [];
  const all = rules(pageCss(html));
  // A width capped in the same rule (max-width:100% or a phone-size px) still fits (GPT review).
  const capped = (b) => /(?:^|[;\s])max-width\s*:\s*(?:100%|\d+(?:\.\d+)?(?:vw|%)|(\d+(?:\.\d+)?)px)/i.test(b)
    && !(Number((b.match(/(?:^|[;\s])max-width\s*:\s*(\d+(?:\.\d+)?)px/i) || [])[1]) > PHONE_MAX_PX);
  const wide = all.flatMap((r) => [...px(r.body, 'min-width', false), ...(capped(r.body) ? [] : px(r.body, 'width', false))])
    .filter((v) => v > PHONE_MAX_PX);
  if (wide.length) out.push(`fixed width ${Math.max(...wide)}px is wider than a ${PHONE_MAX_PX}px phone, so the page scrolls sideways · 固定宽度超过手机屏幕，页面会横向滚动`);
  const field = all.filter((r) => /\b(input|textarea|select)\b/i.test(r.sel)).flatMap((r) => px(r.body, 'font-size', true));
  if (field.some((v) => v < INPUT_MIN_PX)) out.push(`input text forced under ${INPUT_MIN_PX}px: iPhone zooms in when it is tapped · 输入框字号小于 ${INPUT_MIN_PX}px，iPhone 点击时会放大`);
  const tap = all.filter((r) => /\bbutton\b/i.test(r.sel)).flatMap((r) => px(r.body, 'min-(?:height|width)', true));
  if (tap.some((v) => v < TAP_MIN_PX)) out.push(`button forced under ${TAP_MIN_PX}px: too small to tap on a phone · 按钮小于 ${TAP_MIN_PX}px，手机上难以点按`);
  return out;
}
