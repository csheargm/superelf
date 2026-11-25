// The ONE close policy for every shell ⋯ popover（外壳弹出菜单的唯一关闭规则, R3）: the chat list's,
// the drawer app row's, and the open app's ⋯ (#frameMenu, web/app-edit.js). Inlined by
// lib/shellhtml.mjs at PA_POPOVER_JS, ahead of index.html's own script.
// A menu closes on ANY of (owner 2026-11-24: "when the app bar retracts, every menu anchored to it closes"):
//   · a pointerdown OUTSIDE it (capture phase; its click is swallowed, so the first outside tap only closes the
//     menu and the drawer under it stays open). A tap INSIDE runs its item — a pointerdown there never removes it.
//   · a tap inside the app frame: PA (web/broker.inline.html) posts {pa:'shell',type:'tap'} from every app,
//     because a default-prevented touch there (the Journal pad) moves no focus the shell could see.
//   · the shell window losing focus (the classic iframe-click tell, and a tab switch).
//   · Escape, which hands focus back to the ⋯ that opened it.
//   · its anchor going away: detached, hidden, or moved off screen (the app bar sliding up, the drawer
//     closing, the app changing). Checked every MENU_WATCH_MS; barHide() also closes at once.
// While a menu anchored in the app bar is open the bar does not hide itself (menuInBar(), index.html).
// #hmenu (home ⋯, web/home-v2.js) is a fixed element with its own close; #pubSheet is a sheet with ✕.
const MENU_WATCH_MS=150;
let _menuOutside=null, _menuAnchor=null, _menuWatch=0;
const MENU_SEL='.cmenu-pop:not(#hmenu):not(#pubSheet)';
function menuOpen(){ return !!document.querySelector(MENU_SEL); }
function menuInBar(){ return menuOpen()&&!!_menuAnchor&&!!_menuAnchor.closest('#frame .bar'); }
function anchorGone(a){
  if(!a.isConnected) return true;
  const r=a.getBoundingClientRect(); if(!r.width&&!r.height) return true;   // display:none on it or a parent
  const x=r.left+r.width/2, y=r.top+r.height/2;
  if(y<0||y>innerHeight||x<0||x>innerWidth) return true;   // slid or scrolled off screen
  // Scrolled out of a clipping parent (the drawer's list under its header) while still on screen.
  for(let p=a.parentElement;p&&p!==document.body;p=p.parentElement){
    const cs=getComputedStyle(p); if(!/(auto|scroll|hidden|clip)/.test(cs.overflowY+' '+cs.overflowX)) continue;
    const q=p.getBoundingClientRect(); if(y<q.top||y>q.bottom||x<q.left||x>q.right) return true;
  }
  return false;
}
function menuKey(e){ if(e.key==='Escape'&&menuOpen()){ e.preventDefault(); e.stopImmediatePropagation(); closeMenuPop(true); } }   // one Escape closes one layer
function menuBlur(){ closeMenuPop(); }
// The click that follows the closing pointerdown is swallowed, so it never reaches what is underneath (the drawer
// backdrop's close, a row that would open): the first outside tap only closes the menu. The swallower lives until
// that press's click, or — for a tap that sends no click (iOS, plain element) — until the next press begins, a
// click elsewhere, or SWALLOW_MAX_MS as a last bound (a press held longer than that is a deliberate one).
const SWALLOW_MAX_MS=5000;
function swallowClick(at){
  let t=0;
  const eat=(ev)=>{ if(ev.target===at||at.contains(ev.target)||ev.target.contains(at)){ ev.stopPropagation(); ev.preventDefault(); } done(); };
  const next=()=>done();
  const done=()=>{ clearTimeout(t); document.removeEventListener('click',eat,true); removeEventListener('pointerup',arm,true); removeEventListener('pointercancel',arm,true); };
  // A new press ends it, but only after this press is over (its pointerup), so the press itself never does.
  // pointercancel too: a touch that became a scroll sends no pointerup and no click.
  const arm=()=>{ removeEventListener('pointerup',arm,true); removeEventListener('pointercancel',arm,true); document.addEventListener('pointerdown',next,{capture:true,once:true}); };
  document.addEventListener('click',eat,true); addEventListener('pointerup',arm,true); addEventListener('pointercancel',arm,true);
  t=setTimeout(done,SWALLOW_MAX_MS);
}
function closeMenuPop(refocus){
  document.querySelectorAll(MENU_SEL).forEach((m)=>m.remove());
  if(_menuOutside){ document.removeEventListener('pointerdown',_menuOutside,true); _menuOutside=null; }
  clearInterval(_menuWatch); _menuWatch=0;
  removeEventListener('keydown',menuKey,true); removeEventListener('blur',menuBlur);
  const a=_menuAnchor; _menuAnchor=null;
  if(refocus&&a&&a.isConnected&&!anchorGone(a)) a.focus();
}
// anchor: the control that opened the menu (its ⋯); without one only the anchor checks are skipped.
function armMenuPop(anchor){
  _menuAnchor=anchor||null;
  // iOS Safari fires no click for a tap on a plain element (a title, text): the outside tap is seen at pointerdown.
  _menuOutside=(ev)=>{ if(ev.button>0||ev.target.closest('.cmenu-pop')) return; ev.stopPropagation(); closeMenuPop(); swallowClick(ev.target); };   // primary button / touch / pen only
  setTimeout(()=>{ if(_menuOutside) document.addEventListener('pointerdown',_menuOutside,true); },0);
  addEventListener('keydown',menuKey,true); addEventListener('blur',menuBlur);
  if(_menuAnchor) _menuWatch=setInterval(()=>{ if(_menuAnchor&&anchorGone(_menuAnchor)) closeMenuPop(); },MENU_WATCH_MS);
}
// A menu that would run off the bottom opens ABOVE its ⋯ instead (its rows are 44px tall now).
function flipMenuUp(m,r){ const h=m.getBoundingClientRect().height; if(r.bottom+4+h>innerHeight-6) m.style.top=Math.max(6,r.top-4-h)+'px'; }
// Leaving or changing the app (goHome, openApp) closes every popover AND the Publish sheet: neither belongs to the next page.
// _popGen: a reply that arrives after the user moved on (a slow Publish preview) must not open a sheet then.
let _popGen=0; function popGen(){ return _popGen; }
function closeAllPops(){ _popGen++; closeMenuPop(); const s=document.getElementById('pubSheet'); if(s) s.remove(); }
// The Publish sheet (web/publish.js) has ✕ · Close; Escape closes it too.
addEventListener('keydown',(e)=>{ const s=document.getElementById('pubSheet'); if(e.key==='Escape'&&s&&!menuOpen()) s.remove(); });
// The app bar's own popovers: a ⋯ menu anchored in it, and its Aa (web/home-look.js). barHide() closes them;
// the bar's clock waits while one is open (index.html barIdleEnd).
function barMenuOpen(){ return menuInBar()||!!document.querySelector('#frame .bar [aria-expanded="true"]'); }
function closeBarMenus(){ if(menuInBar()) closeMenuPop(); if(typeof PAHomeLook!=='undefined') PAHomeLook.closeAa(); }
// A tap inside the app is an outside tap for every shell popover over it.
addEventListener('message',(e)=>{ const fr=document.getElementById('fr');
  if(e.data&&e.data.pa==='shell'&&e.data.type==='tap'&&fr&&e.source===fr.contentWindow){ closeMenuPop(); if(typeof PAHomeLook!=='undefined') PAHomeLook.closeAa(); } });
