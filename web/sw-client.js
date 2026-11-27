/* ══ PA_SW_CLIENT_BEGIN ══ */
// PASW — the shell's side of the offline app bundle（离线应用包）, docs/plans/offline-first.md §1/§8.
// Registers web/sw.js, hands it the build this page loaded with ({kind:'pa-bundle'}, after every
// load — the ONE thing that names a cache), prefetches the app pages and the Bible corpus in the
// background once online, and loads the app iframe by the route the worker can serve: `src` as
// always, or `srcdoc` (the shell fetches the page through the worker and hands it to the frame)
// when a probe shows the worker does not see the sandboxed iframe's navigation (iPadOS risk, §1).
// The frame's URL then lives in data-app, which frameRef() (web/index.html) reads before src.
// Timers and the DOM come in through deps, so test/offline-sw.test.mjs runs makeSwClient on fakes.
const SW_URL='/sw.js';
const SW_PROBE_URL='/pa-sw-probe';           // answered only by the worker (web/sw.js PROBE_PATH)
const SW_PROBE_MS=3000;                      // no probe page by then: the worker does not serve iframe navigations here
const SW_REPLY_MS=3000;                      // a worker that does not answer by then is treated as silent (fail closed: nothing assumed)
const SW_BUNDLE_KIND='pa-bundle';
const SW_PROBE_KIND='pa-sw-probe';
const SW_BIBLE_STATUS_KIND='pa-bible-status';
const SW_BIBLE_DONE_KIND='pa-bible-done';
const SW_SKIP_KIND='pa-skip';
const SW_OFFLINE_CONFIG_URL='/api/offline-config';   // lib/offline.mjs OFFLINE_CONFIG_PATH: read at every prefetch, never hard-coded
const SW_ROUTE_SRC='src', SW_ROUTE_SRCDOC='srcdoc';
const SW_UID_KEY='pa_uid';                   // localStorage: who signed in last, for a boot with no node (ensureToken)
const SW_APPS_KEY='pa_apps';                 // localStorage: the app list from the last online load (loadApps)
const SW_FAMILY_KEY='pa_family';             // localStorage: {uid, name, apps} — the header name and Family Apps from the last online load (F5-7)
const SW_OPEN_FAILED_TXT='无法打开 · Could not open';
const swAppUrl=(uid,slug)=>`/app/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}/`;
// The build id inside the footer line '<app name> · v<semver>+N · <build>' (web/update.js reads the same line).
const swBuildOf=(footer)=>{ const m=String(footer||'').match(/\bv\d[^ ]* · (.+)$/); return m?m[1].trim():''; };
const swBibleUrl=(b,c)=>'/api/bible?book='+b+'&chapter='+c;   // the broker's own chapter URL (web/index.html kind 'bible')
const swEsc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// deps: sw → navigator.serviceWorker or null; loaded() → the footer line; frame() → #fr;
// fetchText(url) → the HTML (any status, so the worker's offline page shows in the frame) or throws;
// fetchJson(url) → parsed JSON (authenticated) or throws; fetchBytes(url) → byte count or throws;
// probeFrame(url) → {remove()} a hidden sandboxed iframe; onMessage(fn) → unsubscribe;
// storage → localStorage or null; setTimeout/clearTimeout; metered() → true on Save-Data / cellular;
// idle() → resolves when the page is idle; now() → ms (optional, tests).
// The feature probe: does the worker serve a sandboxed iframe's navigation? A hidden frame
// navigates to the URL only the worker answers; its page posts back. Silence by the deadline →
// the srcdoc route. Resolves with the route.
function swProbe(d){
  return new Promise((resolve)=>{
    let done=false, off=()=>{}, fr=null;
    const settle=(served)=>{ if(done) return; done=true; d.clearTimeout(t); off(); if(fr) fr.remove(); resolve(served?SW_ROUTE_SRC:SW_ROUTE_SRCDOC); };
    const t=d.setTimeout(()=>settle(false),SW_PROBE_MS);
    off=d.onMessage((m)=>{ if(m&&m.pa===SW_PROBE_KIND) settle(true); });
    fr=d.probeFrame(SW_PROBE_URL);
  });
}
// openApp's one call: the frame takes the app by the route the probe chose. data-app names the
// page at once (frameSlug reads it), the HTML follows; a frame reused for another app meanwhile
// is left to that app.
function swFrameLoad(d,route,uid,slug){
  const url=swAppUrl(uid,slug), fr=d.frame();
  if(route!==SW_ROUTE_SRCDOC){ fr.removeAttribute('srcdoc'); fr.removeAttribute('data-app'); d.loadSrc(fr,url); return url; }
  fr.removeAttribute('src'); fr.setAttribute('data-app',url);
  d.fetchText(url).then((html)=>{ if(fr.getAttribute('data-app')===url) d.loadDoc(fr,html); })
    .catch((err)=>{ if(fr.getAttribute('data-app')===url) d.loadDoc(fr,'<!doctype html><meta charset="utf-8"><p>'+SW_OPEN_FAILED_TXT+' — '+swEsc(err&&err.message||err)+'</p>'); });   // the reason reaches the user (R5)
  return url;
}
// F3-15 (owner 2026-11-23): a first visit no longer pulls all 1189 chapters at once. FIRST: the book
// being read (the last one the Bible asked the broker for, remembered per device; John before any) and
// today's daily reading. THEN the rest of the corpus, only once the page is idle and only off a metered
// link (no Save-Data, not cellular): a phone on mobile data stops at 'partial' and tries again next boot.
const SW_BIBLE_BOOK_KEY='pa_bible_book';     // localStorage: the 1-based book the Bible app last opened (broker kind 'bible')
const SW_DEFAULT_BOOK=43;                    // John: the Bible app's first-ever chapter is John 3
const SW_IDLE_MS=30000;                      // no requestIdleCallback (Safari): wait this long before the bulk pass
const SW_DAY_MS=86400000;
// Today's daily reading, 1-based [book, chapter]: the SAME rule as the Bible app's dailyRead()
// (workspace/apps/bible/index.html — one chapter per day by day index since the epoch); test/offline-sw-client.test.mjs pins both.
function swDailyChapter(counts,now){
  const total=counts.reduce((a,n)=>a+n,0); if(!total) return null;
  let idx=Math.floor(now/SW_DAY_MS)%total;
  for(let b=0;b<counts.length;b++){ if(idx<counts[b]) return [b+1,idx+1]; idx-=counts[b]; }
  return null;
}
function swFirstChapters(counts,book,now){
  const b=Number.isInteger(book)&&counts[book-1]>0?book:SW_DEFAULT_BOOK, out=[];
  for(let c=1;c<=(counts[b-1]||0);c++) out.push([b,c]);
  const day=swDailyChapter(counts,now); if(day&&!out.some(([x,y])=>x===day[0]&&y===day[1])) out.push(day);
  return out;
}
// After an online boot: the app pages, then the Bible corpus, chapter by chapter, under the byte
// cap the node's config sets — read now, not at load. The worker remembers a finished corpus for
// this build, so a later boot asks once and moves on. A stop short of the end is never reported
// as done (R14). ctx: status (shared), ask(msg,kind) → the worker's reply or null, worker() → active or null.
async function swPrefetch(d,ctx,uid){
  const {status}=ctx;
  if(status.worker!=='ready'||!uid) return status.bible='skipped';
  let cfg; try{ cfg=await d.fetchJson(SW_OFFLINE_CONFIG_URL); }catch(err){ status.bible='no-config'; status.error=String(err&&err.message||err); return status.bible; }
  // apps: this user's own copies; shelf_apps: the family shelf's (the node lists only what exists, F4-4).
  const pages=[...(cfg.apps||[]).map((slug)=>swAppUrl(uid,slug)),...(cfg.shelf_apps||[]).map((slug)=>swAppUrl('shared',slug))];
  for(const url of pages){ try{ await d.fetchText(url); }catch(err){ status.error=String(err&&err.message||err); } }   // a missing app page is not a reason to skip the corpus; the error is kept
  if(cfg.bible_prefetch===false) return status.bible='off';
  const st=await ctx.ask({kind:SW_BIBLE_STATUS_KIND},SW_BIBLE_STATUS_KIND);
  if(st&&st.done) return status.bible='done';
  const counts=Array.isArray(cfg.bible)?cfg.bible:[];
  if(!counts.some((n)=>n>0)) return status.bible='no-corpus';
  let bytes=0;
  const first=swFirstChapters(counts,Number(ctx.recall(SW_BIBLE_BOOK_KEY)),d.now?d.now():Date.now()), got=new Set();
  const fetchOne=async(b,c)=>{
    try{ bytes+=await d.fetchBytes(swBibleUrl(b,c)); got.add(b+':'+c); }
    catch(err){ status.error=String(err&&err.message||err); return status.bible='failed'; }
    if(bytes>cfg.bible_cap_bytes){ status.error='圣经预取已达字节上限 · Bible prefetch stopped at the byte cap'; return status.bible='capped'; }
    return '';
  };
  for(const [b,c] of first){ const stop=await fetchOne(b,c); if(stop) return stop; }
  const metered=()=>!!(d.metered&&d.metered());
  if(metered()) return status.bible='partial';
  if(d.idle) await d.idle();
  if(metered()) return status.bible='partial';
  for(let b=1;b<=counts.length;b++) for(let c=1;c<=counts[b-1];c++){
    if(got.has(b+':'+c)) continue;
    const stop=await fetchOne(b,c); if(stop) return stop;
  }
  const w=ctx.worker(); if(w) w.postMessage({kind:SW_BIBLE_DONE_KIND,bytes});
  return status.bible='done';
}
// Sign-out: drop every stored app page from the offline bundle, so an unshared app (ADR 0037) cannot
// be read from this device's cache by whoever signs in next. The shell's own pages stay. cachesApi =
// window.caches or a fake; resolves with the number of entries removed.
async function swForgetAppPages(cachesApi){
  if(!cachesApi) return 0;
  let n=0;
  for(const name of (await cachesApi.keys()).filter((k)=>k.startsWith('pa-'))){
    const c=await cachesApi.open(name);
    for(const req of await c.keys()){ if(new URL(req.url).pathname.startsWith('/app/')){ await c.delete(req); n++; } }
  }
  return n;
}
// Entering the signed-out state (sign-out, or a boot whose session is gone): forget this device's
// stored app pages and end the app cookie's session, so the next account on this browser can read
// neither (ADR 0037). Both steps run; a failure of either reaches the caller.
async function swSignedOut(cachesApi,post){
  const [a,b]=await Promise.allSettled([swForgetAppPages(cachesApi),post('/app/-/signout')]);
  const bad=[a,b].find((r)=>r.status==='rejected'); if(bad) throw bad.reason;
}
function makeSwClient(d){
  let route=SW_ROUTE_SRC, reg=null;
  const status={worker:'',bundle:'',probe:'',bible:'',error:''};
  const waiters=new Map();   // worker reply kind → resolve
  const worker=()=>reg&&reg.active||null;
  const onWorkerMessage=(m)=>{
    if(!m||!m.kind) return;
    if(m.kind===SW_BUNDLE_KIND){ status.bundle=m.ok?'ok':'failed'; if(!m.ok) status.error=m.error||'bundle failed'; }
    const w=waiters.get(m.kind); if(w){ waiters.delete(m.kind); w(m); }
  };
  // A question to the worker; null when there is none or it does not answer in time (never assumed).
  const ask=(m,kind)=>new Promise((resolve)=>{
    const w=worker(); if(!w) return resolve(null);
    const t=d.setTimeout(()=>{ if(waiters.get(kind)===done){ waiters.delete(kind); resolve(null); } },SW_REPLY_MS);
    const done=(r)=>{ d.clearTimeout(t); resolve(r); };
    waiters.set(kind,done); w.postMessage(m);
  });
  const probe=async()=>{ route=await swProbe(d); status.probe=route; return route; };
  // Registration, then the hand-off: the build this page loaded with names the cache. A waiting
  // (newer) worker script is let through here — after the page's own update, never on its own.
  async function start(){
    if(!d.sw){ status.worker='unsupported'; return status.worker; }
    try{
      reg=await d.sw.register(SW_URL,{scope:'/'});
      d.sw.addEventListener('message',(e)=>onWorkerMessage(e.data));
      reg=await d.sw.ready;
      status.worker='ready';
      if(reg.waiting) reg.waiting.postMessage({kind:SW_SKIP_KIND});
      const build=swBuildOf(d.loaded());
      if(!build){ status.bundle='no-build'; return status.worker; }
      await ask({kind:SW_BUNDLE_KIND,build},SW_BUNDLE_KIND);
      if(d.sw.controller) await probe(); else d.sw.addEventListener('controllerchange',()=>{ probe(); });
    }catch(err){ status.worker='failed'; status.error=String(err&&err.message||err); }   // kept for the state line (session 2); the page works as before without a worker
    return status.worker;
  }
  // Per-device memory for a boot with no node: the last sign-in and app list (JSON, localStorage).
  const remember=(k,v)=>{ try{ d.storage&&d.storage.setItem(k,JSON.stringify(v)); }catch(_){ /* private mode or full: the next online boot remembers again */ } };
  const recall=(k)=>{ try{ return d.storage?JSON.parse(d.storage.getItem(k)||'null'):null; }catch(_){ return null; /* an unreadable entry reads as nothing remembered */ } };
  return { start, probe, frameLoad:(uid,slug)=>swFrameLoad(d,route,uid,slug), prefetch:(uid)=>swPrefetch(d,{status,ask,worker,recall},uid),
    noteBook:(b)=>{ if(Number.isInteger(b)&&b>0) remember(SW_BIBLE_BOOK_KEY,b); },
    remember, recall, route:()=>route, status:()=>({...status}) };
}
const PASW=makeSwClient({
  sw:('serviceWorker' in navigator)?navigator.serviceWorker:null,
  loaded:()=>{ const vl=$('#ver-lbl'); return vl?vl.textContent.trim():''; },   // the same footer line PAUpdate reads (web/update.js)
  frame:()=>$('#fr'),
  loadDoc:(fr,html)=>appFrameLoadDoc(fr,html),   // web/app-frame.js: the page goes in a fresh frame, so it leaves no Back entry
  loadSrc:(fr,url)=>appFrameLoadSrc(fr,url),     // the same for the src route: #fr may be a frame the browser already navigated
  fetchText:async(u)=>{ const r=await fetch(u,{credentials:'same-origin'});   // the Path=/app/ cookie: an unshared app page is its author's only (ADR 0037)
  if(!/^text\/html/.test(r.headers.get('content-type')||'')) throw new Error('HTTP '+r.status); return r.text(); },
  fetchJson:async(u)=>{ const r=await api(u); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); },
  fetchBytes:async(u)=>{ const r=await api(u); if(!r.ok) throw new Error('HTTP '+r.status); return (await r.arrayBuffer()).byteLength; },
  probeFrame:(u)=>{ const f=document.createElement('iframe'); f.setAttribute('sandbox','allow-scripts'); f.style.display='none'; f.src=u; document.body.appendChild(f); return f; },
  onMessage:(fn)=>{ const h=(e)=>fn(e.data); window.addEventListener('message',h); return ()=>window.removeEventListener('message',h); },
  storage:(()=>{ try{ return window.localStorage; }catch(_){ return null; /* storage blocked: nothing remembered, nothing breaks */ } })(),
  setTimeout:(fn,ms)=>setTimeout(fn,ms), clearTimeout:(t)=>clearTimeout(t),
  // F3-15: the bulk corpus pass waits for an idle page and skips a metered link (Save-Data / cellular / 2g).
  metered:()=>{ const c=navigator.connection; return !!(c&&(c.saveData||c.type==='cellular'||/2g/.test(c.effectiveType||''))); },
  idle:()=>new Promise((res)=>{ if(typeof requestIdleCallback==='function') requestIdleCallback(()=>res(),{timeout:SW_IDLE_MS}); else setTimeout(res,SW_IDLE_MS); }),
});
/* ══ PA_SW_CLIENT_END ══ */
