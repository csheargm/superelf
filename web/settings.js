/* ── Settings & family management ── */
let ME={};
async function loadProfile(){
  try{ ME=await (await api('/api/profile')).json(); }catch{ ME={}; }
  $('#pName').value=ME.name||''; $('#pAbout').value=ME.about||''; $('#pPrefs').value=ME.prefs||'Short and plain, no preamble · bullet points, not paragraphs · EN + 中文 for technical terms · explain simply · be direct';
  $('#pAutoUpdate').checked=!!ME.autoUpdateApps;
  $('#pAge').textContent = ME.age!=null ? `Age ${ME.age} · role: ${ME.role}` : `role: ${ME.role||'member'}`;
  $('#pBriefEmail').value=ME.briefingEmail||'';
  $('#pRetainDays').value=ME.briefingRetainDays||30;
  $('#pPostcode').value=ME.postcode||'';
  $('#agentMailWrap').style.display=ME.role==='owner'?'block':'none';   // the node's inbox address is owner-facing setup (like the family/shelf blocks)
  $('#nodeCfgWrap').style.display=ME.role==='owner'?'block':'none';     // Node settings · 节点设置 — owner-only config surface (server re-checks role)
  renderAdvanced();
}

/* ── Advanced settings: user-editable AI system prompts ──
   Each box shows the EFFECTIVE value (the user's override if set, else the config
   default). "Reset to default" refills the box with the default text; on save a box
   left equal to (or blank against) its default is sent blank so the server drops the
   override and the built-in default keeps flowing. */
let SYS_DEFAULTS={global:'',apps:{}};
function renderAdvanced(){
  SYS_DEFAULTS=ME.systemPromptDefaults||{global:'',apps:{}};
  const over=ME.systemPrompts||{};
  $('#spGlobal').value = over.global!=null ? over.global : (SYS_DEFAULTS.global||'');
  // Show a box per configured app directive, plus any app the user already overrode.
  const slugs=[...new Set([...Object.keys(SYS_DEFAULTS.apps||{}), ...Object.keys(over.apps||{})])];
  $('#spApps').innerHTML = slugs.map(s=>{
    const val = (over.apps&&over.apps[s]!=null) ? over.apps[s] : ((SYS_DEFAULTS.apps||{})[s]||'');
    return `<label style="font-size:13px;display:block;margin-top:8px">${esc(s)} directive<br><textarea data-spapp="${esc(s)}" rows="3" style="width:100%;padding:8px;margin:4px 0 2px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px">${esc(val)}</textarea></label><button type="button" class="plain" data-spreset="${esc(s)}" style="font-size:12px;padding:2px 8px" formnovalidate>Reset to default</button>`;
  }).join('') || '<div style="color:var(--muted);font-size:12px;margin-top:6px">No app directives configured.</div>';
  $('#advWrap').querySelectorAll('[data-spreset]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.spreset;
    if(k==='__global') $('#spGlobal').value=SYS_DEFAULTS.global||'';
    else{ const ta=$('#spApps').querySelector(`[data-spapp="${CSS.escape(k)}"]`); if(ta) ta.value=(SYS_DEFAULTS.apps||{})[k]||''; }
  });
}
// Collect only genuine overrides: a box blank or matching its default → omitted, so the
// server clears that override (blank/absent = use default). Sends the full current state.
function collectSystemPrompts(){
  const sp={}, g=$('#spGlobal').value;
  if(g.trim() && g.trim()!==String(SYS_DEFAULTS.global||'').trim()) sp.global=g;
  const apps={};
  $('#spApps').querySelectorAll('[data-spapp]').forEach(ta=>{
    const def=String((SYS_DEFAULTS.apps||{})[ta.dataset.spapp]||'').trim();
    if(ta.value.trim() && ta.value.trim()!==def) apps[ta.dataset.spapp]=ta.value;
  });
  if(Object.keys(apps).length) sp.apps=apps;
  return sp;
}
/* ── Health setup · 健康接入: the copyable URL + token for the iPhone Shortcut.
   Fetched only when the section is opened (the token is sensitive — never loaded
   NO QR any more: it encoded JSON CONTAINING a url, so iOS Camera offered to OPEN that
   url — an unauthenticated GET answering "bad token", which read as a broken setup. The
   phone is already on Tailscale (the upload needs it), so it just opens this panel. */
let healthSetupLoaded=false;
$('#healthWrap').addEventListener('toggle',async()=>{
  if(!$('#healthWrap').open||healthSetupLoaded) return;
  let s=null; try{ s=await (await api('/api/health/setup')).json(); }catch{ /* handled below: !s shows the error line */ }
  if(!s||!s.ok){ $('#healthSetupTxt').textContent='Could not load setup info · 无法加载接入信息'; return; }
  healthSetupLoaded=true;
  $('#healthSetupTxt').innerHTML=`<div style="margin-bottom:4px"><b>URL</b> ${esc(s.url)}</div><div><b>Token 令牌</b> ${esc(s.token)}</div><button type="button" class="plain" id="hsCopy" style="font-size:12px;padding:2px 8px;margin-top:6px">Copy · 复制</button><button type="button" class="plain" id="hsRotate" style="font-size:12px;padding:2px 8px;margin-left:6px">Regenerate · 重新生成</button><span id="hsCopied" style="font-size:12px;color:var(--muted);margin-left:6px"></span>`;
  $('#hsCopy').onclick=async()=>{ try{ await navigator.clipboard.writeText(`URL: ${s.url}\nToken: ${s.token}`); $('#hsCopied').textContent='copied · 已复制'; }catch{ $('#hsCopied').textContent='copy failed — select the text above · 复制失败，请手动选择上方文本'; } };
  // Rotating REVOKES the current token everywhere at once. A health Shortcut using it stops
  // working immediately and fails with the same "bad token" 401 an unauthenticated request
  // gets — indistinguishable from a setup mistake — so say that plainly before doing it.
  $('#hsRotate').onclick=async()=>{
    if(!await askConfirm('Regenerate your token? Any device using the old one — a health Shortcut above all — stops working immediately. · 重新生成令牌？正在使用旧令牌的设备（尤其是健康快捷指令）会立即失效。','Regenerate · 重新生成')) return;
    $('#hsCopied').textContent='regenerating · 生成中…';
    let r=null;
    try{ r=await (await api('/api/profile/token/rotate',{method:'POST'})).json(); }catch{ /* !r below reports it (R5) */ }
    if(!r||!r.ok){ $('#hsCopied').textContent=(r&&r.error)||'could not regenerate · 生成失败'; return; }
    // Re-render from scratch: the panel still shows the DEAD token until it is reloaded.
    healthSetupLoaded=false;
    $('#healthSetupTxt').textContent='';
    // The loader only runs on a CLOSED→OPEN transition, so it has to be closed first.
    $('#healthWrap').open=false; $('#healthWrap').open=true;
  };
});
/* ── Agent email · 管家邮箱: the node's own AgentMail inbox address (owner only).
   Lazy like Health setup above: fetched when the section is opened — the FIRST
   open may create the node's ONE persistent inbox (server-side create-or-get).
   Failure renders the server's honest bilingual error, never a fake address. */
