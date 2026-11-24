// A local fake of the GitHub REST endpoints Publish uses (lib/publish/github.mjs). It ENFORCES the
// real API's guards the client must survive (memory: test harness fidelity): 401 "Bad credentials"
// on a wrong token, 422 "Reference already exists", 404 on an unknown object, 405 "Pull Request is
// not mergeable" while checks are not green or when told so, 409 "Head branch was modified" on a
// stale sha. It records every request (minus the auth header) for assertions.
import http from 'node:http';
import crypto from 'node:crypto';
import { REQUIRED_CHECKS } from '../lib/publish/github.mjs';

export const FAKE_TOKEN = 'fake-publish-token-not-real-0000';

export function startFakeGitHub({ token = FAKE_TOKEN, repo = 'csheargm/superelf', versions = {}, onMerge } = {}) {
  const st = { checks: 'success', mergeable: true, blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(), pulls: [], requests: [], authSeen: [] };
  const main = crypto.randomBytes(20).toString('hex');
  st.commits.set(main, { tree: { sha: 'basetree' }, parents: [] });
  st.refs.set('refs/heads/main', main);
  const versionsB64 = Buffer.from(JSON.stringify(versions)).toString('base64');
  const id = () => crypto.randomBytes(20).toString('hex');
  const pre = `/repos/${repo}`;
  const routes = [
    ['GET', /^\/git\/ref\/heads\/(.+)$/, (m) => (st.refs.has(`refs/heads/${m[1]}`) ? [200, { object: { sha: st.refs.get(`refs/heads/${m[1]}`) } }] : [404, { message: 'Not Found' }])],
    ['GET', /^\/git\/commits\/([0-9a-f]+)$/, (m) => (st.commits.has(m[1]) ? [200, st.commits.get(m[1])] : [404, { message: 'Not Found' }])],
    ['GET', /^\/contents\/lib\/builtin-app-versions\.json$/, () => [200, { content: versionsB64, encoding: 'base64' }]],
    ['POST', /^\/git\/blobs$/, (m, b) => { if (b.encoding !== 'base64') return [422, { message: 'Invalid encoding' }]; const s = id(); st.blobs.set(s, Buffer.from(b.content, 'base64')); return [201, { sha: s }]; }],
    ['POST', /^\/git\/trees$/, (m, b) => { if (!Array.isArray(b.tree) || b.tree.some((t) => !st.blobs.has(t.sha))) return [422, { message: 'tree.sha is not a valid blob' }]; const s = id(); st.trees.set(s, b); return [201, { sha: s }]; }],
    ['POST', /^\/git\/commits$/, (m, b) => { if (!st.trees.has(b.tree) || (b.parents || []).some((p) => !st.commits.has(p))) return [422, { message: 'Tree SHA does not exist' }]; const s = id(); st.commits.set(s, { ...b, tree: { sha: b.tree } }); return [201, { sha: s }]; }],
    ['POST', /^\/git\/refs$/, (m, b) => { if (st.refs.has(b.ref)) return [422, { message: 'Reference already exists' }]; if (!st.commits.has(b.sha)) return [422, { message: 'Object does not exist' }]; st.refs.set(b.ref, b.sha); return [201, { ref: b.ref }]; }],
    ['POST', /^\/pulls$/, (m, b) => { if (!st.refs.has(`refs/heads/${b.head}`)) return [422, { message: 'Validation Failed' }]; const n = st.pulls.length + 1; const pr = { number: n, ...b, headSha: st.refs.get(`refs/heads/${b.head}`), html_url: `https://github.com/${repo}/pull/${n}` }; st.pulls.push(pr); return [201, pr]; }],
    ['GET', /^\/commits\/([0-9a-f]+)\/check-runs$/, () => [200, st.checks === 'none' ? { total_count: 0, check_runs: [] }
      : st.checks === 'early-only' ? { total_count: 1, check_runs: [{ name: 'early', status: 'completed', conclusion: 'success' }] }
      : { total_count: 2, check_runs: REQUIRED_CHECKS.map((name) => ({ name, status: st.checks === 'pending' ? 'in_progress' : 'completed', conclusion: st.checks === 'pending' ? null : st.checks })) }]],
    ['PUT', /^\/pulls\/(\d+)\/merge$/, (m, b) => {
      const pr = st.pulls[Number(m[1]) - 1];
      if (!pr) return [404, { message: 'Not Found' }];
      if (st.checks !== 'success' || !st.mergeable) return [405, { message: 'Pull Request is not mergeable' }];
      if (b.sha && b.sha !== pr.headSha) return [409, { message: 'Head branch was modified. Review and try the merge again.' }];
      pr.merged = true; pr.mergeTitle = b.commit_title; pr.method = b.merge_method;
      if (onMerge) onMerge(pr, st);
      return [200, { merged: true, sha: id() }];
    }],
  ];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      st.authSeen.push(req.headers.authorization || '');
      const body = raw ? JSON.parse(raw) : {};
      st.requests.push({ method: req.method, path: u.pathname, body });
      const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
      if (!u.pathname.startsWith(pre)) return reply(404, { message: 'Not Found' });
      const p = u.pathname.slice(pre.length);
      for (const [meth, re, fn] of routes) { const m = req.method === meth && p.match(re); if (m) return reply(...fn(m, body)); }
      return reply(404, { message: 'Not Found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)),
    files: (pr) => { const t = st.trees.get(st.commits.get(pr.headSha).tree.sha); return Object.fromEntries(t.tree.map((e) => [e.path, st.blobs.get(e.sha)])); } })));
}
