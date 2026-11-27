/* PALangSwitch（语言切换）— the shell's ONE 中 / EN switch, at the foot of the ☰ drawer (owner 2026-11-26:
   one language setting for all of superelf). PALang (web/lang.js) applies the choice; this file
   mounts the control, keeps the choice on the ACCOUNT (profile.lang, so the iPhone and the iPad match) and
   tells the rest of the shell: the home re-draws, the open app frame gets {pa:'prefs', lang} at once.
   A refused account write keeps the choice on this device and says so (R5 b). Kept out of web/index.html
   (over the R4 budget). Its first-use tip registers here, next to the control (ADR 0030). */
const PALangSwitch=(()=>{
  const TIP='tip:lang-switch';
  const TIP_TEXT='新：在这里切换语言 · New: switch the language here';
  const TOAST_MS=3000;
  let btn=null;
  function toast(msg){ const t=document.getElementById('fsToast'); if(!t) return; t.textContent=msg; t.classList.add('on'); setTimeout(()=>t.classList.remove('on'),TOAST_MS); }
  function paint(){ if(!btn) return; const l=PALang.choice(), both=PALang.get()==='both';
    for(const s of btn.querySelectorAll('[data-l]')) s.classList.toggle('on',!both&&s.dataset.l===l); }
  async function save(l){
    try{ const r=await api('/api/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({lang:l})});
      if(!r.ok) throw new Error('HTTP '+r.status);
      if(ME&&typeof ME==='object') ME.lang=l; }
    catch(e){ toast('只保存在本设备 · Saved on this device only ('+((e&&e.message)||'offline')+')'); }   // visible, not swallowed (R5 b)
  }
  function choose(l){ if(!PALang.set(l)) return; paint(); save(l); }
  function mount(){
    const dr=document.getElementById('drawer'); if(!dr||document.getElementById('langSw')) return;
    const foot=document.createElement('div'); foot.className='dlang';
    foot.innerHTML='<button type="button" class="plain" id="langSw" title="语言 · Language" aria-label="语言 · Language"><span data-l="zh" lang="zh-CN">中</span><span data-l="en" lang="en">EN</span></button>';
    const cs=document.getElementById('chatSearch'); if(cs) cs.before(foot); else dr.append(foot);
    btn=foot.firstChild;
    // ONE control: a tap switches to the other language (a tap on a side picks that side).
    btn.onclick=(e)=>{ const side=e.target.closest('[data-l]'); const cur=PALang.get()==='both'?'':PALang.choice();
      choose(side&&side.dataset.l!==cur?side.dataset.l:(cur==='zh'?'en':'zh')); };
    PALang.pairClass('en');   // the shell's <b>中文</b><span class="en">English</span> pairs follow the choice too
    PALang.on(()=>{ paint(); try{ PAHome.rerender(); }finally{ sendAppPrefs(false); } });
    paint();
    // After the whole shell script ran: PATipsShell (web/tips-store.js) is defined below this file.
    document.addEventListener('DOMContentLoaded',()=>PATipsShell.tip(TIP,'#langSw',TIP_TEXT));
  }
  // The account's choice wins over this device's copy (a choice made on the iPad reaches the iPhone).
  function fromProfile(){ if(ME&&(ME.lang==='zh'||ME.lang==='en')) PALang.set(ME.lang); paint(); }
  return {mount,fromProfile,choose};
})();
