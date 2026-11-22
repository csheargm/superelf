// A stub Supabase for the demo-mode suites · 演示模式测试用的 Supabase 桩
// Signs ES256 access tokens and serves their JWKS; records every other request (otp, logout) so a
// browser suite can prove the client called them. Used by demo-account-ui-e2e. TODO: demo-signin.test.mjs keeps its own copy; move it here in a test-only refactor (R8).
import crypto from 'node:crypto';
import http from 'node:http';

export const KID = 'test-kid';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));

export async function startStubSupabase() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' };
  const calls = [];
  const srv = await listen(http.createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ keys: [jwk] })); }
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || '' });
    // CORS: the shell (another origin) calls /auth/v1/* from the browser.
    res.writeHead(req.url.startsWith('/auth/v1/') ? 200 : 404, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' });
    res.end('{}');
  }));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const iss = `${url}/auth/v1`;
  function jwt(claims = {}, { key = privateKey, kid = KID, alg = 'ES256' } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg, kid, typ: 'JWT' });
    const body = b64({ sub: 'user-a', aud: 'authenticated', iss, iat: now, exp: now + 3600, ...claims });
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${head}.${body}.${sig}`;
  }
  return { srv, url, iss, jwt, calls };
}
