// The demo shell's own client code · 演示外壳脚本 (lib/demo.mjs has the rules), injected into the
// shell's <head> at serve time. Three parts:
//  1. Boot: the shell always runs signed in to the NODE. With no node session (or a stale one) it asks
//     DEMO_START_PATH for one; a visitor signed in to scripturetolife.org (Supabase, lib/demo-auth.mjs)
//     sends that access token, and gets their own workspace instead of the anonymous one.
//  2. Sign-in control: email → Supabase magic link (REST /auth/v1/otp with PKCE, no SDK) back to this
//     page; its ?code= is exchanged for a session kept in localStorage (SB_KEY), refreshed before expiry.
//  3. First-use tips (ADR 0030): one beside the chat box, one beside the sign-in control.
// Sign-out (the shell's own logout or ours) clears the Supabase session too, so the next person on a
// shared browser starts signed out.
import { DEMO_START_PATH, DEMO_DELETE_PATH } from './demo.mjs';
import { AUTH_HEADER, SIGNIN_CODE, authConfig } from './demo-auth.mjs';

export const DEMO_APP_TIP = 'Try "make me an app that …" — it appears in your app list · 试试说「帮我做一个……的应用」，它会出现在你的应用列表里 ✕';
export const DEMO_SIGNIN_TIP = 'Sign in with your scripturetolife.org email to use AI — the same account works on both · 用 scripturetolife.org 的邮箱登录即可使用 AI，两边同一个账户 ✕';
export const SIGNIN_LABELS = Object.freeze({
  in: 'Sign in · 登录', out: 'Sign out · 退出登录', send: 'Email me a link · 发送登录链接',
  sent: 'Check your email for the sign-in link · 请查收邮件中的登录链接', email: 'Email · 邮箱',
  off: 'Sign-in is not set up yet · 登录尚未配置', del: 'Delete my account · 删除账户',
  delAsk: 'Delete all your demo data — apps, chats and app data — and sign out? This cannot be undone. Your scripturetolife.org sign-in stays; only the demo data goes. · 删除你在演示中的全部数据（应用、聊天、应用数据）并退出登录？此操作无法撤销。你的 scripturetolife.org 登录账户保留，只删除演示数据。', fail: 'Could not send the link — try again · 发送失败，请重试',
});
const demoNotice = (cfg) => (cfg.demo && typeof cfg.demo.notice === 'string' ? cfg.demo.notice.trim().slice(0, 500) : '');
const SB_KEY = 'sb_session';
const OUT_KEY = 'sb_signed_out';  // when this browser last signed out: other tabs drop replies to calls made before it
const PKCE_KEY = 'sb_pkce';      // the code verifier of the link this browser asked for
const REFRESH_EARLY_S = 300;      // refresh the access token this long before it expires
const REFRESH_CHECK_MS = 60_000;

const DEMO_STYLE = '<style>#shellVfy,#login{display:none!important}'
  + '#demoTip,#demoSigninTip{margin:4px 12px;padding:8px 10px;border:1px solid var(--accent,#0f6355);border-radius:10px;font-size:13px;cursor:pointer;background:var(--card,#fff);color:var(--ink,#1d2321)}'
  + '#demoAuth{position:fixed;top:8px;right:8px;z-index:50;display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:min(320px,calc(100vw - 16px));font-size:13px}'
  + '#demoAuth button,#demoAuth input{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--accent,#0f6355);background:var(--card,#fff);color:var(--ink,#1d2321)}'
  + '#demoSigninTip{margin:0}#demoNotice{margin:2px 12px 6px;font-size:11px;opacity:.7;text-align:center}'
  + '@media(prefers-color-scheme:dark){#demoTip,#demoSigninTip,#demoAuth button,#demoAuth input{background:var(--card,#1c2321);color:var(--ink,#e8ecea)}}</style>';

