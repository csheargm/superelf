// The app contract（应用契约）— superelf.md, enforced.
//
// WHY THIS FILE EXISTS. `workspace.example/CLAUDE.md` had carried the app framework for
// months — reusable components, the broker API, the sandbox limits — and apps kept shipping
// without them anyway, because a document nobody is checked against is advice. Measured
// 2026-09-09 and RE-MEASURED 2026-09-11: 8 of 19 live apps had no AI feature at all, and the
// per-app system prompt was editable in exactly ONE app. The fix is not more prose. It is
// this file: every app is enumerated and every clause of superelf.md is asserted.
//
// HOW A KNOWN GAP IS HANDLED. Nearly every app predates the contract, so PENDING below is an
// explicit ledger of who fails what. It is a debt with names on it, not an exemption:
//   · an app NOT in the ledger must satisfy every clause — so a NEW app cannot be born broken,
//     and an existing app cannot acquire a new violation;
//   · a ledger line that is no longer true FAILS the suite and must be deleted — so the ledger
//     can only shrink, and cannot rot into a permanent excuse list (R14).
// A clause nothing can satisfy is a bad clause, so the achievability test at the bottom
// requires each one to be met by at least one shipped app, and each detector to be proven
// against a known-bad and a known-good fixture. A guard that cannot fail proves nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './helpers-code.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// superelf.md is the contract's text. If it is renamed or deleted, this suite must die loudly
// rather than keep asserting clauses whose wording no longer exists anywhere (R14).
const SUPERELF = fs.readFileSync(path.join(ROOT, 'superelf.md'), 'utf8');

// Comments are not code (codeOnly, helpers-code.mjs). `markdown:` appears in rental-hunt ONLY
// inside the comment that explains the render-md scar — scanning raw text would flag the fix.

