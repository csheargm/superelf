// Parse-guard for the inline <script> in every HTML page the app serves.
//
// Scar: one missing `}` in an app's inline script white-screened the whole Bible app —
// a single syntax error kills the entire <script>, so nothing initialised (empty UI,
// stuck on "Loading…"). Nothing gated it. This test parses every committed app
// template and the shell/shared HTML so that class of bug fails `npm test` instead of
// shipping. (R6: guard the real failure, not just a function contract.)
//
// Scope note: this covers COMMITTED files only. Per-user app INSTANCES under
// workspace/<user>/apps/** are gitignored and cannot be tested here — the Bible bug
// actually lived in an instance. The template gate is still the right guard: templates
// are what ship to new users and what any instance feature must eventually land in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Executable <script> bodies, AFTER stripping HTML comments — a <script> shown as a
// usage example inside <!-- ... --> (e.g. the chat-ui component's doc header, or the
// <!--PA_CHAT_UI--> marker) is documentation, not code, and must not be parsed.
function scriptBlocks(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const m of noComments.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1].trim()) out.push(m[1]);
  }
  return out;
}

// Every committed HTML page whose inline script runs in a browser: each app template,
// plus the shell and the shared chat component (a syntax error in either white-screens
// the whole shell, exactly like the app case).
function targets() {
  const appsDir = path.join(ROOT, 'workspace.example', 'apps');
  const apps = fs.existsSync(appsDir)
    ? fs.readdirSync(appsDir)
        .map((d) => path.join('workspace.example', 'apps', d, 'index.html'))
        .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
    : [];
  // DERIVED, not listed: every web/*.inline.html is a shared component whose syntax error
  // white-screens each app that inlines it. This list used to be hardcoded, which meant a new
  // component simply was not checked and nothing failed to say so — omission has to be
  // impossible here, not merely unlikely.
  const components = fs.readdirSync(path.join(ROOT, 'web'))
    .filter((f) => f.endsWith('.inline.html'))
    .map((f) => path.join('web', f))
    .sort();
  return [...apps, 'web/index.html', ...components]
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
}

const FILES = targets();

// R14: a glob that matched nothing would make every assertion below vacuously pass and
// hide a broken/misconfigured guard. Fail loudly if the target set is empty.
test('parse-guard actually found HTML pages to check — including EVERY shared component', () => {
  assert.ok(FILES.length >= 3, `expected the app templates + shell to be found, got ${FILES.length}: ${FILES.join(', ')}`);
  // The floor above only proves the glob ran. This proves the component half is COMPLETE: a
  // new web/*.inline.html the target builder missed fails here BY NAME, instead of quietly
  // never being parse-checked — which is how a third component would otherwise ship unchecked.
  const onDisk = fs.readdirSync(path.join(ROOT, 'web')).filter((f) => f.endsWith('.inline.html')).sort();
  assert.ok(onDisk.length >= 3, `expected at least the chat/note/split components, found ${onDisk.length}: ${onDisk.join(', ')}`);
  for (const f of onDisk) {
    assert.ok(FILES.includes(path.join('web', f)), `shared component web/${f} is not being parse-checked`);
  }
});

for (const rel of FILES) {
  test(`inline scripts parse: ${rel}`, () => {
    const blocks = scriptBlocks(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    // Each of these pages carries exactly one real inline script; zero means the
    // extractor (or the file) is broken — treat it as a failure, not a silent pass.
    assert.ok(blocks.length >= 1, `${rel}: expected at least one inline <script> block, found none`);
    blocks.forEach((body, i) => {
      // new Function parses `body` as a classic-script function body (same grammar the
      // browser applies to an inline <script>) without executing it — a missing brace,
      // stray comma, etc. throws a SyntaxError here.
      try {
        new Function(body);
      } catch (err) {
        assert.fail(`${rel} <script> #${i} has a syntax error → the whole script would fail to run: ${err.message}`);
      }
    });
  });
}
