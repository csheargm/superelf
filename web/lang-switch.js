/* PALangSwitch（语言切换）— the shell's ONE language control: a row in the home header's ⋯ menu, right after
   Text size (owner 2026-11-27: the v5.38 drawer-foot switch was not found). The row names the OTHER language
   ("中文" in English, "English" in 中文); a tap switches to it, live, and the menu stays open re-labelled.
   PALang (web/lang.js) applies the choice; this file keeps it on the ACCOUNT (profile.lang, so the iPhone and the
   iPad match) and tells the rest of the shell: the home re-draws, the open app frame gets {pa:'prefs', lang} at once.
   A refused account write keeps the choice on this device and says so (R5 b). Kept out of web/index.html
   (over the R4 budget). Its first-use tip points at the ⋯ button (ADR 0030, ADR 0048). */
const PALangSwitch=(()=>{
  const TIP='tip:lang-switch';
  const TIP_TEXT='新：在 ⋯ 里切换语言 · New: switch the language in ⋯';
  const OTHER={zh:'English',en:'中文'};   // the row's label: the language a tap switches TO
  const TOAST_MS=3000;
  let btn=null;
  function toast(msg){ const t=document.getElementById('fsToast'); if(!t) return; t.textContent=msg; t.classList.add('on'); setTimeout(()=>t.classList.remove('on'),TOAST_MS); }
  function paint(){ if(!btn) return; const to=PALang.choice()==='zh'?'en':'zh';
    const l=btn.querySelector('.hm-l'); l.textContent=OTHER[PALang.choice()]; l.lang=to==='zh'?'zh-CN':'en'; }
  // Saves run one at a time, in tap order, so the account ends on the LAST tap (a slow first PUT can't win).
  let saving=Promise.resolve();
  function save(l){ saving=saving.then(()=>put(l)); return saving; }
  async function put(l){
    try{ const r=await api('/api/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({lang:l})});
      if(!r.ok) throw new Error('HTTP '+r.status);
      if(ME&&typeof ME==='object') ME.lang=l; }
    catch(e){ toast('只保存在本设备 · Saved on this device only ('+((e&&e.message)||'offline')+')'); }   // visible, not swallowed (R5 b)
  }
  function choose(l){ if(!PALang.set(l)) return; paint(); save(l); }
  function mount(){
    btn=document.getElementById('langSw'); if(!btn||btn.dataset.bound) return; btn.dataset.bound='1';
    btn.onclick=()=>choose(PALang.choice()==='zh'?'en':'zh');
    PALang.pairClass('en');   // the shell's <b>中文</b><span class="en">English</span> pairs follow the choice too
    PALang.on(()=>{ paint(); try{ PAHome.rerender(); }finally{ sendAppPrefs(false); } });
    paint();
    // After the whole shell script ran: PATipsShell (web/tips-store.js) is defined below this file.
    document.addEventListener('DOMContentLoaded',()=>PATipsShell.tip(TIP,'#hmore',TIP_TEXT));
  }
  // The account's choice wins over this device's copy (a choice made on the iPad reaches the iPhone).
  // An account with no choice yet (a loaded profile: it has a role) adopts a choice made on this device before
  // sign-in. Sign-out clears the device copy (web/index.html logout), so a shared browser never hands one
  // account's choice to the next.
  function fromProfile(){ if(!ME||typeof ME!=='object') return paint();
    if(ME.lang==='zh'||ME.lang==='en') PALang.set(ME.lang);
    else if(ME.role&&PALang.stored()) save(PALang.stored());
    paint(); }
  return {mount,fromProfile,choose};
})();
