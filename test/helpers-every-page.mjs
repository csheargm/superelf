// The components web.mjs puts on EVERY app page (sendAppHtml: PATwoTap, PAStore, then PALeave, ahead of
// the page's first script). test/two-tap.test.mjs, test/store.test.mjs and test/leave.test.mjs each prove their component
// reaches every committed app page, through a REAL web.mjs; the sweep and the server live here once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

// Every committed app, from the owner's apps, the templates and the shelf.
export function committedApps() {
  const out = [];
  for (const [dir, tag] of [['workspace/apps', 'ws'], ['workspace.example/apps', 'ex'], ['shared-apps', 'sh']]) {
    for (const app of fs.existsSync(path.join(ROOT, dir)) ? fs.readdirSync(path.join(ROOT, dir)) : []) {
      const f = path.join(ROOT, dir, app, 'index.html');
      if (fs.existsSync(f)) out.push({ slug: `${tag}-${app}`.slice(0, 40), html: fs.readFileSync(f, 'utf8') });
    }
  }
  assert.ok(out.length >= 10, `the sweep must find the apps, or it passes vacuously (R14): ${out.length}`);
  return out;
}

// The scripts a browser runs, in page order (a marker left in a comment runs nothing).
export const execScripts = (html) => [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]).filter((s) => s.trim());

// Pages that test what the builder does with a page's shape: a script inside <head>, a body with no
// <head> at all, and a page with no script of its own.
export const SYNTHETIC = (use) => [
  { slug: 'syn-head-script', html: `<!doctype html><html><head><script>var early = ${use};</script></head><body></body></html>` },
  { slug: 'syn-no-head', html: `<!doctype html><body><p>x</p><script>var early = ${use};</script></body>` },
  { slug: 'syn-static', html: '<!doctype html><body><p>no head end, no script</p></body>' },
];

// Serves `pages` ([{slug, html}]) as the owner's apps from a throwaway root, and hands `fn` a
// served(slug) that answers the page exactly as web.mjs builds it.
export async function withServedPages(pages, fn) {
  const port = await freePort();
  const root = mkWebRoot({ port });
  for (const { slug, html } of pages) {
    fs.mkdirSync(path.join(root, 'workspace/apps', slug), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspace/apps', slug, 'index.html'), html);
  }
  const web = startWeb(root);
  const served = async (slug) => { const r = await api(port, `/app/owner/${slug}/`); assert.equal(r.status, 200, slug); return r.text(); };
  try { await waitReady(port); await fn(served); } finally { await stopWeb(web); rmTemp(root); }
}
