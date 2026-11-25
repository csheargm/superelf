/* PAHome（主页）— the "ask-first" home (approved mockup C layout + B style): greeting, the ask box as
   the centrepiece, a "Start here" row of 3 gradient tiles, then a dock of compact app tiles. No app
   is shown twice. Also the header's ⋯ menu (Apps & chats, Aa, refresh, settings, workspace) and the
   signed-in avatar. Kept out of web/index.html (over the R4 budget); pure helpers are exported for
   test/home-v2.test.mjs. Colours: web/home-v2.css on the shared tokens (web/theme-tokens.css).
   - guest: a demo visitor with no sign-in (lib/demo-boot.mjs PADemoAuth with no session).
   - hidden slugs: demo config demo.home_hide (lib/demo-boot.mjs passes it as PADemoAuth.conf.hide). */
const PAHome=(function(){
  const MORE_TIP='tip:home-more';
  const T={
    guestHi:['嗨，','想做点什么？','Hi — what shall we make?'],
    demo:['这是演示版 · 点任一应用试试，或在下方让我做一个新应用','This is the demo — open any app, or ask below for a new one.'],
    keep:['登录后可保存','Sign in to keep your work'],
    phGuest:['试试：“给孩子做个背经文的小游戏”','Try: “make a verse game for my kids”'], phGuestShort:['让我做个应用','Ask me to make an app'],
    phMember:['问我，或让我改一个应用','Ask anything, or change an app'],
    make:['做个应用','Make an app'], starter:'帮我做一个应用，它能',
    more:'更多应用 · More apps', shelf:'家庭书架 · Family shelf',
    tip:'新：字号、刷新和设置都在这里 · New: text size, refresh and settings are here',
  };
  // Built-in apps installed before their titles became bilingual keep their old meta.json (the
  // updater only replaces index.html, lib/builtin-app-update.mjs). Their old titles map here.
  const OLD_TITLES={'Biblical Values':['圣经价值观','Biblical Values'],'Longevity':['长寿','Longevity'],'Productivity Hub':['效率中心','Productivity Hub'],
    'Tasks':['待办','Tasks'],'Diabetes':['糖尿病','Diabetes'],'Allergy & Pollen 花粉':['花粉','Allergy & Pollen'],'Bible 圣经':['圣经','Bible'],
    'Journal 手写':['手写','Journal'],'Sunday Study 主日查经':['主日查经','Sunday Study']};
  const CJK=/[　-〿㐀-鿿＀-￯]/;
  // A title → [中文, English]. Mixed titles split into their CJK and Latin runs; one-language titles keep one line.
  function label(title){
    const t=String(title||'').trim(); if(Object.hasOwn(OLD_TITLES,t)) return OLD_TITLES[t];   // own keys only: a title like "constructor" is a title
    if(!CJK.test(t)) return [t,''];
    const zh=(t.match(/[　-〿㐀-鿿＀-￯·]+/g)||[]).join('').replace(/^·|·$/g,'').trim();
    const en=t.replace(/[　-〿㐀-鿿＀-￯]+/g,' ').replace(/\s*·\s*/g,' ').replace(/\s+/g,' ').trim();
    return en?[zh,en]:[zh,''];
  }
  // Which apps go where. own: the member's apps, already in most-used order (index.html sortBySavedOrder).
  // No open history yet (a new account): the familiar starters lead instead of folder order.
  const FIRST=['bible','notes','tasks'];
  function layout(own,shelf,{guest,hide,mru}){
    const hidden=new Set(hide||[]); const keep=(a)=>!hidden.has(a.name);
    const mine=(own||[]).filter(keep), by=(n)=>mine.find((a)=>a.name===n);
    let start;
    if(guest){ start=[by('bible'),by('notes')].filter(Boolean).map((a)=>({app:a})); start.push({make:true}); }
    else { const used=new Set(mru||[]), seen=mine.filter((a)=>used.has(a.name));   // most-used first, then the starters, then the rest
      const lead=[...seen,...FIRST.map(by).filter((a)=>a&&!used.has(a.name)),...mine.filter((a)=>!used.has(a.name)&&!FIRST.includes(a.name))];
      start=lead.slice(0,3).map((a)=>({app:a})); }
    if(!start.length) start=[{make:true}];
    const used=new Set(start.filter((s)=>s.app).map((s)=>s.app.name));
    return {start,dock:mine.filter((a)=>!used.has(a.name)),shelf:(shelf||[]).filter(keep)};
  }
  // Today's chips: the open-task count and other live app faces (no extra request: they ride /api/apps).
  function chips(own){
    const out=[];
    for(const a of own||[]){ const f=a.face; if(!f||!f.value) continue;
      if(a.name==='tasks') out.unshift({app:a,zh:`${f.value} 件待办`,en:`${f.value} tasks`});
      else { const [zh,en]=label(a.title); const v=String(f.value), ve=CJK.test(v)?'':' '+v;   // a 中文 value (周日) stays on the 中文 side only
        out.push({app:a,zh:`${zh||en} ${v}`,en:en&&zh?en+ve:''}); }
    }
    return out.slice(0,3);
  }
  const GRADS=['g1','g2','g3'];
  const dockIcon=(a)=>{ const {icon,color}=PAIcons.appIcon(a); return `<span class="dk-ic" style="--c:${color}">${PAIcons.svg(icon)}</span>`; };
  const updDot=(a,esc)=>a.hasUpdate?`<span class="update-dot" data-update="${esc(a.name)}" data-title="${esc(a.title)}" title="有新版本 · Update available"></span>`:'';
  const name2=(zh,en,esc)=>`${esc(zh||en)}${zh&&en?`<small>${esc(en)}</small>`:''}`;
  function tileHtml(s,i,uid,esc){
    if(s.make) return `<button type="button" class="st g3" data-make>${PAIcons.svg('spark')}<span class="zh">${T.make[0]}</span><span class="en">${T.make[1]}</span></button>`;
    const a=s.app, [zh,en]=label(a.title);
    return `<button type="button" class="st ${GRADS[i%3]} ecard" data-eu="${esc(uid)}" data-es="${esc(a.name)}" data-et="${esc(a.title)}">${updDot(a,esc)}${PAIcons.svg(PAIcons.appIcon(a).icon)}<span class="zh">${esc(zh||en)}</span>${zh&&en?`<span class="en">${esc(en)}</span>`:''}</button>`;
  }
  function dockHtml(lay,uid,esc){
    const card=(u,a,badge)=>{ const [zh,en]=label(a.title);
      return `<div class="ecard dk" tabindex="0" role="button" data-eu="${esc(u)}" data-es="${esc(a.name)}" data-et="${esc(a.title)}" title="${esc(a.desc||a.title)}">${dockIcon(a)}${updDot(a,esc)}<b>${name2(zh,en,esc)}</b>${badge||''}</div>`; };
    const badge=(a)=>a.fromFamily?`<button class="plain" data-fget="${esc(a.uid)}" data-fslug="${esc(a.name)}">获取 · Get</button>`:'';
    return lay.dock.map((a)=>card(uid,a,'')).join('')
      +(lay.shelf.length?`<div class="grid-sep">${T.shelf}</div>`+lay.shelf.map((a)=>card(a.uid,a,badge(a))).join(''):'');
  }
  const guest=()=>!!(window.PADemoAuth&&!(PADemoAuth.session&&PADemoAuth.session()));
  const hideList=()=>{ const h=window.PADemoAuth&&PADemoAuth.conf&&PADemoAuth.conf.hide; return Array.isArray(h)?h:[]; };
  let NAME='';
  const $=(s)=>document.querySelector(s);
  function render({own,shelf,uid,esc}){
    const g=guest(), lay=layout(own,shelf,{guest:g,hide:hideList(),mru:(typeof ME!=='undefined'&&ME&&ME.appOrder)||[]});
    const [gz,ge]=PAHomeLook.greeting(), [dz,de]=PAHomeLook.dateLine();
    $('#hHello').innerHTML=g
      ?`${T.guestHi[0]}<span class="grad">${T.guestHi[1]}</span><span class="en">${T.guestHi[2]}</span>`
      :`${esc(gz)}，<span class="grad">${esc(NAME||'')}</span><span class="en">${esc(ge)} · ${esc(dz)} · ${esc(de)}</span>`;
    $('#hChips').innerHTML=g?'':chips(own).map((c)=>`<button type="button" class="chip-t" data-eu="${esc(uid)}" data-es="${esc(c.app.name)}" data-et="${esc(c.app.title)}">${esc(c.zh)}${c.en?` · ${esc(c.en)}`:''}</button>`).join('');
    $('#hWelcome').hidden=!g; $('#hKeep').hidden=!g;
    const ph=g?T.phGuest:T.phMember, sh=g?T.phGuestShort:ph;   // phone: the short line, so the ring never cuts it
    $('#hPh').innerHTML=`<span class="ph-l">${ph[0]}<small>${ph[1]}</small></span><span class="ph-s">${sh[0]}<small>${sh[1]}</small></span>`; PH_LABEL=ph[0]+' · '+ph[1]; if(docked) $('#box').setAttribute('aria-label',PH_LABEL);
    $('#hStart').innerHTML=lay.start.map((s,i)=>tileHtml(s,i,uid,esc)).join('');
    $('#hDockHead').hidden=!(lay.dock.length||lay.shelf.length);
    $('#eApps').innerHTML=dockHtml(lay,uid,esc);
    const n=document.getElementById('demoNotice'); $('#hNotice').textContent=n?n.textContent:'';
    syncHeader();
    return lay;
  }
  function setName(n){ NAME=String(n||''); syncHeader(); }
  function syncHeader(){
    const av=$('#hAvatar'); if(!av) return;
    const g=guest(), sbIn=!!(window.PADemoAuth&&!g); av.hidden=g||(!NAME&&!sbIn); av.textContent=NAME?[...NAME][0].toUpperCase():(sbIn?'我':'');   // a signed-in demo visitor with no name still sees the account, not a blank header
  }
  // The ONE composer: while the home shows, the chat's own input row (#frow: attach, #box, send) sits in the
  // ask ring, so every send path, attachment and test stays the shell's own. Its chat placeholder comes back on leave.
  let docked=false, anchor=null, chipAnchor=null, chatPh='', PH_LABEL='';
  function dockInput(on){
    const row=$('#frow'), box=$('#box'); if(!row||!box||on===docked) return;
    if(!anchor){ anchor=document.createComment('frow'); row.after(anchor); }
    const att=$('#chips'); if(att&&!chipAnchor){ chipAnchor=document.createComment('chips'); att.after(chipAnchor); }   // attachment chips go with the row, or they hide in #f

    docked=on;
    if(on){ chatPh=box.placeholder; box.placeholder=' '; if(PH_LABEL) box.setAttribute('aria-label',PH_LABEL); $('#homeForm').prepend(row); if(att) $('#homeForm').after(att); }
    else { box.placeholder=chatPh; box.removeAttribute('aria-label'); anchor.before(row); if(att) chipAnchor.before(att); }
  }
  function startMake(){ const i=$('#box'); i.value=T.starter; i.focus(); i.setSelectionRange(i.value.length,i.value.length); i.dispatchEvent(new Event('input')); }
  function closeMore(){ const m=$('#hmenu'); if(m&&!m.hidden){ m.hidden=true; $('#hmore').setAttribute('aria-expanded','false'); } }
  function bind(){
    $('#hmore').onclick=(e)=>{ e.stopPropagation(); const m=$('#hmenu'); m.hidden=!m.hidden; if(!m.hidden) placeMenu(m,$('#hmore')); $('#hmore').setAttribute('aria-expanded',String(!m.hidden)); };   // the press on ⋯ also closes its tip (PATips)
    $('#hmenu').addEventListener('click',(e)=>{ if(e.target.closest('button')&&!e.target.closest('.aa')) closeMore(); });
    // pointerdown as well as click: iOS Safari sends no click for a tap on plain text, so the menu stayed (web/popover.js).
    for(const ev of ['pointerdown','click']) document.addEventListener(ev,(e)=>{ if(!e.target.closest('#hmenu,#hmore')) closeMore(); },true);   // + click: a keyboard Enter outside
    document.addEventListener('keydown',(e)=>{ if(e.key==='Escape'&&!$('#hmenu').hidden){ closeMore(); $('#hmore').focus(); } });
    $('#hAvatar').onclick=()=>$('#settings').click();
    $('#homeForm').onsubmit=(e)=>{ e.preventDefault(); submitSend(); };   // Enter in #box, as #f does
    $('#hKeep').querySelector('a').onclick=(e)=>{ e.preventDefault(); dispatchEvent(new Event('pa-demo-signin')); };   // = DEMO_SIGNIN_EVENT (index.html), lib/demo-boot.mjs SIGNIN_EVENT
    const open=(e)=>{ if(e.target.closest('[data-make]')){ startMake(); return; }
      const dot=e.target.closest('.update-dot'); if(dot){ e.stopPropagation(); showUpdateSheet(dot.dataset.update,dot.dataset.title); return; }
      const c=e.target.closest('[data-es]'); if(c) openApp(c.dataset.eu,c.dataset.es,c.dataset.et); };
    $('#hStart').onclick=open; $('#hChips').onclick=open;
    // Dock tiles are divs (they hold a Get button): Enter / Space opens them like a click.
    $('#eApps').addEventListener('keydown',(e)=>{ if((e.key==='Enter'||e.key===' ')&&e.target.matches('.ecard.dk')){ e.preventDefault(); e.target.click(); } });
    // After the whole shell script ran: _SEEN (web/settings.js) exists only then, and the demo's Sign in
    // (lib/demo-boot.mjs) has landed beside ⚙, now inside ⋯ — bring it to the header.
    document.addEventListener('DOMContentLoaded',()=>{
      if(!_SEEN.has(MORE_TIP)) PATipsShell.tip(MORE_TIP,'#hmore',T.tip);   // the ONE tip mechanism (✕, Escape, outside tap); an old device-only dismissal still counts
      const s=$('#demoSignin'); if(s){ s.classList.add('h-signin'); $('#hmore').before(s); } syncHeader(); });
  }
  return {label,layout,chips,render,setName,bind,startMake,dockInput,T};
})();
