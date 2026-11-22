// Object.prototype's names, and the scan for a plain-object table looked up by text · 原型上的名字
// (ADR 0003, Follow-up — prototype lookups; ADR 0015). Shared by the stationery-proto-keys,
// stationery-panote, stationery-sanitize-attrs, note-proto-keys, note-proto-gates and app-load suites
// (R3: one list, one scan).
//
// A lookup in a plain {…} literal finds the members of Object.prototype. So 'constructor', 'toString',
// 'valueOf', '__proto__' and the rest each pass a membership check, and a map keyed by one returns a
// function. Every table keyed by a file's, a notebook's or an SVG's own text must reject each one.

// Derived, so none is missed.
export const PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype);

// THE SCAN. A TABLE is any name, in any case, given a plain {…} (a spread too), Object.assign({…},…)
// or Object.fromEntries(…): by `=`, `||=`, `??=`, `&&=` or `:` (a property), at any place in a
// declaration, inside any parentheses, and also as a default after `||`, `??` or `&&` (`x||{}`,
// `f()||{}`, `a?.b||{}`, `(x||{})`, `a||b||{}`, the operator on the next line). A LOOKUP is
// `T[k]`, `T [k]`, `T?.[k]`, `Reflect.get(T,…)`, `Reflect.has(T,…)`, or `in` before the name or a path
// to it (`k in T`, `k in (T)`, `k in(T)`, `id in now.pages`, a for…in). An index that is a bare
// integer is not text, so it is not counted.
// It is a regex, not a parser. These are its KNOWN limits, each pinned in
// test/stationery-proto-keys.test.mjs; they are not proved to be the only ones:
//   · MISSED: a table chosen by a ternary (`c?{…}:{…}`); a default whose left side holds `,`, `=`,
//     `<`, `>`, `{` or `}` (`f(a,b)||{}`, `(x===y)||{}`); one reached through an alias
//     (`const t=T; t[k]`); one built another way (`new Object()`, `make()`); and a lookup by
//     destructuring with a computed key (`const {[k]:v}=T`).
//   · FALSE ALARMS: it matches names, not scopes, so a name reused in another scope is reported with
//     the table; so is an arrow's destructured parameter (`f=({a})=>…` with `f[k]`), a label or
//     `case y: {`, the `w` in `c?w:{}`, a value computed from a default (`make(x||{})`,
//     `Object.keys(o||{})`, `(o||{}).p`), and the word "in" inside a string.
// Pass code with its comments stripped (codeOnly in helpers-code), or prose can read as code.
const TABLE = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?:\|\|=|\?\?=|&&=|[=:])\s*(?:\(\s*)*(?:[^;{}=,<>\n]*?\s*(?:\|\||\?\?|&&)\s*(?:\(\s*)*)?(?:\{|Object\.assign\s*\(\s*\{|Object\.fromEntries\s*\()/g;
const esc = (name) => name.replace(/\$/g, '\\$');
const lookedUp = (n) => new RegExp(`(?<![\\w$])${n}\\s*(?:\\?\\.)?\\s*\\[(?!\\s*\\d+\\s*\\])|Reflect\\.(?:get|has)\\s*\\(\\s*${n}(?![\\w$])`
  + `|\\bin\\b\\s*\\(*\\s*(?:[\\w$]+\\s*\\??\\.\\s*)*${n}(?![\\w$])`);
export const plainIndexed = (src) => [...new Set([...src.matchAll(TABLE)].map((m) => m[1]))]
  .filter((n) => lookedUp(esc(n)).test(src));

// Mutation: ONE prototype-free table put back as it was. NAME=Object.assign(Object.create(null),X)
// becomes NAME=X, so the source still runs.
export const oldTable = (name) => (src) =>
  src.replace(new RegExp(`(\\b${name}=)Object\\.assign\\(Object\\.create\\(null\\),([\\s\\S]*?)\\);`), '$1$2;');
// Mutation: every prototype-free table in `src` made plain again, in one of the two plain shapes the
// scan must find. 'literal' gives {…} (and Object.fromEntries(…) as it was); 'assign' gives
// Object.assign({},…).
export function plainAgain(src, shape) {
  const open = shape === 'literal' ? '' : 'Object.assign({},';
  return src.replace(/Object\.assign\(Object\.create\(null\),/g, open)
    .replace(/Object\.create\(null\)/g, shape === 'literal' ? '{}' : 'Object.assign({},{})');
}
