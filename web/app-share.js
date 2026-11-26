// PAShare — 分享 · Share an app by link, the shell half (docs/adr/0047-app-share-link.md; server:
// lib/app-share-routes.mjs). Inlined at the PA_APP_SHARE_JS marker (lib/shellhtml.mjs SHELL_PARTS).
// Entry: the open app's ⋯ (web/app-edit.js frameMenu) — the owner on their node, any visitor on the
// demo (a signed-out one is asked to sign in). The sheet is PAPublish's (R3): the link, 复制 · Copy,
// and, where the node has AgentMail, an email field. One-time tip beside the item (PATipsShell).
// On the demo, a link's ?share=<id> is kept across the sign-in round trip; once signed in the shell
// asks for the visitor's own copy and opens it.
const PAShare=(()=>{
  const TIP_KEY='tip:share', PENDING='pa_share_pending', ID_RE=/^[A-Za-z0-9_-]{22}$/, UID_WAIT_MS=10000;
  const L={
    item:'分享 · Share',
    tip:'新：把这个应用的链接发给别人，对方登录后得到自己的一份 · New: send this app as a link — they sign in and get their own copy',
    wait:'正在检查隐私并生成链接… · Checking for private data and making the link…',
    title:'分享链接 · Share link',
    how:'打开链接的人登录后会得到自己的一份副本，数据各自独立；以后你再分享，新来的人会拿到新版本 · Whoever opens it signs in and gets their own copy with their own data; share again later and newcomers get the new version',
    copy:'复制 · Copy', copied:'已复制 · Copied', send:'发送 · Send', sent:'已发送 · Sent', email:'对方邮箱 · Their email',
    demoCopy:'演示版只能复制链接 · On the demo you can copy the link only',
    fail:'分享失败 · Share failed', joining:'正在为你复制应用… · Making your own copy…',
  };
  const demo=()=>!!window.PADemoAuth;
  const allowed=()=>demo()||(typeof ROLE!=='undefined'&&ROLE==='owner');
  function item(){ return allowed()?'<button data-a="share-link" id="shItem">'+L.item+'</button>':''; }
  function armTip(){ if($('#shItem')&&!_SEEN.has(TIP_KEY)) PATipsShell.tip(TIP_KEY,'#shItem',L.tip); }   // the ONE tip mechanism
  const post=(p,body)=>api(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  const hitsLine=(hits)=>'<ul>'+(hits||[]).map(h=>'<li><code>'+esc(h.file)+':'+h.line+'</code> '+esc(h.rule)+(h.text?'<br><small>'+esc(h.text)+'</small>':'')+'</li>').join('')+'</ul>';
  let seq=0;
  async function open(slug){
    if(demo()&&!PADemoAuth.session()){ dispatchEvent(new Event('pa-demo-signin')); return; }   // = SIGNIN_EVENT (lib/demo-boot.mjs)
    const mine=++seq; PAPublish.sheet('<p id="shWait">'+L.wait+'</p>');
    let j; try{ const r=await post('/api/share',{slug}); j=await r.json(); }catch(e){ j={error:(e&&e.message)||''}; }
    if(mine!==seq||!$('#shWait')) return;   // a newer Share, or the wait sheet was dismissed / the app switched: never reopen it
    if(!j||!j.ok) return PAPublish.sheet('<p id="shFail"><b>'+esc((j&&j.error)||L.fail)+'</b></p>'+(j&&j.hits?hitsLine(j.hits):''));
    const s=PAPublish.sheet('<p><b>'+L.title+'</b></p><div style="display:flex;gap:6px"><input id="shUrl" readonly style="flex:1;min-width:0;width:auto" value="'+esc(j.url)+'"><button type="button" id="shCopy" class="primary" style="flex:none;width:auto">'+L.copy+'</button></div>'
      +(j.mail?'<form id="shMail" style="display:flex;gap:6px;margin-top:8px"><input id="shTo" type="email" required autocomplete="email" style="flex:1;min-width:0;width:auto" placeholder="'+L.email+'"><button type="submit" id="shSend" style="flex:none;width:auto">'+L.send+'</button></form><p id="shMailNote" style="font-size:12px;opacity:.7"></p>'
        :(demo()?'<p id="shDemoNote" style="font-size:12px;opacity:.7">'+L.demoCopy+'</p>':''))
      +'<p id="shHow" style="font-size:12px;opacity:.7">'+L.how+'</p>');
    const u=s.querySelector('#shUrl'), c=s.querySelector('#shCopy');
    c.onclick=async()=>{ try{ await navigator.clipboard.writeText(j.url); }catch(_){ u.select(); document.execCommand('copy'); /* no clipboard API (an old WebView): the selected text is copied */ } c.textContent=L.copied; };
    const f=s.querySelector('#shMail'); if(f) f.onsubmit=async(ev)=>{ ev.preventDefault(); const n=s.querySelector('#shMailNote'), b=s.querySelector('#shSend'); b.disabled=true;
      try{ const r=await post('/api/share/email',{id:j.id,to:s.querySelector('#shTo').value,name:j.name}); const k=await r.json(); n.textContent=k.ok?L.sent:(k.error||L.fail); }
      catch(e){ n.textContent=L.fail+': '+((e&&e.message)||''); }
      b.disabled=false; };
  }
  // ---- the demo's receiving end -----------------------------------------------------------------
  function keep(){ try{ const q=new URLSearchParams(location.search), id=q.get('share'); if(id&&ID_RE.test(id)){ localStorage.setItem(PENDING,id); q.delete('share'); history.replaceState(null,'',location.pathname+(q.toString()?'?'+q:'')+location.hash); } return localStorage.getItem(PENDING); }
    catch(_){ return null; /* blocked storage: the link page can be opened again */ } }
  const drop=()=>{ try{ localStorage.removeItem(PENDING); }catch(_){ /* blocked storage: nothing was kept */ } };
  const uidReady=()=>new Promise((res)=>{ const t0=Date.now(); (function look(){ if(typeof UID!=='undefined'&&UID&&hasSession()) return res(true); if(Date.now()-t0>UID_WAIT_MS) return res(false); setTimeout(look,200); })(); });
  const hasSession=()=>{ try{ return !!localStorage.getItem('pa_session'); }catch(_){ return false; } };
  async function boot(){
    const id=keep(); if(!id||!ID_RE.test(id)) return;
    await (PADemoAuth.busy||Promise.resolve());
    if(!PADemoAuth.session()){ setTimeout(()=>dispatchEvent(new Event('pa-demo-signin')),0); return; }   // signed out: the sign-in popover; the id waits in storage
    if(!await uidReady()) return;
    PAPublish.sheet('<p id="shJoining">'+L.joining+'</p>');
    let j; try{ const r=await post('/api/share/'+id+'/join'); j=await r.json(); }catch(e){ j={error:(e&&e.message)||''}; }
    if(!j||!j.ok){ if(j&&j.code==='gone') drop(); return PAPublish.sheet('<p id="shJoinFail"><b>'+esc((j&&j.error)||L.fail)+'</b></p>'); }
    drop(); const sh=$('#pubSheet'); if(sh) sh.remove();
    if(typeof loadApps==='function') await loadApps();
    openApp(UID,j.slug,j.name);
  }
  if(demo()){ if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else setTimeout(boot,0); }
  return {item,armTip,open,L};
})();
