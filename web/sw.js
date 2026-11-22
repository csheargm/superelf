/* ══ PA_SW_BEGIN ══ */
// The service worker — the offline app bundle（离线应用包）, docs/plans/offline-first.md §1.
// Served by web.mjs at /sw.js with scope /. test/offline-sw.test.mjs runs this file in a harness.
//
// It stores what the page just loaded, in ONE cache named pa-<build>, and answers from it only
// when the network fails. It never decides a version: the shell posts {kind:'pa-bundle', build}
// after every load (web/sw-client.js), naming the build it loaded with (the footer, ADR 0026 §2),
// and that message is what creates the new cache and deletes the old ones. PAUpdate stays the one
// updater; this worker never calls skipWaiting on its own schedule (the shell asks, after the
// hand-off). Never cache-first for HTML (ADR 0026 §5): a stale shell served while online is the
// scar that rule exists for. The Bible corpus is immutable, so chapters are cache-first and
// refilled when the build changes (the cache is per build).
const CACHE_PREFIX='pa-';
const BIBLE_PATH='/api/bible';
const PROBE_PATH='/pa-sw-probe';          // == lib/offline.mjs SW_PROBE_PATH (test/offline-sw.test.mjs pins both)
const BUNDLE_KIND='pa-bundle';            // == lib/offline.mjs PA_BUNDLE_KIND
const PROBE_KIND='pa-sw-probe';           // == lib/offline.mjs PA_SW_PROBE_KIND
const BIBLE_STATUS_KIND='pa-bible-status';
const BIBLE_DONE_KIND='pa-bible-done';
const SKIP_KIND='pa-skip';
const BIBLE_DONE_PATH='/__pa/bible-done'; // a synthetic entry: the corpus for this build is complete
const SHELL_URLS=['/','/manifest.webmanifest'];   // what a cold open needs before any app page
const OFFLINE_HTML='<!doctype html><meta charset="utf-8"><p style="font:15px system-ui;padding:24px">Offline · 离线 — this page is not saved on this device yet · 此页尚未保存在本机</p>';
const PROBE_CSP="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'";
let build='';   // told by the shell; after a worker restart the one cache left names it (currentCache)

const cacheName=(b)=>CACHE_PREFIX+b;
const paCaches=async()=>(await caches.keys()).filter((n)=>n.startsWith(CACHE_PREFIX));
async function currentCache(){
  if(!build){ const names=await paCaches(); if(names.length) build=names[names.length-1].slice(CACHE_PREFIX.length); }
  return build?caches.open(cacheName(build)):null;
}
const inBundle=(u)=>u.pathname==='/'||u.pathname==='/index.html'||u.pathname==='/manifest.webmanifest'||u.pathname.startsWith('/app/');
const abs=(p)=>self.location.origin+p;

// The newest pa-* cache that holds the URL: the current one first, then any left (a shell that
// loaded offline before the bundle message arrived still finds its pages).
async function fromAnyCache(url){
  const cur=await currentCache();
  const hit=cur&&await cur.match(url,{ignoreVary:true});
  if(hit) return hit;
  for(const n of (await paCaches()).reverse()){ const h=await (await caches.open(n)).match(url,{ignoreVary:true}); if(h) return h; }
  return null;
}
const offlineResponse=()=>new Response(OFFLINE_HTML,{status:503,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});

// Network-first; stored on a 200; the cache answers ONLY when the network failed (a thrown fetch),
// or on a 304 the worker itself received (the browser's own conditional request, answered by us).
async function bundleFetch(req){
  let res;
  try{ res=await fetch(req); }
  catch(err){ return (await fromAnyCache(req.url))||offlineResponse(); }
  if(res.status===200){ const c=await currentCache(); if(c) await c.put(req.url,res.clone()); }
  else if(res.status===304){ const hit=await fromAnyCache(req.url); if(hit) return hit; }
  return res;
}
// Cache-first: the corpus never changes within a build. A miss goes to the network and is stored
// on a 200; a network failure rejects as today (the broker's relay reports code:'network').
async function bibleFetch(req){
  const c=await currentCache();
  const hit=c&&await c.match(req.url,{ignoreVary:true});
  if(hit) return hit;
  const res=await fetch(req);
  if(res.status===200&&c) await c.put(req.url,res.clone());
  return res;
}
// The feature probe (web/sw-client.js): a sandboxed iframe navigates here. Only this worker
// answers (the node 404s the path), and the page it gets tells the shell it arrived.
const probeResponse=()=>new Response('<!doctype html><script>parent.postMessage({pa:\''+PROBE_KIND+'\'},\'*\')</script>',
  {status:200,headers:{'content-type':'text/html; charset=utf-8','content-security-policy':PROBE_CSP,'cache-control':'no-store'}});

self.addEventListener('fetch',(e)=>{
  const req=e.request;
  if(req.method!=='GET'||req.cache==='no-store') return;   // the hard rule: PAUpdate's question is never answered from a cache, and never stored
  const u=new URL(req.url);
  if(u.origin!==self.location.origin) return;
  if(u.pathname===PROBE_PATH) e.respondWith(probeResponse());
  else if(u.pathname===BIBLE_PATH) e.respondWith(bibleFetch(req));
  else if(inBundle(u)) e.respondWith(bundleFetch(req));
  // every other /api/* and anything else: untouched (never cached — conversations, notes, uploads)
});

const tell=(client,m)=>{ if(client&&typeof client.postMessage==='function') client.postMessage(m); };
// The shell loaded with <build>: that cache becomes the bundle, filled with the shell itself (the
// page that registered us was not loaded through us), and every other pa-* cache goes.
async function adoptBuild(b,client){
  build=b;
  const name=cacheName(b);
  const c=await caches.open(name);
  let error='';
  try{ await c.addAll(SHELL_URLS); }
  catch(err){ error=String(err&&err.message||err); }   // offline with the same build: the cache already holds the shell; reported, never swallowed (R5)
  for(const n of await paCaches()) if(n!==name) await caches.delete(n);
  tell(client,{kind:BUNDLE_KIND,ok:!error,build:b,error});
}
async function bibleStatus(client){
  const c=await currentCache();
  const done=!!(c&&await c.match(abs(BIBLE_DONE_PATH)));
  tell(client,{kind:BIBLE_STATUS_KIND,done,build});
}
async function markBibleDone(bytes){
  const c=await currentCache();
  if(c) await c.put(abs(BIBLE_DONE_PATH),new Response(JSON.stringify({bytes:Number(bytes)||0,at:Date.now()}),{headers:{'content-type':'application/json'}}));
}
self.addEventListener('message',(e)=>{
  const m=e.data||{};
  if(m.kind===BUNDLE_KIND&&typeof m.build==='string'&&m.build) e.waitUntil(adoptBuild(m.build,e.source));
  else if(m.kind===BIBLE_STATUS_KIND) e.waitUntil(bibleStatus(e.source));
  else if(m.kind===BIBLE_DONE_KIND) e.waitUntil(markBibleDone(m.bytes));
  else if(m.kind===SKIP_KIND) e.waitUntil(self.skipWaiting());   // the shell's decision, after its own hand-off — never ours
});
self.addEventListener('activate',(e)=>e.waitUntil(self.clients.claim()));
/* ══ PA_SW_END ══ */
