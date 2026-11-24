/* ── Activity log · 活动记录 (F5-10) ── The owner's Settings → Activity log opens this dialog instead of a
   native alert(): newest first, each row in the device's local time with the full date, a plain bilingual
   label instead of the raw event name, and the person's name instead of their account id.
   Inlined into the shell at /* PA_ACTIVITY_JS *\/ (lib/shellhtml.mjs); test/activity-log-e2e.test.mjs drives it. */
const ACTIVITY_TITLE='活动记录 · Activity log', ACTIVITY_EMPTY='还没有活动 · No activity yet.', ACTIVITY_CLOSE='关闭 · Close';
const ACTIVITY_UNREADABLE='无法加载活动记录 · Could not load the activity log';
const ACTIVITY_ROWS=50;
const ACTIVITY_LABELS={
  login:'登录 · Sign-in', setup:'初始设置 · Setup', 'health-setup':'健康设置 · Health setup', register:'申请加入 · Join request',
  approve:'批准成员 · Member approved', create:'添加成员 · Member added', delete:'移除成员 · Member removed',
  'set-pin':'修改密码 · Password changed', 'password-reset':'重设密码 · Password reset', 'token-rotate':'更换密钥 · Key changed',
  share:'共享应用 · App shared', unshare:'取消共享 · App unshared', fork:'复制应用 · App copied', rollback:'回退应用 · App rolled back',
  'job-run':'任务运行 · Job ran', 'job-failed':'任务失败 · Job failed', 'job-retries-exhausted':'任务多次失败 · Job failed again',
  'job-created':'新建任务 · Job created', 'job-updated':'修改任务 · Job changed', 'job-deleted':'删除任务 · Job deleted',
  'reminder-sent':'已发送提醒 · Reminder sent', 'reminder-failed':'提醒失败 · Reminder failed', 'reminder-removed':'删除提醒 · Reminder removed',
  'restore-data':'恢复数据 · Data restored', 'save-data-failed':'数据保存失败 · Data save failed', restart:'重启 · Restarted',
  'reload-config':'设置已重新加载 · Settings reloaded', 'config-set':'设置已更改 · Settings changed', 'chat-cancelled':'已停止回答 · Answer stopped',
  'node-health-failed':'节点健康检查发现问题 · Node health check found a problem', 'node-action':'节点修复操作 · Node fix requested',
};
// Critical rows (docs/adr/0041): pinned on top for a week and marked; everything else is routine and
// runs of the same label fold into one row "label ×N". The fixes themselves live in ☰ → Needs attention.
const ACTIVITY_CRITICAL=new Set(['node-health-failed','job-retries-exhausted','save-data-failed']), ACTIVITY_PIN_MS=7*24*3600_000;
function activityGroups(rows,now=Date.now()){
  const pin=(r)=>ACTIVITY_CRITICAL.has(r.ev)&&now-Date.parse(r.at)<ACTIVITY_PIN_MS;
  const out=rows.filter(pin).map((r)=>({r,n:1,crit:true}));
  for(const r of rows){ if(pin(r)) continue; const last=out[out.length-1];
    if(last&&!last.crit&&activityLabel(last.r)===activityLabel(r)&&last.r.who===r.who) last.n++; else out.push({r,n:1,crit:false}); }
  return out;
}
// A known event's label; else the event in plain words ("briefing-email-failed" → "Briefing email failed").
function activityLabel(r){
  const ev=String(r&&r.ev||''), plain=ev.replace(/-error$/,'-failed').replace(/-/g,' ');
  const base=ACTIVITY_LABELS[ev]||(/ failed$/.test(plain)?'失败 · ':'事件 · ')+plain.charAt(0).toUpperCase()+plain.slice(1);
  return r&&r.ok===false?base+' — 失败 · failed':base;
}
const activityTime=(at)=>{ const d=new Date(at); return isNaN(d)?'':d.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); };
async function showActivityLog(){
  let rows=null, names={};
  try{ const r=await api('/api/admin/audit'); if(!r.ok) throw new Error('HTTP '+r.status); rows=await r.json(); }catch{ rows=null; }   // shown as ACTIVITY_UNREADABLE below (R5)
  try{ (await (await api('/api/admin/users')).json()).forEach((u)=>{ names[u.id]=u.name; }); }catch{ /* names are a nicety: rows still show, with no name (R5: deliberate) */ }
  let d=document.getElementById('activityLog');
  if(!d){ d=document.createElement('dialog'); d.id='activityLog'; d.style.maxWidth='420px'; document.body.appendChild(d); }
  const list=!rows?`<p style="color:var(--danger)">${ACTIVITY_UNREADABLE}</p>`:!rows.length?`<p style="color:var(--muted)">${ACTIVITY_EMPTY}</p>`
    :'<div class="act-rows" style="max-height:60vh;overflow-y:auto">'+activityGroups(rows).slice(0,ACTIVITY_ROWS).map(({r,n,crit})=>`<div class="act-row${crit?' act-crit':''}" style="padding:6px ${crit?'8px':'0'};border-bottom:1px solid var(--line)${crit?';border-left:4px solid var(--warn)':''}">
      <div>${crit?'<b>':''}${esc(activityLabel(r))}${crit?'</b>':''}${n>1?` ×${n}`:''}${r.who&&names[r.who]?` <small style="color:var(--muted)">· ${esc(names[r.who])}</small>`:''}</div>
      <small style="color:var(--muted)">${esc(activityTime(r.at))}</small></div>`).join('')+'</div>';
  d.innerHTML=`<b>${ACTIVITY_TITLE}</b>${list}<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="plain" id="activityClose">${ACTIVITY_CLOSE}</button></div>`;
  d.querySelector('#activityClose').onclick=()=>d.close();
  if(!d.open) d.showModal();
}