let agentAddrLoaded=false;
$('#agentMailWrap').addEventListener('toggle',async()=>{
  if(!$('#agentMailWrap').open||agentAddrLoaded) return;
  let s=null; try{ s=await (await api('/api/agentmail/address')).json(); }catch{ /* handled below: !s renders the bilingual error line */ }
  if(!s||!s.ok){ $('#agentAddr').textContent=(s&&s.error)||'Could not load agent address · 无法加载管家邮箱'; return; }
  agentAddrLoaded=true;
  $('#agentAddr').innerHTML=`<b>${esc(s.address)}</b><button type="button" class="plain" id="agCopy" style="font-size:12px;padding:2px 8px;margin-left:8px">Copy · 复制</button><span id="agCopied" style="font-size:12px;color:var(--muted);margin-left:6px"></span>`;
  $('#agCopy').onclick=async()=>{ try{ await navigator.clipboard.writeText(s.address); $('#agCopied').textContent='copied · 已复制'; }catch{ $('#agCopied').textContent='copy failed — select the address · 复制失败，请手动选择地址'; } };
});
/* ── Jobs · 任务: per-user job & reminder status + Run now（立即运行）.
   Re-fetched on every open so the status is fresh. Outcomes come from the
   SERVER's audit-derived lastOutcome — never assumed ok client-side (R14).
   Reminder removal reuses the existing path: the shared confirm labels +
   DELETE /api/reminders/:id — the same endpoint the longevity app relays to. */
