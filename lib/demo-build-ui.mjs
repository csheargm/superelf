// The demo shell's background-build indicator · 后台建应用指示 (lib/demo-build-job.mjs has the job).
// Injected by lib/demo-boot.mjs (the shell, web/index.html, is far over its size budget, so demo-only
// UI lives here). One small fixed pill, top right, above an open app too:
//   building → "Building <title>… · 正在创建…", re-checked every POLL_MS until it ends;
//   done     → "✓ <title> — Open · 打开": a tap opens the app; the app list and an open chat refresh;
//   failed   → "⚠ <reason>": a tap dismisses it.
// A finished job is shown until tapped once (its id remembered in this browser). After every chat
// send the pill looks for a new job for WATCH_MS (a build starts only once the model has answered).
// The chat's done note links to /#app=<slug>: that link, and a page opened at it, open the app in place.
// First-use tip (ADR 0030, owner rule): the first time the pill shows, a PATips tip beside it (the shell's ONE tip
// mechanism: ✕, Escape, any outside press; seen on the account). A device that dismissed the old tip keeps it gone.
export const DEMO_BUILD_TIP = '应用在后台创建，可以切换应用或刷新，完成后这里会提示 · Your app is built in the background — switch apps or reload, this shows when it is done';
export const BUILD_LABELS = Object.freeze({ building: 'Building', buildingZh: '正在创建…', open: '打开 · Open' });
const POLL_MS = 4000;
const GAP_PX = 4;            // between the header's bottom edge, the pill and its tip
const WATCH_MS = 330_000;   // covers the chat model's own answer (chat_timeout_s 300 on the live node) before a build starts

const STYLE = '<style>#demoBuild{position:fixed;right:12px;z-index:2147482000;max-width:min(320px,calc(100vw - 24px));'
  + 'box-sizing:border-box;font-size:13px;border-radius:999px;padding:6px 12px;cursor:pointer;background:var(--card,#fff);'
  + 'color:var(--text,#1c1e1d);border:1px solid var(--accent,#0f6355);box-shadow:0 2px 8px rgba(0,0,0,.15);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
  + '#demoBuild{top:60px}'   // fallback: place() measures the header
  + '#demoBuild.fail{border-color:var(--danger,#b3261e)}</style>';

const SCRIPT = `<script>(function(){var P='/api/demo/build',K='demo_build_seen',TK='demo_tip_build_seen',L=${JSON.stringify(BUILD_LABELS)},TIP=${JSON.stringify(DEMO_BUILD_TIP)};
var BARS='header,#frame .bar',pill=null,tipped=false,timer=0,watch=0,ended='',first=true,job=null;
function get(k){try{return localStorage.getItem(k)||'';}catch(e){return '';/* blocked storage: shown again, a hint only */}}
function put(k,v){try{localStorage.setItem(k,v);}catch(e){/* blocked storage: shown again next load */}}
function later(ms){clearTimeout(timer);timer=setTimeout(check,ms);}
function tok(){return typeof T!=='undefined'&&T?T:'';}   // the shell's own session, not another tab's
function check(){var t=tok();if(!t)return later(${POLL_MS});
fetch(P,{headers:{authorization:'Bearer '+t}}).then(function(r){return r.ok?r.json():null;}).then(function(j){if(j&&j.ok&&tok()===t)show(j.job);/* a refused poll or a changed session keeps what is shown */})
.catch(function(){/* offline or restarting: looked at again below */}).then(function(){if((job&&job.status==='building')||Date.now()<watch)later(${POLL_MS});});}
function el(id){var e=document.createElement('div');e.id=id;document.body.appendChild(e);return e;}
function drop(){if(pill){pill.remove();pill=null;}}
function open(slug,title){var go=function(){if(typeof UID!=='undefined'&&UID&&typeof openApp==='function')openApp(UID,slug,title||slug);else setTimeout(go,300);};go();}
function finished(j){if(typeof loadApps==='function')loadApps();if(typeof convoId!=='undefined'&&convoId===j.convoId&&typeof openConvo==='function')openConvo(convoId);}
function place(){if(!pill)return;var b=0;document.querySelectorAll(BARS).forEach(function(h){var r=h.getBoundingClientRect();if(r.height&&r.bottom>b)b=r.bottom;});   // below the header and an open app's bar as they are NOW (wrapped, A+, a phone), never over their controls
pill.style.top=(b+${GAP_PX})+'px';}
window.addEventListener('resize',place);document.addEventListener('transitionend',place,true);   // the app bar slides in by transform: no resize fires
if(typeof ResizeObserver==='function'){var ro=new ResizeObserver(place);document.addEventListener('DOMContentLoaded',function(){document.querySelectorAll(BARS).forEach(function(h){ro.observe(h);});});}
function show(j){job=j;if(j&&j.status!=='building'&&ended!==j.id){if(!first)finished(j);ended=j.id;}first=false;
if(!j||(j.status!=='building'&&get(K)===j.id)){drop();return;}
if(!pill){pill=el('demoBuild');pill.onclick=function(){if(!job||job.status==='building')return;put(K,job.id);drop();if(job.status==='done')open(job.slug,job.title);};}
pill.className=j.status==='failed'?'fail':'';
pill.textContent=j.status==='building'?L.building+' '+j.title+'… · '+L.buildingZh:j.status==='done'?'✓ '+j.title+' — '+L.open:String(j.error||'');
if(!tipped&&!get(TK)&&window.PATips){tipped=true;window.PATips.register({id:'tip:demo-build',anchor:function(){return pill;},text:TIP});}place();}
var of=window.fetch;window.fetch=function(u){var p=of.apply(this,arguments);if(String(u).indexOf('/api/chat')>=0){watch=Date.now()+${WATCH_MS};later(${POLL_MS});}return p;};
var SLUG=/^#app=([a-z0-9-]{1,40})$/;
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a||a.origin!==location.origin)return;var m=a.hash.match(SLUG);if(!m||a.pathname!=='/')return;
e.preventDefault();e.stopPropagation();open(m[1]);},true);
var h=location.hash.match(SLUG);if(h){history.replaceState(null,'',location.pathname);if(typeof appHistReplaceNext!=='undefined')appHistReplaceNext=true;open(h[1]);}
document.addEventListener('visibilitychange',function(){if(!document.hidden)check();});
document.addEventListener('DOMContentLoaded',check);})();</script>`;

export const BUILD_UI = STYLE + SCRIPT;