// Boot. `s` is the stored Supabase session {a: access token, r: refresh token, e: expires_at (s)}.
// Sign-in return: ?code=… is exchanged ONLY with the PKCE verifier this browser stored when it asked
// for the link (PKCE_KEY), so a link someone else requested can never sign this browser in (login
// CSRF); access tokens in a #fragment are ignored. Every minute (and at boot) a signed-in tab rebinds
// its current token to its node session (the server keeps that binding in memory) and reloads if
// the node session changed. Sign-out sets A.stopped: no pending call may write credentials after it.
const bootScript = (c) => `<script>(function(){var K='pa_session',SK='${SB_KEY}',PK='${PKCE_KEY}',OK='${OUT_KEY}',U='Demo unavailable · 演示暂不可用',C=${JSON.stringify(c).replace(/</g, '\\u003c')};
function get(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function put(k,v){if(A.stopped&&v!=null)return;try{if(v==null)localStorage.removeItem(k);else localStorage.setItem(k,v);}catch(e){/* a blocked storage: no session can be kept; start() then says so on the page */}}
function outSince(t0){return (+get(OK)||0)>=t0;}
function sb(){try{return JSON.parse(get(SK)||'null');}catch(e){return null;}}
var A=window.PADemoAuth={session:sb,conf:C,stopped:false,last:'',busy:Promise.resolve(),clear:function(){put(SK,null);put(PK,null);}};
function keep(j){if(j&&j.access_token)put(SK,JSON.stringify({a:j.access_token,r:j.refresh_token||'',e:j.expires_at||0}));}
function auth(path,body){return fetch(C.url+'/auth/v1/token?grant_type='+path,{method:'POST',headers:{apikey:C.anonKey,'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {r:r,j:j};});});}
var q=new URLSearchParams(location.search),hs=new URLSearchParams(location.hash.slice(1)),code=q.get('code'),ver=get(PK),err=q.get('error_description')||hs.get('error_description');
if(err)A.error=err;
if(code||err||hs.get('access_token'))history.replaceState(null,'',location.pathname);
var first=code&&ver&&C.url?auth('pkce',{auth_code:code,code_verifier:ver}).then(function(x){if(x.r.ok){put(PK,null);keep(x.j);}else A.error=x.j.error_description||x.j.msg||'sign-in failed';}).catch(function(){A.error='sign-in failed';}):Promise.resolve();
var of=window.fetch;window.fetch=function(u){var self=this,args=arguments;if(String(u).indexOf('/api/logout')<0)return of.apply(self,args);
var s0=sb(),rv=s0&&s0.a&&C.url&&!A.revoking?of(C.url+'/auth/v1/logout',{method:'POST',keepalive:true,headers:{apikey:C.anonKey,authorization:'Bearer '+s0.a}}).catch(function(){/* revoking is best effort: the local session is cleared either way */}):null;
A.stopped=true;A.clear();try{localStorage.setItem(OK,String(Date.now()));}catch(e){/* other tabs then sign out on their next 401 */}
return Promise.resolve(rv).then(function(){return of.apply(self,args);});};   // the shell reloads after this answers: the revoke has finished first
function say(m){document.body.textContent=m;}
function start(){var s=sb(),t=get(K),hd={},t0=Date.now();if(A.stopped)return Promise.resolve();if(s&&s.a){hd['${AUTH_HEADER}']=s.a;if(t)hd.authorization='Bearer '+t;}
return of('${DEMO_START_PATH}',{method:'POST',credentials:'same-origin',headers:hd}).then(function(r){return r.json().then(function(j){if(j.token)A.last=j.token;if(A.stopped||(s&&outSince(t0)))return;
if(r.status===401&&j.code==='${SIGNIN_CODE}'&&s){A.clear();return start();}
if(!r.ok||!j.token){if(!t)say(j.error||U);return;}put(K,j.token);if(get(K)!==j.token)return say(U);if(j.token!==t)location.reload();});}).catch(function(){if(!get(K))say(U);});}
function refresh(){var s=sb();if(!s||!s.r||!C.url||!C.anonKey||s.e-Date.now()/1000>${REFRESH_EARLY_S})return Promise.resolve();
var t0=Date.now();return auth('refresh_token',{refresh_token:s.r}).then(function(x){if(outSince(t0))return;if(x.r.ok)keep(x.j);else if(x.r.status===400||x.r.status===401||x.r.status===403)A.clear();/* 429/5xx: kept, retried next minute */})
.catch(function(){/* offline: the old token stays until it expires; the server then answers "sign in again" */});}
function sync(){if(A.stopped)return;var had;A.busy=first.then(function(){had=!!sb();return refresh();}).then(function(){var t=get(K);if(had&&!sb())put(K,null),t=null;if(!t||sb())return start();
return of('/api/ping',{headers:{authorization:'Bearer '+t}}).then(function(r){if(r.status===401){put(K,null);return start();}}).catch(function(){/* offline: the shell shows its own offline line */});});}
window.addEventListener('storage',function(e){if(e.key===OK){A.stopped=true;location.reload();}});
sync();setInterval(sync,${REFRESH_CHECK_MS});})();</script>`;

