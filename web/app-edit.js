// PAAppEdit — 改这个应用 · Change this app, the shell half (docs/adr/0040-change-this-app.md, Phase 1).
// Inlined into the shell at its PA_APP_EDIT_JS marker (lib/shellhtml.mjs SHELL_PARTS). Owner only in Phase 1; the
// server checks again (lib/app-edit.mjs appEditOf).
// Entry, hidden by default: the open app's ⋯ (#fmore, first item), the drawer app row's ⋯ (first
// item), a long-press on the app title (#ftitle), and an own-bar app's long-press on ← Home, which
// posts {pa:'shell',type:'edit-app'}. One-time tip: a line under the menu item until it is tapped.
// Flow: picture of the app (PASnap, fails closed to a manual photo) → upload to the user's uploads/
// → the panel (web/app-edit-panel.html, PAChat) docks beside the app (a bottom sheet on a phone).
// One chat per app (ADR 0042): it answers questions and, after the server's 改 · Apply step, changes the
// app. A turn the server applied ({type:'app-edit',applied:true}) reloads the app in place; only once the
// reload loaded does the panel say 已完成 · Done and show 撤销 · Undo (a failed reload says so, Undo still shown).
// Members and demo guests use it on their own apps too (the server runs their no-tools lane). It is the SHELL's way back:
// it never depends on the app's page (self-test 2026-11-25: a rewritten page removed its own Ask AI, so the chat and
// Undo were lost). The ⋯ also offers 撤销上次修改 · Undo last change while a change can be undone.
const PAAppEdit=(()=>{
  const ITEM='改这个应用 · Change this app', UNDO_ITEM='撤销上次修改 · Undo last change', EDITS_MS=3000, SAY_MS=5000;
  const TIP_KEY='tip:app-edit';
  const TIP='长按标题可修改此应用 · Long-press the title to change this app';
  const CHAT_TIP_KEY='tip:app-chat', CAM_TIP_KEY='tip:app-chat-camera';
  const DONE='已完成 · Done', RELOAD_FAILED='已改但未能重新加载，可撤销 · Changed, but the app did not reload — you can undo';
  const SNAP_MS=6000, LOAD_MS=10000, PRESS_MS=600, SIDE_MIN_PX=768;
  // The broker kinds the panel's PAChat needs; anything else from the panel is refused (it has no data of its own).
  const KINDS=new Set(['chat','chat-cancel','convo','app-convos','render-md','upload','attach-url','set-model','seen-feature','get-new-features','convo-rename','convo-delete']);
  let S=null;   // {slug,title,el,fr,rec}
  let snapSeq=0, openSeq=0, gen=0;   // gen: the app's reload count — a screenshot from an older gen is stale (the panel retakes it)   // openSeq: a newer open, a close or Home makes an older open's late steps no-ops
  const CSS=`#aePanel{position:fixed;z-index:12;background:var(--bg);display:flex;flex-direction:column;border-left:1px solid var(--line)}
#aePanel .ae-h{display:flex;gap:6px;align-items:center;padding:calc(4px + env(safe-area-inset-top)) 8px 4px;border-bottom:1px solid var(--line);font-size:14px}
#aePanel .ae-h b{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#aePanel iframe{flex:1;border:0;width:100%}
#aePanel.side{top:0;right:0;bottom:0;width:min(400px,45vw)}
#frame.ae-side{right:min(400px,45vw)}
#aePanel.sheet{left:0;right:0;bottom:0;height:55%;border-left:0;border-top:1px solid var(--line);border-radius:12px 12px 0 0;box-shadow:0 -4px 16px rgba(0,0,0,.15)}
#aePanel.sheet .ae-h{padding-top:6px}
#frame.ae-sheet{bottom:55%}`;
  const owner=()=>ROLE==='owner'||ROLE==='member';   // demo guests are members of their own workspace; the server decides the lane by role
  const canEdit=()=>owner()&&frameOpen()&&frameUid()===UID&&!!frameSlug();
  function item(){
    return '<button data-a="edit-app" id="aeItem">'+ITEM+'</button>';
  }
  function armTip(){ if($('#aeItem')&&!_SEEN.has(TIP_KEY)) PATipsShell.tip(TIP_KEY,'#aeItem',TIP); }   // the ONE tip mechanism
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
  // A PNG, by its signature: the app frame answers the snap, so it chooses the bytes (GPT review).
  const PNG_B64='iVBORw0KGgo', UP_MS=15000;
  async function upload(slug,dataUrl,g,at){
    if(!dataUrl||!dataUrl.startsWith('data:image/png;base64,'+PNG_B64)) return null;
    try{ const r=await api('/api/upload',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(UP_MS),
        body:JSON.stringify({name:'screen-'+slug+'-'+(++snapSeq)+'.png',data:dataUrl.split(',')[1]})});   // unique: two shots in one ms never share a file
      const j=await r.json(); return j&&j.ok?{name:j.name,path:j.path,thumb:dataUrl,gen:g,at}:null; }
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
    el.querySelector('#aeTitle').textContent=title;
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
    const sees=ROLE==='owner'&&!window.PADemoAuth;   // a member's lane cannot see pictures (lib/app-edit-lane.mjs): no auto-shot, no camera, no camera tip (self-test round 2)
    const g0=gen, at0=Date.now(), shot=sees?await upload(slug,await snap(),g0,at0):null;
    if(my!==openSeq||!canEdit()||frameSlug()!==slug) return;   // Home, another app or another open came first
    S=build(slug,title||$('#ftitle').textContent||slug); layout(); addEventListener('resize',layout);
    const me=S;
    try{ const r=await api('/api/app-edit/panel'); if(!r.ok) throw new Error('HTTP '+r.status); const html=await r.text(); if(S!==me) return; me.fr.srcdoc=html; }
    catch(err){ if(S===me) me.el.querySelector('#aeTitle').textContent='面板加载失败 · The panel did not load: '+((err&&err.message)||''); return; }
    if(S!==me) return;
    S.fr.addEventListener('load',()=>{ if(S!==me) return; const tip=onceTip(CHAT_TIP_KEY), camTip=sees&&onceTip(CAM_TIP_KEY);   // the one-time tips, shown in the panel
      me.fr.contentWindow.postMessage({pa:'edit-init',slug,title:me.title,shot,tip,camTip,snap:sees,gen,prefill:typeof prefill==='string'?prefill.slice(0,2000):''},'*'); },{once:true});
  }
  // Any new document in #fr (the app reloading or navigating itself, not only Apply/Undo) makes earlier shots stale.
  document.addEventListener('load',(e)=>{ if(e.target&&e.target.id==='fr') bumpGen(); },true);
  function bumpGen(){ gen++; if(S&&S.fr.contentWindow) S.fr.contentWindow.postMessage({pa:'edit-gen',gen},'*'); }
  function onceTip(k){ if(_SEEN.has(k)) return false; _SEEN.add(k); _saveSeen(); return true; }
  // The panel's camera (web/app-edit-panel.html): a picture of the app NOW, uploaded, or null (the panel says it cannot).
  addEventListener('message',async(e)=>{ const m=e.data;
    if(!S||!m||m.pa!=='edit-snap'||e.source!==S.fr.contentWindow||typeof m.id!=='string') return;
    const me=S, g=gen, at=Date.now();   // the load and the time the picture was TAKEN, not when its upload came back (GPT review)
    const shot=canEdit()&&frameSlug()===me.slug?await upload(me.slug,await snap(),g,at):null;
    if(S===me&&me.fr.contentWindow) me.fr.contentWindow.postMessage({pa:'edit-snap-res',id:m.id,shot},'*'); });
  // The next load of the app frame that is not the blank placeholder (appFrameLeave loads about:blank first).
  function loaded(){ const fr=$('#fr'); return new Promise((res)=>{ const t=setTimeout(()=>{ fr.removeEventListener('load',on); res(false); },LOAD_MS);
    const on=()=>{ const u=fr.getAttribute('src'), sd=fr.getAttribute('srcdoc'); if(sd===null&&(!u||u==='about:blank')) return; clearTimeout(t); fr.removeEventListener('load',on);
      res(!(sd&&sd.includes(SW_OPEN_FAILED_TXT))); };   // the srcdoc route's error page is a failed reload, never Done (GPT review)
    fr.addEventListener('load',on); }); }
  function close(){
    openSeq++;
    if(!S) return;
    S.el.remove(); S=null; removeEventListener('resize',layout);
    $('#frame').classList.remove('ae-side','ae-sheet');
  }
  // The app reloads in place, beside the panel: the same leave-then-load openApp uses (its last save is kept, ADR 0018).
  // Resolves true once the reloaded app loaded, false when it did not within LOAD_MS.
  function reloadApp(){ if(!S) return Promise.resolve(false); bumpGen(); appFrameLeave(); const wait=loaded(); PASW.frameLoad(UID,S.slug); return wait; }   // after the leave: it swaps #fr for a fresh frame
  async function reloadThenDone(){ const me=S; const ok=await reloadApp(); if(!me||S!==me) return;
    say(ok?DONE:RELOAD_FAILED); me.el.querySelector('#aeUndo').style.display=''; }
  function say(t){ if(S&&S.fr.contentWindow) S.fr.contentWindow.postMessage({pa:'edit-note',text:t},'*'); }
  // One Undo at a time (panel or ⋯): a double tap must not take back two changes (GPT review r3).
  let undoing=false;
  async function undo(){
    if(!S||undoing) return; const me=S; undoing=true;
    try{ const r=await api('/api/apps/'+encodeURIComponent(S.slug)+'/undo',{method:'POST'}); const j=await r.json();
      if(S!==me) return;   // another app's panel opened meanwhile: never its Undo (GPT review)
      say(j.text||j.error||('HTTP '+r.status)); if(j.undone) reloadApp(); undoLeft(j.left); }
    catch(err){ say('撤销失败 · Undo failed: '+((err&&err.message)||'')); }
    finally{ undoing=false; }
  }
  // Nothing left to undo: 撤销 · Undo goes (self-test F11: it stayed after both changes were undone).
  function undoLeft(n){ if(S&&n===0) S.el.querySelector('#aeUndo').style.display='none'; }
  // Every event of the panel's chat passes here (the broker's chat relay).
  function onEvent(ev){
    if(!S||!ev||ev.type!=='app-edit'||ev.slug!==S.slug) return;
    if(ev.applied&&!ev.undone) reloadThenDone(); else if(ev.applied) reloadApp();
    if(ev.undone||'left' in ev) undoLeft(ev.left);
  }
  function frameRec(win){ return S&&win&&S.fr.contentWindow===win?S.rec:null; }
  const kindOk=(k)=>KINDS.has(k);
  // The open app's ⋯ and the long-press on its title.
  // How many changes of this app can be undone (0 when the server cannot say: the item is then not shown).
  async function editsLeftOf(slug){ try{ const r=await api('/api/apps/'+encodeURIComponent(slug)+'/edits',{signal:AbortSignal.timeout(EDITS_MS)}); const j=await r.json(); return j&&j.ok?{left:j.left|0,v:String(j.v||'')}:{left:0,v:''}; }
    catch(_){ return {left:0,v:''}; /* offline or refused: no Undo item; the panel's own Undo stays */ } }
  // A short line over the app (no panel open): what the shell's Undo did.
  function shout(t){ let el=$('#aeSay'); if(!el){ el=document.createElement('div'); el.id='aeSay'; el.setAttribute('role','status');
      el.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom));z-index:13;max-width:90vw;padding:10px 14px;border-radius:10px;background:var(--fg,#222);color:var(--bg,#fff);font-size:14px;box-shadow:0 2px 10px rgba(0,0,0,.25)';
      document.body.appendChild(el); }
    el.textContent=t; el.hidden=false; clearTimeout(shout.t); shout.t=setTimeout(()=>{ el.hidden=true; },SAY_MS); }
  // 撤销上次修改 · Undo last change, from the shell's ⋯: the app reloads whether or not its page still has a chat.
  // v: the change the menu offered; the server refuses (409) if a newer one arrived since, never undoing that one instead.
  async function undoFromMenu(slug,v){
    if(undoing) return; undoing=true;
    try{ const r=await api('/api/apps/'+encodeURIComponent(slug)+'/undo?v='+encodeURIComponent(v),{method:'POST'}); const j=await r.json(); const t=j.text||j.error||('HTTP '+r.status);
      if(S&&slug===S.slug){ say(t); undoLeft(j.left); } else shout(t);
      if(j.undone&&frameSlug()===slug&&frameUid()===UID){ bumpGen(); appFrameLeave(); PASW.frameLoad(UID,slug); } }
    catch(err){ shout('撤销失败 · Undo failed: '+((err&&err.message)||'')); }
    finally{ undoing=false; }
  }
  // The menu opens at once; 撤销上次修改 · Undo last change joins it (after Change this app) when the server says one exists.
  function frameMenu(anchor){
    closeMenuPop();
    const slug=frameSlug(), title=$('#ftitle').textContent;
    const m=document.createElement('div'); m.id='frameMenu'; m.className='cmenu-pop';
    m.innerHTML=item()+(window.PADemoAuth?'':PAPublish.item(slug));   // PAPublish decides for a fork (ONE gate); the demo has no Publish
    document.body.appendChild(m);
    placeMenu(m,anchor);
    editsLeftOf(slug).then(({left,v})=>{ if(!(left>0)||!v||!m.isConnected||frameSlug()!==slug||m.querySelector('#aeUndoItem')) return;
      const u=document.createElement('button'); u.dataset.a='undo-app'; u.id='aeUndoItem'; u.dataset.v=v; u.textContent=UNDO_ITEM;
      m.querySelector('#aeItem').after(u); placeMenu(m,anchor); });
    m.onclick=(ev)=>{ const b=ev.target.closest('button'); if(!b) return; closeMenuPop();
      if(b.dataset.a==='edit-app') open(slug,title); else if(b.dataset.a==='undo-app') undoFromMenu(slug,b.dataset.v); else if(b.dataset.a==='publish') PAPublish.open(slug); };
    armTip(); if(!window.PADemoAuth) PAPublish.armTip(slug); armMenuPop(anchor);
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
  // Only a request the SERVER offered to this frame's chat may prefill the panel (GPT review): a tap anywhere in an
  // app also counts as activation here, so the app's own text must never reach the owner's panel.
  const offers=new WeakMap();   // frame element → Set of offered requests
  function noteOffer(el,req){ if(!el||typeof req!=='string') return; if(!offers.has(el)) offers.set(el,new Set()); offers.get(el).add(req); }
  function fromApp(e){
    const m=e.data, fr=$('#fr');
    if(!fr||e.source!==fr.contentWindow||e.origin!=='null'||!canEdit()) return;
    // '' = the button of a reopened reply (stored without its request): the panel opens empty.
    if(typeof m.request!=='string'||(m.request!==''&&!(offers.get(fr)||new Set()).has(m.request))) return;
    if(!(navigator.userActivation&&navigator.userActivation.isActive)) return;
    open(frameSlug(),$('#ftitle').textContent,m.request);
  }
  // An app's own Ask AI asked for the one app chat ({pa:'shell',type:'app-chat'}): the page open in #fr, on a real tap.
  function fromAppChat(e){ const fr=$('#fr'); if(!fr||e.source!==fr.contentWindow||e.origin!=='null'||!canEdit()) return;
    if(!(navigator.userActivation&&navigator.userActivation.isActive)) return; open(frameSlug(),$('#ftitle').textContent); }
  return {item,armTip,open,fromAppChat,close,onEvent,frameRec,kindOk,bindBar,syncBar,fromApp,noteOffer,editAppFromBar:()=>{ if(canEdit()) open(frameSlug(),$('#ftitle').textContent); }};
})();
