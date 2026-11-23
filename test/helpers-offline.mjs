// Shared by test/offline-queue.test.mjs, test/offline-sync.test.mjs and test/offline-origin.test.mjs
// (R3: one fake store, one stand-in node).
import assert from 'node:assert/strict';
import http from 'node:http';

// ── An in-memory IndexedDB: open → upgrade → db; transaction(store).objectStore(store) → requests
// that settle on a microtask, as the browser's do. `quota` makes every write fail like a full disk.
export function fakeIndexedDB() {
  const dbs = new Map();
  const state = { quota: false, ops: [] };
  const request = (work) => {
    const r = { onsuccess: null, onerror: null, result: undefined, error: null };
    Promise.resolve().then(() => {
      try { r.result = work(); r.onsuccess && r.onsuccess(); }
      catch (e) { r.error = e; r.onerror && r.onerror(); }
    });
    return r;
  };
  const quotaErr = () => Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
  const storeApi = (st, name) => ({
    get: (k) => request(() => { state.ops.push(['get', name, k]); return st.rows.get(k); }),
    put: (v) => request(() => { if (state.quota) throw quotaErr(); const k = st.auto ? (v[st.keyPath] ?? ++st.seq) : v[st.keyPath]; st.rows.set(k, { ...v, [st.keyPath]: k }); state.ops.push(['put', name, k]); return k; }),
    add: (v) => request(() => { if (state.quota) throw quotaErr(); const k = st.auto ? ++st.seq : v[st.keyPath]; if (st.rows.has(k)) throw Object.assign(new Error('ConstraintError'), { name: 'ConstraintError' }); st.rows.set(k, { ...v, [st.keyPath]: k }); state.ops.push(['add', name, k]); return k; }),
    delete: (k) => request(() => { st.rows.delete(k); state.ops.push(['del', name, k]); }),
    getAll: () => request(() => [...st.rows.values()]),
    count: () => request(() => st.rows.size),
  });
  const idb = { open: (name, version) => {
    const r = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null };
    Promise.resolve().then(() => {
      let db = dbs.get(name);
      const fresh = !db;
      if (fresh) {
        db = { stores: new Map(), version,
          objectStoreNames: { contains: (n) => db.stores.has(n) },
          createObjectStore: (n, { keyPath, autoIncrement = false } = {}) => { db.stores.set(n, { rows: new Map(), keyPath, auto: autoIncrement, seq: 0 }); },
          transaction: (n, mode) => ({ mode, objectStore: (s) => { assert.equal(s, n); assert.ok(db.stores.has(s), `store ${s} exists`); return storeApi(db.stores.get(s), s); } }) };
        dbs.set(name, db);
      }
      r.result = db;
      if (fresh && r.onupgradeneeded) r.onupgradeneeded();
      r.onsuccess && r.onsuccess();
    });
    return r;
  } };
  return { idb, state, rows: (name, store) => (dbs.has(name) ? [...dbs.get(name).stores.get(store).rows.values()] : []) };
}

// The state line as PAOffline renders it: textContent and the `on` class.
export const lineStub = () => { const cls = new Set(); return { textContent: '', dataset: {}, onclick: null, classList: { toggle: (c, on) => { on ? cls.add(c) : cls.delete(c); }, add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) } }; };

// Let the broker's promise chains run (the relay, the store, the drain) without a real timer.
export const settle = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// A stand-in node over real HTTP: /api/build (its `build`), GET /api/data/<path> from `files`,
// POST /api/save-data into `files` (a path ending fail.json answers 500). `auth` is the last
// Authorization header seen; `posts` the saved paths in order.
export function standInNode(files, { build = 'b1' } = {}) {
  const posts = [];
  const node = { files, posts, auth: '' };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      node.auth = req.headers.authorization || '';
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/build') return json(200, { build, version: 'v1 · ' + build });
      if (req.url === '/api/save-data') { const b = JSON.parse(body); posts.push(b.path); if (b.path.endsWith('fail.json')) return json(500, { ok: false, error: '保存失败 · save failed', code: 'write_failed' }); files.set(b.path, b.data); return json(200, { ok: true, bytes: b.data.length }); }
      if (req.url.startsWith('/api/data/')) { const t = files.get(decodeURIComponent(req.url.slice('/api/data/'.length))); if (t == null) return json(404, { error: 'not found' }); res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(t); }
      json(404, { error: 'nf' });
    });
  });
  const listen = (port = 0) => new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv.address().port)));
  return Object.assign(node, { srv, listen, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(() => r())); } });
}
