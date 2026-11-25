// Built app pages are cached · 应用页面构建缓存
//
// An app page is a pure function of the app file and the component files, and those change only
// when something on disk does — but every request rebuilt it: a readFileSync per component,
// ~500KB of string splicing, a SHA-1 over all of it for the ETag and a ~10ms gzip. Measured at
// 17.4ms per request, including requests that end in a 304 and send no body at all.
//
// The risk a cache brings is serving something stale, so what is pinned here is the KEY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';

const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');

test('the key is every input, by mtime AND size', () => {
  const fn = /function appStamp\(file\) \{[\s\S]*?\n\}/.exec(WEB);
  assert.ok(fn, 'appStamp must be findable');
  assert.match(fn[0], /st\.mtimeMs \+ ':' \+ st\.size/, 'the app file, both facts');
  assert.match(fn[0], /for \(const c of \[\.\.\.PA_COMPONENTS, \{ file: PA_THEME_FILE \}, \{ file: PA_REPLY_CLEAN_FILE \}\]\)/, 'and every component, plus the shared theme tokens and the reply cleaner');
  // mtime alone misses two writes inside one millisecond, which a script editing several
  // components does routinely. Size alone misses a same-length edit — the exact hole that made
  // the save-skip guard drop cropped photos.
  assert.equal((fn[0].match(/st\.size/g) || []).length, 2, 'size is part of both halves of the key');
});

test('an unreadable input disables the cache rather than guessing', () => {
  const fn = /function appStamp\(file\) \{[\s\S]*?\n\}/.exec(WEB)[0];
  assert.equal((fn.match(/return null;/g) || []).length, 2, 'a failed stat on either side returns null');
  assert.match(WEB, /const hit = stamp && APP_CACHE\.get\(file\);/, 'and no stamp means no hit');
});

test('a page is cached only after it has been built', () => {
  // Caching before the build would remember a failure as a success, and it would be served until
  // a file changed.
  const i = WEB.indexOf('const entry = stamp ?');
  const j = WEB.indexOf('APP_CACHE.set(file, entry)');
  assert.ok(i > 0 && j > i, 'the entry is constructed, then stored');
  assert.ok(WEB.indexOf("html = html.split(c.marker).join(snippet)") < i, 'after the inlining loop');
});

test('the cached entry carries what the request would otherwise recompute', () => {
  assert.match(WEB, /\{ stamp, html, etag: etagOf\(html\), gz: zlib\.gzipSync/, 'html, ETag and gzip');
  assert.match(WEB, /const etagOf = \(html\) =>/, 'the ETag is computed by one named function');
});

test('passing no cache behaves exactly as before', () => {
  // Every other caller of sendHtml is unchanged, which is what makes this safe to land.
  assert.match(WEB, /function sendHtml\(res, html, extra = \{\}, cached = null\)/, 'the parameter is optional');
  assert.match(WEB, /const etag = \(cached && cached\.etag\) \|\| etagOf\(html\);/, 'and falls back to computing it');
  assert.match(WEB, /if \(cached && cached\.gz && \/\\bgzip\\b\/\.test\(res\._paAccept \|\| ''\)\)/,
    'the precompressed body is used only when the client asked for gzip');
});

test('a gzipped cached response still varies on accept-encoding', () => {
  // Without Vary a shared cache can hand a gzipped body to a client that never asked for one.
  const branch = /if \(cached && cached\.gz[\s\S]*?return res\.end\(cached\.gz\);/.exec(WEB);
  assert.ok(branch, 'the cached-gzip branch must be findable');
  assert.match(branch[0], /vary: 'accept-encoding'/, 'Vary is set');
  assert.match(branch[0], /'x-content-type-options': 'nosniff'/, 'and the security headers are not lost');
});
