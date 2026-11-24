// PAAppEdit — 改这个应用 · Change this app, the shell half (docs/adr/0040-change-this-app.md, Phase 1).
// Inlined into the shell at its PA_APP_EDIT_JS marker (lib/shellhtml.mjs SHELL_PARTS). Owner only in Phase 1; the
// server checks again (lib/app-edit.mjs appEditOf).
// Entry, hidden by default: the open app's ⋯ (#fmore, first item), the drawer app row's ⋯ (first
// item), a long-press on the app title (#ftitle), and an own-bar app's long-press on ← Home, which
// posts {pa:'shell',type:'edit-app'}. One-time tip: a line under the menu item until it is tapped.
// Flow: picture of the app (PASnap, fails closed to a manual photo) → upload to the user's uploads/
// → the panel (web/app-edit-panel.html, PAChat) docks beside the app (a bottom sheet on a phone).
// A turn the server applied ({type:'app-edit',applied:true}) reloads the app in place and shows
// 撤销 · Undo in the panel's header.
const PAAppEdit=(()=>{
  const ITEM='改这个应用 · Change this app';
  const TIP_KEY='tip:app-edit';
  const TIP='长按标题可修改此应用 · Long-press the title to change this app';
  const SNAP_MS=6000, LOAD_MS=10000, PRESS_MS=600, SIDE_MIN_PX=768;
  // The broker kinds the panel's PAChat needs; anything else from the panel is refused (it has no data of its own).
  const KINDS=new Set(['chat','chat-cancel','convo','app-convos','render-md','upload','attach-url','set-model','seen-feature','get-new-features','convo-rename','convo-delete']);
  let S=null;   // {slug,title,el,fr,rec}
  let snapSeq=0, openSeq=0;   // openSeq: a newer open, a close or Home makes an older open's late steps no-ops
  const CSS=`#aePanel{position:fixed;z-index:12;background:var(--bg);display:flex;flex-direction:column;border-left:1px solid var(--line)}
#aePanel .ae-h{display:flex;gap:6px;align-items:center;padding:calc(4px + env(safe-area-inset-top)) 8px 4px;border-bottom:1px solid var(--line);font-size:14px}
#aePanel .ae-h b{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#aePanel iframe{flex:1;border:0;width:100%}
#aePanel.side{top:0;right:0;bottom:0;width:min(400px,45vw)}
#frame.ae-side{right:min(400px,45vw)}
#aePanel.sheet{left:0;right:0;bottom:0;height:55%;border-left:0;border-top:1px solid var(--line);border-radius:12px 12px 0 0;box-shadow:0 -4px 16px rgba(0,0,0,.15)}
#aePanel.sheet .ae-h{padding-top:6px}
#frame.ae-sheet{bottom:55%}`;
  const owner=()=>ROLE==='owner';
  const canEdit=()=>owner()&&frameOpen()&&frameUid()===UID&&!!frameSlug();
  function item(){
    const seen=_SEEN.has(TIP_KEY);
    return '<button data-a="edit-app" id="aeItem">'+ITEM+(seen?'':'<span class="ae-tip" style="display:block;font-size:11px;opacity:.75">'+TIP+'</span>')+'</button>';
  }
  function armTip(){ const b=$('#aeItem'); if(b) markNew(b,TIP_KEY); }
  // The picture of the app in #fr: its own PASnap answers. null = no picture (the panel asks for a photo).
  function snap(){
    const fr=$('#fr'), w=fr&&fr.contentWindow; if(!w) return Promise.resolve(null);
    const id='snap'+(++snapSeq);
    return new Promise((res)=>{
      const done=(v)=>{ clearTimeout(t); removeEventListener('message',on); res(v); };
      const on=(e)=>{ const m=e.data; if(e.source!==w||e.origin!=='null'||!m||m.pa!=='snap-res'||m.id!==id) return;
        done(m.ok&&typeof m.dataUrl==='string'&&m.dataUrl.startsWith('data:image/png;base64,')?m.dataUrl:null); };
      const t=setTimeout(()=>done(null),SNAP_MS);   // a page with no PASnap (no script) never answers
      addEventListener('message',on);
      w.postMessage({pa:'snap',id},'*');
    });
  }
  async function upload(slug,dataUrl){
    if(!dataUrl) return null;
    try{ const r=await api('/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'screen-'+slug+'.png',data:dataUrl.split(',')[1]})});
      const j=await r.json(); return j&&j.ok?{name:j.name,path:j.path,thumb:dataUrl}:null; }
    catch(_){ return null; /* the panel then says there is no picture and asks for one (fail closed) */ }
  }
  function layout(){
    if(!S) return;
    const side=innerWidth>=SIDE_MIN_PX;
    S.el.className=side?'side':'sheet';
    $('#frame').classList.toggle('ae-side',side); $('#frame').classList.toggle('ae-sheet',!side);
  }
  function build(slug,title){
    if(!$('#aeStyle')){ const st=document.createElement('style'); st.id='aeStyle'; st.textContent=CSS; document.head.appendChild(st); }
    const el=document.createElement('div'); el.id='aePanel';
    el.innerHTML='<div class="ae-h"><b id="aeTitle"></b><button class="plain" id="aeUndo" style="display:none">撤销 · Undo</button><button class="plain" id="aeClose" title="关闭 · Close" aria-label="Close">✕</button></div>';
    el.querySelector('#aeTitle').textContent=ITEM.split(' · ')[0]+' · '+title;
    const fr=document.createElement('iframe'); fr.id='aefr'; fr.setAttribute('sandbox','allow-scripts'); el.appendChild(fr);
    document.body.appendChild(el);
    el.querySelector('#aeClose').onclick=close;
    el.querySelector('#aeUndo').onclick=undo;
    return {slug,title,el,fr,rec:{el:fr,slug,edit:true,spoke:true,busy:0,held:false,left:false}};
  }
  async function open(slug,title,prefill){
    if(!owner()) return;
    if(frameSlug()!==slug||frameUid()!==UID){ openApp(UID,slug,title); await loaded(); }
    if(!canEdit()) return;
    close(); const my=++openSeq;
    const shot=await upload(slug,await snap());
    if(my!==openSeq||!canEdit()||frameSlug()!==slug) return;   // Home, another app or another open came first
    S=build(slug,title||$('#ftitle').textContent||slug); layout(); addEventListener('resize',layout);
    const me=S;
    try{ const r=await api('/api/app-edit/panel'); if(!r.ok) throw new Error('HTTP '+r.status); const html=await r.text(); if(S!==me) return; me.fr.srcdoc=html; }
    catch(err){ if(S===me) me.el.querySelector('#aeTitle').textContent='面板加载失败 · The panel did not load: '+((err&&err.message)||''); return; }
    if(S!==me) return;
    S.fr.addEventListener('load',()=>{ if(S===me) me.fr.contentWindow.postMessage({pa:'edit-init',slug,title:me.title,shot,prefill:typeof prefill==='string'?prefill.slice(0,2000):''},'*'); },{once:true});
  }
  function loaded(){ return new Promise((res)=>{ const t=setTimeout(res,LOAD_MS); $('#fr').addEventListener('load',()=>{ clearTimeout(t); res(); },{once:true}); }); }
  function close(){
    openSeq++;
    if(!S) return;
    S.el.remove(); S=null; removeEventListener('resize',layout);
    $('#frame').classList.remove('ae-side','ae-sheet');
  }
  // The app reloads in place, beside the panel: the same leave-then-load openApp uses (its last save is kept, ADR 0018).
  function reloadApp(){ if(!S) return; appFrameLeave(); PASW.frameLoad(UID,S.slug); }
  function say(t){ if(S&&S.fr.contentWindow) S.fr.contentWindow.postMessage({pa:'edit-note',text:t},'*'); }
  async function undo(){
    if(!S) return;
    try{ const r=await api('/api/apps/'+encodeURIComponent(S.slug)+'/undo',{method:'POST'}); const j=await r.json();
      say(j.text||j.error||('HTTP '+r.status)); if(j.undone) reloadApp(); }
    catch(err){ say('撤销失败 · Undo failed: '+((err&&err.message)||'')); }
  }
  // Every event of the panel's chat passes here (the broker's chat relay).
  function onEvent(ev){
    if(!S||!ev||ev.type!=='app-edit'||ev.slug!==S.slug) return;
    if(ev.applied){ reloadApp(); S.el.querySelector('#aeUndo').style.display=''; }
  }
  function frameRec(win){ return S&&win&&S.fr.contentWindow===win?S.rec:null; }
  const kindOk=(k)=>KINDS.has(k);
  // The open app's ⋯ and the long-press on its title.
  function frameMenu(anchor){
    closeMenuPop();
    const slug=frameSlug(), title=$('#ftitle').textContent;
    const m=document.createElement('div'); m.id='frameMenu'; m.className='cmenu-pop';
    m.innerHTML=item()+PAPublish.item();
    document.body.appendChild(m);
    const r=anchor.getBoundingClientRect(); m.style.top=(r.bottom+4)+'px'; m.style.right=Math.max(6,innerWidth-r.right)+'px';
    m.onclick=(ev)=>{ const b=ev.target.closest('button'); if(!b) return; closeMenuPop();
      if(b.dataset.a==='edit-app') open(slug,title); else if(b.dataset.a==='publish') PAPublish.open(slug); };
    armTip(); PAPublish.armTip(slug); armMenuPop();
  }
  function bindBar(){
    const more=$('#fmore'), t=$('#ftitle');
    if(more) more.onclick=(e)=>{ e.stopPropagation(); if(canEdit()) frameMenu(more); };
    let timer=0;
    t.addEventListener('pointerdown',()=>{ clearTimeout(timer); timer=setTimeout(()=>{ if(canEdit()) open(frameSlug(),t.textContent); },PRESS_MS); });
    for(const ev of ['pointerup','pointerleave','pointercancel']) t.addEventListener(ev,()=>clearTimeout(timer));
    t.addEventListener('contextmenu',(e)=>e.preventDefault());
  }
  // Shown only where it can work: the owner, on their own app (openApp passes the uid it opens).
  function syncBar(uid){ const more=$('#fmore'); if(more) more.style.display=owner()&&uid===UID?'':'none'; }
  // The app's chat said it cannot change the app and offered this button (lib/app-chat-honesty.mjs). Only the page
  // open in #fr, only on a real tap (an app cannot open the owner's panel by itself), only where the panel works.
  function fromApp(e){
    const m=e.data, fr=$('#fr');
    if(!fr||e.source!==fr.contentWindow||e.origin!=='null'||!canEdit()) return;
    if(!(navigator.userActivation&&navigator.userActivation.isActive)) return;
    open(frameSlug(),$('#ftitle').textContent,typeof m.request==='string'?m.request:'');
  }
  return {item,armTip,open,close,onEvent,frameRec,kindOk,bindBar,syncBar,fromApp,editAppFromBar:()=>{ if(canEdit()) open(frameSlug(),$('#ftitle').textContent); }};
})();