// ── the four clauses of superelf.md, as detectors ──────────────────────────────────────────
// Each takes {html, code, meta} and answers true when the app SATISFIES the clause.
const CLAUSES = {
  // (a) an (ask) AI feature, mounted from PAChat. listDrawer is NOT a conversation — an app that
  // mounts the component for a list drawer alone has no way to ask anything.
  // A one-shot kind:'ask' errand is not an AI feature either: no transcript, no model chooser.
  a: {
    what: 'an (ask) AI feature mounted from PAChat',
    ok: ({ html, code }) => html.includes('<!--PA_CHAT_UI-->') && /\bPAChat\.(fullscreen|mount)\s*\(/.test(code),
  },
  // (b) an app-specific system prompt the user can edit AND reset. PASettings is the only
  // mechanism that offers both: its override box empties back to the default. Settings ›
  // Advanced does not count — it lists only apps with a declared default in config.json
  // system_prompts.apps, which is EMPTY on this node, so it currently lists nothing at all.
  b: {
    what: 'an editable + resettable system prompt (PASettings)',
    ok: ({ html, code }) => html.includes('<!--PA_SETTINGS_UI-->') && /\bPASettings\.attach\s*\(/.test(code),
  },
  // (c) reuse first. Two statically checkable second copies, both with scars behind them:
  // a private chat client posting kind:'chat', and the render-md field name that made every
  // answer render as raw **bold** for weeks.
  c: {
    what: 'no second copy of a shared component (private chat / render-md field)',
    ok: ({ code }) => !/kind\s*:\s*['"]chat['"]/.test(code) && !/\bmarkdown\s*:/.test(code),
  },
  // (d) a face, DECLARED. `false` is a real answer — "this app deliberately has no face".
  // Absent is not: it means nobody decided, which is what the shelf is full of today.
  d: {
    what: 'a face declared in meta.json (an object with a label, or false)',
    ok: ({ meta }) => {
      if (!Object.prototype.hasOwnProperty.call(meta, 'face')) return false;
      const f = meta.face;
      if (f === false) return true;
      return !!f && typeof f === 'object' && !Array.isArray(f)
        && typeof f.label === 'string' && !!f.label.trim();
    },
  },
};

// ── where apps live ────────────────────────────────────────────────────────────────────────
// workspace.example/apps is TRACKED and provisioned into every new account (web.mjs
// provisionWorkspace), so it is present in every checkout and this suite is never vacuous.
// workspace/apps is the owner's LIVE set — gitignored user data, absent on a fresh checkout —
// and is where new apps are actually built, so it is enumerated when it exists. The
// workspace-<member>/ forks are deliberately NOT enumerated: they are copies of these same
// apps, and a copy failing is the original failing, reported twice.
const SOURCES = ['workspace.example/apps', 'workspace/apps'];

// ── the ledger: app slug → clauses it does not yet meet (measured 2026-09-11) ──────────────
// Ownership note for whoever shortens this: bible/longevity/notes/diabetes were being worked
// on concurrently when this was written and are NOT this session's to fix. `bible` is the
// reference for (a)+(b)+(c) — it proves the contract is met by a real, shipped app.
const PENDING = {
  allergy: ['a', 'b', 'd'],
  'bible-values': ['a', 'b', 'd'],
  bible: ['d'],
  brainstorm: ['a', 'b', 'c', 'd'],   // mounts the PAChat marker, then hand-rolls its own chat
  calendar: ['a', 'b', 'd'],
  'daily-digest': ['a', 'b', 'd'],
  diabetes: ['a', 'b', 'd'],
  family: ['a', 'b', 'd'],
  longevity: ['b', 'd'],
  'math-algebra': ['b', 'd'],
  notes: ['b', 'd'],                  // (a) met: Ask AI is PAChat.panel in the rail, PAChat.fullscreen on a phone
  'productivity-hub': ['a', 'b', 'd'],
  'rental-hunt': ['b', 'd'],
  research: ['b', 'd'],
  'semi-news': ['b', 'd'],
  tasks: ['a', 'b'],                  // (d) met 2026-09-11: the first app with a face
};

function readApp(src, slug) {
  const dir = path.join(ROOT, src, slug);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) || {}; } catch { meta = {}; }
  return { slug, src, html, code: codeOnly(html), meta };
}

function enumerateApps(sources = SOURCES) {
  const apps = [];
  for (const src of sources) {
    const dir = path.join(ROOT, src);
    if (!fs.existsSync(dir)) continue;
    for (const slug of fs.readdirSync(dir).sort()) {
      if (!fs.existsSync(path.join(dir, slug, 'index.html'))) continue;
      apps.push(readApp(src, slug));
    }
  }
  return apps;
}

const violations = (app) => Object.keys(CLAUSES).filter((k) => !CLAUSES[k].ok(app));

const APPS = enumerateApps();

test('the enumeration is real — the tracked apps are found and read', () => {
  const tracked = APPS.filter((a) => a.src === 'workspace.example/apps');
  assert.ok(tracked.length >= 4,
    `only ${tracked.length} tracked apps found — this suite would pass by examining nothing (R14)`);
  for (const a of APPS) assert.ok(a.html.length > 200, `${a.src}/${a.slug}: index.html is empty`);
});

test('superelf.md still states the four clauses this file asserts', () => {
  // The document and the test are two halves of one contract; a clause silently dropped from
  // the prose while the detector stayed would enforce a rule nobody was told about.
  for (const marker of ['**(a)', '**(b)', '**(c)', '**(d)']) {
    assert.ok(SUPERELF.includes(marker), `superelf.md lost clause ${marker}`);
  }
  assert.match(SUPERELF, /test\/app-contract\.test\.mjs/, 'superelf.md must name the test that enforces it');
});

test('no app violates a clause that is not in the ledger', () => {
  const unexpected = [];
  for (const app of APPS) {
    const allowed = new Set(PENDING[app.slug] || []);
    for (const k of violations(app)) {
      if (!allowed.has(k)) unexpected.push(`${app.src}/${app.slug}: (${k}) ${CLAUSES[k].what}`);
    }
  }
  assert.deepEqual(unexpected, [],
    'these apps break superelf.md with no ledger entry. Fix the app — a new app is never added '
    + 'to PENDING:\n  ' + unexpected.join('\n  '));
});

test('the ledger has no stale line — a clause now met must be struck off', () => {
  // Without this, PENDING becomes a list of excuses that outlives the problems it describes,
  // and the suite would go green over apps that had quietly been fixed (R14).
  const bySlug = new Map();
  for (const app of APPS) {
    const prev = bySlug.get(app.slug) || new Set();
    violations(app).forEach((k) => prev.add(k));
    bySlug.set(app.slug, prev);
  }
  const stale = [];
  for (const [slug, clauses] of Object.entries(PENDING)) {
    const found = bySlug.get(slug);
    if (!found) continue;              // not on this machine: workspace/apps is gitignored
    for (const k of clauses) if (!found.has(k)) stale.push(`${slug}: (${k}) is met now — delete this ledger entry`);
  }
  assert.deepEqual(stale, [], 'stale ledger entries:\n  ' + stale.join('\n  '));
});

test('every clause is achievable — at least one shipped app meets it', () => {
  // A clause no app can satisfy is a clause written wrong. This is what stops the contract
  // from being tightened into something that only ever grows the ledger.
  for (const [k, c] of Object.entries(CLAUSES)) {
    const met = APPS.filter((a) => c.ok(a)).map((a) => a.slug);
    assert.ok(met.length > 0, `no app satisfies clause (${k}) ${c.what} — the clause, not the apps, is wrong`);
  }
});

test('each detector fires on a known-bad app and stays quiet on a known-good one', () => {
  // R14 in one test: the detectors above are the whole guard, so they are run against
  // fixtures whose verdict is known. A detector that answers true for everything would make
  // every other test in this file pass by examining nothing.
  const good = {
    html: '<!--PA_CHAT_UI--><!--PA_SETTINGS_UI-->',
    code: 'PAChat.fullscreen({}); PASettings.attach({host:h}); post({kind:"render-md",text:t});',
    meta: { face: { label: 'open' } },
  };
  const bad = {
    html: '<div>nothing</div>',
    code: 'post({pa:"req",kind:"chat",message:m}); post({kind:"render-md",markdown:t});',
    meta: {},
  };
  for (const [k, c] of Object.entries(CLAUSES)) {
    assert.equal(c.ok(good), true, `clause (${k}) rejects a compliant app`);
    assert.equal(c.ok(bad), false, `clause (${k}) accepts a non-compliant app — it cannot fail`);
  }
  // …and the shapes that were tempting to accept but must not be.
  assert.equal(CLAUSES.d.ok({ meta: { face: {} } }), false, 'a face with no label is not a declaration');
  assert.equal(CLAUSES.d.ok({ meta: { face: true } }), false, 'face:true declares nothing');
  assert.equal(CLAUSES.d.ok({ meta: { face: false } }), true, '"deliberately no face" IS a declaration');
  assert.equal(CLAUSES.a.ok({ html: '<!--PA_CHAT_UI-->', code: 'PAChat.listDrawer({})' }), false,
    'a notes drawer is not an AI feature');
  assert.equal(CLAUSES.c.ok({ code: codeOnly('// it posted `markdown:` and broke\nok();') }), true,
    'a comment about the scar is not the scar');
});

// ── no native modals（不用原生弹窗）— the app sandbox has no allow-modals ──────────────────────
// Apps run under CSP `sandbox allow-scripts` WITHOUT allow-modals. There confirm() returns false at
// once and alert()/prompt() do nothing (prompt returns null) — no error, no dialog. Measured
// 2026-10-12: Family could never remove a member, Productivity Hub's "Reset all data" never reset,
// and a failed import or topic save said nothing at all. Not one of the four clauses — a rule of
// the sandbox, like localStorage — but just as silent, so it is scanned rather than trusted.
// A bare call, a call through window/self/globalThis/top/parent (dotted, ?. or ['…']),
// .call/.apply/.bind and the optional call confirm?.(…) all count; a method on any other object (PAChat's drawer.confirm(), its
// in-panel modal) does not. shared-apps/ is the shelf members install from, and every
// web/*.inline.html is a component inlined INTO app frames (web.mjs's marker table), so both run
// in the same sandbox and are scanned too.
const MODAL = '(?:confirm|alert|prompt)', GLOBAL = '\\b(?:window|self|globalThis|top|parent)\\s*';
const NATIVE_MODAL = new RegExp(
  `(?:^|[^.\\w$]|${GLOBAL}\\??\\.\\s*)${MODAL}(?:\\s*\\.\\s*(?:call|apply|bind))?\\s*(?:\\?\\.\\s*)?\\(`
  + `|${GLOBAL}(?:\\?\\.)?\\s*\\[\\s*['"\`]${MODAL}['"\`]\\s*\\]\\s*(?:\\?\\.\\s*)?\\(`, 'g');
const nativeModalCalls = (code) => [...code.matchAll(NATIVE_MODAL)]
  .map((m) => code.slice(m.index, m.index + m[0].length + 40).trim().split('\n')[0]);

const MODAL_SCANNED = [
  ...enumerateApps([...SOURCES, 'shared-apps']),
  ...fs.readdirSync(path.join(ROOT, 'web')).filter((f) => f.endsWith('.inline.html')).sort()
    .map((f) => ({ src: 'web', slug: f, code: codeOnly(fs.readFileSync(path.join(ROOT, 'web', f), 'utf8')) })),
];

test('no app or app-frame component calls confirm(), alert() or prompt()', () => {
  const srcs = new Set(MODAL_SCANNED.map((a) => a.src));
  for (const s of ['workspace.example/apps', 'shared-apps', 'web']) {
    assert.ok(srcs.has(s), `nothing scanned under ${s} — this test would pass by examining nothing (R14)`);
  }
  const found = MODAL_SCANNED.flatMap((a) => nativeModalCalls(a.code).map((c) => `${a.src}/${a.slug}: ${c}`));
  assert.deepEqual(found, [],
    'native modals are dead in the app sandbox. Use PATwoTap for a destructive action and the '
    + "app's own status line for a message (superelf.md, \"Reusable components\"):\n  " + found.join('\n  '));
});

test('the native-modal detector fires on real calls and ignores lookalikes', () => {
  for (const bad of ["if(!confirm('Remove?')) return;", "alert('saved')", 'x = prompt("Name")',
    "window.confirm('x')", 'self.alert(1)', 'globalThis.prompt ( "t" )', "}catch(e){alert('保存失败')}",
    "window?.confirm('x')", "window['alert']('x')", "confirm.call(window, 'x')",
    "if(!window.confirm?.('Delete?')) return;", "confirm?.('x')", "window['alert']?.('x')",
    // comment openers inside literals: a regex stripper dropped the code after each of these
    "inp.accept='image/*';\nif(!confirm('Delete?'))return; /* x */", "const u='a//b'; alert('x')",
    "s.replace(/\\/\\*/g,''); alert(1) /* c */", "h=`<i>${a?`/*`:'b'}</i>`; prompt('t') /* c */"]) {
    assert.equal(nativeModalCalls(codeOnly(bad)).length, 1, `missed: ${bad}`);
  }
  for (const ok of ["drawer.confirm('Delete?')", "PAChat.listDrawer(o).prompt('Rename')", 'armOrAct(btn)',
    'confirmDelete(id)', "const prompt = 'x'", 'opts.alert(m)', 'x?.confirm(m)', 'opts.alert?.(m)', "// if(!confirm('x')) return;",
    "/* alert() is ignored here */ go();", '<!-- prompt() -->', "a=`t`; /* confirm('x') `*/ b()"]) {
    assert.deepEqual(nativeModalCalls(codeOnly(ok)), [], `false alarm: ${ok}`);
  }
});
