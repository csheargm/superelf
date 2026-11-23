/* ══ PA_UPDATE_BEGIN ══ */
// PAUpdate — the shell keeps itself on the newest build（客户端自动更新, docs/adr/0026).
// An iPad runs this page as a home-screen app that stays alive for days, so the owner had to
// remember to tap ↺. Now the page remembers the version it loaded with (the footer line, the ONE
// place the server writes it) and asks /api/build when it becomes visible and every
// UPDATE_POLL_MS while visible. A different version reloads the page at once when that is safe,
// and otherwise lights the ↺ and shows one line — the user taps when ready.
// Safe = the open app answers {kind:'pa-busy'} with busy:false (web/busy.inline.html) and no answer
// within BUSY_REPLY_MS counts as busy (fail closed): an app that is mid-save or mid-stream, or
// one that cannot answer, is never reloaded under the user. Also busy: a leaving app still held
// for its last save (web/app-frame.js), and the shell's own composer with a draft or a turn in flight.
const UPDATE_POLL_MS=15*60*1000;
const BUSY_REPLY_MS=500;
const BUSY_QUERY={kind:'pa-busy?'};
const UPDATE_READY_TXT='有新版本 · Update ready — 点按刷新 · tap to reload';
const REOPEN_KEY='pa_reopen';   // sessionStorage: the app open when PAUpdate reloaded, reopened after boot
const RELOAD_RETRY_MS=1000;     // a tap on ↺/the bar under a queue drain: asked again this often until the drain ends
// deps: loaded() → the version this page loaded with; fetchJson(path) → parsed JSON or throws;
// frameWin() → the open app's window or null; heldPages() → a leaving app is still saving;
// shellBusy() → the shell composer holds a draft or a turn is in flight; onReply(fn) → unsubscribe,
// fn gets that window's messages; reload(); markReady(); setTimeout/clearTimeout.
function makeUpdate(d){
  let checking=false, ready=false;
  // Resolves true when a held (leaving) page is still saving, when the open app says busy, when it
  // does not answer in time, or when there is no way to ask; false only on an explicit {busy:false}.
  // No open app and nothing held → nothing to lose → false.
  const appBusy=()=>new Promise((resolve)=>{
    if(d.heldPages()) return resolve(true);
    const w=d.frameWin(); if(!w) return resolve(false);
    let done=false, off=()=>{};
    const settle=(v)=>{ if(done) return; done=true; d.clearTimeout(t); off(); resolve(v); };
    const t=d.setTimeout(()=>settle(true),BUSY_REPLY_MS);
    off=d.onReply((m)=>{ if(m&&m.kind==='pa-busy') settle(!!m.busy); });
    try{ w.postMessage(BUSY_QUERY,'*'); }catch(_){ settle(true); /* a window that cannot be asked cannot prove idle */ }
  });
  // → 'same' | 'reloaded' | 'ready' | 'unknown' | 'error' | 'busy-checking'
  async function check(){
    if(checking) return 'busy-checking';
    checking=true;
    try{
      let j; try{ j=await d.fetchJson('/api/build'); }catch(_){ return 'error'; /* offline or the node restarting: the next visible/poll check asks again */ }
      if(!j||typeof j.version!=='string'||!j.version) return 'unknown';
      if(d.loaded().endsWith(j.version)) return 'same';
      // shellBusy is read AGAIN after the app answered: a draft typed during the BUSY_REPLY_MS wait counts too.
      if(d.shellBusy()||await appBusy()||d.shellBusy()){ ready=true; d.markReady(); return 'ready'; }
      d.reload(); return 'reloaded';
    } finally{ checking=false; }
  }
  return { check, isReady:()=>ready };
}
// Which app is open, from the frame's URL (the same parse as frameSlug, with the owner too).
const frameApp=()=>{ const m=frameRef().match(/\/app\/([^/]+)\/([^/]+)(?:\/|$)/); return m?{u:decodeURIComponent(m[1]),s:decodeURIComponent(m[2]),t:$('#ftitle').textContent}:null; };
// Reload the way ↺ does (spinner carried across), remembering the open app so boot reopens it.
// Once an update was deferred, ↺ and the bar call this directly — past check()'s shellBusy — so the
// one thing that must never be reloaded under, a queue drain (web/offline-sync.js), is refused here
// too: the tap is kept and tried again until the drain ends. → true when the page reloads.
function updateReload(){
  if(typeof PASync!=='undefined'&&PASync.inFlight()){ setTimeout(updateReload,RELOAD_RETRY_MS); return false; }
  try{ sessionStorage.setItem('pa_refreshing','1'); const a=frameApp(); if(a) sessionStorage.setItem(REOPEN_KEY,JSON.stringify(a)); }catch(_){ /* private mode: a plain reload, the user reopens the app */ }
  location.reload(); return true;
}
// After boot: the app that was open when the page reloaded itself.
function reopenAfterUpdate(){
  let a=null; try{ a=JSON.parse(sessionStorage.getItem(REOPEN_KEY)||'null'); sessionStorage.removeItem(REOPEN_KEY); }catch(_){ a=null; /* nothing remembered */ }
  if(a&&a.u&&a.s) openApp(a.u,a.s,a.t);
}
const PAUpdate=makeUpdate({
  // The footer is '<app name> · <appVersion()>' (web/settings-dialog.html); the version is its tail.
  loaded:()=>{ const vl=$('#ver-lbl'); return vl?vl.textContent.trim():''; },
  fetchJson:async(p)=>{ const r=await fetch(p,{cache:'no-store'}); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); },
  frameWin:()=>{ const u=frameRef(); return u&&u!=='about:blank'?$('#fr').contentWindow:null; },   // src, or data-app on the srcdoc route (web/sw-client.js)
  heldPages:()=>appFramesHeld.size>0,   // web/app-frame.js: a page that is leaving and not yet removed is mid-save
  // The composer with text, or a turn in flight: the status row (add('status') in submitSend) lives only until the reply settles.
  shellBusy:()=>!!($('#box').value.trim()||$('#log').querySelector('.msg.status')||(typeof PASync!=='undefined'&&PASync.inFlight())),   // + a queue drain in flight (web/offline-sync.js): never reload under it
  onReply:(fn)=>{ const h=(e)=>{ if(e.source===$('#fr').contentWindow) fn(e.data); }; window.addEventListener('message',h); return ()=>window.removeEventListener('message',h); },
  reload:updateReload,
  markReady:()=>{ $('#reload').classList.add('upd'); $('#reload').onclick=updateReload; const b=$('#updBar'); b.textContent=UPDATE_READY_TXT; b.classList.add('on'); b.onclick=updateReload; },   // the lit ↺ reloads the way the bar does: the open app is kept
  setTimeout:(fn,ms)=>setTimeout(fn,ms), clearTimeout:(t)=>clearTimeout(t),
});
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') PAUpdate.check(); });
setInterval(()=>{ if(document.visibilityState==='visible') PAUpdate.check(); },UPDATE_POLL_MS);
/* ══ PA_UPDATE_END ══ */
