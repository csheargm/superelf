/* ── Activity log · 活动记录 (F5-10) ── The owner's Settings → Activity log. It shows only what matters
   (lib/activity-view.mjs decides, server side): security events, failures, and app changes. Each row is
   one plain bilingual sentence with the specifics, in the device's local time with the full date.
   An app change shows the request that caused it, plus 撤销 · Undo (newest change only) and
   查看改动 · See the difference while its saved copy is kept. A failure links to ☰ → Needs attention.
   Inlined into the shell at /* PA_ACTIVITY_JS *\/ (lib/shellhtml.mjs); test/activity-log-e2e.test.mjs drives it. */
const ACTIVITY_TITLE='活动记录 · Activity log', ACTIVITY_CLOSE='关闭 · Close';
const ACTIVITY_EMPTY='没有需要你留意的事：这里只记安全事件、失败和应用改动 · Nothing needs you: this log keeps only security events, failures and app changes.';
const ACTIVITY_UNREADABLE='无法加载活动记录 · Could not load the activity log';
const ACTIVITY_TIP_KEY='tip:activity-app-changes', ACTIVITY_TIP='新：应用改动可以在这里撤销或查看改动 · New: undo an app change or see the difference here';
const ACTIVITY_BTN={undo:'撤销 · Undo', diff:'查看改动 · See the difference', fix:'去处理 · Fix it', back:'返回 · Back'};
// One sentence per row: [中文, English]. n = a person's name (or what we know of them).
function activitySentence(r,n){
  const who=n(r.who), by=n(r.by||r.who), app=r.app||r.slug||'', job=r.job||'';
  const S={
    login:[`登录失败：${who}`,`Failed sign-in: ${who}`], setup:['初始设置尝试失败','A setup attempt failed'],
    create:[`${by} 添加了成员 ${r.name||who}`,`${by} added the member ${r.name||who}`], approve:[`${by} 批准 ${who} 加入`,`${by} approved ${who} to join`],
    register:[`${r.name||who} 申请加入`,`${r.name||who} asked to join`], delete:[`${by} 移除了成员 ${who}`,`${by} removed the member ${who}`],
    'password-reset':[`${by} 重设了 ${who} 的密码`,`${by} reset ${who}'s password`], 'set-pin':[`${who} 修改了密码`,`${who} changed their password`],
    'token-rotate':[`${who} 更换了密钥`,`${who} changed their key`],
    'app-edit':[`${who} 修改了应用「${app}」`,`${who} changed the app "${app}"`], 'app-edit-undo':[`${who} 撤销了应用「${app}」的上次修改`,`${who} undid the last change to "${app}"`],
    fork:[`${who} 复制了应用「${app}」`,`${who} copied the app "${app}"`], share:[`${by} 共享了应用「${app}」`,`${by} shared the app "${app}"`],
    unshare:[`${by} 取消共享应用「${app}」`,`${by} stopped sharing "${app}"`], rollback:[`${by} 把共享应用「${app}」回退了一版`,`${by} rolled the shared app "${app}" back one version`],
    'app-publish':[`${who} 发布了应用「${app}」`,`${who} published the app "${app}"`], 'app-update':[`${who} 更新了应用「${app}」`,`${who} updated the app "${app}"`],
    'job-failed':[`任务「${job}」失败`,`The job "${job}" failed`], 'job-retries-exhausted':[`任务「${job}」多次重试仍失败`,`The job "${job}" failed every retry`],
    'node-health-failed':['节点健康检查发现问题','The node health check found a problem'], 'save-data-failed':['数据保存失败','Saving data failed'],
  };
  if(r.ev==='app-edit'&&!r.applied) return [`应用「${app}」的修改没通过检查，已还原`,`A change to "${app}" failed its checks and was rolled back`];
  if(r.ev==='app-publish'&&r.state!=='failed'&&r.state!=='blocked'&&r.state!=='published') return [`${who} 开始发布应用「${app}」`,`${who} started publishing "${app}"`];
  if(r.ev==='app-publish'&&r.state!=='published') return [`应用「${app}」发布失败`,`Publishing "${app}" failed`];
  if(S[r.ev]) return S[r.ev];
  const plain=String(r.ev||'').replace(/-error$/,'-failed').replace(/-/g,' '), what=[app,job].filter(Boolean).join(' ');
  return ['失败',plain.charAt(0).toUpperCase()+plain.slice(1)+(what?` (${what})`:'')];
}
const activityTime=(at)=>{ const d=new Date(at); return isNaN(d)?'':d.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); };
// Critical failures (r.crit, marked by lib/activity-view.mjs) pinned on top; runs of the same sentence fold into "×N".
function activityGroups(rows,n){
  const pin=(r)=>!!r.crit, key=(r)=>activitySentence(r,n).join();
  const out=rows.filter(pin).map((r)=>({r,n:1,crit:true}));
  for(const r of rows){ if(pin(r)) continue; const last=out[out.length-1];
    if(last&&!last.crit&&r.kind!=='app'&&key(last.r)===key(r)) last.n++; else out.push({r,n:1,crit:false}); }
  return out;
}
function activityRowHtml({r,n,crit},names){
  const [zh,en]=activitySentence(r,names), btn=(k,cls)=>`<button class="plain act-${k}" data-k="${k}" data-app="${esc(r.app||'')}" data-v="${esc(r.version||'')}">${ACTIVITY_BTN[k]}</button>`;
  const btns=[r.canUndo&&btn('undo'),r.canDiff&&btn('diff'),r.kind==='failure'&&crit&&btn('fix')].filter(Boolean).join('');
  return `<div class="act-row act-${r.kind}${crit?' act-crit':''}" style="padding:6px ${crit?'8px':'0'};border-bottom:1px solid var(--line)${crit?';border-left:4px solid var(--warn)':''}">
    <div>${crit?'<b>':''}${esc(zh)} · ${esc(en)}${crit?'</b>':''}${n>1?` ×${n}`:''}</div>
    ${r.request?`<div class="act-req" style="font-size:13px">“${esc(r.request)}”</div>`:''}${r.error?`<div style="font-size:13px;color:var(--muted)">${esc(r.error)}</div>`:''}
    <small style="color:var(--muted)">${esc(activityTime(r.at))}</small>${btns?`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${btns}</div>`:''}</div>`;
}
async function activityAct(d,b){
  if(b.dataset.k==='fix'){ d.close(); const c=$('#cfg'); if(c&&c.open) c.close(); openDrawer(); return; }
  if(b.dataset.k==='undo'){ b.disabled=true; let t;
    try{ const r=await api('/api/apps/'+encodeURIComponent(b.dataset.app)+'/undo?v='+encodeURIComponent(b.dataset.v),{method:'POST'}); const j=await r.json(); t=j.text||j.error||r.statusText; }catch(e){ t=ACTIVITY_UNREADABLE+': '+e.message; }
    return showActivityLog(t); }
  let t; try{ const r=await api('/api/admin/activity/diff?app='+encodeURIComponent(b.dataset.app)+'&v='+encodeURIComponent(b.dataset.v)); const j=await r.json(); t=r.ok?j.text:j.error; }catch(e){ t=ACTIVITY_UNREADABLE+': '+e.message; }
  d.querySelector('.act-body').innerHTML=`<pre class="act-diff" style="max-height:60vh;overflow:auto;font-size:12px;white-space:pre-wrap">${esc(t||'')}</pre><button class="plain" id="activityBack">${ACTIVITY_BTN.back}</button>`;
  d.querySelector('#activityBack').onclick=()=>showActivityLog();
}
async function showActivityLog(note){
  let rows=null; const names={};
  try{ const r=await api('/api/admin/activity'); if(!r.ok) throw new Error('HTTP '+r.status); rows=await r.json(); }catch{ rows=null; }   // shown as ACTIVITY_UNREADABLE below (R5)
  try{ (await (await api('/api/admin/users')).json()).forEach((u)=>{ names[u.id]=u.name; }); }catch{ /* names are a nicety: rows still show the account id (R5: deliberate) */ }
  const n=(id)=>names[id]||id||'?';
  let d=document.getElementById('activityLog');
  if(!d){ d=document.createElement('dialog'); d.id='activityLog'; d.style.maxWidth='420px'; document.body.appendChild(d); }
  const tip=rows&&rows.some((r)=>r.canDiff)&&!_SEEN.has(ACTIVITY_TIP_KEY);
  const list=!rows?`<p style="color:var(--danger)">${ACTIVITY_UNREADABLE}</p>`:!rows.length?`<p class="act-empty" style="color:var(--muted)">${ACTIVITY_EMPTY}</p>`
    :'<div class="act-rows" style="max-height:60vh;overflow-y:auto">'+activityGroups(rows,n).map((g)=>activityRowHtml(g,n)).join('')+'</div>';
  d.innerHTML=`<b>${ACTIVITY_TITLE}</b>${typeof note==='string'?`<p class="act-note" style="font-size:13px">${esc(note)}</p>`:''}<div class="act-body">${list}</div><div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="plain" id="activityClose">${ACTIVITY_CLOSE}</button></div>`;
  d.querySelector('#activityClose').onclick=()=>d.close();
  d.querySelector('.act-body').onclick=(e)=>{ const b=e.target.closest('button[data-k]'); if(b) activityAct(d,b); };
  if(!d.open) d.showModal();
  if(tip) PATipsShell.tip(ACTIVITY_TIP_KEY,()=>d.querySelector('.act-rows button[data-k]'),ACTIVITY_TIP);   // the ONE tip mechanism, inside the dialog
}