function fmtDue(ms){
  if(ms==null) return '—';
  if(ms<=Date.now()) return 'due now · 待运行';
  const d=new Date(ms),p=(n)=>String(n).padStart(2,'0'),hm=`${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString()===new Date().toDateString()?`today · 今天 ${hm}`:`${d.getMonth()+1}/${d.getDate()} ${hm}`;
}
/* Three different questions, and only the first was ever answered here:
     did it RUN · did it SAY anything · did that ARRIVE.
   A job returning null forever passes "ran ok" — so a mis-set threshold looked exactly like a
   quiet month. And a broken push (email) never showed at all, because notify never throws. */
const SILENT_RUNS_WARN=5;
// Generous: a research job legitimately takes a minute or more (search + scrape + model).
// This is a ceiling on the WAIT, not on the job — the run continues server-side either way.
const RUN_NOW_TIMEOUT_MS=5*60*1000;
function fmtWhen(ms){ if(!ms) return '—'; const d=new Date(ms);
  return d.toDateString()===new Date().toDateString()?`today · 今天 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`:`${d.getMonth()+1}/${d.getDate()}`; }
function jobHealth(r){
  if(r.kind!=='job') return '';
  const bits=[];
  if(r.delivery&&r.delivery.status==='failed'){
    bits.push(`<span style="color:var(--danger)">⚠ not delivered · 未送达${r.delivery.channel?' ('+esc(r.delivery.channel)+')':''}${r.delivery.error?' — '+esc(String(r.delivery.error).slice(0,60)):''}</span>`);
  }
  // Only worth saying once a job has been quiet for a WHILE — a conditional job is supposed
  // to be silent most days, and flagging that every morning would be the noise we removed.
  if(r.lastReportAt) bits.push(`said something 上次报告: ${esc(fmtWhen(r.lastReportAt))}${r.silentRuns>=SILENT_RUNS_WARN?` · quiet since 已连续 ${r.silentRuns} 次无报告`:''}`);
  else if(r.silentRuns>=SILENT_RUNS_WARN) bits.push(`<span style="color:var(--danger)">never reported · 从未报告 (${r.silentRuns} runs 次)</span>`);
  return bits.length?`<div style="color:var(--muted);font-size:12px">${bits.join(' · ')}</div>`:'';
}
function outcomeLabel(o){ return o==='ok'?'✓ ok · 成功':o==='failed'?'✗ failed · 失败':o==='skipped'?'– skipped · 已跳过':'—'; }
async function loadJobs(){
  const box=$('#jobsList');
  let rows=null; try{ rows=await (await api('/api/jobs')).json(); }catch{ /* !Array below renders the bilingual failure line (R5) */ }
  if(!Array.isArray(rows)){ box.textContent='Could not load jobs · 无法加载任务'; return; }
  // The buttons WRAP to their own line rather than squeezing the label. Every button is
  // flex-shrink:0, so on a narrow panel they took the whole row and left the text column about
  // 20px wide — the job title then rendered one character per line. A flex-basis on the text is
  // what forces the wrap: below it the buttons move down instead of stealing the last pixels.
  box.innerHTML=rows.map((r,i)=>`<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
      <div style="flex:1 1 200px;min-width:0"><div style="overflow-wrap:anywhere">${esc(r.label)}</div>
        <div style="color:var(--muted);font-size:12px">${esc(r.schedule)} · ${r.paused?'paused · 已暂停'+(r.pausedReason?' — '+esc(r.pausedReason):''):'next 下次: '+esc(fmtDue(r.nextDue))}</div>
        <div style="color:var(--muted);font-size:12px">last 上次: ${esc(r.lastRun||'—')} · ${esc(outcomeLabel(r.lastOutcome))}<span data-jr="${esc(r.name)}"></span></div>
        ${jobHealth(r)}</div>
      ${r.kind==='job'&&r.editable?`<button type="button" class="plain" style="font-size:12px;padding:3px 8px;flex-shrink:0" data-editjob="${esc(r.name)}">Edit · 编辑</button>`:''}
      ${r.kind==='job'?`<button type="button" class="plain" style="font-size:12px;padding:3px 8px;flex-shrink:0" data-togglejob="${esc(r.name)}" data-on="${r.paused?'1':'0'}">${r.paused?'On · 开启':'Off · 关闭'}</button>`:''}
      ${r.kind==='job'
        ?`<button type="button" class="plain" style="font-size:12px;padding:3px 8px;flex-shrink:0" data-runjob="${esc(r.name)}" data-jlabel="${esc(r.label)}">Run now · 立即运行</button>`
        :`<button type="button" class="plain" style="font-size:12px;padding:3px 8px;flex-shrink:0" data-remrem="${esc(r.id)}" data-jlabel="${esc(r.label)}">Remove · 移除</button>`}
    </div>`).join('')||'<div style="color:var(--muted)">No jobs · 暂无任务</div>';
}
$('#jobsWrap').addEventListener('toggle',()=>{ if($('#jobsWrap').open) loadJobs(); });
/* ── Job editor（任务编辑）— create and edit a job WITHOUT touching a file or restarting.
   Only file-defined jobs are editable: a built-in is code, and the server refuses to write
   one, so the UI must not offer it either (it would be a button that always errors).
   A NEW job is created PAUSED — you see what it will do before it can message you. */
let JOB_TOOLS=null;
async function jobTools(){ if(JOB_TOOLS) return JOB_TOOLS;
  // NORMALISE. A failed call answers {error:'…'} with a 200 body, so a bare assignment left
  // JOB_TOOLS without .runnable and the editor threw on .map — a button that did nothing and
  // said nothing. Shape it here so every caller can rely on the two arrays existing (R5).
  let raw=null; try{ raw=await (await api('/api/jobs/tools')).json(); }catch{ /* raw stays null */ }
  JOB_TOOLS = (raw && Array.isArray(raw.runnable) && raw.tools)
    ? raw : { tools:{}, runnable:[], error:(raw && raw.error) || 'Could not load tools · 无法加载工具' };
  return JOB_TOOLS; }
function jobFieldRow(label,inner){ return `<label style="display:block;margin:6px 0">${esc(label)}<br>${inner}</label>`; }
async function openJobEditor(job){
  const t=await jobTools(), box=$('#jobEdit'), isNew=!job;
  const j=job||{id:'',title:'',prompt:'',schedule:{time:'07:00'},plan:{kind:'tool',tool:t.runnable[0]||'',args:{}},enabled:false};
  const S='width:100%;padding:7px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit';
  // No runnable tools = nothing a job could DO. Say so instead of rendering a form whose
  // Save can only fail.
  if(!t.runnable.length){ box.style.display='block';
    box.innerHTML=`<div style="border:1px solid var(--line);border-radius:8px;padding:10px;color:var(--muted)">${esc(t.error||'No tools available · 暂无可用工具')}<div style="margin-top:8px"><button type="button" class="plain" id="jeCancel2" style="font-size:13px;padding:6px 12px">Close · 关闭</button></div></div>`;
    $('#jeCancel2').onclick=()=>{ box.style.display='none'; box.innerHTML=''; JOB_TOOLS=null; };
    return; }
  // Only RUNNABLE tools are offered: picking one with no runner would create a job that can
  // never do anything, and a job that does nothing looks exactly like a quiet day.
  const opts=t.runnable.map(n=>`<option value="${esc(n)}"${n===j.plan.tool?' selected':''}>${esc(n)} — ${esc((t.tools[n]||{}).purpose||'')}</option>`).join('');
  box.style.display='block';
  box.innerHTML=`<div style="border:1px solid var(--line);border-radius:8px;padding:10px">
    <b style="font-size:13px">${isNew?'New job · 新建任务':'Edit · 编辑 '+esc(j.title)}</b>
    ${isNew?`<div style="margin:8px 0 10px;padding:8px;border:1px dashed var(--line);border-radius:8px">
      <div style="color:var(--muted);font-size:12px;margin-bottom:5px">Describe it and let the assistant fill this in · 用一句话描述，助手自动填写</div>
      <textarea id="jeSay" rows="2" style="${S}" placeholder="alert me if the pollen count is high today"></textarea>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <button type="button" class="plain" id="jeResolve" style="font-size:12px;padding:4px 10px">Fill it in · 自动填写</button>
        <span id="jeSayMsg" style="color:var(--muted);font-size:12px"></span></div></div>`:''}
    ${isNew?jobFieldRow('Id (a-z 0-9 -)',`<input id="jeId" style="${S}" value="${esc(j.id)}" placeholder="pollen-alert">`):''}
    ${jobFieldRow('Title · 标题',`<input id="jeTitle" style="${S}" value="${esc(j.title)}">`)}
    ${jobFieldRow('What should it do? · 任务说明',`<textarea id="jePrompt" rows="2" style="${S}">${esc(j.prompt||'')}</textarea>`)}
    ${jobFieldRow('Tool · 工具',`<select id="jeTool" style="${S}">${opts}</select>`)}
    ${jobFieldRow('Settings (JSON) · 参数',`<textarea id="jeArgs" rows="2" style="${S}">${esc(JSON.stringify(j.plan.args||{}))}</textarea>`)}
    <div id="jeModelRow" style="display:none">${jobFieldRow('Model · 模型 (blank = default 留空用默认)',`<select id="jeModel" style="${S}"></select>`)}</div>
    ${jobFieldRow('Time · 时间 (HH:MM)',`<input id="jeTime" style="${S}" value="${esc(j.schedule.time)}">`)}
    ${jobFieldRow('Day · 星期 (blank = daily 每日)',`<input id="jeDay" style="${S}" value="${j.schedule.day===undefined?'':j.schedule.day}" placeholder="0=Sun … 6=Sat">`)}
    <label style="display:block;margin:8px 0"><input type="checkbox" id="jeOn"${j.enabled?' checked':''}> Enabled · 启用</label>
    <div id="jeErr" style="color:var(--danger);font-size:12px;min-height:16px"></div>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button type="button" class="primary" id="jeSave" style="font-size:13px;padding:6px 12px">Save · 保存</button>
      <button type="button" class="plain" id="jeCancel" style="font-size:13px;padding:6px 12px">Cancel · 取消</button>
      ${isNew?'':`<button type="button" class="plain" id="jeDel" style="font-size:13px;padding:6px 12px;margin-left:auto">Delete · 删除</button>`}
    </div></div>`;
  // The model picker appears only for tools that actually call one. Offering it on a
  // deterministic tool would be a setting that does nothing — the server refuses it anyway.
  async function syncModelRow(){
    const man=(t.tools||{})[$('#jeTool').value]||{};
    const row=$('#jeModelRow');
    if(!man.usesModel){ row.style.display='none'; $('#jeModel').innerHTML=''; return; }
    row.style.display='block';
    if(!$('#jeModel').options.length){
      let models=[]; try{ models=await (await api('/api/models')).json(); }catch{ /* blank list = default only (R5) */ }
      $('#jeModel').innerHTML='<option value="">default · 默认</option>'
        +models.map(m=>`<option value="${esc(m.id)}">${esc(m.label)}${m.group?' · '+esc(m.group):''}</option>`).join('');
    }
    $('#jeModel').value=j.model||'';
  }
  $('#jeTool').onchange=syncModelRow; syncModelRow();
  $('#jeCancel').onclick=()=>{ box.style.display='none'; box.innerHTML=''; };
  if($('#jeResolve')) $('#jeResolve').onclick=async()=>{
    const said=$('#jeSay').value.trim(); if(!said) return;
    const msg=$('#jeSayMsg'); msg.textContent='thinking · 思考中…'; $('#jeResolve').disabled=true;
    let out=null;
    try{ out=await (await api('/api/jobs/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:said})})).json(); }
    catch{ /* !out below reports it (R5) */ }
    $('#jeResolve').disabled=false;
    if(!out){ msg.textContent='Could not reach the assistant · 无法连接助手'; return; }
    // It ASKS only when an input genuinely cannot be inferred — then it names which one,
    // rather than handing back an empty form with no explanation.
    if(!out.ok&&Array.isArray(out.ask)&&out.ask.length){
      msg.textContent='Needs · 还需要: '+out.ask.map(a=>a.input).join(', ');
      if(out.draft){ $('#jeTitle').value=out.draft.title||''; $('#jeTool').value=out.draft.tool||$('#jeTool').value;
        $('#jeArgs').value=JSON.stringify(out.draft.args||{}); $('#jeTime').value=(out.draft.schedule||{}).time||$('#jeTime').value; }
      return; }
    if(!out.ok){ msg.textContent=out.error||'Could not work that out · 无法解析'; return; }
    const j2=out.job;
    $('#jeId').value=j2.id; $('#jeTitle').value=j2.title; $('#jePrompt').value=j2.prompt||said;
    $('#jeTool').value=j2.plan.tool; $('#jeArgs').value=JSON.stringify(j2.plan.args||{});
    $('#jeTime').value=j2.schedule.time; $('#jeDay').value=j2.schedule.day===undefined?'':j2.schedule.day;
    // Stays UNCHECKED on purpose — you review what it worked out before it can message you.
    $('#jeOn').checked=false;
    msg.textContent=out.usedDefaultTime?'filled · 已填写 (no time given, defaulted · 未指定时间，用默认值)':'filled · 已填写 — review, then Save';
  };
  $('#jeSave').onclick=async()=>{
    let args; try{ args=JSON.parse($('#jeArgs').value||'{}'); }
    catch{ $('#jeErr').textContent='Settings must be JSON · 参数需为 JSON'; return; }
    const dayRaw=$('#jeDay').value.trim();
    const body={ id:isNew?$('#jeId').value.trim():j.id, title:$('#jeTitle').value.trim(), prompt:$('#jePrompt').value,
      schedule:dayRaw===''?{time:$('#jeTime').value.trim()}:{time:$('#jeTime').value.trim(),day:Number(dayRaw)},
      plan:{kind:'tool',tool:$('#jeTool').value,args}, enabled:$('#jeOn').checked,
      model:($('#jeModel')&&$('#jeModelRow').style.display!=='none')?$('#jeModel').value:'' };
    const r=await api(isNew?'/api/jobs':'/api/jobs/'+encodeURIComponent(j.id),
      {method:isNew?'POST':'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    let out=null; try{ out=await r.json(); }catch{ /* !out below shows the failure (R5) */ }
    // The server is the authority on validity; show ITS sentence rather than a generic one.
    if(!out||!out.ok){ $('#jeErr').textContent=(out&&out.error)||'Could not save · 保存失败'; return; }
    box.style.display='none'; box.innerHTML=''; loadJobs();
  };
  if($('#jeDel')) $('#jeDel').onclick=async()=>{
    if(!await askConfirm(`Delete "${j.title}"? · 删除该任务？`,'Delete · 删除')) return;
    await api('/api/jobs/'+encodeURIComponent(j.id),{method:'DELETE'});
    box.style.display='none'; box.innerHTML=''; loadJobs();
  };
}
$('#jobNew').onclick=()=>openJobEditor(null);

$('#jobsList').onclick=async(e)=>{
  const rb=e.target.closest('[data-runjob]');
  if(rb){ e.preventDefault();
    if(!await askConfirm(`Run "${rb.dataset.jlabel}" now? · 立即运行该任务？`,'Run now · 立即运行')) return;
    // Re-FIND the slot each time rather than holding a reference: loadJobs() re-renders the
    // whole list, and a captured node is then orphaned — the update lands on a detached
    // element while the visible row keeps saying "running" for ever.
    const jobName=rb.dataset.runjob;
    const say=(t)=>{ const el=$('#jobsList').querySelector(`[data-jr="${CSS.escape(jobName)}"]`); if(el) el.textContent=t; };
    // A live counter, because "working" and "hung" look identical without one. A research job
    // does a web search, scrapes pages and calls a model — tens of seconds is NORMAL, and the
    // honest answer to "how long will this take" is to show the time passing.
    const t0=Date.now();
    const tick=setInterval(()=>say(' · running · 运行中… '+took(Date.now()-t0)),1000);
    say(' · running · 运行中… 0.0s');
    // And a real ceiling. Without one a request that never returns leaves the row claiming to
    // be running until the page is reloaded — which is exactly what happened.
    const ac=new AbortController();
    const killer=setTimeout(()=>ac.abort(),RUN_NOW_TIMEOUT_MS);
    let j=null,timedOut=false;
    try{ j=await (await api('/api/jobs/'+encodeURIComponent(jobName)+'/run',{method:'POST',signal:ac.signal})).json(); }
    catch(err){ timedOut=ac.signal.aborted; /* !j below shows failed (R5) */ }
    clearInterval(tick); clearTimeout(killer);
    const elapsed=took(Date.now()-t0);
    if(timedOut){ say(` · ✗ gave up after ${elapsed} · 超时未完成 — it may still finish; reopen to check`); return; }
    say((!j||!j.ok)?` · ✗ failed · 失败${j&&j.error?': '+j.error:''}`
      :j.skipped?` · no report today · 今日无简报 (${elapsed})`:j.alreadyRanToday?` · ✓ ran again today · 已再次运行 (${elapsed})`:` · ✓ ran · 已运行 (${elapsed})`);
    // SHOW the result. "ran ok" with the output only in the feed is not an answer to someone
    // who just pressed Run now.
    const out=$('#jobRunOut');
    if(out){
      if(j&&j.ok&&j.body){
        out.style.display='block';
        out.innerHTML=`<div style="border:1px solid var(--line);border-radius:8px;padding:10px;margin:4px 0 10px">
          <div style="color:var(--muted);font-size:12px;margin-bottom:6px">${esc(rb.dataset.jlabel)}${j.truncated?' · shortened 已截断':''}</div>
          <div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px">${esc(j.body)}</div>
          <div style="margin-top:8px"><button type="button" class="plain" id="jobRunClose" style="font-size:12px;padding:3px 8px">Close · 关闭</button></div></div>`;
        $('#jobRunClose').onclick=()=>{ out.style.display='none'; out.innerHTML=''; };
      } else if(j&&j.ok&&j.skipped){
        out.style.display='block';
        out.innerHTML=`<div style="border:1px solid var(--line);border-radius:8px;padding:10px;margin:4px 0 10px;color:var(--muted);font-size:13px">Nothing to report today · 今日无需报告 — the job ran and decided there was nothing worth saying.</div>`;
      }
    }
    return;
  }
  const eb=e.target.closest('[data-editjob]');
  if(eb){ e.preventDefault();
    // Fetch the job's own record — the view row is a SUMMARY and does not carry plan/args.
    let all=null; try{ all=await (await api('/api/jobs/files')).json(); }catch{}
    const rec=all&&all.jobs&&all.jobs[eb.dataset.editjob];
    if(!rec){ alert('Could not load that job · 无法加载该任务'); return; }
    openJobEditor(rec); return;
  }
  const tb=e.target.closest('[data-togglejob]');
  if(tb){ e.preventDefault();
    // The ONE control that can stop any job, built-in or not. No confirm: it is one click to put
    // back and the row says plainly which state it is in — a dialog for a reversible switch is
    // friction, unlike the editor's Delete, which destroys the job file.
    const on=tb.dataset.on==='1';
    tb.disabled=true;
    const r=await api('/api/jobs/'+encodeURIComponent(tb.dataset.togglejob),
      {method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:on})});
    tb.disabled=false;
    // The server's own sentence, not a house string: "built-in" and "unknown job" are different
    // problems and the row must not flatten them into one (R5).
    if(!r.ok){ let m=''; try{ m=(await r.json()).error||''; }catch{}
      alert(m||'Could not change that job · 无法更改该任务'); }
    loadJobs(); return;
  }
  const rr=e.target.closest('[data-remrem]');
  if(rr){ e.preventDefault();
    const [en,zh]=SHELL_CONFIRM_LABELS['remove-reminder'];
    if(!await askConfirm(`${en} "${rr.dataset.jlabel}"? · ${zh}，确认？`,`${en} · ${zh}`)) return;
    const r=await api('/api/reminders/'+encodeURIComponent(rr.dataset.remrem),{method:'DELETE'});
    if(r.ok) loadJobs(); else alert('Remove failed · 移除失败');
  }
};
/* ── Node settings · 节点设置 (owner): whitelisted config editor. Secrets are
   WRITE-ONLY — the server sends only SET/empty and the input starts blank;
   typing a value REPLACES on save, Clear deletes the key. Boot-time fields
   are marked; Apply & restart exits the process (supervisor respawns) and the
   UI polls / until the node answers again. */
async function loadNodeCfg(){
  const box=$('#nodeCfgList');
  let rows=null; try{ rows=await (await api('/api/admin/config')).json(); }catch{ /* !Array below renders the bilingual failure line (R5) */ }
  if(!Array.isArray(rows)){ box.textContent='Could not load config · 无法加载配置'; return; }
  box.innerHTML=rows.map((r)=>{
    const val=r.kind==='value'?(Array.isArray(r.value)?r.value.join(', '):(r.value==null?'':String(r.value))):'';
    const badge=r.kind==='secret'?`<small style="flex-shrink:0;color:${r.status==='SET'?'var(--accent)':'var(--muted)'}">${r.status==='SET'?'SET · 已设置':'empty · 未设置'}</small>`:'';
    return `<div style="padding:6px 0;border-bottom:1px solid var(--line)">
      <div style="font-size:12px;color:var(--muted)">${esc(r.label)}${r.boot?' <small>(after restart · 重启后生效)</small>':''}</div>
      <div style="display:flex;gap:6px;align-items:center;margin-top:3px">${badge}
        <input data-ck="${esc(r.key)}" ${r.kind==='secret'?'type="password" placeholder="paste to replace · 粘贴以替换" autocomplete="new-password"':''} value="${esc(val)}" style="flex:1;min-width:0;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font-size:12px">
        <button type="button" class="plain" style="font-size:12px;padding:3px 8px" data-cs="${esc(r.key)}">Save · 保存</button>
        ${r.kind==='secret'&&r.status==='SET'?`<button type="button" class="plain" style="font-size:12px;padding:3px 8px" data-cc="${esc(r.key)}">Clear · 清除</button>`:''}
      </div><div data-cmsg="${esc(r.key)}" style="font-size:12px;color:var(--muted)"></div></div>`;
  }).join('')
  +'<div style="margin-top:10px;display:flex;gap:8px;align-items:center"><button type="button" class="plain" id="cfgReload">Reload config · 重载配置</button><button type="button" class="plain" id="cfgRestart" style="color:var(--danger)">Apply &amp; restart · 应用并重启</button><span id="cfgRestartMsg" style="font-size:12px;color:var(--muted)"></span></div>';
  $('#cfgReload').onclick=doReloadConfig;
  $('#cfgRestart').onclick=doNodeRestart;
}
async function putNodeCfg(key,value){
  const msg=$('#nodeCfgList').querySelector(`[data-cmsg="${CSS.escape(key)}"]`);
  // A 413 (BODY_LIMITS.config), an expired session and a dead socket used to be ONE
  // sentence here — 'Save failed · 保存失败'. Each is now its own (R3, relayText).
  const g=await relayJson(api('/api/admin/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({key,value})}),'data');
  if(!g.ok||!g.data||!g.data.ok){ if(msg){ msg.style.color='var(--danger)'; msg.textContent=g.ok?((g.data&&g.data.error)||'Save refused · 保存被拒绝。'):g.text; } return; }
  loadNodeCfg(); // re-render from the server's view — a typed secret never lingers in the DOM
}
$('#nodeCfgList').onclick=async(e)=>{
  const s=e.target.closest('[data-cs]');
  if(s){ e.preventDefault(); const inp=$('#nodeCfgList').querySelector(`input[data-ck="${CSS.escape(s.dataset.cs)}"]`); putNodeCfg(s.dataset.cs,inp?inp.value:''); return; }
  const c=e.target.closest('[data-cc]');
  if(c){ e.preventDefault(); if(await askConfirm('Clear this secret? · 清除该密钥，确认？','Clear · 清除')) putNodeCfg(c.dataset.cc,''); }
};
async function doReloadConfig(){
  const m=$('#cfgRestartMsg');
  m.style.color='var(--muted)'; m.textContent='';
  const g=await relayJson(api('/api/admin/reload-config',{method:'POST'}),'request');
  if(!g.ok){ m.style.color='var(--danger)'; m.textContent=g.text; return; }
  m.style.color='var(--accent)'; m.textContent='reloaded · 已重载';
  setTimeout(()=>{ m.textContent=''; },3000);
}
async function doNodeRestart(){
  if(!await askConfirm('Restart the node now? Boot-time settings apply after restart. · 立即重启节点？重启后生效的设置将被应用。','Restart · 重启')) return;
  const m=$('#cfgRestartMsg');
  // SCAR: this swallowed the result. `api` is a bare fetch, so a 401 (signed out — which
  // is exactly what a new origin gives you) or a 403 (not owner) never threw; the catch
  // was not even reached. The UI then said "restarting…", polled '/', got 200 from the
  // server that had never gone down, and reported "restarted · 已重启" — a success message
  // for a request that was refused (R14: a failed step must never read as a pass).
  const g=await relayJson(api('/api/admin/restart',{method:'POST'}),'request');
  if(!g.ok){ m.style.color='var(--danger)'; m.textContent=g.text; return; }   // nothing restarted — say so
  m.style.color='var(--muted)';
  m.textContent='restarting · 重启中…';
  const t0=Date.now();
  const poll=setInterval(async()=>{
    if(Date.now()-t0>120000){ clearInterval(poll); m.textContent='still down — check the node · 未恢复，请检查节点'; return; }
    try{ const r=await fetch('/',{cache:'no-store'}); if(r.ok){ clearInterval(poll); m.textContent='restarted · 已重启'; } }catch{ /* still down — keep polling until the deadline above */ }
  },2000);
}
$('#nodeCfgWrap').addEventListener('toggle',()=>{ if($('#nodeCfgWrap').open) loadNodeCfg(); });
$('#logoutBtn').onclick=(e)=>{ e.preventDefault(); logout(); };
// Release-notes sheet content (pure builders — the test harness renders them
// without a DOM). Latest RECENT_VERSIONS expanded; the rest behind a
// "Show earlier · 更早版本" toggle.
const RECENT_VERSIONS=3;
// TODO(R4 seam): the release-notes sheet (verBadge, verBlock, verSheetHtml, showVerNotes) is its own part — web/vernotes-sheet.js.
// n.auto: the automatic 'v<pkg>+<N>' entry's badge text, written by lib/version-auto.mjs (ONE wording).
const verBadge=(t)=>'<span style="font-size:11px;font-weight:600;margin-left:6px;padding:1px 6px;border:1px solid var(--accent);border-radius:8px">'+t+'</span>';
function verBlock(v,n,cur){
  const isCur=v===cur;
  let h=`<div style="margin-bottom:18px${isCur?';border-left:3px solid var(--accent);padding-left:10px':''}"><div style="font-size:14px;font-weight:700;color:var(--accent)">${esc(v)}${isCur?verBadge('current · 当前'):''}${n.auto?verBadge(esc(n.auto)):''}<span style="font-weight:400;color:var(--muted);margin-left:8px;font-size:12px">${esc(n.date||'')}</span></div>`;
  const sec=(t,items)=>items&&items.length?`<div style="font-size:12px;font-weight:600;color:var(--muted);margin:8px 0 4px">${t}</div><ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7">${items.map(f=>'<li>'+esc(f)+'</li>').join('')}</ul>`:'';
  return h+sec('New · 新功能',n.features)+sec('Fixed · 修复',n.fixes)+'</div>';
}
function verSheetHtml(vers,notes,cur){
  if(!vers.length) return '<div style="color:var(--muted);font-size:13px;padding:8px 0 16px">No release notes yet · 暂无版本记录</div>';
  const blocks=vers.map(v=>verBlock(v,notes[v],cur));
  const recent=blocks.slice(0,RECENT_VERSIONS).join('');
  const earlier=blocks.slice(RECENT_VERSIONS).join('');
  return recent+(earlier?'<button id="_ver_more" class="plain" style="width:100%;margin:2px 0 14px">Show earlier · 更早版本</button><div id="_ver_earlier" style="display:none">'+earlier+'</div>':'');
}

