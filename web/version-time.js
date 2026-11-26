/* ══ PA_VERSION_TIME_BEGIN ══ */
// PAVerTime — the release time in the VIEWER's local time（版本发布时间，按本机时区）.
// Many releases ship per day, so the footer's date alone ("11-25") did not say which one was
// running. tools/bump-version.mjs records each release's full UTC ISO time in version-notes.json
// (`time`, the ONE source, R3); this file turns it into 'MM-DD HH:mm' (24h), with the year in front
// when it is not the current year. A release from before `time` existed shows its date only —
// never a made-up time. test/version-time.test.mjs evaluates this same file in Node.
const VT_ISO_RE=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
const vt2=(n)=>String(n).padStart(2,'0');
const vtDate=(iso)=>{ if(!VT_ISO_RE.test(String(iso||''))) return null; const d=new Date(iso); return Number.isFinite(d.getTime())?d:null; };
// 'MM-DD HH:mm' local; 'YYYY-MM-DD HH:mm' in another year; '' when iso is missing or bad.
function verTimeShort(iso,now=new Date()){
  const d=vtDate(iso); if(!d) return '';
  const md=`${vt2(d.getMonth()+1)}-${vt2(d.getDate())} ${vt2(d.getHours())}:${vt2(d.getMinutes())}`;
  return d.getFullYear()===now.getFullYear()?md:`${d.getFullYear()}-${md}`;
}
// The tooltip: full local date-time, the UTC offset and the zone name.
function verTimeFull(iso){
  const d=vtDate(iso); if(!d) return '';
  const off=-d.getTimezoneOffset(), sign=off<0?'-':'+', a=Math.abs(off);
  let zone=''; try{ zone=Intl.DateTimeFormat().resolvedOptions().timeZone||''; }catch(_){ /* no Intl zone: the UTC offset alone still names the time */ }
  return `${d.getFullYear()}-${vt2(d.getMonth()+1)}-${vt2(d.getDate())} ${vt2(d.getHours())}:${vt2(d.getMinutes())}:${vt2(d.getSeconds())} UTC${sign}${vt2(Math.floor(a/60))}:${vt2(a%60)}${zone?' ('+zone+')':''}`;
}
// What a version line shows after the build id: the local release time, else the date given ('11-25').
function verTimeLabel(iso,date,now){ return verTimeShort(iso,now)||String(date||''); }
// The Settings footer: data-vtime (ISO) / data-vdate → data-shown (drawn by CSS ::after, so the
// footer's textContent — the string PAUpdate compares with /api/build — never changes) + a title.
function verTimeApply(el){
  if(!el) return;
  const shown=verTimeLabel(el.dataset.vtime,el.dataset.vdate);
  if(shown) el.dataset.shown=shown; else delete el.dataset.shown;
  const full=verTimeFull(el.dataset.vtime); if(full) el.title=full;
}
/* ══ PA_VERSION_TIME_END ══ */
