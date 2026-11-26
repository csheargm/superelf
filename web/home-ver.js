// PAHomeVer（主页版本行）— the home's pinned footer, outside the scrolling app list: which version runs and
// when it was released, ONE short English line (owner: English only) "Version 5.x.y · Updated Nov 26, 10:30",
// in the viewer's zone; the full time with its zone sits in the title.
// ONE source (R3): the Settings footer #ver-lbl (the string web.mjs writes and PAUpdate compares)
// + its data-vtime/data-vdate, through web/version-time.js. Inlined AFTER version-time.js, so
// its helpers exist when sync() runs; it re-syncs whenever the footer changes (a later update).
const PAHomeVer=(function(){
  const PREFIX=/^管家\s*·\s*/;
  // footer text 'v5.30.0+2 · ab12cd3' → 'v5.30.0+2'; '' when the server wrote no version.
  function versionOf(text){ return String(text||'').trim().replace(PREFIX,'').split(' · ')[0].trim(); }
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // ISO → 'Nov 26, 10:30' local (24h), the year added when it is not this year; bad ISO → the date given.
  function whenOf(iso,date,now=new Date()){
    const short=verTimeShort(iso,now); if(!short) return String(date||'');
    const d=new Date(iso), hm=short.slice(-5);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear()===now.getFullYear()?'':', '+d.getFullYear()}, ${hm}`;
  }
  function lineOf(ver,when){
    if(!ver) return '';
    const v=ver.replace(/^v/,'');
    return when?`Version ${v} · Updated ${when}`:`Version ${v}`;
  }
  function sync(){
    const vl=document.getElementById('ver-lbl'), out=document.getElementById('hVer'); if(!vl||!out) return;
    const line=lineOf(versionOf(vl.textContent),whenOf(vl.dataset.vtime,vl.dataset.vdate));
    out.textContent=line; out.hidden=!line;
    const full=verTimeFull(vl.dataset.vtime); if(line) out.title=full?`${line} (${full})`:line; else out.removeAttribute('title');
  }
  function start(){
    sync();
    const vl=document.getElementById('ver-lbl');
    if(vl) new MutationObserver(sync).observe(vl,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['data-vtime','data-vdate']});
  }
  return {versionOf,whenOf,lineOf,sync,start};
})();
PAHomeVer.start();
