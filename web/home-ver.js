// PAHomeVer（主页版本行）— the last line of the home: which version runs and when it was released,
// "版本 v5.x.y · 更新于 11-26 10:30 · Version v5.x.y · Updated 11-26 10:30", in the viewer's zone.
// ONE source (R3): the Settings footer #ver-lbl (the string web.mjs writes and PAUpdate compares)
// + its data-vtime/data-vdate, formatted by web/version-time.js. Inlined AFTER version-time.js, so
// its helpers exist when sync() runs; it re-syncs whenever the footer changes (a later update).
const PAHomeVer=(function(){
  const PREFIX=/^管家\s*·\s*/;
  // footer text 'v5.30.0+2 · ab12cd3' → 'v5.30.0+2'; '' when the server wrote no version.
  function versionOf(text){ return String(text||'').trim().replace(PREFIX,'').split(' · ')[0].trim(); }
  function lineOf(ver,when){
    if(!ver) return '';
    return when?`版本 ${ver} · 更新于 ${when} · Version ${ver} · Updated ${when}`:`版本 ${ver} · Version ${ver}`;
  }
  function sync(){
    const vl=document.getElementById('ver-lbl'), out=document.getElementById('hVer'); if(!vl||!out) return;
    const line=lineOf(versionOf(vl.textContent),verTimeLabel(vl.dataset.vtime,vl.dataset.vdate));
    out.textContent=line; out.hidden=!line;
    const full=verTimeFull(vl.dataset.vtime); if(full) out.title=full; else out.removeAttribute('title');
  }
  function start(){
    sync();
    const vl=document.getElementById('ver-lbl');
    if(vl) new MutationObserver(sync).observe(vl,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['data-vtime','data-vdate']});
  }
  return {versionOf,lineOf,sync,start};
})();
PAHomeVer.start();
