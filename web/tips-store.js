/* PATipsStore — the shell's first-use tips 'seen' list on the ACCOUNT (profile.tipsSeen, lib/tips-seen.mjs), so a tip
   closed on the phone stays closed on the Mac (ADR 0030). PATips (web/tips.inline.html, inlined at the shell's
   PA_TIPS_UI marker) reads it lazily; app pages use PAAppPrefs instead. PATipsShell.ready(p) is called at boot with
   the profile load. A read that never answers (signed out, offline) counts as refused after READY_MS: PATips then
   falls back to this device's copy. Shell tips register here too: PATipsShell.tip(id, anchor, text). */
const PATipsShell=(()=>{
  const READY_MS=15000;
  // Pending until boot calls ready() after sign-in (a signed-out page shows no shell tip); then bounded by READY_MS.
  let resolveReady=null, timer=0; const ready=new Promise((r)=>{ resolveReady=r; });
  const list=()=>(ME&&Array.isArray(ME.tipsSeen))?ME.tipsSeen.filter((x)=>typeof x==='string'):[];
  // A thrown or refused write answers {ok:false}: PATips has already closed the tip and kept it in tab/device copies (R5 c).
  async function put(next){
    try{ const r=await api('/api/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({tipsSeen:next})});
      if(!r.ok) return {ok:false,error:'HTTP '+r.status};
      if(ME&&typeof ME==='object') ME.tipsSeen=next; return {ok:true}; }
    catch(e){ return {ok:false,error:(e&&e.message)||'network unavailable'}; }
  }
  window.PATipsStore={
    oneAtATimeOnly:true,
    who:()=>(typeof UID!=='undefined'&&UID)?String(UID):'',   // the device copy's key carries the account   // a long-lived page: one tip at a time, not one per open (web/tips.inline.html)
    read:async()=>{ const ok=await ready; return ok&&ME&&ME.tipsSeen!==undefined?{ok:true,list:list()}:{ok:false}; },
    write:(seen)=>put([...new Set([...list(),...seen])]),   // the server unions it with the stored list (another device's dismissals stay)
    reset:()=>put([]),
  };
  // An app's tip lives in its frame: Escape or a press out here would never reach it. Forward both (web/tips.inline.html).
  const toApp=()=>{ const fr=document.getElementById('fr'); try{ if(fr&&fr.contentWindow) fr.contentWindow.postMessage({pa:'tips-dismiss'},'*'); }catch{ /* no frame yet: nothing to close */ } };
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') toApp(); },true);
  // And back: the app frame reports its Escape and presses (only #fr's window counts), closing a shell tip.
  addEventListener('message',(e)=>{ const fr=document.getElementById('fr'); if(e.data&&e.data.pa==='tips-dismiss-up'&&fr&&e.source===fr.contentWindow&&window.PATips&&window.PATips.current()) window.PATips.hide(); });   // hidden, NOT stored: the app could send it unasked
  document.addEventListener('pointerdown',(e)=>{ if(!(e.target&&e.target.closest&&e.target.closest('#fr'))) toApp(); },true);
  function tip(id,anchor,text,o){ if(window.PATips) window.PATips.register(Object.assign({id,anchor,text},o||{})); }
  function readyOn(p){ timer=setTimeout(()=>resolveReady(false),READY_MS);
    return Promise.resolve(p).then(()=>{ clearTimeout(timer); resolveReady(true); },()=>{ clearTimeout(timer); resolveReady(false); }); }
  return {ready:readyOn,tip};
})();
