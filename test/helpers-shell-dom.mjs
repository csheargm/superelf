// The shell's body as a DOM stub, built from the SHIPPED markup — and the shell's
// SHELL_BEHIND_APP block (web/index.html) run against it.
//
// Why built from the markup and not hand-written: the property under test is STRUCTURAL. `inert`
// disables an element's whole subtree, so whether the app bar, the drawer, a dialog or the A-/A+
// toast keep working depends on where they sit in the real tree. A hand-made tree would encode the
// author's belief about the nesting, which is exactly what can be wrong (the toast WAS inside
// <header> until this change).
// Only tags, ids and classes are modelled; matches() is the strict matcher (throws on syntax it
// does not know) from test/helpers-dom-match.mjs.
import assert from 'node:assert/strict';
import { matches } from './helpers-dom-match.mjs';
import { SHELL, between } from './helpers-app.mjs';
import { fakeClock } from './helpers-sandbox-app.mjs';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const attr = (attrs, name) => (new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`).exec(attrs) || []).slice(1).find((v) => v !== undefined);

export function node(tag, { id = '', className = '' } = {}, parent = null) {
  const el = {
    nodeType: 1, nodeName: tag.toUpperCase(), id, className, children: [], parent, attrs: {},
    value: '', textContent: '', style: {},
    classList: {
      contains: (c) => String(el.className).split(/\s+/).includes(c),
      add: (...cs) => { for (const c of cs) if (!el.classList.contains(c)) el.className = `${el.className} ${c}`.trim(); },
      remove: (...cs) => { el.className = String(el.className).split(/\s+/).filter((x) => x && !cs.includes(x)).join(' '); },
      toggle: (c, force) => { const on = force === undefined ? !el.classList.contains(c) : !!force; if (on) el.classList.add(c); else el.classList.remove(c); return on; },
    },
    matches: (sel) => matches(el, sel),
    contains: (n) => { for (let x = n; x; x = x.parent) if (x === el) return true; return false; },
    getAttribute: (n) => (n in el.attrs ? el.attrs[n] : null),
    setAttribute: (n, v) => { el.attrs[n] = String(v); },
    hasAttribute: (n) => n in el.attrs,
    toggleAttribute: (n, force) => { const on = force === undefined ? !(n in el.attrs) : !!force; if (on) el.attrs[n] = ''; else delete el.attrs[n]; return on; },
    appendChild: (c) => { c.parent = el; el.children.push(c); return c; },
    // What leaving an app does to the frame (web/app-frame.js): a shallow clone goes in BEFORE the
    // held iframe, which loses its id and is later removed. A cloned iframe gets its own window.
    removeAttribute: (n) => { delete el.attrs[n]; if (n === 'id') el.id = ''; if (n === 'src') el.src = ''; },   // the src property reflects the attribute
    cloneNode: () => {
      const c = node(tag, { id: el.id, className: el.className });
      Object.assign(c, { attrs: { ...el.attrs }, src: el.src, _doc: el._doc });
      if (tag === 'iframe') { c.posted = []; c.contentWindow = { postMessage: (m, origin) => c.posted.push({ m, origin }) }; }
      return c;
    },
    before: (n) => { n.srcAtInsert = n.src; n.parent = el.parent; el.parent.children.splice(el.parent.children.indexOf(el), 0, n); },   // an iframe loads its src when inserted
    remove: () => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; },
    blur: () => { el._blurred = (el._blurred || 0) + 1; if (el._doc && el._doc.activeElement === el) el._doc.activeElement = el._doc.body; },
  };
  if (parent) parent.children.push(el);
  return el;
}

// <body> … first <script>: every element the shell's markup declares (the settings dialog is
// already inlined in SHELL, as served).
export function shellBody(src = SHELL) {
  const html = src.slice(src.indexOf('<body>') + 6, src.indexOf('<script>', src.indexOf('<body>'))).replace(/<!--[\s\S]*?-->/g, '');
  const body = node('body');
  let cur = body;
  for (const m of html.matchAll(TAG)) {
    const [, close, tag, attrs, selfClose] = m;
    const t = tag.toLowerCase();
    if (close) {
      assert.equal(cur.nodeName.toLowerCase(), t, `markup nesting: </${t}> closes <${cur.nodeName.toLowerCase()}>`);
      cur = cur.parent; continue;
    }
    const el = node(t, { id: attr(attrs, 'id') || '', className: attr(attrs, 'class') || '' }, cur);
    if (!VOID.has(t) && !selfClose) cur = el;
  }
  assert.equal(cur, body, 'every element in the shell body is closed');
  return body;
}

export const all = (root) => [root, ...root.children.flatMap(all)];
export const byId = (root, id) => all(root).find((e) => e.id === id) || null;
export const inertAncestor = (el) => { for (let x = el; x; x = x.parent) if (x.hasAttribute('inert')) return x; return null; };

export const behindBlock = (src = SHELL) => {
  const b = between(src, '/* ══ SHELL_BEHIND_APP_BEGIN', 'SHELL_BEHIND_APP_END ══ */');
  assert.ok(b, 'the SHELL_BEHIND_APP block is extractable from web/index.html');
  return b;
};

// The shell's document with the block loaded. #scrollBtn is created by the script at boot and
// appended to <body> (pinned by the test), so it is appended here the same way.
export function runShell(src = SHELL) {
  const body = shellBody(src);
  node('button', { id: 'scrollBtn' }, body);
  const listeners = [];
  const doc = {
    body, activeElement: body,
    addEventListener: (type, fn, opt) => listeners.push({ type, fn, capture: !!(opt && (opt === true || opt.capture)), passive: !!(opt && opt.passive) }),
    removeEventListener: (type, fn, opt) => {
      const cap = !!(opt && (opt === true || opt.capture));
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === cap);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  for (const e of all(body)) e._doc = doc;
  const posted = [];
  const fr = byId(body, 'fr');
  fr.src = '';   // an iframe with no src attribute, as the markup declares it
  fr.contentWindow = { postMessage: (m, origin) => posted.push({ m, origin }) };
  const $ = (sel) => (sel.startsWith('#') ? byId(body, sel.slice(1)) : all(body).find((e) => e.matches(sel)) || null);
  // eslint-disable-next-line no-new-func
  const api = new Function('document', '$', `${behindBlock(src)}\nreturn { shellBehindApp, SHELL_BEHIND_APP, SHELL_EVENTS };`)(doc, $);
  // Deliver an event the way the shell document would: its capture listeners see it first.
  const fire = (target, type) => { const ev = { type, target }; for (const l of [...listeners]) if (l.type === type) l.fn(ev); return ev; };
  const focus = (el) => { doc.activeElement = el; };
  return { ...api, body, doc, listeners, posted, fr, $, fire, focus, byId: (id) => byId(body, id) };
}

// openApp and goHome as shipped, with the app-frame block they leave through (web/app-frame.js) and
// frameSlug, run against this stub. Supplied: the model-list refresh, the drawer, the conversation,
// the transcript and the shelf (no-ops: test/models-refresh.test.mjs and others run them), the
// shell window's message listeners (`messages`), and a clock the caller steps (`clock`).
export function runShellNav(src = SHELL, clock = fakeClock()) {
  const s = runShell(src);
  const js = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const open = /function openApp\(uid,slug,title\)\{.*\}\n/.exec(js);
  const at = js.indexOf('function goHome(){');
  // frameRef (src, or data-app on the srcdoc route) and the two parses over it, as one unit.
  const frameSlug = /^const frameRef=\(\)=>[^\n]*\nconst frameSlug=\(\)=>[^\n]*$/m.exec(src);
  const block = between(src, '/* ══ APP_FRAME_BEGIN', '/* ══ APP_FRAME_END ══ */');
  assert.ok(open && at >= 0 && frameSlug && block, 'openApp, goHome, frameSlug and the app-frame block are extractable');
  const home = js.slice(at, js.indexOf('\n}', at) + 2);
  const messages = [];
  const window = { addEventListener: (t, fn) => { if (t === 'message') messages.push(fn); } };
  const noop = () => {};
  // The REAL PASW core (web/sw-client.js) with no worker: openApp loads the frame through it.
  const swBlock = between(src, '/* ══ PA_SW_CLIENT_BEGIN', 'PA_SW_CLIENT_END ══ */');
  assert.ok(swBlock, 'the PA_SW_CLIENT block is in the composed shell');
  // eslint-disable-next-line no-new-func
  const { makeSwClient } = new Function(`${swBlock.slice(0, swBlock.indexOf('const PASW=makeSwClient('))}\nreturn { makeSwClient };`)();
  const PASW = makeSwClient({ sw: null, loaded: () => '', frame: () => s.$('#fr'), fetchText: async () => { throw new Error('no network in this harness'); },
    fetchJson: async () => { throw new Error('no network in this harness'); }, fetchBytes: async () => { throw new Error('no network in this harness'); },
    probeFrame: () => ({ remove() {} }), onMessage: () => () => {}, storage: null, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const names = ['$', 'window', 'setTimeout', 'clearTimeout', 'shellBehindApp', 'UID', 'promoteApp', 'closeDrawer', 'barHide',
    'setConvo', 'loadApps', 'loadConvos', 'showEmptyState', 'refreshChatModels', 'PASW'];
  // eslint-disable-next-line no-new-func
  const run = new Function(...names, `${frameSlug[0]}\n${block}\n${open[0]}\n${home}\nreturn { openApp, goHome, held: appFramesHeld };`)(
    s.$, window, clock.setTimeout, clock.clearTimeout, s.shellBehindApp, 'u1', noop, noop, noop, noop, noop, noop, noop, noop, PASW);
  return { ...s, ...run, clock, messages, PASW };
}
