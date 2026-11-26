// 分享邮件 · The share email, its prefill token and one-tap-one-email (lib/app-share-mail.mjs; flows: app-share-signin-e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealPrefill, openPrefill, PREFILL_TTL_MS, SHARE_EMAIL, cleanNote, makeSendOnce, NOTE_MAX } from '../lib/app-share-mail.mjs';
import { handleOwnerShareRoute } from '../lib/app-share-routes.mjs';

const SECRET = 's'.repeat(64), TO = 'friend@example.com';

test('prefill token: round-trips, hides the address, rejects forgery, other secrets and expiry', () => {
  const t0 = 1_800_000_000_000, k = sealPrefill(SECRET, TO, t0);
  assert.match(k, /^[A-Za-z0-9_-]+$/);
  assert.ok(!Buffer.from(k, 'base64url').toString('latin1').includes('friend'), 'no readable address in the token');
  assert.ok(!k.includes('friend') && !k.includes('example'));
  assert.equal(openPrefill(SECRET, k, t0 + 1000), TO);
  assert.equal(openPrefill(SECRET, k, t0 + PREFILL_TTL_MS + 1), '', 'expired');
  assert.equal(openPrefill('t'.repeat(64), k, t0), '', 'another secret');
  const bad = k.slice(0, -2) + (k.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(openPrefill(SECRET, bad, t0), '', 'tampered');
  for (const junk of ['', 'x', '../../etc', 'a'.repeat(700), null]) assert.equal(openPrefill(SECRET, junk, t0), '');
  assert.equal(sealPrefill('', TO), '', 'no secret, no token');
  assert.notEqual(sealPrefill(SECRET, TO, t0), k, 'a fresh IV each time');
});

test('the email is minimal: no sender, no "someone shared", note above the link, no emoji', () => {
  const url = 'https://try.example.com/s/AAAAAAAAAAAAAAAAAAAAAA?k=abc';
  assert.equal(SHARE_EMAIL.subject('Hello Card'), '「Hello Card」应用链接 · Your link to the Hello Card app');
  assert.equal(SHARE_EMAIL.text(url, ''), `点开即可使用 · Tap to open:\n${url}\n`);
  const t = SHARE_EMAIL.text(url, 'See you Friday');
  assert.ok(t.indexOf('See you Friday') < t.indexOf(url));
  for (const s of [t, SHARE_EMAIL.html(url, 'x')]) { assert.ok(!/someone|有人|分享给你/i.test(s)); assert.ok(!/\p{Extended_Pictographic}/u.test(s)); }
  const h = SHARE_EMAIL.html(url, '<b>hi</b>');
  assert.ok(h.includes('&#60;b&#62;hi') && !h.includes('<b>hi'), 'the note is escaped');
  assert.ok(h.includes(`href="${url.replace(/&/g, '&#38;')}"`));
  assert.equal([...cleanNote('x'.repeat(NOTE_MAX + 50))].length, NOTE_MAX);
  assert.equal(cleanNote(5), '');
});

test('sendOnce: one key = one send, even while in flight; a failure frees the key', async () => {
  const once = makeSendOnce();
  let n = 0, release;
  const slow = () => new Promise((r) => { n++; release = () => r({ ok: true }); });
  const a = once('k1', slow), b = once('k1', slow);
  await new Promise((r) => setImmediate(r)); release();
  assert.deepEqual(await a, { ok: true }); assert.deepEqual(await b, { ok: true, again: true });
  assert.equal(n, 1);
  await assert.rejects(once('k2', () => { n++; throw new Error('boom'); }));
  assert.deepEqual(await once('k2', () => { n++; return { ok: true }; }), { ok: true });
  assert.equal(n, 3);
  let t = 0; const timed = makeSendOnce(() => t);
  await timed('k', () => ({ ok: true })); t = 11 * 60 * 1000;
  assert.deepEqual(await timed('k', () => ({ ok: true, second: true })), { ok: true, second: true }, 'an old key is forgotten');
});

function ownerCtx(sent, delay = 0) {
  return { user: { id: 'owner', role: 'owner' }, cfg: { share_ingest_secret: SECRET, shares: { demo_url: 'https://try.example.com' } }, demo: false, audit: () => {},
    send: (res, code, type, body) => { res.code = code; res.body = JSON.parse(body); },
    mail: { sendEmail: async (m) => { await new Promise((r) => setTimeout(r, delay)); sent.push(m); return { message_id: 'm' }; } } };
}
const post = (ctx, body) => { const res = {}; return handleOwnerShareRoute({ method: 'POST' }, res, '/api/share/email', { ...ctx, readBody: async () => body }).then(() => res); };

test('POST /api/share/email: a double send with one key sends one email; the link prefills, never names the address', async () => {
  const sent = [], ctx = ownerCtx(sent, 30);
  const body = { id: 'AAAAAAAAAAAAAAAAAAAAAA', to: TO, name: 'Hello Card', key: 'key-0123456789', note: 'Hi' };
  const [r1, r2] = await Promise.all([post(ctx, body), post(ctx, body)]);
  assert.equal(r1.code, 200); assert.equal(r2.code, 200);
  assert.equal(sent.length, 1, 'one email');
  const m = sent[0];
  assert.equal(m.to, TO); assert.equal(m.subject, SHARE_EMAIL.subject('Hello Card'));
  const url = m.text.match(/https:\S+/)[0];
  assert.ok(!url.includes('friend') && !url.includes('%40'), 'no address in the URL');
  assert.equal(openPrefill(SECRET, new URL(url).searchParams.get('k')), TO);
  assert.ok(m.text.startsWith('Hi\n\n')); assert.ok(m.html.includes(url));
  await post(ctx, { ...body, key: 'key-other-0001' });
  assert.equal(sent.length, 2, 'a new key is a new email');
  assert.equal((await post(ctx, { ...body, key: '' })).code, 400, 'a key is required');
});

test('sendOnce: a key still in flight past the TTL is never sent twice', async () => {
  let t = 0, n = 0, release; const once = makeSendOnce(() => t);
  const a = once('k', () => new Promise((r) => { n++; release = r; }));
  await new Promise((r) => setImmediate(r));
  t = 11 * 60 * 1000;
  const b = once('k', () => { n++; return { ok: true }; });
  release({ ok: true });
  await a; assert.deepEqual(await b, { ok: true, again: true });
  assert.equal(n, 1);
});
