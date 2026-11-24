/* PADrawerSections（侧栏分组）— the ☰ drawer's section headers: 我的应用 / 家庭应用 / 简报 / 对话记录.
   Each header is a full-width button: line icon, 中文 bold + English lighter, a count pill, a chevron;
   aria-expanded says its state, Enter/Space toggle it (a <button>). Rows sit under it on a soft card.
   DEFAULTS (owner 2026-11-24, "everything open is overwhelming"): every section closed except 对话记录,
   which shows only the recent chats (PAHomeLook.recentCount) with 更多 · More. A tap is remembered ON
   THE ACCOUNT (profile.drawerOpen, PUT /api/profile; lib/webutil.mjs drawerOpenOf keeps known ids only),
   so the phone and the Mac open the same way. Only taps are stored; the defaults live here.
   Driven by test/drawer-sections-e2e.test.mjs. */
const PADrawerSections=(()=>{
  const DEFAULT_OPEN=Object.freeze({secChats:true});
  const style=document.createElement('style');
  style.textContent=`#drawer .dsec{margin:0 10px}
#drawer .dsec-head{width:100%;display:flex;align-items:center;gap:10px;padding:12px 8px;margin-top:4px;border:0;border-radius:12px;background:none;
  color:var(--text);font:inherit;text-align:left;cursor:pointer;min-height:44px}
#drawer .dsec-head:hover,#drawer .dsec-head:focus-visible{background:color-mix(in srgb,var(--text) 6%,transparent)}
#drawer .dsec-head::after{content:none}
#drawer .dsec-ic{flex:none;width:20px;height:20px;color:var(--hv-a,var(--accent))}
#drawer .dsec-ic svg{width:20px;height:20px}
#drawer .dsec-l{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;white-space:nowrap;overflow:hidden}
#drawer .dsec-l b{font-family:var(--hv-font,inherit);font-weight:800;font-size:16px}
#drawer .dsec-l .en{font-size:13px;font-weight:400;color:var(--muted);overflow:hidden;text-overflow:ellipsis}
#drawer .dsec-n{flex:none;min-width:22px;padding:1px 7px;border-radius:999px;background:var(--bg);border:1px solid var(--line);
  font-size:12px;font-weight:600;color:var(--muted);text-align:center}
#drawer .dsec-n:empty{display:none}
#drawer .dsec-chev{flex:none;width:18px;height:18px;color:var(--muted);transition:transform .15s ease}
#drawer .dsec-chev svg{width:18px;height:18px}
#drawer .dsec.open > .dsec-head .dsec-chev{transform:rotate(90deg)}
@media (prefers-reduced-motion:reduce){#drawer .dsec-chev{transition:none}}
#drawer .dsec.open > .dsec-body{margin:0 0 6px 8px;border-radius:12px;background:color-mix(in srgb,var(--text) 4%,transparent);overflow:hidden}
#drawer .dsec-body .day{font-size:11.5px;font-weight:600;color:var(--muted)}`;
  document.head.appendChild(style);
  const secs=()=>[...document.querySelectorAll('#drawer .dsec')];
  // ME (web/settings.js) is a `let` inlined AFTER this file: read before the profile script ran it throws (TDZ).
  // Silent on purpose: that is the boot moment, which correctly means "no taps known yet" → the defaults.
  const me=()=>{ try{ return ME; }catch{ return null; } };
  const stored=()=>{ const o=me(), m=o&&typeof o==='object'&&o.drawerOpen; return (m&&typeof m==='object')?m:{}; };
  let local={};   // taps this session, over the account's (the list moves before the save answers)
  const isOpen=(id)=>{ const st=Object.assign({},stored(),local); return (id in st)?!!st[id]:!!DEFAULT_OPEN[id]; };
  function paint(){ for(const s of secs()){ const on=isOpen(s.id); s.classList.toggle('open',on);
    s.querySelector('.dsec-head').setAttribute('aria-expanded',String(on)); } }
  // A refused save leaves the tap in effect for this session — a view state is not worth reverting under
  // the finger — and says so in the console (R5: no user-facing line is about a drawer pref).
  async function save(){ const next=Object.assign({},stored(),local);
    try{ const r=await api('/api/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({drawerOpen:next})});
      if(r.ok){ const o=me(); if(o&&typeof o==='object') o.drawerOpen=next; } else console.warn('[PADrawerSections] not saved: HTTP '+r.status); }
    catch(e){ console.warn('[PADrawerSections] not saved',e); } }
  function toggle(id){ local[id]=!isOpen(id); paint(); return save(); }
  function bind(){ for(const s of secs()){ const h=s.querySelector('.dsec-head');
    h.setAttribute('aria-controls',s.id+'Body'); s.querySelector('.dsec-body').id=s.id+'Body';
    h.onclick=()=>toggle(s.id); } paint(); }
  // The count pill: rows the section holds (for chats, all of them, not only the recent few shown).
  function count(id,n){ const el=document.querySelector('#'+id+' .dsec-n'); if(el) el.textContent=n>0?String(n):''; }
  return {bind,paint,toggle,isOpen,count,DEFAULT_OPEN};
})();
