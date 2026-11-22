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
const SW_OPEN_FAILED_TXT='Could not open · 无法打开';
const swAppUrl=(uid,slug)=>`/app/${encodeURIComponent(uid)}/${encodeURIComponent(slug)}/`;
// The build id inside the footer line '<app name> · v<semver>+N · <build>' (web/update.js reads the same line).
const swBuildOf=(footer)=>{ const m=String(footer||'').match(/\bv\d[^ ]* · (.+)$/); return m?m[1].trim():''; };
const swBibleUrl=(b,c)=>'/api/bible?book='+b+'&chapter='+c;   // the broker's own chapter URL (web/index.html kind 'bible')
const swEsc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// deps: sw → navigator.serviceWorker or null; loaded() → the footer line; frame() → #fr;
// fetchText(url) → the HTML (any status, so the worker's offline page shows in the frame) or throws;
// fetchJson(url) → parsed JSON (authenticated) or throws; fetchBytes(url) → byte count or throws;
// probeFrame(url) → {remove()} a hidden sandboxed iframe; onMessage(fn) → unsubscribe;
// storage → localStorage or null; setTimeout/clearTimeout.
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
  if(route!==SW_ROUTE_SRCDOC){ fr.removeAttribute('srcdoc'); fr.removeAttribute('data-app'); fr.src=url; return url; }
  fr.removeAttribute('src'); fr.setAttribute('data-app',url);
  d.fetchText(url).then((html)=>{ if(fr.getAttribute('data-app')===url) fr.srcdoc=html; })
    .catch((err)=>{ if(fr.getAttribute('data-app')===url) fr.srcdoc='<!doctype html><meta charset="utf-8"><p>'+SW_OPEN_FAILED_TXT+' — '+swEsc(err&&err.message||err)+'</p>'; });   // the reason reaches the user (R5)
  return url;
}
// After an online boot: the app pages, then the Bible corpus, chapter by chapter, under the byte
// cap the node's config sets — read now, not at load. The worker remembers a finished corpus for
// this build, so a later boot asks once and moves on. A stop short of the end is never reported
// as done (R14). ctx: status (shared), ask(msg,kind) → the worker's reply or null, worker() → active or null.
async function swPrefetch(d,ctx,uid){
  const {status}=ctx;
  if(status.worker!=='ready'||!uid) return status.bible='skipped';
  let cfg; try{ cfg=await d.fetchJson(SW_OFFLINE_CONFIG_URL); }catch(err){ status.bible='no-config'; status.error=String(err&&err.message||err); return status.bible; }
  for(const slug of cfg.apps||[]){ try{ await d.fetchText(swAppUrl(uid,slug)); }catch(err){ status.error=String(err&&err.message||err); } }   // a missing app page is not a reason to skip the corpus; the error is kept
  if(cfg.bible_prefetch===false) return status.bible='off';
  const st=await ctx.ask({kind:SW_BIBLE_STATUS_KIND},SW_BIBLE_STATUS_KIND);
  if(st&&st.done) return status.bible='done';
  const counts=Array.isArray(cfg.bible)?cfg.bible:[];
  if(!counts.some((n)=>n>0)) return status.bible='no-corpus';
  let bytes=0;
  for(let b=1;b<=counts.length;b++) for(let c=1;c<=counts[b-1];c++){
    try{ bytes+=await d.fetchBytes(swBibleUrl(b,c)); }
    catch(err){ status.error=String(err&&err.message||err); return status.bible='failed'; }
    if(bytes>cfg.bible_cap_bytes){ status.error='Bible prefetch stopped at the byte cap · 圣经预取已达字节上限'; return status.bible='capped'; }
  }
  const w=ctx.worker(); if(w) w.postMessage({kind:SW_BIBLE_DONE_KIND,bytes});
  return status.bible='done';
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
  return { start, probe, frameLoad:(uid,slug)=>swFrameLoad(d,route,uid,slug), prefetch:(uid)=>swPrefetch(d,{status,ask,worker},uid),
    remember, recall, route:()=>route, status:()=>({...status}) };
}
const PASW=makeSwClient({
  sw:('serviceWorker' in navigator)?navigator.serviceWorker:null,
  loaded:()=>{ const vl=$('#ver-lbl'); return vl?vl.textContent.trim():''; },   // the same footer line PAUpdate reads (web/update.js)
  frame:()=>$('#fr'),
  fetchText:async(u)=>{ const r=await fetch(u,{credentials:'omit'}); if(!/^text\/html/.test(r.headers.get('content-type')||'')) throw new Error('HTTP '+r.status); return r.text(); },
  fetchJson:async(u)=>{ const r=await api(u); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); },
  fetchBytes:async(u)=>{ const r=await api(u); if(!r.ok) throw new Error('HTTP '+r.status); return (await r.arrayBuffer()).byteLength; },
  probeFrame:(u)=>{ const f=document.createElement('iframe'); f.setAttribute('sandbox','allow-scripts'); f.style.display='none'; f.src=u; document.body.appendChild(f); return f; },
  onMessage:(fn)=>{ const h=(e)=>fn(e.data); window.addEventListener('message',h); return ()=>window.removeEventListener('message',h); },
  storage:(()=>{ try{ return window.localStorage; }catch(_){ return null; /* storage blocked: nothing remembered, nothing breaks */ } })(),
  setTimeout:(fn,ms)=>setTimeout(fn,ms), clearTimeout:(t)=>clearTimeout(t),
});
/* ══ PA_SW_CLIENT_END ══ */
