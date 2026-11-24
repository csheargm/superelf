// PAPublish — 发布 · Publish an app to the public repo (docs/adr/0039). Owner only: the item is added
// to the app's ⋯ menu only for the owner, and the server checks again (lib/publish/routes.mjs).
// Flow: ⋯ → Publish → confirm sheet (the files that would leave + the privacy scan) → Publish →
// notice "已发布 vX · Published" with the PR link, or the step that failed and why.
const PAPublish=(()=>{
  const POLL_MS=5000, TERMINAL=new Set(['published','failed','blocked']);
  const TIP_KEY='tip:publish';
  const url=(slug)=>'/api/apps/'+encodeURIComponent(slug)+'/publish';
  const post=(slug,body)=>api(url(slug),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  // The menu item; the first time it is on screen it carries the one-time bilingual tip line.
  function item(){
    const seen=_SEEN.has(TIP_KEY);
    return '<button data-a="publish" id="pubItem">发布到公开仓库 · Publish'
      +(seen?'':'<span class="pub-tip" style="display:block;font-size:11px;opacity:.75">新：审核后公开分享此应用 · New: share this app publicly after a privacy check</span>')+'</button>';
  }
  function armTip(){ const b=$('#pubItem'); if(b) markNew(b,TIP_KEY); }
  function sheet(html){
    let s=$('#pubSheet'); if(!s){ s=document.createElement('div'); s.id='pubSheet'; s.className='cmenu-pop';
      s.style.cssText='left:8px;right:8px;top:64px;max-height:70vh;overflow:auto;padding:12px;font-size:14px'; document.body.appendChild(s); }
    s.innerHTML=html+'<div style="text-align:right;margin-top:10px"><button data-pub="close" class="plain">关闭 · Close</button></div>';
    s.onclick=(e)=>{ const b=e.target.closest('[data-pub]'); if(b&&b.dataset.pub==='close') s.remove(); };
    return s;
  }
  const hitsHtml=(hits)=>'<p><b>隐私检查未通过 · Privacy scan found something</b></p><ul>'
    +hits.map(h=>`<li><code>${esc(h.file)}:${h.line}</code> ${esc(h.rule)}<br><small>${esc(h.text||'')}</small></li>`).join('')+'</ul>';
  function tokenNeeded(j){ sheet(`<p id="pubToken"><b>${esc(j.error)}</b></p><ol>${(j.steps||[]).map(s=>`<li>${esc(s)}</li>`).join('')}</ol>`); }
  function notice(st){
    const pr=st.pr?` <a href="${esc(st.pr)}" target="_blank" rel="noopener">PR</a>`:'';
    if(st.state==='published') return sheet(`<p id="pubDone">已发布 ${esc(st.version||'')} · Published${pr}</p>`);
    if(st.state==='blocked') return sheet(hitsHtml(st.hits||[]));
    if(st.state==='failed') return sheet(`<p id="pubFail">发布失败（${esc(st.step||'')}） · Publish failed: ${esc(st.error||'')}${pr}</p>`);
    return sheet(`<p id="pubWait">正在发布，等待 CI · Publishing, waiting for CI${pr}</p>`);
  }
  async function watch(slug){
    for(;;){ await new Promise(r=>setTimeout(r,POLL_MS));
      let j; try{ const r=await api(url(slug)); j=await r.json(); }catch{ continue; /* offline for a beat: the publish runs on the node; look again */ }
      if(j&&j.status){ if(TERMINAL.has(j.status.state)){ notice(j.status); return; } } }
  }
  async function go(slug){
    const r=await post(slug,{}); const j=await r.json().catch(()=>({error:'回复无效 · Bad answer'}));
    if(j.code==='TOKEN_MISSING') return tokenNeeded(j);
    if(!j.status) return sheet(`<p id="pubFail">发布失败 · Publish failed: ${esc(j.error||r.status)}</p>`);
    notice(j.status); if(!TERMINAL.has(j.status.state)) watch(slug);
  }
  async function open(slug){
    const r=await post(slug,{preview:true}); const j=await r.json().catch(()=>({error:'回复无效 · Bad answer'}));
    if(j.code==='TOKEN_MISSING') return tokenNeeded(j);
    if(!j.preview) return sheet(`<p id="pubFail">${esc(j.error||'发布失败 · Publish failed')}</p>`);
    const p=j.preview;
    if(p.hits.length) return sheet(hitsHtml(p.hits));
    const s=sheet(`<p><b>将公开以下文件 · These files will be public</b></p><ul id="pubFiles">${p.files.map(f=>`<li><code>${esc(f.path)}</code> (${f.bytes} B)</li>`).join('')}</ul>`
      +(p.refused.length?`<p>不发布 · Not published: ${p.refused.map(x=>esc(x.file)).join(', ')}</p>`:'')
      +'<p>隐私检查通过；CI 通过后自动合并并发版 · Privacy scan clean; merges and releases when CI is green.</p>'
      +'<button data-pub="go" id="pubGo">发布 · Publish</button>');
    // ONE handler, replaced on every sheet (sheet() resets onclick): a stale preview can never publish.
    const close=s.onclick; s.onclick=(e)=>{ if(e.target.closest('[data-pub="go"]')){ s.onclick=null; go(slug); } else close(e); };
  }
  return { item, armTip, open };
})();
