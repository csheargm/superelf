// The demo admin page in the shell · 演示管理页面 (server: lib/demo-admin.mjs, ADR 0045). Injected by
// lib/demo-boot.mjs. When the signed-in visitor's token passes /api/demo/admin/me, one row joins the
// header's ⋯ menu (#hmenu), with its one-time bilingual tip (PATipsShell, the one tip mechanism). It
// opens one modal <dialog> with five tabs: Today, People, Apps, Waiting list, 14-day trend. Phone
// first: every table is a stack of cards; from 720px the cards sit in a grid. Plain text only
// (textContent), the trend is small inline SVG bars, no library.
import { ADMIN_PATHS } from './demo.mjs';
import { AUTH_HEADER } from './demo-auth.mjs';

export const ADMIN_TIP_KEY = 'tip:demo-admin';
export const ADMIN_LABELS = Object.freeze({
  item: '演示管理 · Demo admin',
  tip: '只有你能看到：谁登录了、用了哪些应用、被限的网络 · Only you see this: who signed in, which apps they use, blocked networks',
  tabs: ['今天 · Today', '用户 · People', '应用 · Apps', '候补 · Waiting list', '14 天趋势 · 14-day trend'],
  visits: '访问 · Visits', newV: '新访客 · New visitors', nets: '网络（短哈希）· Networks (short hash)', blocked: '已达上限 · At the cap',
  reset: '清零 · Reset', done: '已清零 · Reset done', none: '暂无 · Nothing yet', anon: '访客 · Guest',
  first: '首次 · First', last: '最近 · Last', aiToday: '今日 AI · AI today', ai14: 'AI（14 天）· AI (14 days)',
  open: '打开 · Opens', ai: 'AI', build: '新建 · Builds', edit: '修改 · Edits', people: '人数 · People',
  apps: '应用 · Apps', builds: '建/改 · Builds+edits', fail: '读取失败，请重试 · Could not load — try again',
  close: '关闭 · Close',
});
const STYLE = '#demoAdm{width:min(960px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;margin:0 auto;padding:0;border:none;background:var(--bg);color:var(--text)}'
  + '#demoAdm .da-h{position:sticky;top:0;background:var(--bg);padding:12px 16px 0;z-index:1}'
  + '#demoAdm .da-t{display:flex;gap:6px;overflow-x:auto;padding:8px 0;scrollbar-width:none}'
  + '#demoAdm .da-t button{flex-shrink:0;font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--line);border-radius:16px;background:var(--card);color:var(--text);cursor:pointer}'
  + '#demoAdm .da-t button[aria-selected=true]{background:var(--accent);color:#fff;border-color:var(--accent)}'
  + '#demoAdm .da-b{padding:8px 16px 24px;display:grid;gap:8px;grid-template-columns:1fr}'
  + '@media(min-width:720px){#demoAdm .da-b{grid-template-columns:repeat(auto-fill,minmax(280px,1fr))}}'
  + '#demoAdm .da-c{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px;min-width:0;overflow-wrap:anywhere}'
  + '#demoAdm .da-c b{display:block;font-size:14px;margin-bottom:4px}#demoAdm .da-c .m{color:var(--muted)}'
  + '#demoAdm .da-c button{margin-top:6px;font:inherit;font-size:13px;padding:6px 12px;border:none;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}'
  + '#demoAdm .demo-pop-x{background:none;border:none;font-size:18px;padding:4px 8px;color:var(--muted);cursor:pointer}'
  + '#demoAdm .da-c.bad{border-color:var(--danger)}#demoAdm svg{width:100%;height:auto;display:block}';