// The sign-in control (top right) and its one-time tip. Asking for a link stores a fresh PKCE
// verifier and sends only its SHA-256 challenge. Sign-out clears local state FIRST, waits for any
// pending sync, then ends the node visit (/api/logout revokes every session of the visitor and
// expires the cookie) and the Supabase session (/auth/v1/logout revokes the refresh token).
const SIGNIN_SCRIPT = `<script>document.addEventListener('DOMContentLoaded',function(){var A=window.PADemoAuth;if(!A)return;var L=${JSON.stringify(SIGNIN_LABELS)},C=A.conf,TK='demo_tip_signin_seen',PK='${PKCE_KEY}';
var box=document.createElement('div');box.id='demoAuth';document.body.appendChild(box);
function el(tag,txt,par){var e=document.createElement(tag);if(txt)e.textContent=txt;(par||box).appendChild(e);return e;}
function note(m){var n=document.getElementById('demoAuthNote')||el('div');n.id='demoAuthNote';n.textContent=m;}
function b64(u){return btoa(String.fromCharCode.apply(null,new Uint8Array(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
function signOut(){var s=A.session(),t='';try{t=localStorage.getItem('pa_session')||'';}catch(e){}A.stopped=true;A.clear();try{localStorage.removeItem('pa_session');localStorage.setItem('${OUT_KEY}',String(Date.now()));}catch(e){/* other tabs then sign out on their next 401 */}
var done=function(){location.reload();};
A.busy.then(function(){var h={authorization:'Bearer '+(A.last||t)};
A.revoking=true;var rv=s&&C.url?fetch(C.url+'/auth/v1/logout',{method:'POST',headers:{apikey:C.anonKey,authorization:'Bearer '+s.a}}).catch(function(){/* revoking is best effort: the local session is already gone */}):null;
return Promise.all([rv,fetch('/api/logout',{method:'POST',headers:h})]);}).then(done,done);}
function ask(){box.textContent='';var f=el('form'),i=el('input','',f),b=el('button',L.send,f);i.type='email';i.required=true;i.placeholder=L.email;i.autocomplete='email';b.type='submit';i.focus();
f.onsubmit=function(ev){ev.preventDefault();b.disabled=true;var v=new Uint8Array(32);crypto.getRandomValues(v);var ver=b64(v);
crypto.subtle.digest('SHA-256',new TextEncoder().encode(ver)).then(function(d){localStorage.setItem(PK,ver);
return fetch(C.url+'/auth/v1/otp?redirect_to='+encodeURIComponent(location.origin+'/'),{method:'POST',headers:{apikey:C.anonKey,'content-type':'application/json'},
body:JSON.stringify({email:i.value.trim(),create_user:true,code_challenge:b64(d),code_challenge_method:'s256'})});})
.then(function(r){if(!r.ok)throw new Error(String(r.status));box.textContent='';note(L.sent);}).catch(function(){b.disabled=false;note(L.fail);});};}
var s=A.session();
if(s){el('button',L.out).onclick=signOut;el('button',L.del).onclick=function(){if(!confirm(L.delAsk))return;var t='';try{t=localStorage.getItem('pa_session')||'';}catch(e){/* no session: the server answers 401 */}
fetch('${DEMO_DELETE_PATH}',{method:'POST',headers:{authorization:'Bearer '+t}}).then(function(r){if(!r.ok)return r.json().then(function(j){note(j.error||String(r.status));});signOut();}).catch(function(){note(L.fail);});};}
else{var b=el('button',C.url&&C.anonKey?L.in:L.off);if(C.url&&C.anonKey)b.onclick=ask;else b.disabled=true;
var seen=null;try{seen=localStorage.getItem(TK);}catch(e){/* a tip: a blocked storage just shows it again */}
if(!seen){var t=el('div',${JSON.stringify(DEMO_SIGNIN_TIP)});t.id='demoSigninTip';t.onclick=function(){t.remove();try{localStorage.setItem(TK,'1');}catch(e){/* shown again next time */}};}}
if(A.error)note(A.error);});</script>`;

// First-use tip (ADR 0030) beside the chat box: the shell carries no PATips, so this one is its own —
// shown until tapped once, remembered in this browser (a tip, so a blocked storage just shows it again).
const DEMO_TIP_SCRIPT = `<script>document.addEventListener('DOMContentLoaded',function(){var K='demo_tip_app_seen',f=document.getElementById('f');
try{if(localStorage.getItem(K))return;}catch(e){}if(!f)return;var t=document.createElement('div');t.id='demoTip';t.textContent=${JSON.stringify(DEMO_APP_TIP)};
t.onclick=function(){t.remove();try{localStorage.setItem(K,'1');}catch(e){}};f.parentNode.insertBefore(t,f);});</script>`;

// The client gets the PUBLIC values only (project URL, anon key) — read per request, so a config
// edit needs no restart; bootScript escapes `<`, so a value can never close the <script> it sits in.
// The notice under the chat box: its text is config (demo.notice), shown as plain text.
const noticeScript = (text) => (text ? `<script>document.addEventListener('DOMContentLoaded',function(){var f=document.getElementById('f');if(!f)return;var n=document.createElement('div');n.id='demoNotice';
n.textContent=${JSON.stringify(text).replace(/</g, '\\u003c')};f.parentNode.insertBefore(n,f.nextSibling);});</script>` : '');
export function injectDemoBoot(html, cfg) {
  const a = authConfig(cfg);
  const c = { url: a.url, anonKey: a.anonKey };
  return html.replace('</head>', () => DEMO_STYLE + bootScript(c) + SIGNIN_SCRIPT + DEMO_TIP_SCRIPT + noticeScript(demoNotice(cfg)) + '</head>');
}
