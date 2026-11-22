// Page settings reachable from BOTH modes · 页面设置在两种模式下都可用
//
// Template and Background were parked in the DRAWING row, so switching to Text mode put them out
// of reach — even though a template is a property of the PAGE. The ruled lines a typed note sits
// on are the same ruled lines a written one does; there was no reason for one mode to own them.
//
// They now open from a ⋯ button in the header, which is visible in every mode. The drawing row
// keeps the button only in MOUNT mode, where there is no header to promote it to — the same rule
// the T tool follows, and for the same reason: a control with nowhere to go must stay where it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);

test('the header carries a settings button in every mode', () => {
  const bar = /\(hasTop\?'<div class="pan-top">'[\s\S]*?'<\/div>'/.exec(E);
  assert.ok(bar, 'the header markup must be findable');
  assert.match(bar[0], /class="pan-hmore"/, 'the ⋯ lives in the header');
  assert.match(bar[0], /title="Page settings · 页面设置"/, 'bilingual, like every other control');
  // Nothing hides it per mode: syncMode toggles the tool ROW and the tabs, never this.
  const sync = /function syncMode\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(sync, 'syncMode must be findable');
  assert.doesNotMatch(sync[0], /pan-hmore/, 'the settings button is never mode-gated');
});

test('the template button is not in two places at once', () => {
  // Two buttons opening one popover can disagree about which is lit, and the row copy was the one
  // that could not be reached from Text mode.
  const row = /\(hasTop\?''\:'<button class="pan-tbtn pan-paperbtn"/.exec(E);
  assert.ok(row, 'the row copy is rendered only when there is NO header');
});

test('mount mode keeps it in the row — there is no header to promote it to', () => {
  // Same rule the T tool follows. Hiding it there would leave no way to change the paper at all.
  // Stop at the comma: the declaration continues into paperPop on the same line.
  const btn = /const paperBtn=([^,;]+)[,;]/.exec(E);
  assert.ok(btn, 'the toggler must resolve to one element');
  assert.equal(btn[1], "q('.pan-hmore')||q('.pan-paperbtn')",
    'header first, row as the fallback — one variable, so every consumer is unchanged');
});

test('the outside-tap guard knows the new toggler', () => {
  // A tap on a toggler is handled by the toggler. If the guard does not recognise it, the same tap
  // both opens the panel and closes it, and the panel never appears.
  const guard = /e\.target\.closest\('([^']+)'\)\) return;/.exec(E);
  assert.ok(guard, 'the outside-tap guard must be findable');
  assert.match(guard[1], /\.pan-hmore/, 'or the ⋯ opens and immediately closes');
  for (const t of ['.pan-inkbtn', '.pan-paperbtn', '.pan-fhl', '.pan-photo']) {
    assert.ok(guard[1].includes(t), `${t} is still exempt`);
  }
});

test('the ⋯ shows when its panel is open', () => {
  // It is the only header button that owns a popover; unlit, the panel looks like it belongs to
  // nothing. syncPopBtns already drives this through the shared paperBtn variable.
  // The selector grew when the photo button joined the header — both light the same way. What is
  // pinned is that ⋯ HAS an open state, not the exact list of selectors sharing the rule.
  assert.match(E, /\.pan-hmore\.on[^{]*\{color:var\(--accent/, 'an open state exists');
  assert.match(E, /paperBtn\.classList\.toggle\('on',paperPop\.classList\.contains\('on'\)\)/,
    'and it is driven by the panel, not set by hand at the call site');
});

test('the ⋯ icon is three dots, and filled', () => {
  const icon = new Function(`${/const ICON=[\s\S]*?\n  \}\)?;/.exec(E)[0]}
    ${/const ICON_FILL=[^;\n]*;/.exec(E)[0]}; return { ICON, ICON_FILL };`)();
  assert.ok(icon.ICON.more, 'the icon exists');
  assert.equal(icon.ICON_FILL.more, 1, 'dots are shapes — stroking them draws rings');
  // One 'a' command per dot; the dot's second arc is an implicit repeat with no letter.
  const dots = (icon.ICON.more.match(/a1\.3 1\.3 0/g) || []).length;
  assert.equal(dots, 3, 'three dots');
});
