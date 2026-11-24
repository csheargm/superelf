/* ── PAOwnerAlerts · 需要处理 · Needs attention (docs/adr/0041-owner-alerts.md) ── OWNER ONLY: a member never
   asks (ROLE) and the server refuses anyway (lib/node-alerts.mjs). While a critical alert is open and not
   snoozed, ☰ carries a softly pulsing amber dot (steady under reduced motion). The drawer opens on ONE card:
   per alert what is wrong and what it means, then the buttons that fix it. Host fixes go through the fixed
   host action channel; what the node cannot do for itself opens the main chat with a request to 管家 filled
   in (never sent for you). The card clears when the next check passes.
   Inlined into the shell at /* PA_OWNER_ALERTS_JS *\/ (lib/shellhtml.mjs); test/owner-alerts-e2e.test.mjs drives it. */
const PAOwnerAlerts=(()=>{
  const URL_='/api/admin/alerts', TIP_KEY='tip:owner-alerts', POLL_MS=4000, POLL_MAX_MS=6*60_000;
  const T={
    head:'需要处理 · Needs attention',
    tip:'新：节点出问题时会在这里提示，并给出一键解决办法 · New: node problems show here, with one-tap fixes',
    again:'再检查 · Check again', snooze:'今天不再提示 · Not today', working:'正在处理… · Working…',
    restarting:'节点正在重启，约 2 分钟 · The node is restarting, about 2 minutes',
    done:'完成 · Done', failed:'没有成功 · Did not work: ', ask:'问管家 · Ask 管家',
    filled:'已填好给管家的请求，检查后点发送 · Your request to 管家 is filled in; check it and tap Send',
    free:'清理空间 · Free up space', rebuild:'重建节点 · Rebuild node',
    rebuildSure:'确认重建（约 2 分钟无法使用）· Confirm: rebuild (about 2 minutes offline)',
    noHelper:'这台节点没有主机助手，按钮无法自动修复 · This node has no host helper, so this cannot be fixed automatically',
  };
  const BOX={system:['系统盘','system disk'],private:['私有数据盘','private data disk'],demo:['演示数据盘','demo data disk'],other:['磁盘','disk']};
  let view=null, busy='', note='', pollUntil=0, armed='';
  const style=document.createElement('style');
  style.textContent=`#menu{position:relative}
.oa-dot{position:absolute;top:4px;right:4px;width:9px;height:9px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 2px var(--card);pointer-events:none;animation:oa-pulse 2s ease-in-out infinite}
@keyframes oa-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.oa-dot{animation:none}}
#oaCard{margin:8px 12px;padding:10px 12px;border:1px solid var(--warn);border-left-width:4px;border-radius:12px;background:var(--card)}
#oaCard b{display:block;margin-bottom:4px}
#oaCard .oa-a{margin:6px 0;font-size:14px;line-height:1.4}
#oaCard .oa-m{color:var(--muted);font-size:13px}
#oaCard .oa-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
#oaCard button{font-size:13px;padding:6px 10px}
#oaCard .oa-note{font-size:13px;margin-top:6px}`;
  document.head.appendChild(style);
  const open=()=>view?view.alerts.filter((a)=>!a.snoozed):[];
  const has=(a)=>!!view&&view.actions.includes(a);
  const recent=(a)=>{ const r=view&&view.results[a]; return r&&Date.now()-Date.parse(r.at)<24*3600_000?r:null; };
  function words(a){
    if(a.kind==='claude') return ['Claude 在这台节点上无法启动 · Claude will not start on this node','管家暂时无法回答问题，重建节点通常能修好 · 管家 cannot answer until this is fixed; a rebuild usually fixes it'];
    if(a.kind==='job') return [`任务「${a.job}」多次重试仍失败 · The job "${a.job}" failed every retry`,'它这次的结果没有送到 · Its result did not arrive this time'];
    const [zh,en]=BOX[a.box]||BOX.other;
    if(a.kind==='disk-unreadable') return [`无法读取${zh}的用量 · Cannot read how full the ${en} is`,'数据盘可能被锁或未挂载 · The box may be locked or not mounted'];
    const still=recent('cleanup-disk');
    return [`${zh}已用 ${a.pct}% · The ${en} is ${a.pct}% full`,
      still?'已经清理过，剩下的是你自己的数据。可以问管家哪些占地方，或在 VM 上给它更多空间（需要你本人操作）· Already cleaned up; what is left is your own data. Ask 管家 what takes the space, or give it more room on the VM (needs you there)'
        :'再满下去，更新和保存可能失败 · If it fills up, updates and saving can fail'];
  }
  const prompt=(a)=>a.kind==='job'?`我的任务「${a.job}」多次重试仍失败，请查明原因并修好。 · My job "${a.job}" failed every retry; please find out why and fix it.`
    :`节点提示：${words(a)[0]}。请帮我看看该怎么办。 · The node says: ${words(a)[0]}. Please help me fix it.`;
  function buttons(a){
    const b=[];
    if(a.kind==='claude'&&has('rebuild-node')) b.push(`<button class="primary" data-oa="rebuild-node">${armed==='rebuild-node'?T.rebuildSure:T.rebuild}</button>`);
    if(a.kind==='disk'&&has('cleanup-disk')&&!recent('cleanup-disk')) b.push(`<button class="primary" data-oa="cleanup-disk">${T.free}</button>`);
    b.push(`<button class="plain" data-ask="${esc(a.id)}">${T.ask}</button>`);
    return b.join('');
  }
  function paint(){
    const n=open().length, m=$('#menu');
    let d=m&&m.querySelector('.oa-dot');
    if(n&&m&&!d){ d=document.createElement('span'); d.className='oa-dot'; m.appendChild(d); m.setAttribute('aria-label','菜单（需要处理）· Menu (needs attention)'); }
    if(!n&&d){ d.remove(); m.setAttribute('aria-label','菜单 · Menu'); }
    render();
  }
  function render(){
    let c=$('#oaCard');
    const list=open();
    if(!list.length&&!note){ if(c) c.remove(); return; }
    if(!c){ c=document.createElement('div'); c.id='oaCard'; c.setAttribute('role','alert'); $('#drawer .dhead').after(c); }
    const tip=_SEEN.has(TIP_KEY)?'':`<div class="oa-m oa-tip">${T.tip}</div>`;
    const helper=list.some((a)=>a.kind!=='job')&&!view.actions.length?`<div class="oa-m">${T.noHelper}</div>`:'';
    c.innerHTML=`<b>${T.head}</b>${tip}`+list.map((a)=>{ const [what,means]=words(a);
      return `<div class="oa-a" data-id="${esc(a.id)}">${esc(what)}<div class="oa-m">${esc(means)}</div><div class="oa-btns">${busy?'':buttons(a)}</div></div>`; }).join('')
      +helper+(note?`<div class="oa-note">${esc(note)}</div>`:'')
      +(list.length&&!busy?`<div class="oa-btns"><button class="plain" data-oa="recheck">${T.again}</button><button class="plain" data-snooze>${T.snooze}</button></div>`:'');
    if(tip&&$('#drawer').classList.contains('open')){ _SEEN.add(TIP_KEY); _saveSeen(); }   // seen only once it was on screen
    c.onclick=onClick;
  }
  async function onClick(ev){
    const t=ev.target.closest('button'); if(!t) return;
    if(t.dataset.ask){ const a=open().find((x)=>x.id===t.dataset.ask); if(!a) return; closeDrawer(); goHome(); const box=$('#box'); box.value=prompt(a); box.focus(); note=T.filled; render(); return; }
    if(t.hasAttribute('data-snooze')){ const mid=new Date(); mid.setHours(24,0,0,0);
      await Promise.all(open().map((a)=>api(URL_+'/snooze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:a.id,until:mid.toISOString()})})));
      note=''; return refresh(); }
    const act=t.dataset.oa; if(!act) return;
    if(act==='rebuild-node'&&armed!==act){ armed=act; render(); return; }
    armed='';
    if(act==='recheck'&&!has('recheck')){ note=''; return refresh(); }
    let r; try{ r=await api(URL_+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:act})}); }catch{ r=null; }
    if(!r||!r.ok){ let e=''; try{ e=(await r.json()).error; }catch{ /* no body: the status alone is shown */ } note=T.failed+(e||(r?'HTTP '+r.status:'offline')); render(); return; }
    busy=act; note=act==='rebuild-node'?T.restarting:T.working; pollUntil=Date.now()+POLL_MAX_MS; render(); poll();
  }
  async function poll(){
    const ok=await refresh(true);
    if(busy&&ok&&!view.pending.includes(busy)){ const r=view.results[busy]; note=r?(r.ok?T.done:T.failed+r.msg):''; busy=''; paint(); return; }
    if(busy&&Date.now()<pollUntil) setTimeout(poll,POLL_MS);
    else if(busy){ busy=''; note=T.failed+'timeout'; render(); }
  }
  // true when the node answered. A refused or unreachable read keeps the last view (R5 case c: the dot is a
  // hint; while a rebuild restarts the node the read is EXPECTED to fail, and poll() keeps asking).
  async function refresh(quiet){
    if(ROLE!=='owner') return false;
    try{ const r=await api(URL_); if(!r.ok) return false; view=await r.json(); }catch{ return false; }
    if(!quiet||!busy) paint(); else render();
    return true;
  }
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&!busy) refresh(); });
  return {refresh,render,state:()=>({view,busy,note})};
})();
