/*  PALang — the ONE language setting（界面语言）: 中文 or English for all of superelf, instead of every label
     showing both (owner 2026-11-26). The SAME file runs in the shell (SHELL_PARTS, before the shell script) and
     on every app page (web.mjs puts it in a script tag ahead of the first script), so one change covers the drawer,
     the home, the app bar, PANote / PAChat and every first-use tip (R3: shared components).
     WHERE THE CHOICE LIVES: the account (profile.lang, so the iPhone and the iPad match), a device copy
     (localStorage pa_lang) for before sign-in and when the account write fails, and the device's language
     (navigator.language zh* → 中文, else English) when nothing was chosen. An app frame has no storage
     (opaque origin): the shell posts {pa:'prefs', lang} to it, and this page applies it live.
     BILINGUAL APPS keep both (the Bible app, its study pages: lib/ui-lang.mjs BILINGUAL_APPS or meta.json
     "bilingual": true). The server writes that into PA_LANG_BOTH below when it serves such a page.
     HOW STRINGS FOLLOW IT, with no edit at each call site:
       - PALang.t(['中文','English']) or PALang.t('中文 · English') → the chosen side ('both' joins them);
       - text nodes and title / aria-label / placeholder / alt of the form "中文 · English" (the house style)
         are switched in place, and switched back on a flip; new nodes are switched as they arrive;
       - in the shell only (pairClass), a <span class="en"> after its 中文 sibling is the English half.
       Never switched: inputs' values, textareas' text (their title/placeholder/aria-label are), contenteditable in any state, the note text layer, scripts, the chat logs (#log, .pac-log:
       what people wrote and what the AI said) and anything inside [data-pa-lang-skip].
     Native alert / confirm / prompt messages are switched the same way (wrapped once, below).
     PALang.get() → 'zh' | 'en' | 'both'; choice() → 'zh' | 'en'; stored() → this device's saved choice or ''; set(l) → applied now, kept on this device;
     bilingual(on); on(fn) → called on every change; device() → the device's default.
     Driven by test/lang.test.mjs (unit, over this file in a vm) and test/lang-e2e.test.mjs (browsers).
   (The shell pairing CSS lives in web/shell-look.css.) */
