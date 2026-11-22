/* ══ PA_ORIGIN_BEGIN ══ */
// PAOrigin — the home-node fallback（家中节点回退）, docs/plans/offline-first.md §6.
// The iPad sits on home Wi-Fi but the public name does not resolve (home internet down). The
// worker serves the cached shell; the node is one hop away under its local name. PASync asks here
// whether a node is reachable: /api/build on the public name first — always, so a public name that
// answers again takes the session back — and, only when that fails, on the home name the node's
// config gave the last online read (config `local_origin`, remembered per device by PAOffline).
// The home name is used ONLY when it answers the SAME build this page loaded with: a different
// build is some other node, never trusted with this session's token. On a switch the broker's
// api() base (API_BASE, web/index.html) points at the home name — same Bearer — and the state
// line says Home node (OFF_TXT_HOME, web/offline-client.js) for ORIGIN_NOTE_MS. PAUpdate keeps asking the public name: a
// reload fetches the shell from the public name, so a build seen only on the home name must never
// trigger one (it would reload into the cached old shell, forever).
// Deps come in so test/offline-origin.test.mjs runs makeOrigin on fakes with stubbed timers.
const ORIGIN_NOTE_MS=4000;             // how long the line says 'Home node' after a switch
const ORIGIN_BUILD_URL='/api/build';   // the same unauthenticated question PAUpdate asks (web/update.js)
// deps: fetchBuild(origin) → {build,version} or null, never throws (cache:'no-store': never a cached answer);
// localOrigin() → the remembered config value or ''; loadedBuild() → the build id this page loaded with;
// setBase(origin) → API_BASE; state(patch) → PAOffline.syncState (home:true|false); setTimeout/clearTimeout.
function makeOrigin(d){
  let base='', noteT=null;
  const status={base:'',last:''};
  const use=(o)=>{ base=o; status.base=o; d.setBase(o); };
  const note=()=>{ d.state({home:true}); if(noteT) d.clearTimeout(noteT); noteT=d.setTimeout(()=>{ noteT=null; d.state({home:false}); },ORIGIN_NOTE_MS); };
  // → true when a node answered /api/build on the public name (the base goes back to it), or on the
  // home name with the same build (the base switches to it); false otherwise, the base untouched
  // except that a home name answering a different build is dropped at once.
  async function reachable(){
    const pub=await d.fetchBuild('');
    if(pub){ if(base) use(''); status.last='public'; return true; }
    const local=d.localOrigin();
    if(!local){ status.last='no-local'; return false; }
    const loc=await d.fetchBuild(local);
    if(!loc){ status.last='local-away'; return false; }
    const mine=d.loadedBuild();
    if(!mine||loc.build!==mine){ status.last='different-build'; if(base) use(''); return false; }
    if(base!==local){ use(local); note(); }
    status.last='local'; return true;
  }
  return { reachable, base:()=>base, status:()=>({...status}) };
}
const PAOrigin=makeOrigin({
  fetchBuild:async(o)=>{ try{ const r=await fetch(o+ORIGIN_BUILD_URL,{cache:'no-store'}); return r.ok?await r.json():null; }catch(_){ return null; /* no node on that name, or not JSON (a captive portal): reachable() reports it in status().last */ } },
  localOrigin:()=>{ const v=PASW.recall(OFF_LOCAL_ORIGIN_KEY); return typeof v==='string'?v:''; },
  loadedBuild:()=>{ const vl=$('#ver-lbl'); return swBuildOf(vl?vl.textContent.trim():''); },   // the same footer line PASW and PAUpdate read
  setBase:(o)=>{ API_BASE=o; }, state:PAOffline.syncState,
  setTimeout:(fn,ms)=>setTimeout(fn,ms), clearTimeout:(t)=>clearTimeout(t),
});
/* ══ PA_ORIGIN_END ══ */
