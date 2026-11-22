// A CSS selector matcher for the PANote routing harness's DOM stub (test/helpers-panote-routing.mjs),
// so `el.closest(sel)` in the shipped routing answers the way Safari would.
//
// It understands only what the routing's selectors use: comma lists of compound selectors built
// from a tag, `#id`, `.class`, `[attr]`, `[attr=value]` and `:not(<compound>)`. Anything else THROWS.
// (`#id` is for the shell's SHELL_BEHIND_APP list, test/shell-inert.test.mjs.)
// A matcher that quietly returned "no match" for syntax it did not parse would make an exemption
// look absent (or present) by accident — the harness-fidelity rule: a stub must be as strict as
// the system it stands in for, never more forgiving.
const TOKEN = /^(?:([a-z][a-z0-9-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]|:not\(([^()]+)\))/i;

function classesOf(el) {
  const out = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
  if (el._classes) for (const c of el._classes) out.add(c);
  return out;
}

function matchesCompound(el, compound) {
  let rest = compound.trim();
  if (!rest) throw new Error(`helpers-dom-match: empty compound selector in "${compound}"`);
  while (rest) {
    const m = TOKEN.exec(rest);
    if (!m) throw new Error(`helpers-dom-match: unsupported selector syntax at "${rest}"`);
    const [all, tag, id, cls, attr, dq, sq, bare, not] = m;
    if (tag !== undefined && String(el.nodeName || '').toLowerCase() !== tag.toLowerCase()) return false;
    if (id !== undefined && String(el.id || '') !== id) return false;
    if (cls !== undefined && !classesOf(el).has(cls)) return false;
    if (attr !== undefined) {
      const v = el.getAttribute ? el.getAttribute(attr) : null;
      if (v === null || v === undefined) return false;
      const want = dq ?? sq ?? bare;
      if (want !== undefined && String(v) !== want) return false;
    }
    if (not !== undefined && matchesCompound(el, not)) return false;
    rest = rest.slice(all.length);
  }
  return true;
}

// Element.matches — a comma list matches when any member does.
export function matches(el, selector) {
  return selector.split(',').some((part) => matchesCompound(el, part));
}

// Element.closest — the element itself first, then its ancestors; stops at a non-element
// (document / window), as the DOM does.
export function closest(el, selector) {
  for (let x = el; x && !x._notElement; x = x.parent) if (matches(x, selector)) return x;
  return null;
}