(function(){
  if(typeof window==='undefined'||typeof document==='undefined'||window.PALang) return;   // no page (a script run outside a browser): nothing to switch
  const KEY='pa_lang', SEP=' · ';
  const CJK=/[　-〿㐀-鿿豈-﫿＀-￯]/, LATIN=/[A-Za-z]/;
  const ATTRS=['title','aria-label','placeholder','alt'];
  // contenteditable in ANY state (the note's text layer is contenteditable=false outside the T tool, and its
  // HTML is committed on the next edit: switching it would rewrite saved notes) and the note text layer itself.
  const SKIP='script,style,[contenteditable],.pan-textlayer,#log,.pac-log,[data-pa-lang-skip]';
  const FORM='textarea,input,select';   // their values / text are the person's; their title, placeholder, aria-label are ours
  const norm=(v)=>(v==='zh'||v==='en'?v:'');
  function device(){ try{ const l=String((navigator.languages&&navigator.languages[0])||navigator.language||''); return /^zh/i.test(l)?'zh':'en'; }catch(_){ return 'en'; } }
  function stored(){ try{ return norm(localStorage.getItem(KEY)); }catch(_){ return ''; } }   // an opaque app frame: storage throws; the shell's prefs bring the choice (R5 case c)
  let chosen=stored(), both=/*PA_LANG_BOTH*/false, pairs='';
  if(!chosen) chosen=device();
  const subs=new Set();
  const get=()=>(both?'both':chosen);
  // "中文 · English" (or "English · 中文") → ['中文','English']: the 中文 parts and the parts with no 中文 at all, either order. Else null.
  function split(s){
    const parts=String(s).split(SEP); if(parts.length<2) return null;
    let k=0; while(k<parts.length&&CJK.test(parts[k])) k++;
    if(k<1){ // English first (the live demo notice puts its English half first): the same split, mirrored
      while(k<parts.length&&!CJK.test(parts[k])) k++;
      const en=parts.slice(0,k), zh=parts.slice(k);
      if(!zh.length||zh.some((p)=>!CJK.test(p))||!en.some((p)=>LATIN.test(p))) return null;
      return [zh.join(SEP),en.join(SEP)]; }
    if(k>=parts.length) return null;
    const rest=parts.slice(k); if(rest.some((p)=>CJK.test(p))||!rest.some((p)=>LATIN.test(p))) return null;
    return [parts.slice(0,k).join(SEP),rest.join(SEP)];
  }
  // The English side keeps a leading symbol only the 中文 side carried ("⚠ 出错了 · Failed" → "⚠ Failed").
  function lead(zh,en){ const m=/^[^\p{L}\p{N}]+/u.exec(zh); return m&&!en.startsWith(m[0].trim())?m[0]+en.trimStart():en; }
  function pick(zh,en,l){ zh=String(zh||''); en=String(en||'');
    if(l==='both') return zh&&en?zh+SEP+en:(zh||en);
    return l==='zh'?(zh||en):(en||zh); }
  function t(v,l){ l=l||get();
    if(Array.isArray(v)) return pick(v[0],v[1],l);
    const s=String(v==null?'':v), p=split(s.trim()); if(!p) return s;
    const pre=s.match(/^\s*/)[0], post=s.match(/\s*$/)[0];
    return pre+(l==='en'?lead(p[0],p[1]):pick(p[0],p[1],l))+post;
  }
  // In-place switching. orig: what the page wrote; last: what we wrote. A page that rewrites a node later
  // (its data no longer equals ours) gives the node a new original.
  const orig=new WeakMap(), last=new WeakMap();
  const skipped=(el)=>{ try{ return !!(el&&el.closest&&el.closest(SKIP)); }catch(_){ return false; } };
  function own(o,key,cur){ let m=orig.get(o); if(!m){ m={}; orig.set(o,m); } let w=last.get(o); if(!w){ w={}; last.set(o,w); }
    if(!(key in m)||w[key]!==cur) m[key]=cur; return [m,w]; }
  function text(n){
    const cur=n.data; if(!cur||cur.indexOf('·')<0&&!(orig.get(n)||{}).d) return;
    const [m,w]=own(n,'d',cur), out=t(m.d); w.d=out; if(out!==cur) n.data=out; }
  function attrs(el){
    for(const a of ATTRS){ const cur=el.getAttribute(a); if(cur==null||cur.indexOf('·')<0&&!((orig.get(el)||{})[a])) continue;
      const [m,w]=own(el,a,cur), out=t(m[a]); w[a]=out; if(out!==cur) el.setAttribute(a,out); } }
  // The shell's older markup: <b>我的应用</b><span class="en">My Apps</span>. The 中文 sibling (an element or a text
  // node, wrapped once) is marked .pa-lz; CSS on html[data-pa-lang] hides one side. A leading "· " on the English
  // half is dropped in English (it only joined the two halves).
  function pair(el){
    if(!pairs||!el.classList||!el.classList.contains(pairs)) return;
    let prev=el.previousSibling; while(prev&&prev.nodeType===3&&!prev.data.trim()) prev=prev.previousSibling;
    if(prev&&prev.nodeType===3&&CJK.test(prev.data)){ const s=document.createElement('span'); s.className='pa-lz'; prev.replaceWith(s); s.append(prev); }
    else if(prev&&prev.nodeType===1&&!prev.classList.contains(pairs)&&CJK.test(prev.textContent)) prev.classList.add('pa-lz');
    const f=el.firstChild; if(f&&f.nodeType===3){ const [m,w]=own(f,'p',f.data), out=chosen==='en'&&!both?m.p.replace(/^\s*·\s*/,''):m.p; w.p=out; if(out!==f.data) f.data=out; }
  }
  function walk(root){
    if(!root) return;
    if(root.nodeType===3){ if(!skipped(root.parentElement)) text(root); return; }
    if(root.nodeType!==1&&root.nodeType!==9&&root.nodeType!==11) return;
    if(root.nodeType===1&&skipped(root)) return;
    if(root.nodeType===1&&root.matches(FORM)){ attrs(root); return; }
    const tw=document.createTreeWalker(root,5,{acceptNode:(n)=>{ if(n.nodeType!==1) return 1; if(n.matches(SKIP)) return 2; if(n.matches(FORM)){ attrs(n); return 2; } return 1; }});   // SHOW_ELEMENT|SHOW_TEXT; REJECT a skipped subtree (a form control: its attributes only)
    if(root.nodeType===1){ attrs(root); pair(root); }
    for(let n=tw.nextNode();n;n=tw.nextNode()){ if(n.nodeType===3) text(n); else { attrs(n); pair(n); } }
  }
  let mo=null, queued=new Set(), flushing=false;
  function flush(){ flushing=true; try{ for(const n of queued) if(n.isConnected) walk(n); } finally{ queued.clear(); flushing=false; } }
  function watch(){
    if(mo||typeof MutationObserver!=='function'||!document.documentElement) return;
    mo=new MutationObserver((list)=>{ if(flushing) return;
      for(const r of list){ if(r.type==='childList') r.addedNodes.forEach((n)=>queued.add(n)); else queued.add(r.target); }
      if(queued.size) flush(); });
    mo.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:ATTRS});
  }
  function apply(){
    const r=document.documentElement;
    if(r){ r.setAttribute('data-pa-lang',get()); if(get()!=='both') r.lang=chosen==='zh'?'zh-CN':'en';
      flushing=true; try{ walk(r); } finally{ flushing=false; }   // the whole document: PATips hangs its tip on <html>, outside <body>
      watch(); }
    for(const f of subs){ try{ f(get()); }catch(e){ setTimeout(()=>{ throw e; }); } }   // one bad listener must not stop the rest; rethrown, not swallowed (R5)
  }
  function set(l){ l=norm(l); if(!l) return false;
    try{ localStorage.setItem(KEY,l); }catch(_){ /* opaque frame or blocked storage: the account copy / the shell's prefs hold it */ }
    if(l===chosen) return true; chosen=l; apply(); return true; }
  function bilingual(on){ on=!!on; if(on===both) return; both=on; apply(); }
  // The shell → this app page: {pa:'prefs', lang:'zh'|'en'|'both'} (web/index.html sendAppPrefs). Only the parent counts.
  addEventListener('message',(e)=>{ const m=e&&e.data; if(!m||m.pa!=='prefs'||typeof m.lang!=='string'||e.source!==window.parent||window.parent===window) return;
    if(m.lang==='both') bilingual(true); else { if(both&&!/*PA_LANG_BOTH*/false) bilingual(false); set(m.lang); } });
  window.PALang={KEY,get,choice:()=>chosen,t,split,set,bilingual,device,apply,stored,
    on:(f)=>{ subs.add(f); return ()=>subs.delete(f); },
    pairClass:(c)=>{ pairs=String(c||''); if(document.documentElement) document.documentElement.toggleAttribute('data-pa-pairs',!!pairs); apply(); }};
  // Native pop-ups (alert / confirm / prompt) show the chosen side of a "中文 · English" message too, for every
  // caller at once (R3). Only the message: prompt's default value (a sign-in code) is the person's, never switched.
  for(const k of ['alert','confirm','prompt']){ const f=window[k]; if(typeof f!=='function') continue;
    window[k]=function(msg,...rest){ return f.call(window,msg==null?msg:t(msg),...rest); }; }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',apply,{once:true}); else apply();
  if(document.documentElement) document.documentElement.setAttribute('data-pa-lang',get());
})();
