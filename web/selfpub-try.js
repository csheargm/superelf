// PASelfPubTry — 试用 · Try it: the owner opens an unpublished core change full screen before publishing it
// (docs/adr/0049). The button sits in the Publish sheet (web/selfpub.js), owner only; the server checks
// again (lib/selfpub/routes.mjs: 403 for anyone else). The page is the change's own shell with sample data,
// in a frame with sandbox="allow-scripts" and NO allow-same-origin: an opaque origin, so its code cannot read
// this page's session or cookies, and its CSP lets it talk only to the fake API (lib/selfpub/try.mjs).
const PASelfPubTry=(()=>{
  const TIP_KEY='tip:selfpub-try';
  const TIP='新：发布前先试用这个改动（示例数据） · New: try this change before publishing (sample data)';
  // The page is the agent's code and fills the screen: it could draw a fake sign-in. What is typed there could leave
  // (WebRTC, DNS prefetch: outside the CSP, docs/adr/0049), so the banner says not to (R13, GPT review).
  const BANNER=['预览 — 示例数据，服务器改动不显示；不要在这里输入密码','Preview — sample data; server changes not shown. Never type a password here'];
  const CLOSE='关闭预览 · Close preview';
  const t=(p)=>(window.PALang?PALang.t(p):p.join(' · '));
  const isOwner=()=>typeof ROLE!=='undefined'&&ROLE==='owner';
  const button=()=>isOwner()?'<button type="button" data-sp="try" id="spTry" class="plain" style="min-height:44px;padding:8px 18px;border-radius:22px;border:1px solid var(--accent,#0f6355);color:var(--accent,#0f6355);background:none">试用 · Try it</button>':'';
  // Beside the button, once: the ONE tip mechanism; a tap uses it up.
  function armTip(){
    if(!isOwner()||!document.getElementById('spTry')||_SEEN.has(TIP_KEY)) return;
    // Another tip still up (one whose control the sheet now covers) would hold the one slot: it steps aside,
    // unseen, and shows again later (PATips.hide). The sheet's own control gets the slot.
    const c=window.PATips&&window.PATips.current(); if(c&&c!==TIP_KEY) window.PATips.hide();
    PATipsShell.tip(TIP_KEY,'#spTry',TIP,{priority:true,dismissOnUse:true,when:()=>!!document.getElementById('spTry')&&!document.getElementById('spTryView')});
    if(window.PATips) window.PATips.check();
  }
  function say(text){ const s=document.getElementById('pubSheet'); if(!s) return;
    let p=s.querySelector('#spTryErr'); if(!p){ p=document.createElement('p'); p.id='spTryErr'; const b=s.querySelector('#spTry'); if(b) b.before(p); else s.prepend(p); }
    p.textContent=text; }
  // The tapped button still on screen, in the sheet of THIS change: a slow answer never opens (or reports on) another change's sheet (GPT review).
  const still=(b,id)=>{ const st=b.isConnected&&b.closest('#pubSheet'), l=st&&st.querySelector('#spSheetState'); return !!(l&&l.getAttribute('data-id')===String(id)); };
  async function open(id){
    if(window.PATips&&window.PATips.current()) window.PATips.hide();
    const b=document.getElementById('spTry'); if(!b) return;
    let j;
    try{ const r=await api('/api/selfpub/'+encodeURIComponent(id)+'/try',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); j=await r.json(); }
    catch(e){ if(still(b,id)) say('无法打开预览 · Could not open the preview: '+((e&&e.message)||'')); return; }
    if(!still(b,id)) return;   // the sheet closed or moved on while the link was made: open nothing, say nothing there
    if(!j||typeof j.url!=='string'||!j.url.startsWith('/selfpub-try/')) return say((j&&j.error)||'无法打开预览 · Could not open the preview');
    show(j.url);
  }
  function show(url){
    close();
    const v=document.createElement('div'); v.id='spTryView'; v.setAttribute('role','dialog'); v.setAttribute('aria-modal','true'); v.setAttribute('aria-label','预览 · Preview');
    v.style.cssText='position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;background:var(--bg,#fff)';
    v.innerHTML='<div id="spTryBar" style="flex:none;display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top,0px) + 2px) 4px 2px 12px;background:var(--accent,#0f6355);color:#fff;font-size:13px;line-height:1.3">'
      +'<span id="spTryBanner" style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere"></span>'
      +'<button type="button" id="spTryClose" style="flex:none;width:44px;height:44px;border:0;background:none;color:inherit;font-size:18px;padding:0;cursor:pointer">✕</button></div>'
      +'<iframe id="spTryFrame" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" title="预览 · Preview" style="flex:1 1 auto;min-height:0;width:100%;border:0;display:block;background:#fff"></iframe>';
    v.querySelector('#spTryBanner').textContent=t(BANNER);
    const x=v.querySelector('#spTryClose'); x.setAttribute('aria-label',CLOSE); x.title=CLOSE; x.onclick=close;
    v.onkeydown=(e)=>{ if(e.key==='Escape'){ e.stopPropagation(); close(); } };
    v.querySelector('#spTryFrame').src=url;   // set after the sandbox attribute: the page never loads unsandboxed
    document.body.appendChild(v);
    // A modal over everything: the page behind is inert, so a shell tip whose control is now covered leaves
    // (PATips counts an inert anchor as off screen) and focus cannot wander behind the preview.
    for(const el of document.body.children) if(el!==v&&!el.inert&&!el.classList.contains('pat-tip')){ el.inert=true; behind.push(el); }
    if(window.PATips&&window.PATips.current()) window.PATips.hide();
    x.focus({preventScroll:true});
  }
  const behind=[];
  function close(){ const v=document.getElementById('spTryView'); if(!v) return; v.remove();
    for(const el of behind.splice(0)) el.inert=false;
    const b=document.getElementById('spTry'); if(b) b.focus({preventScroll:true}); }
  return { button, armTip, open, close, TIP, BANNER, TIP_KEY };
})();