// Version label → release-notes sheet. Mouse: plain click opens. Touch/pen:
// 600ms long-press opens; a quick tap does nothing. _pt gates the synthetic
// click that follows a touch long-press so it can't reopen (or instantly
// ── New-feature blue dot system ──
// Shell: markNew(el, key) — adds a blue dot cleared on first tap, persisted in localStorage.
// Apps: use broker kinds 'get-new-features' (returns unseen keys[]) and 'seen-feature' (marks key seen).
const _SEEN=new Set(JSON.parse(localStorage.getItem('pa_new_seen')||'[]'));
function _saveSeen(){ try{localStorage.setItem('pa_new_seen',JSON.stringify([..._SEEN]));}catch{} }
function markNew(el,key){ if(!el||_SEEN.has(key)) return; el.classList.add('pa-new'); el.addEventListener('pointerdown',()=>{ el.classList.remove('pa-new'); _SEEN.add(key); _saveSeen(); },{once:true,capture:true}); }
function markNewSel(sel,key){ markNew($(sel),key); }

// close) the sheet.
(()=>{
  const vl=$('#ver-lbl'); if(!vl) return;
  let _lt=null,_pt='mouse',_x=0,_y=0;
  const start=(e)=>{ _pt=e.pointerType||'mouse'; if(_pt==='mouse') return; _x=e.clientX; _y=e.clientY; clearTimeout(_lt); _lt=setTimeout(()=>{ _lt=null; showVerNotes(); },600); };
  const cancel=()=>{ clearTimeout(_lt); _lt=null; };
  vl.addEventListener('pointerdown',start);
  vl.addEventListener('pointerup',cancel);
  vl.addEventListener('pointercancel',cancel);
  vl.addEventListener('pointermove',(e)=>{ if(_lt&&Math.hypot(e.clientX-_x,e.clientY-_y)>10) cancel(); });
  vl.addEventListener('contextmenu',(e)=>e.preventDefault());
  vl.addEventListener('click',()=>{ if(_pt!=='mouse') return; showVerNotes(); });
  // A NESTED native <dialog> + showModal(): the top layer stacks it above the
  // open profile dialog with a viewport-sized backdrop — no z-index games, and
  // Esc ('cancel' event) plus backdrop click (click target === the dialog) are
  // the platform's own close paths. Internal scroll; the ✕ header never scrolls
  // away. Inline width/box-sizing/overflow-wrap override the global dialog CSS
  // so long note lines wrap instead of forcing a horizontal scroll on iPhone.
  function showVerNotes(){
    if(document.getElementById('_ver_sheet')) return;
    const notes=window._VER_NOTES||{};
    const vers=Object.keys(notes).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
    const cur=(vl.textContent.match(/v[\d.]+\d(?:\+\d+)?/)||[])[0];   // 'v5.0.0' or the automatic 'v5.0.0+12'
    const dlg=document.createElement('dialog');
    dlg.id='_ver_sheet';
    dlg.style.cssText='width:min(100vw - 24px,480px);max-width:none;box-sizing:border-box;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--text);overflow:hidden';
    dlg.innerHTML='<div style="display:flex;flex-direction:column;max-height:min(80dvh,80vh)">'
      +'<div style="position:sticky;top:0;flex-shrink:0;display:flex;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--card)"><b style="flex:1;font-size:16px">Release Notes · 版本记录</b><button id="_ver_close" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--muted);padding:0 2px">✕</button></div>'
      +'<div style="overflow-y:auto;padding:16px 16px calc(16px + env(safe-area-inset-bottom));overflow-wrap:anywhere">'+verSheetHtml(vers,notes,cur)+'</div></div>';
    document.body.appendChild(dlg);
    const openedAt=Date.now();
    const close=()=>{ if(dlg.open) dlg.close(); };
    dlg.addEventListener('close',()=>dlg.remove());       // one teardown path, whatever closed it
    dlg.querySelector('#_ver_close').onclick=close;
    // Backdrop-click pattern: clicks on ::backdrop target the dialog itself.
    // openedAt guard: the synthetic click after a touch long-press lands on the
    // freshly shown dialog — don't let it close the sheet immediately.
    dlg.addEventListener('click',(e)=>{ if(e.target===dlg&&Date.now()-openedAt>400) close(); });
    const more=dlg.querySelector('#_ver_more');
    if(more) more.onclick=()=>{
      const box=dlg.querySelector('#_ver_earlier');
      const show=box.style.display==='none';
      box.style.display=show?'':'none';
      more.textContent=show?'Hide earlier · 收起更早版本':'Show earlier · 更早版本';
    };
    dlg.showModal();
  }
})();
$('#settings').onclick=async()=>{ await loadProfile(); if(ME.role==='owner'){ await loadFamily(); await loadShelf(); $('#auditBtn').style.display='inline-block'; } $('#cfg').showModal(); };
$('#auditBtn').onclick=async(e)=>{ e.preventDefault(); let rows=[]; try{ rows=await (await api('/api/admin/audit')).json(); }catch{} alert(rows.slice(0,20).map(r=>`${(r.at||'').slice(5,16)}  ${r.ev}  ${r.who||''}${r.ok===false?' (failed)':''}`).join('\n')||'No activity yet.'); };
$('#pSave').onclick=async(e)=>{
  e.preventDefault();
  const body={name:$('#pName').value,about:$('#pAbout').value,prefs:$('#pPrefs').value,briefingEmail:$('#pBriefEmail').value,briefingRetainDays:parseInt($('#pRetainDays').value,10)||30, postcode:$('#pPostcode').value.trim(),
    autoUpdateApps:$('#pAutoUpdate').checked,
    systemPrompts:collectSystemPrompts()};
  if($('#pPin').value.trim()) body.password=$('#pPin').value.trim();   // too short → the server's 400 is shown below (lib/owner.mjs MIN_PASSWORD)
  // A refused save (e.g. invalid 简报邮箱 · briefing email → 400) is SHOWN and the
  // dialog stays open for the fix — never silently closed as if saved (R5).
  // The prompt overrides can be long, so a 413 (BODY_LIMITS.profile) is reachable here:
  // it must say "Too large · 内容过大 (max 64 KB)", never the same words a dropped
  // connection produces — and a null `r` used to make `r.json()` throw inside the try,
  // discarding the reason entirely.
  const g=await relayJson(api('/api/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),'data');
  if(!g.ok){ alert(g.text); return; }
  $('#pPin').value='';
  if(ME.name!==$('#pName').value){ ME.name=$('#pName').value; }
  $('#cfg').close();
};
async function loadShelf(){
  const box=$('#shelf'); box.style.display='block';
  let shelf=[],cand=[];
  try{ shelf=await (await api('/api/admin/shared')).json(); }catch{}
  try{ cand=await (await api('/api/admin/share/candidates')).json(); }catch{}
  const opts=cand.flatMap(u=>u.apps.map(a=>`<option value="${esc(u.user)}|${esc(a)}">${esc(u.name)} · ${esc(a)}</option>`)).join('');
  box.innerHTML='<b>Shared apps (family shelf)</b>'+
    (shelf.map(a=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1">${esc(a.title)} <small style="color:var(--muted)">by ${esc(a.sharedBy||'?')}${a.versions?' · '+a.versions+' old ver':''}</small></span>
      ${a.versions?`<button class="plain" style="font-size:12px;padding:3px 8px" data-rb="${esc(a.name)}">Roll back</button>`:''}
      <button class="plain" style="font-size:12px;padding:3px 8px" data-un="${esc(a.name)}">Remove</button>
    </div>`).join('')||'<div style="color:var(--muted);font-size:13px;padding:4px 0">Nothing shared yet.</div>')+
    `<div style="display:flex;gap:6px;margin-top:10px"><select id="promoteSel" style="flex:1;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text)"><option value="">Promote an app to the shelf…</option>${opts}</select><button class="primary" id="promoteBtn" style="padding:6px 10px">Promote</button></div>`;
  box.querySelectorAll('[data-rb]').forEach(b=>b.onclick=async()=>{ if(confirm('Roll back "'+b.dataset.rb+'" to the previous version?')){ await api('/api/admin/shared/'+b.dataset.rb+'/rollback',{method:'POST'}); loadShelf(); loadApps(); } });
  box.querySelectorAll('[data-un]').forEach(b=>b.onclick=async()=>{ if(confirm('Remove "'+b.dataset.un+'" from the shelf? (archived, not deleted)')){ await api('/api/admin/shared/'+b.dataset.un+'/unshare',{method:'POST'}); loadShelf(); loadApps(); } });
  $('#promoteBtn').onclick=async(e)=>{ e.preventDefault(); const v=$('#promoteSel').value; if(!v) return; const [from,slug]=v.split('|'); const r=await api('/api/admin/share',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from,slug})}); const j=await r.json(); if(!j.ok){alert(j.error||'failed');return;} loadShelf(); loadApps(); };
}
// TODO(R4): web/settings.js is over budget — Family accounts (loadFamily and its add/approve/reset/
// remove handlers) is the seam to split into its own web/settings-family.js.
async function loadFamily(){
  const box=$('#family'); box.style.display='block';
  // min-width:0 + minmax(0,1fr): a phone's 390px fits two inputs; their intrinsic width used to push
  // the row (and the whole Settings page) sideways (F5-5).
  const FIELD='min-width:0;width:100%;box-sizing:border-box;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text)';
  let list=[]; try{ list=await (await api('/api/admin/users')).json(); }catch{}
  box.innerHTML='<b>Family accounts</b>'+list.map(u=>
    `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
      <span style="flex:1;min-width:0;overflow-wrap:anywhere">${esc(u.name)} <small style="color:var(--muted)">${u.status==='pending'?'等待批准 · Waiting for approval':u.role}${u.age!=null?' · age '+u.age:''}</small></span>
      ${u.status==='pending'?`<button class="primary" data-approve="${esc(u.id)}">批准 · Approve</button>`:''}
      ${u.id!=='owner'?`<button class="plain" data-pw="${esc(u.id)}">重设密码 · Reset password</button><button class="plain" data-del="${esc(u.id)}">×</button>`:''}
    </div>`).join('')+
    `<div style="margin-top:10px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
      <input id="nId" placeholder="id (e.g. mia)" style="${FIELD}">
      <input id="nName" placeholder="Name" style="${FIELD}">
      <input id="nYear" placeholder="Birth year" inputmode="numeric" style="${FIELD}">
      <input id="nPass" type="password" autocomplete="new-password" placeholder="起始密码（可不填）· Starting password (optional)" style="${FIELD}">
      <button class="primary" id="addU" style="padding:6px">Add member</button>
    </div>`;
  // preventDefault: these buttons sit inside Settings' <form method="dialog">, so a bare click also
  // submitted it and closed the whole Settings page (F5-8).
  box.querySelectorAll('[data-del]').forEach(b=>b.onclick=async(e)=>{
    e.preventDefault();
    if(!confirm(`移除 ${b.dataset.del}？对方会被登出，资料仍留在电脑上 · Remove ${b.dataset.del}? They are signed out; their data stays on disk.`)) return;
    const g=await relayJson(api('/api/admin/users/'+b.dataset.del,{method:'DELETE'}),'data');
    if(!g.ok) alert(g.text);
    loadFamily();
  });
  // Self sign-ups wait for the owner (cfg.require_approval); this is the owner's only way to let them in (F5-3).
  box.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async(e)=>{
    e.preventDefault();
    const g=await relayJson(api('/api/admin/users/'+b.dataset.approve+'/approve',{method:'POST'}),'data');
    if(!g.ok){ alert(g.text); return; }
    loadFamily();
  });
  box.querySelectorAll('[data-pw]').forEach(b=>b.onclick=async(e)=>{
    e.preventDefault();
    const pw=prompt(`给 ${b.dataset.pw} 设新密码（至少 8 位），对方会被登出 · New password for ${b.dataset.pw} (8+ characters); they will be signed out:`,'');
    if(!pw) return;
    const g=await relayJson(api('/api/admin/users/'+b.dataset.pw,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw})}),'data');
    alert(g.ok?`已重设。对方用新密码登录 · Done. They sign in with the new password.`:g.text);
  });
  $('#addU').onclick=async(e)=>{
    e.preventDefault();
    const id=$('#nId').value.trim().toLowerCase(), name=$('#nName').value.trim(), birthYear=parseInt($('#nYear').value,10)||null, password=$('#nPass').value;
    if(!id){ alert('请填用户名 · Username required'); return; }
    const r=await api('/api/admin/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,name,birthYear,...(password?{password}:{})})});
    const j=await r.json();
    if(!j.ok){ alert(j.error||'添加失败 · Could not add'); return; }
    // With a password they sign in by name; without one the server hands out a one-time sign-in code (F5-1).
    if(j.token) prompt(`已添加 ${name||id}。把这个登录码交给对方（只显示一次），登录后在设置里设密码 · Added ${name||id}. Give them this sign-in code (shown once); they set a password in Settings:`, j.token);
    else alert(`已添加 ${name||id}。对方用用户名「${id}」和你设的密码登录 · Added ${name||id}. They sign in with username "${id}" and the password you set.`);
    loadFamily();
  };
}
