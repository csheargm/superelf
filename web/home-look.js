/* PAHomeLook（主页外观）— the pieces of the new look that are LOGIC, kept out of web/index.html
   (already over the R4 budget). Pure helpers are exposed for test/new-look.test.mjs.
   - greeting(now): 早安 / 午安 / 晚上好 with the English beside it, 中文 first.
   - dateLine(now): ["11月24日 周二", "Tue, Nov 24"].
   - chatGroups(list, now, limit): chats grouped by day (今天 / 昨天 / 11月20日), newest first;
     only the first `limit` rows unless expanded, so the drawer shows 5 recent + 更多 · More.
   - convosHtml(list, activeId, expanded, esc): the drawer markup; rows keep class .convo + data-id
     and the ⋯ button keeps data-menu, so the existing click handler in index.html is unchanged.
   - bindAa(root): the single "Aa" text-size control; it reveals the existing .fs-dn/.fs-up pair. */
const PAHomeLook=(function(){
  const RECENT=5;
  const WD_ZH=['周日','周一','周二','周三','周四','周五','周六'];
  const WD_EN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MON_EN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function greeting(now){ const h=(now||new Date()).getHours();
    return h<5?['夜深了','Good night']:h<12?['早安','Good morning']:h<18?['午安','Good afternoon']:['晚上好','Good evening']; }
  function dateLine(now){ const d=now||new Date();
    return [`${d.getMonth()+1}月${d.getDate()}日 ${WD_ZH[d.getDay()]}`,`${WD_EN[d.getDay()]}, ${MON_EN[d.getMonth()]} ${d.getDate()}`]; }
  const dayKey=(d)=>`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  function dayLabel(ms,now){ const d=new Date(ms), n=now||new Date();
    if(dayKey(d)===dayKey(n)) return '今天 · Today';
    const y=new Date(n); y.setDate(n.getDate()-1);
    if(dayKey(d)===dayKey(y)) return '昨天 · Yesterday';
    if(!ms) return '更早 · Earlier';
    return `${d.getMonth()+1}月${d.getDate()}日 · ${WD_EN[d.getDay()]}`; }
  function chatGroups(list,now,limit){
    const rows=(Array.isArray(list)?list:[]).slice().sort((a,b)=>(b.updated||0)-(a.updated||0));
    const shown=limit==null?rows:rows.slice(0,limit);
    const groups=[];
    for(const c of shown){ const label=dayLabel(c.updated||0,now);
      const g=groups[groups.length-1]; if(g&&g.label===label) g.items.push(c); else groups.push({label,items:[c]}); }
    return {groups,total:rows.length,hidden:rows.length-shown.length};
  }
  function convosHtml(list,activeId,expanded,esc,now){
    const {groups,hidden}=chatGroups(list,now,expanded?null:RECENT);
    if(!groups.length) return '<div class="d-empty">还没有对话 · No chats yet.</div>';
    return groups.map((g)=>`<div class="day">${esc(g.label)}</div>`+g.items.map((c)=>
      `<div class="convo${c.id===activeId?' active':''}" data-id="${esc(c.id)}"><div class="t">${esc(c.title||'New chat')}</div><button class="cmenu" data-menu="${esc(c.id)}" title="更多 · More" aria-label="More">${PAIcons.svg('more')}</button></div>`).join('')).join('')
      +(hidden>0?`<button type="button" class="more-chats" data-more-chats>更多 · More (${hidden})</button>`:'');
  }
  function closeAa(){ document.querySelectorAll('.aa.open').forEach((x)=>{ x.classList.remove('open'); x.querySelector('.aa-btn')?.setAttribute('aria-expanded','false'); }); }
  function bindAa(root){
    (root||document).querySelectorAll('.aa').forEach((w)=>{
      const b=w.querySelector('.aa-btn'); if(!b||b.dataset.bound) return; b.dataset.bound='1';
      b.onclick=(e)=>{ e.stopPropagation(); const on=!w.classList.contains('open'); closeAa(); w.classList.toggle('open',on); b.setAttribute('aria-expanded',String(on)); };
    });
    if(!bindAa.doc){ bindAa.doc=1;
      document.addEventListener('click',(e)=>{ if(!e.target.closest('.aa')) closeAa(); });
      document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') closeAa(); }); }
  }
  // The header's second line: date, then today's reading when the Bible tile carries a face.
  function headerSub(apps,esc,now){
    const bible=(apps||[]).find((a)=>/bible/.test(a&&a.name||'')&&a.face&&a.face.value);
    const [zh,en]=greeting(now), [dz,de]=dateLine(now);
    return `<span class="it">${esc(zh)}<span class="en"> ${esc(en)}</span></span><span class="it">${esc(dz)}<span class="en"> · ${esc(de)}</span></span>`
      +(bible?`<span class="it rd">今日读经 <b>${esc(bible.face.value)}</b></span>`:'');
  }
  return {RECENT,greeting,dateLine,dayLabel,chatGroups,convosHtml,bindAa,headerSub};
})();
