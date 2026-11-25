// Phone check（手机检查）— a static scan of an app page for the three phone faults the 2026-11-24
// audit found: the page scrolls sideways, a field iOS zooms into, a button too small to tap.
//
// WHY static: app-postcheck, the edit gate and the demo maker all run with no browser. The shared
// touch base (web/touch-base.css) already lifts inputs to 16px and buttons to 44px on touch screens,
// so only what can beat it is flagged: a fixed width wider than a phone and a size forced with
// !important. No viewport-line check: an app runs in the shell's iframe, which takes the shell's
// width. Known limits: a width set from JS, a wide image or a long unbroken word is not seen; a wide
// box inside its own scroll container is flagged anyway.

// The phone-first rule（手机优先规则）— ONE string (R3), told to the app maker on every lane (superelf.md
// build rule 4 is filled from it by appContract) and to app edit / Apply (lib/app-edit*.mjs).
export const PHONE_FIRST_RULE = 'Phone first: design for a 390px-wide phone first, then iPad/desktop. No sideways scroll: '
  + 'no fixed width or min-width over 390px (max-width:100%). Body text >=16px (chat messages 17px), labels >=12px, '
  + 'inputs 16px. Tap targets >=44px with gaps. One column on a phone; grids collapse. A fixed bottom bar or composer '
  + 'pads the content above it, stays above the keyboard (visualViewport) and keeps env(safe-area-inset-bottom). '
  + 'No hover-only control. Dialogs fit the screen (max-height:100dvh, scroll inside). The node checks this.';

export const PHONE_MAX_PX = 390;   // the narrowest phone the audit measured (iPhone 390x844)
const INPUT_MIN_PX = 16, TAP_MIN_PX = 44, LABEL_MIN_PX = 12, BODY_MIN_PX = 16;

// The CSS of a page: <style> bodies and style="" attributes, with `@media (min-width…)` blocks
// dropped (they never apply on a phone).
export function pageCss(html) {
  const parts = [];
  // A commented-out block never applies; a <style> body is kept whole, so "<!--" inside its CSS is not a comment (GPT review).
  html = html.replace(/(<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$))|<!--[\s\S]*?(?:-->|$)/gi, (m, st) => st || '');
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
  // The winning max-width caps when it is at most 100% / 100vw or a phone-size px.
  const capped = (b) => { const all = [...b.matchAll(/(?:^|[;\s])max-width\s*:\s*([^;!]*)(!important)?/gi)];
    const m = (all.filter((x) => x[2]).pop() || all.pop());   // an !important one wins, else the last (GPT review r3)
    const v = m && m[1].trim().match(/^(\d+(?:\.\d+)?)(px|%|vw)$/i);   // rem/em/none/var(): not counted as a cap
    return !!v && Number(v[1]) <= (v[2].toLowerCase() === 'px' ? PHONE_MAX_PX : 100); };
  const wide = all.flatMap((r) => [...px(r.body, 'min-width', false), ...(capped(r.body) ? [] : px(r.body, 'width', false))])
    .filter((v) => v > PHONE_MAX_PX);
  if (wide.length) out.push(`fixed width ${Math.max(...wide)}px is wider than a ${PHONE_MAX_PX}px phone, so the page scrolls sideways · 固定宽度超过手机屏幕，页面会横向滚动`);
  const field = all.filter((r) => /\b(input|textarea|select)\b/i.test(r.sel)).flatMap((r) => px(r.body, 'font-size', true));
  if (field.some((v) => v < INPUT_MIN_PX)) out.push(`input text forced under ${INPUT_MIN_PX}px: iPhone zooms in when it is tapped · 输入框字号小于 ${INPUT_MIN_PX}px，iPhone 点击时会放大`);
  const tap = all.filter((r) => /\bbutton\b/i.test(r.sel)).flatMap((r) => px(r.body, 'min-(?:height|width)', true));
  if (tap.some((v) => v < TAP_MIN_PX)) out.push(`button forced under ${TAP_MIN_PX}px: too small to tap on a phone · 按钮小于 ${TAP_MIN_PX}px，手机上难以点按`);
  return out;
}

// Text size and hover faults（字号与悬停检查）, kept apart from phoneProblems: many built-in apps carry
// 10–11px labels from before the rule, so these must never block a change to an app that already had
// them. The edit gate drops what the app had before the turn, the demo maker builds new apps only, and
// app-postcheck applies them to apps NEW this turn. Each line is constant (no px value), so one more
// small label in an app that had one is not a new fault.
// Known limits: px only (rem/em/calc/var and sizes set from JS are not read); a `font-size:0` is
// ignored; a hover reveal is counted as click-reachable when any rule of the page reveals the same
// target with :focus-within, :active, [open] or a class — whether JS sets that class is not checked.
export function phoneTextProblems(html) {
  const all = rules(pageCss(html)), out = [];
  const sizes = (r) => px(r.body, 'font-size', false).filter((v) => v > 0);
  if (all.some((r) => sizes(r).some((v) => v < LABEL_MIN_PX))) out.push(`text under ${LABEL_MIN_PX}px: too small to read on a phone · 文字小于 ${LABEL_MIN_PX}px，手机上看不清`);
  const bodyText = all.filter((r) => r.sel.split(',').some((x) => /^(html|body|p)$/i.test(x.trim())));
  if (bodyText.some((r) => sizes(r).some((v) => v < BODY_MIN_PX))) out.push(`body text under ${BODY_MIN_PX}px: hard to read on a phone · 正文小于 ${BODY_MIN_PX}px，手机上难以阅读`);
  if (hoverOnly(all)) out.push('a control shown only on hover: a phone has no hover, so it cannot be reached · 控件只在鼠标悬停时出现，手机无法使用');
  return out;
}

// `A:hover B { display:block | visibility:visible | opacity:1 }` with no other way to reveal B.
const REVEAL = /(?:^|[;\s])(?:display\s*:\s*(?!none)[a-z-]+|visibility\s*:\s*visible|opacity\s*:\s*(?:1|0?\.[1-9]\d*)\b)/i;
function hoverOnly(all) {
  const target = (sel) => sel.split(':hover').pop().trim();
  const hovers = all.flatMap((r) => r.sel.split(',').map((s) => s.trim()).filter((s) => /:hover\s*[>+~]?\s*[\w.#[]/.test(s) && REVEAL.test(r.body)));
  const other = all.filter((r) => REVEAL.test(r.body)).flatMap((r) => r.sel.split(',').map((s) => s.trim())).filter((s) => !s.includes(':hover'));
  return hovers.some((h) => { const t = target(h);
    return !other.some((o) => o.endsWith(t) && /:focus-within|:active|\[open\]|\.[\w-]+\s*[>+~]?\s*\S*$/.test(o.slice(0, o.length - t.length) || ' ')); });
}
