// PAPublish — 发布 · Publish an app to the public repo (docs/adr/0039). Owner only: the item is added
// to the app's ⋯ menu only for the owner, and the server checks again (lib/publish/routes.mjs).
// Flow: ⋯ → Publish → confirm sheet (the files that would leave + the privacy scan) → Publish →
// notice "已发布 vX · Published" with the PR link, or the step that failed and why.
const PAPublish=(()=>{
  const POLL_MS=5000, TERMINAL=new Set(['published','failed','blocked']);
  const TIP_KEY='tip:publish';
  // CI_MINUTES: measured from recent CI runs on main (4-9 min, 2026-11-24; PR 1 took 4.5 min).
  const WAIT_TEXT='正在发布，CI 约需 5–10 分钟。可以关闭此窗口，完成后会提示（或下次打开 ⋯ 菜单时显示） · Publishing — CI takes about 5–10 minutes. You can close this; you\'ll be told when it\'s done (or see it next time you open the ⋯ menu).';
  const WHAT_TEXT='发布会先检查隐私，再在 GitHub 上开一个合并请求（PR）；CI 检查通过后自动合并，此应用成为 superelf 的一部分，所有人可见，下次部署后出现在演示站。 · Publishing first scans for private data, then opens a pull request on GitHub; when CI checks pass it merges, the app becomes part of superelf for everyone, and it appears on the demo after the next deploy.';
  const url=(slug)=>'/api/apps/'+encodeURIComponent(slug)+'/publish';
  const post=(slug,body)=>api(url(slug),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  // The menu item; its one-time bilingual tip is a PATips tip beside it (armTip).
  // The second line (#pubState) says what Publish would do for THIS app; check() fills it in.
  // A copy (meta.json forkedFrom): the OWNER's copy of a repo app publishes back to that app (the server
  // decides, lib/publish/copy-target.mjs; check() swaps the item for the server's line when it cannot).
  // Anyone else sees one quiet line: publishing is the node owner's (lib/publish/routes.mjs answers 403).
  const MEMBER_FORK_LINE='发布只对节点主人开放 · Only the node\'s owner can publish apps';
  const isFork=(slug)=>typeof FORK_APPS!=='undefined'&&FORK_APPS.has(slug);
  const isOwner=()=>typeof ROLE!=='undefined'&&ROLE==='owner';
  const forkLine=(t)=>'<div id="pubFork" style="padding:8px 12px;font-size:12px;opacity:.65">'+esc(t)+'</div>';
  const copyText=(c)=>`更新共享应用 ${c.title} · Updates the shared app ${c.title}`;
  function item(slug){
    if(isFork(slug)&&!isOwner()) return forkLine(MEMBER_FORK_LINE);
    // The owner's copy waits, off, until the server says where it goes (showState): no tap that can only refuse.
    return '<button data-a="publish" id="pubItem"'+(isFork(slug)?' disabled style="opacity:.5;pointer-events:none"':'')+'>发布到公开仓库 · Publish to the public repo'
      +'<span id="pubState" style="display:block;font-size:11px;opacity:.65"></span>'
      +'</button>';
  }
  // repo: { inRepo, upToDate, changedFiles } from the server (lib/publish/status.mjs), or null.
  function stateText(repo){
    if(!repo) return '';
    if(!repo.inRepo) return '分享为公开应用（所有人可见） · Share as a public app (everyone can see it)';
    if(repo.upToDate) return '已是最新 · Already up to date';
    return `有 ${repo.changedFiles} 处改动未发布 · ${repo.changedFiles} change${repo.changedFiles===1?'':'s'} not yet published`;
  }
  // b: the item of the menu that asked — a late answer for app A never touches app B's menu.
  function showState(b,repo,j){
    if(j&&j.refused&&b&&b.isConnected){ b.outerHTML=forkLine(j.refused.error); return; }   // a copy that cannot go back: say why, no button
    const l=b&&b.isConnected&&b.querySelector('#pubState'); if(!l) return;
    l.textContent=[j&&j.copyOf?copyText(j.copyOf):'',stateText(repo)].filter(Boolean).join(' — ');
    const off=!!(repo&&repo.upToDate); b.disabled=off;   // also turns on the owner's copy item held off in item()
    b.style.opacity=off?'.5':''; b.style.pointerEvents=off?'none':'';   // a tap on the line text must not reach the menu's handler
    // The line arrives after the menu was placed: keep the menu's bottom on screen.
    const pm=b.closest('.cmenu-pop'); if(pm&&pm._paAnchor&&pm._paAnchor.isConnected) placeMenu(pm,pm._paAnchor);   // wider now: never past the left edge (menu-anchor-e2e, 390)
    const m=b.closest('#appMenu'); if(m&&m.style.top){ const over=m.getBoundingClientRect().bottom-(innerHeight-6); if(over>0) m.style.top=Math.max(6,parseFloat(m.style.top)-over)+'px'; }
  }
  // armTip(slug) runs each time the owner's ⋯ menu opens: it also shows a publish result the owner
  // has not seen yet (they closed the wait sheet, or left the app), and re-attaches the watcher to
  // a publish still running. The node keeps the status in memory, so a node restart forgets it.
  const TIP='新：审核后公开分享此应用 · New: share this app publicly after a privacy check';
  function armTip(slug){ if(isFork(slug)&&!isOwner()) return; const b=$('#pubItem'); if(b&&!_SEEN.has(TIP_KEY)) PATipsShell.tip(TIP_KEY,'#pubItem',TIP); if(b&&slug) check(slug); }   // the ONE tip mechanism
  const SEEN_KEY=(slug)=>'pub:seen:'+slug;
  const seenAt=(slug)=>{ try{ return localStorage.getItem(SEEN_KEY(slug)); }catch{ return null; /* no storage: show it again, harmless */ } };
  const markSeen=(slug,st)=>{ try{ localStorage.setItem(SEEN_KEY(slug),String(st.at)); }catch{ /* no storage: the result may show once more */ } };
  const watching=new Set();
  async function check(slug){
    const b=$('#pubItem');
    let j; try{ const r=await api(url(slug)); if(!r.ok) return; /* no answer: the owner's copy item stays off */ j=await r.json(); }catch{ return; /* offline: the next ⋯ open looks again */ }
    showState(b,j&&j.repo,j);
    const st=j&&j.status; if(!st) return;
    if(TERMINAL.has(st.state)){ if(seenAt(slug)!==String(st.at)){ notice(st); markSeen(slug,st); } }
    else watch(slug);
  }
  // The sheet stands out from the page (owner report 2026-11-26): a dimming #pubScrim behind it covers the
  // page and the app frame; a tap on it closes the sheet like 关闭 · Close. It is a modal dialog: focus stays
  // in it (Tab wraps). Whoever removes #pubSheet (Close, Escape, leaving the app) takes the scrim with it.
  function sheet(html,withGo){
    let s=$('#pubSheet'); if(!s){ s=document.createElement('div'); s.id='pubSheet'; s.className='cmenu-pop';
      s.setAttribute('role','dialog'); s.setAttribute('aria-modal','true'); s.tabIndex=-1;
      s.style.cssText='left:8px;right:8px;top:auto;bottom:calc(8px + env(safe-area-inset-bottom));max-height:60vh;overflow:auto;padding:12px;font-size:14px'; document.body.appendChild(s); }   // at the bottom: never over the app's header or its chips (owner report 2026-11-25)
    if(!$('#pubScrim')){ const m=document.createElement('div'); m.id='pubScrim'; m.onclick=()=>s.remove(); document.body.insertBefore(m,s);
      document.querySelectorAll('.pac-mmenu').forEach((x)=>x.remove()); }   // the shell's model menu (z 50) would stand over the modal: opened from an app or a chat action no shell click closed it
    s.innerHTML=html+'<div class="sheet-acts"><button data-pub="close" class="plain" id="pubClose">关闭 · Close</button>'+(withGo?'<button data-pub="go" id="pubGo" class="primary">发布 · Publish</button>':'')+'</div>';
    s.onclick=(e)=>{ const b=e.target.closest('[data-pub]'); if(b&&b.dataset.pub==='close') s.remove(); };
    s.onkeydown=trapTab;
    if(!s.contains(document.activeElement)) s.focus({preventScroll:true});
    return s;
  }
  function trapTab(e){
    if(e.key!=='Tab') return;
    const f=[...e.currentTarget.querySelectorAll('button,input,textarea,select,a[href]')].filter((x)=>!x.disabled&&x.offsetParent);
    if(!f.length) return;
    const first=f[0], last=f[f.length-1];
    if(e.shiftKey&&(document.activeElement===first||document.activeElement===e.currentTarget)){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
  }
  new MutationObserver(()=>{ const m=$('#pubScrim'); if(m&&!$('#pubSheet')) m.remove(); }).observe(document.body,{childList:true});
  const hitsHtml=(hits)=>'<p><b>隐私检查未通过 · Privacy scan found something</b></p><ul>'
    +hits.map(h=>`<li><code>${esc(h.file)}:${h.line}</code> ${esc(h.rule)}<br><small>${esc(h.text||'')}</small></li>`).join('')+'</ul>';
  function tokenNeeded(j){ sheet(`<p id="pubToken"><b>${esc(j.error)}</b></p><ol>${(j.steps||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ol>`); }
  function notice(st){
    const pr=st.pr?` <a href="${esc(st.pr)}" target="_blank" rel="noopener">PR</a>`:'';
    if(st.state==='published') return sheet(`<p id="pubDone">已发布 ${esc(st.version||'')} · Published${pr}</p>`);
    if(st.state==='blocked') return sheet(hitsHtml(st.hits||[]));
    if(st.state==='failed') return sheet(`<p id="pubFail">发布失败（${esc(st.step||'')}） · Publish failed: ${esc(st.error||'')}${pr}</p>`);
    return sheet(`<p id="pubWait">${WAIT_TEXT}${pr}</p>`);
  }
  async function watch(slug){
    if(watching.has(slug)) return; watching.add(slug);
    try{ for(;;){ await new Promise(r=>setTimeout(r,POLL_MS));
      let j; try{ const r=await api(url(slug)); j=await r.json(); }catch{ continue; /* offline for a beat: the publish runs on the node; look again */ }
      if(j&&j.status){ if(TERMINAL.has(j.status.state)){ notice(j.status); markSeen(slug,j.status); return; } } } }
    finally{ watching.delete(slug); }
  }
  async function go(slug,hash){
    const r=await post(slug,{hash}); const j=await r.json().catch(()=>({error:'回复无效 · Bad answer'}));
    if(j.code==='TOKEN_MISSING') return tokenNeeded(j);
    if(!j.status) return sheet(`<p id="pubFail">发布失败 · Publish failed: ${esc(j.error||r.status)}</p>`);
    notice(j.status); if(TERMINAL.has(j.status.state)) markSeen(slug,j.status); else watch(slug);
  }
  let openSeq=0;
  async function open(slug){
    const gen=typeof popGen==='function'?popGen():0, mine=++openSeq;   // web/popover.js: the user left the app, or opened another preview, meanwhile → no stale sheet
    const r=await post(slug,{preview:true}); const j=await r.json().catch(()=>({error:'回复无效 · Bad answer'}));
    if(mine!==openSeq||(typeof popGen==='function'&&gen!==popGen())) return;
    if(j.code==='TOKEN_MISSING') return tokenNeeded(j);
    if(!j.preview) return sheet(`<p id="pubFail">${esc(j.error||'发布失败 · Publish failed')}</p>`);
    const p=j.preview;
    if(p.hits.length) return sheet(hitsHtml(p.hits));
    const s=sheet((p.copyOf?`<p id="pubCopy"><b>${esc(copyText(p.copyOf))}</b></p>`:'')+`<p id="pubWhat">${WHAT_TEXT}</p><p><b>将公开以下文件 · These files will be public</b></p><ul id="pubFiles">${p.files.map(f=>`<li><code>${esc(f.path)}</code> (${f.bytes} B)</li>`).join('')}</ul>`
      +(p.refused.length?`<p>不发布 · Not published: ${p.refused.map(x=>esc(x.file)).join(', ')}</p>`:'')
      +`<p id="pubRepo">目标仓库 · Repository: <code>${esc(p.repo||'')}</code></p>`
      +'<p>隐私检查通过；CI 通过后自动合并并发版 · Privacy scan clean; merges and releases when CI is green.</p>',true);
    // ONE handler, replaced on every sheet (sheet() resets onclick): a stale preview can never publish.
    const close=s.onclick; s.onclick=(e)=>{ if(e.target.closest('[data-pub="go"]')){ s.onclick=null; go(slug,p.hash); } else close(e); };
  }
  return { item, armTip, open, stateText, copyText, sheet, hitsHtml, tokenNeeded, WAIT_TEXT, WHAT_TEXT, MEMBER_FORK_LINE };   // sheet/hitsHtml/tokenNeeded: also core Publish (web/selfpub.js, R3)
})();
