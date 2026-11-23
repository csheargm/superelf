// Contract guard for the briefings reading surface (简报 in the longevity app).
//
// The shell broker and the app templates are inline <script> HTML — not
// importable as modules — so this guards the CONTRACT in the committed sources:
// the shell must relay the two briefing kinds to the autonomy API (with the id
// guarded and URL-encoded, like every other id-carrying kind), and the
// longevity template must consume exactly those kinds and reuse the shell's
// existing markdown renderer (no new renderer dependency). Syntax of these
// scripts is separately gated by test/app-scripts.test.mjs (the template is in
// workspace.example, so the parse guard picks it up automatically).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'); // throws if missing — a moved file must fail here, not pass vacuously (R14)

test('shell broker relays kind "briefings" → GET /api/briefings', () => {
  const html = readShell(ROOT);
  assert.match(html, /m\.kind==='briefings'/);
  // Through the shared failure mapper, not a bare api() call: a 401/500/network drop must
  // reach the app as its own code, never as an empty list (test/broker-relay.test.mjs).
  assert.match(html, /relayCall\('\/api\/briefings'/);
});

test('shell broker relays kind "briefing" → /api/briefings/:id with a guarded, encoded id', () => {
  const html = readShell(ROOT);
  assert.match(html, /m\.kind==='briefing'/);
  // The briefing id travels as m.briefingId — m.id is the broker's correlation
  // id, and a payload field named `id` would clobber it (Object.assign order).
  assert.match(html, /typeof m\.briefingId!=='string'/, 'non-string id must be rejected before the request');
  assert.match(html, /\/api\/briefings\/'\+encodeURIComponent\(m\.briefingId\)/, 'id must be URL-encoded like every other id-carrying kind');
});

test('longevity template: briefings section uses the broker kinds + existing renderer only', () => {
  const html = read('workspace.example/apps/longevity/index.html');
  assert.match(html, /简报 · Briefings/, 'section present');
  assert.match(html, /kind:'briefings'/, 'list via the shell broker');
  assert.match(html, /kind:'briefing',briefingId:/, 'detail via the shell broker (briefingId, never a clobbering `id`)');
  assert.match(html, /kind:'render-md'/, 'body rendered by the shell\'s existing markdown renderer');
  assert.match(html, /暂无简报 · No briefings yet/, 'bilingual empty state');
  assert.ok(!/<script[^>]+src=/.test(html), 'sandbox CSP forbids external scripts — no renderer dependency may be added');
});

test('live-instance parity: the workspace copy carries the same briefings section', () => {
  // The owner's live instance is gitignored personal data; when present it must
  // carry the identical section so template and instance don't drift.
  const live = path.join(ROOT, 'workspace', 'apps', 'longevity', 'index.html');
  if (!fs.existsSync(live)) return; // fresh checkout: no instance — template-only is correct
  const html = fs.readFileSync(live, 'utf8');
  for (const marker of ["kind:'briefings'", "kind:'briefing',briefingId:", '暂无简报 · No briefings yet']) {
    assert.ok(html.includes(marker), `live longevity app missing: ${marker}`);
  }
});
