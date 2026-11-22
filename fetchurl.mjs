#!/usr/bin/env node
// Fetch a web page and print readable text — a reliable alternative to the
// model's built-in web fetch. Usage: node fetchurl.mjs <url>
// SSRF-guarded: refuses non-http(s) and any host that resolves to a private range.
import dns from 'node:dns/promises';
import net from 'node:net';

const url = process.argv[2];
if (!url) { console.error('usage: node fetchurl.mjs <url>'); process.exit(1); }

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l === '::';
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

try {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https URLs are allowed');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivate(a.address))) throw new Error('refusing to fetch a private/internal address');
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (superelf fetchurl)', 'accept': 'text/html,application/xhtml+xml,text/plain,*/*' },
    signal: AbortSignal.timeout(20000),
  });
  const ct = res.headers.get('content-type') || '';
  let body = await res.text();
  if (body.length > 400_000) body = body.slice(0, 400_000); // cap
  const text = /html/i.test(ct) ? htmlToText(body) : body;
  console.log(`# ${url}\n# HTTP ${res.status} · ${ct.split(';')[0]} · ${text.length} chars\n`);
  console.log(text.slice(0, 100_000)); // ~100k chars is plenty for summarizing
} catch (e) {
  console.error(`fetch failed: ${e.message}`);
  process.exit(1);
}
