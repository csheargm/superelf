// The waiting-list line in the demo shell · 演示外壳的等候名单入口 (server: lib/demo-waitlist.mjs).
// Injected by lib/demo-boot.mjs. One quiet row in the left drawer, just above "About superelf"; it
// opens a tiny form (email + optional note) in the shell's shared .cmenu-pop, which says what the
// email is for (its first-use hint) and ends in a thank-you line. ?join=1 (the front page's link,
// site/index.html) opens the form on load: the static site never posts across origins.
import { WAITLIST_PATH } from './demo-waitlist.mjs';

export const WAITLIST_LABELS = Object.freeze({
  line: '想要自己的私人 superelf？ · Want your own private superelf?',
  hint: '留下邮箱，私人部署开放时我们会通知你，不作他用。 · Leave your email and we will write when private hosting opens. Used for nothing else.',
  email: '邮箱 · Email', note: '备注（可选） · Note (optional)', send: '加入等候名单 · Join the waiting list',
  thanks: '谢谢，你已在名单上 · Thank you — you are on the list', fail: '发送失败，请重试 · Could not send — try again',
});
export const JOIN_PARAM = 'join';
export const JOIN_EVENT = 'pa-demo-join';   // the limit card (lib/demo-boot.mjs) opens the form with no node session
// ?join=1 opens the form only once the shell holds a node session: a first visit reloads the page
// when the boot gets its session (lib/demo-boot.mjs), which would wipe a half-typed form.
const SESSION_KEY = 'pa_session';   // web/index.html and lib/demo-boot.mjs keep the node session here

const STYLE = '#demoJoin{margin-top:auto;flex-shrink:0;padding:12px 16px 4px;background:none;border:none;text-align:left;font:inherit;font-size:13px;color:var(--accent);cursor:pointer}'
  + '#demoJoin+#demoHome{margin-top:0}'
  + '#demoWait{top:72px;left:50%;transform:translateX(-50%);width:min(360px,calc(100vw - 24px));padding:12px;font-size:13px;color:var(--text);z-index:60}'
  + '#demoWait form{display:flex;flex-direction:column;gap:6px}#demoWait p{margin:0 0 6px;color:var(--muted)}'
  + '#demoWait input,#demoWait textarea{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}'
  + '#demoWait textarea{min-height:56px;resize:vertical}#demoWaitMsg{margin-top:6px}';

const L = JSON.stringify(WAITLIST_LABELS).replace(/</g, '\\u003c');
export const WAITLIST_UI = `<style>${STYLE}</style><script>document.addEventListener('DOMContentLoaded',function(){var L=${L},pop=null;
function el(t,x,p){var e=document.createElement(t);if(x)e.textContent=x;p.appendChild(e);return e;}
function close(){if(pop){pop.remove();pop=null;}}
function open(){if(pop)return close();pop=el('div','',document.body);pop.id='demoWait';pop.className='cmenu-pop';el('p',L.hint,pop);
var f=el('form','',pop),i=el('input','',f),n=el('textarea','',f),b=el('button',L.send,f),m=el('div','',pop);m.id='demoWaitMsg';
i.type='email';i.required=true;i.maxLength=254;i.placeholder=L.email;i.autocomplete='email';n.maxLength=500;n.placeholder=L.note;b.type='submit';b.className='primary';var P=window.PADemoPop;if(P){P.head(pop,P.T.join,close);P.go(b);}i.focus();
f.onsubmit=function(e){e.preventDefault();b.disabled=true;m.textContent='';
fetch('${WAITLIST_PATH}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:i.value,note:n.value})})
.then(function(r){return r.json().then(function(j){if(r.ok&&j.ok){f.remove();m.textContent=L.thanks;return;}m.textContent=j.error||L.fail;b.disabled=false;});})
.catch(function(){m.textContent=L.fail;b.disabled=false;});};}
var d=document.getElementById('drawer');if(d){var row=document.createElement('button');row.id='demoJoin';row.type='button';row.textContent=L.line;row.onclick=open;
d.insertBefore(row,document.getElementById('demoHome'));}
window.addEventListener('${JOIN_EVENT}',function(){if(!pop)open();});
try{if(new URLSearchParams(location.search).get('${JOIN_PARAM}')==='1'&&localStorage.getItem('${SESSION_KEY}'))open();}catch(e){/* an odd URL or blocked storage: the drawer row still opens the form */}});</script>`;
