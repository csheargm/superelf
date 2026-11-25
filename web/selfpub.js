// PASelfPub — 发布 · Publish under a 改 superelf reply (docs/adr/0044). Owner only: the server sends the
// 'selfpub' event only on the owner's composer turns and refuses everyone else (lib/selfpub/routes.mjs).
// Flow: 发布 · Publish → the preview sheet (checks, iPhone before/after, files, the diff; nothing sent) →
// the sheet's 发布 · Publish → PR → CI → merge → release → deploy, each step said on the line under the reply.
// The sheet, the scan list and the token steps are PAPublish's own (web/publish.js, R3).
const PASelfPub=(()=>{
  const POLL_MS=5000, TIP_KEY='tip:selfpub';
  const TIP='新：superelf 可以改自己——先看预览，再点 发布 · New: superelf can change itself — check the preview, then tap Publish';
  const url=(id,a)=>'/api/selfpub/'+encodeURIComponent(id)+(a?'/'+a:'');
  const post=(id,a,body)=>api(url(id,a),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
  const DONE=new Set(['live','failed','blocked','waiting']);
  // One line per state, said plainly: what happened, never more.
  function stateLine(st){
    if(!st) return '';
    const v=esc(st.version||''), pr=/^https:\/\//.test(st.pr||'')?` <a href="${esc(st.pr)}" target="_blank" rel="noopener">PR</a>`:'';   // https only: never a javascript: link (GPT review)
    const t={ opening:'正在开 PR · Opening the PR', checking:'PR 已开，CI 检查中（约 5–10 分钟） · PR opened — CI is running (about 5–10 min)',
      merging:'CI 通过，正在合并 · CI green — merging', releasing:'已合并，正在发版 · Merged — cutting the release',
      deploying:`已发版 ${v}，等待部署（约 10 分钟） · Released ${v} — waiting for deploy (about 10 min)`, live:`已上线 ${v} · Live`,
      waiting:esc(st.error||''), blocked:'隐私检查未通过，未发送 · Privacy scan found something; nothing was sent',
      failed:`发布失败（${esc(st.step||'')}） · Publish failed: ${esc(st.error||'')}` }[st.state];
    return (t||esc(st.state))+pr;
  }
  const GONE={ discarded:'已丢弃 · Discarded', superseded:'已并入下面较新的改动 · Folded into the newer change below' };
  function gone(id,text){ const r=rowOf(id); if(!r) return; r.querySelectorAll('.sp-go,.sp-drop').forEach(b=>b.remove()); const l=r.querySelector('.sp-state'); if(l) l.textContent=text; }
  async function discard(id){ try{ const r=await post(id,'discard'); if(r.ok) gone(id,GONE.discarded); }catch{ /* offline: the change stays; try again */ } }
  const rowOf=(id)=>document.querySelector('.sp-row[data-id="'+CSS.escape(id)+'"]');
  function paint(id,st,shown){ const r=rowOf(id); if(!r) return; const l=r.querySelector('.sp-state'); if(l) l.innerHTML=stateLine(st);
    const b=r.querySelector('.sp-go'); if(b&&st&&!(st.state==='failed'&&shown==='ready')) b.remove(); }   // once it is on its way, no second tap
  // Under the reply: the button (ready) or the plain reason (not ready), and the progress line.
  function attach(bubble,ev){
    if(!ev||!ev.id||!bubble) return;
    const row=document.createElement('div'); row.className='sp-row'; row.dataset.id=ev.id;
    row.style.cssText='margin:4px 0 10px;display:flex;flex-direction:column;gap:4px;align-items:flex-start';
    row.innerHTML=(ev.ready?'<button type="button" class="sp-go primary" style="min-height:44px;padding:8px 18px;border-radius:22px">发布 · Publish</button>'
      :'<span style="font-size:13px;opacity:.7">未通过检查，不能发布 · Checks did not pass: cannot publish</span><button type="button" class="sp-drop plain" style="min-height:44px">丢弃这个改动 · Discard this change</button>')+'<span class="sp-state" style="font-size:13px;opacity:.8"></span>';
    bubble.after(row);
    document.querySelectorAll('.sp-row').forEach((r)=>{ if(r!==row) refresh(r.dataset.id); });   // an earlier one may now be folded into this one
    const d=row.querySelector('.sp-drop'); if(d) d.onclick=()=>discard(ev.id);
    const b=row.querySelector('.sp-go'); if(b){ b.id='spGo-'+ev.id; b.onclick=()=>open(ev.id); if(!_SEEN.has(TIP_KEY)) PATipsShell.tip(TIP_KEY,'#spGo-'+ev.id,TIP,{priority:true,dismissOnUse:true,when:()=>!document.getElementById('pubSheet')}); }   // beside the new control now; a tap uses it up; never over the sheet
    refresh(ev.id);
  }
  async function refresh(id){
    let j; try{ const r=await api(url(id)); if(!r.ok) return; j=await r.json(); }catch{ return; /* offline: the line stays as it is */ }
    if(j&&j.status){ paint(id,j.status,j.state); if(!DONE.has(j.status.state)) watch(id); }
    else if(j&&GONE[j.state]) gone(id,GONE[j.state]);
  }
  const watching=new Set();
  async function watch(id){
    if(watching.has(id)) return; watching.add(id);
    try{ for(;;){ await new Promise(r=>setTimeout(r,POLL_MS));
      let j; try{ const r=await api(url(id)); j=await r.json(); }catch{ continue; /* offline for a beat: the publish runs on the node */ }
      if(j&&j.status){ paint(id,j.status,j.state); const s=document.getElementById('spSheetState'); if(s) s.innerHTML=stateLine(j.status); if(DONE.has(j.status.state)) return; } } }
    finally{ watching.delete(id); }
  }
  async function shotUrl(id,n){ try{ const r=await api(url(id,'shot/'+n)); return r.ok?URL.createObjectURL(await r.blob()):''; }catch{ return ''; /* no shot: the sheet says so */ } }
  function checksHtml(p){
    const t=p.verify&&p.verify.tests||{}, rd=p.verify&&p.verify.render||{};
    const sk=t.skipped?`（${t.skipped} 个跳过）`:'', skE=t.skipped?` (${t.skipped} skipped)`:'';
    const tests=t.ci?'测试：由 GitHub CI 运行，CI 通过才合并 · Tests: run by GitHub CI; merges only on green':`测试 ${t.pass||0}/${t.tests||0} 通过${sk} · Tests ${t.pass||0}/${t.tests||0} pass${skE}`;
    const shot=rd.note?esc(rd.note):(rd.shots&&rd.shots.length?'iPhone 宽度（390）截图：改前 / 改后 · iPhone width (390): before / after':'');
    return `<p id="spChecks">${esc(tests)}${shot?'<br>'+shot:''}<br>隐私检查通过 · Privacy scan clean</p>`;
  }
  let openSeq=0;
  async function open(id){
    const mine=++openSeq;
    if(window.PATips&&window.PATips.current()) window.PATips.hide();   // never a tip over the sheet; it shows again later, not stored as seen
    const r=await post(id,'preview'); const j=await r.json().catch(()=>({error:'回复无效 · Bad answer'}));
    if(mine!==openSeq) return;
    if(j.code==='TOKEN_MISSING') return PAPublish.tokenNeeded(j);
    if(!j.preview) return PAPublish.sheet(`<p id="pubFail">${esc(j.error||'发布失败 · Publish failed')}</p>`);
    const p=j.preview;
    if(p.hits.length) return PAPublish.sheet(PAPublish.hitsHtml(p.hits));
    const files=p.files.map(f=>`<li><code>${esc(f.path)}</code> (${f.bytes} B)${f.security?' <b>⚠ 安全相关 · security-relevant</b>':''}</li>`).join('')+p.deletes.map(d=>`<li><code>${esc(d)}</code> 删除 · deleted</li>`).join('');
    const s=PAPublish.sheet(`<p id="spWhat"><b>发布这个 superelf 改动 · Publish this change to superelf</b></p><p id="spTitle">公开的 PR 标题 · Public PR title: <code>${esc(p.title||'')}</code></p>${checksHtml(p)}<div id="spShots" style="display:flex;gap:8px"></div>`
      +`<p><b>改动的文件 · Files changed</b></p><ul id="spFiles">${files}</ul>`
      +(p.refused.length?`<p id="spRefused"><b>含不允许发布的文件 · Has files that are never published:</b> ${p.refused.map(x=>esc(x.file)).join(', ')}</p>`:'')
      +`<details><summary>改动内容 · The diff</summary><pre id="spDiff" style="white-space:pre-wrap;word-break:break-all;font-size:11px">${esc(p.diff)}</pre></details>`
      +`<p>会在 <code>${esc(p.repo||'')}</code> 开 PR；CI 通过后合并、发版，节点约 10 分钟内自动更新。 · Opens a PR on <code>${esc(p.repo||'')}</code>; on green CI it merges and releases, and the node updates itself within about 10 min.</p><p id="spSheetState"></p><button type="button" data-sp="discard" class="plain" style="min-height:44px">丢弃这个改动 · Discard this change</button>`,
      p.ready&&!p.refused.length);
    // The handler goes on NOW, before any await: a later preview reuses the same sheet, and a stale one must never publish it (GPT review).
    const close=s.onclick; s.onclick=(e)=>{ if(mine!==openSeq) return close(e); if(e.target.closest('[data-pub="go"]')){ s.onclick=close; go(id,p.hash,s); }
      else if(e.target.closest('[data-sp="discard"]')){ s.remove(); discard(id); } else close(e); };
    const box=s.querySelector('#spShots');
    for(const n of [0,1]){ const u=await shotUrl(id,n); if(!u||mine!==openSeq||!box.isConnected) continue; const f=document.createElement('figure'); f.style.cssText='margin:0;flex:1;min-width:0';
      f.innerHTML=`<img src="${u}" alt="" style="width:100%;border:1px solid currentColor;border-radius:8px"><figcaption style="font-size:11px;text-align:center">${n?'改后 · After':'改前 · Before'}</figcaption>`; box.appendChild(f); }
  }
  async function go(id,hash,s){
    s.querySelectorAll('#pubGo,[data-sp="discard"]').forEach(b=>b.remove());
    const r=await post(id,'publish',{hash}); const j=await r.json().catch(()=>({error:'回复无效 · Bad answer'}));
    if(j.code==='TOKEN_MISSING') return PAPublish.tokenNeeded(j);
    const st=j.status||{state:'failed',step:'',error:j.error||String(r.status)};
    const l=s.querySelector('#spSheetState'); if(l) l.innerHTML=stateLine(st);
    paint(id,st); if(!DONE.has(st.state)) watch(id);
  }
  // A stream's 'selfpub' event: open = a typed 发布 · publish (open the preview); else the button under the reply.
  function handle(bubble,ev){ if(ev&&ev.open) open(ev.id); else attach(bubble,ev); }
  return { attach, handle, open, stateLine, TIP };
})();