const L = JSON.stringify(ADMIN_LABELS).replace(/</g, '\\u003c');
export const ADMIN_UI = `<style>${STYLE}</style><script>document.addEventListener('DOMContentLoaded',function(){var A=window.PADemoAuth,L=${L},dlg=null,data=null,tab=0;if(!A)return;
function tok(){var s=A.session();return s&&s.a?s.a:'';}
function call(p,o){o=o||{};o.headers=Object.assign({'${AUTH_HEADER}':tok(),'content-type':'application/json'},o.headers||{});return fetch(p,o).then(function(r){return r.ok?r.json():Promise.reject(r.status);});}
function el(t,x,p,c){var e=document.createElement(t);if(x!=null&&x!=='')e.textContent=String(x);if(c)e.className=c;if(p)p.appendChild(e);return e;}
function when(ms){return ms?new Date(ms).toLocaleString():'—';}
function card(p,title,lines,cls){var c=el('div','',p,'da-c'+(cls?' '+cls:''));el('b',title,c);lines.forEach(function(l){el('div',l,c,'m');});return c;}
function bars(p,rows,key,label){var c=card(p,label,[]),w=rows.length*12,top=Math.max.apply(null,rows.map(function(r){return r[key];})),max=Math.max(1,top),ns='http://www.w3.org/2000/svg',s=document.createElementNS(ns,'svg');
s.setAttribute('viewBox','0 0 '+w+' 44');s.setAttribute('role','img');s.setAttribute('aria-label',label);rows.forEach(function(r,i){var h=Math.round(r[key]/max*36),b=document.createElementNS(ns,'rect');b.setAttribute('x',i*12+1);b.setAttribute('y',40-h);b.setAttribute('width',10);b.setAttribute('height',Math.max(h,1));b.setAttribute('fill','var(--accent)');
var t=document.createElementNS(ns,'title');t.textContent=r.day+': '+r[key];b.appendChild(t);s.appendChild(b);});c.appendChild(s);el('div',rows[0].day+' → '+rows[rows.length-1].day+' · max '+top,c,'m');}
function today(b){var t=data.today;card(b,L.tabs[0],[L.visits+': '+t.visits,L.newV+': '+t.new]);if(!t.nets.length)card(b,L.nets,[L.none]);
t.nets.forEach(function(n){var c=card(b,n.net+(n.blocked?' · '+L.blocked:''),[L.visits+': '+n.visits,L.newV+': '+n.new],n.blocked?'bad':'');if(!n.blocked)return;var r=el('button',L.reset,c);r.type='button';r.dataset.net=n.net;
r.onclick=function(){r.disabled=true;call('${ADMIN_PATHS.reset}',{method:'POST',body:JSON.stringify({net:n.net})}).then(function(){r.textContent=L.done;load();}).catch(function(){r.disabled=false;r.textContent=L.fail;});};});}
function appLines(apps){return Object.keys(apps).map(function(s){var a=apps[s];return s+' — '+L.open+' '+a.open+', '+L.ai+' '+a.ai+', '+L.build+' '+a.build+', '+L.edit+' '+a.edit;});}
function people(b){if(!data.people.length)card(b,L.tabs[1],[L.none]);data.people.forEach(function(u){var c=card(b,(u.name||u.email||L.anon)+(u.name&&u.email?' · '+u.email:''),[L.first+': '+when(u.first||u.created),L.last+': '+when(Math.max(u.last,u.seen)),L.aiToday+': '+u.aiToday+' / '+data.aiCap,L.ai14+': '+u.ai]);c.dataset.uid=u.id;
var more=appLines(u.apps);if(more.length){var d=el('details','',c),s=el('summary',L.apps+' ('+more.length+')',d);more.forEach(function(l){el('div',l,d,'m');});}});}
function who(id){var u=data.people.find(function(x){return x.id===id;});return u?(u.name||u.email||L.anon):L.anon;}
function apps(b){if(!data.apps.length)card(b,L.tabs[2],[L.none]);data.apps.forEach(function(a){card(b,a.slug,[L.people+': '+a.people.length,L.open+': '+a.open+' · '+L.ai+': '+a.ai,L.build+': '+a.build+' · '+L.edit+': '+a.edit,a.people.map(who).join(', ')]);});}
function wait(b){if(!data.waitlist.length)card(b,L.tabs[3],[L.none]);data.waitlist.forEach(function(w){card(b,w.email,[w.name,w.note,w.t].filter(Boolean));});}
function trend(b){var r=data.trend;bars(b,r,'visits',L.visits);bars(b,r,'new',L.newV);bars(b,r,'ai',L.ai);bars(b,r,'builds',L.builds);}
function draw(){var b=dlg.querySelector('.da-b');b.textContent='';dlg.querySelectorAll('.da-t button').forEach(function(x,i){x.setAttribute('aria-selected',String(i===tab));});if(!data)return;[today,people,apps,wait,trend][tab](b);}
function load(){return call('${ADMIN_PATHS.summary}?days=14').then(function(j){data=j;draw();}).catch(function(){var b=dlg.querySelector('.da-b');b.textContent='';card(b,L.fail,[]);});}
function open(){if(!dlg){dlg=el('dialog','',document.body);dlg.id='demoAdm';var h=el('div','',dlg,'da-h'),P=window.PADemoPop;if(P)P.head(h,L.item,function(){dlg.close();});else el('b',L.item,h);
var t=el('div','',h,'da-t');t.setAttribute('role','tablist');L.tabs.forEach(function(n,i){var x=el('button',n,t);x.type='button';x.setAttribute('role','tab');x.onclick=function(){tab=i;draw();};});el('div','',dlg,'da-b');}
if(!dlg.open)dlg.showModal();draw();load();}
(A.busy||Promise.resolve()).then(function(){if(!tok())return;return call('${ADMIN_PATHS.me}').then(function(){var m=document.getElementById('hmenu');if(!m||document.getElementById('demoAdminItem'))return;
var b=el('button','',m,'ibtn');b.id='demoAdminItem';b.type='button';if(typeof PAIcons!=='undefined')b.innerHTML=PAIcons.svg('users');el('span',L.item,b,'hm-l');b.onclick=open;if(typeof PATipsShell!=='undefined')PATipsShell.tip('${ADMIN_TIP_KEY}','#demoAdminItem',L.tip);});})
.catch(function(){/* not the demo admin (404) or offline: no menu row, nothing to say */});});</script>`;
