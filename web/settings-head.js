// Settings' sticky top bar (owner report 2026-11-23: "I have to go all the way down to the bottom
// of the page to close this page"). The bar holds the title, 保存 · Save and the ONE close control ✕.
// Save is explicit (nothing autosaves), so ✕ / Escape with unsaved edits asks before dropping them.
// Dirty = the tracked fields differ from the snapshot taken when Settings opened or last saved.
// Family, shelf, jobs and node settings save on their own buttons, so they are not tracked.
const CFG_OWN_SAVE='#family,#shelf,#jobsWrap,#nodeCfgWrap';
const CFG_DISCARD_ASK='有未保存的更改，要放弃吗？ · Unsaved changes — discard them?';
let _cfgSnap='';
let _cfgSaving=false;   // set by 保存 · Save (web/settings.js) while its PUT runs
function cfgFields(){
  return [...$('#cfg').querySelectorAll('input,textarea,select')].filter(el=>!el.closest(CFG_OWN_SAVE))
    .map(el=>el.type==='checkbox'?el.checked:el.value);
}
function cfgDirty(){ return JSON.stringify(cfgFields())!==_cfgSnap; }
function cfgSync(){ $('#pSave').disabled=_cfgSaving||!cfgDirty(); }
function cfgMarkClean(){ _cfgSnap=JSON.stringify(cfgFields()); cfgSync(); }
function roleLabel(r){ return r==='owner'?'所有者 · owner':'成员 · member'; }
function roleLine(r){ const [zh,en]=roleLabel(r).split(' · '); return `角色：${zh} · role: ${en}`; }
// A dirty close asks; Cancel keeps Settings open with the edits. Clean closes straight away.
function cfgMayClose(){ return !cfgDirty()||confirm(CFG_DISCARD_ASK); }
for(const ev of ['input','change']) $('#cfg').addEventListener(ev,cfgSync);
$('#cfg').addEventListener('click',()=>setTimeout(cfgSync,0));   // "Reset to default" sets a value without an input event
$('#cfg').addEventListener('cancel',(e)=>{ if(!cfgMayClose()) e.preventDefault(); });   // Escape
$('#cfgClose').addEventListener('click',(e)=>{ if(!cfgMayClose()) e.preventDefault(); });
