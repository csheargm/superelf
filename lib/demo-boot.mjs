// The demo shell's own client code · 演示外壳脚本 (lib/demo.mjs has the rules), injected into the
// shell's <head> at serve time. Three parts:
//  1. Boot: the shell always runs signed in to the NODE. With no node session (or a stale one) it asks
//     DEMO_START_PATH for one; a visitor signed in to scripturetolife.org (Supabase, lib/demo-auth.mjs)
//     sends that access token, and gets their own workspace instead of the anonymous one.
//  2. Account controls (header Sign in, ⚙ Delete my account): Continue with Google first (Supabase OAuth, PKCE), then email → Supabase magic link (prefilled from a share email's link page, never signed in by it) (REST /auth/v1/otp with PKCE, no SDK) back to this
//     page; its ?code= is exchanged for a session kept in localStorage (SB_KEY), refreshed before expiry.
//  3. First-use tip (ADR 0030) inside the chat box's fixed bar, above the input (owner 2026-11-22: no
//     sign-in banner — the demo never names the account provider's site to visitors).
//  4. The background app-build indicator (lib/demo-build-ui.mjs).
//  5. A quiet way back to the product's front page: the last row of the left drawer (demo.home_url).
//  7. The demo admin's ⋯ row and page, for the config's admin emails only (lib/demo-admin-ui.mjs).
//  6. The waiting-list row just above it (lib/demo-waitlist-ui.mjs), injected after 5 so it can find #demoHome.
// Sign-out (the shell's own, the only one) clears the Supabase session too, so the next person on a
// shared browser starts signed out.
import { DEMO_START_PATH, DEMO_DELETE_PATH } from './demo.mjs';
import { AUTH_HEADER, SIGNIN_CODE, authConfig } from './demo-auth.mjs';
import { BUILD_UI } from './demo-build-ui.mjs';
import { WAITLIST_UI, JOIN_EVENT } from './demo-waitlist-ui.mjs';
import { POP_UI } from './demo-pop.mjs';
import { PREFILL_STASH } from './app-share-mail.mjs';
import { ADMIN_UI } from './demo-admin-ui.mjs';

// The shell (web/index.html relayHttpFail) fires this when the demo's AI gate refuses a signed-out visitor.
export const SIGNIN_EVENT = 'pa-demo-signin';
export const SIGNIN_LABELS = Object.freeze({
  in: '登录 · Sign in', google: 'Continue with Google · 使用 Google 登录', or: 'or with email · 或用邮箱', answer: '登录后获得回答 · Sign in to get an answer', send: 'Email me a link · 发送登录链接',
  sent: 'Check your email for the sign-in link · 请查收邮件中的登录链接', email: 'Email · 邮箱',
  off: 'Sign-in is not set up yet · 登录尚未配置', del: 'Delete my account · 删除账户',
  delFail: 'Could not delete — try again · 删除失败，请重试',
  delAsk: 'Delete all your demo data — apps, chats and app data — and sign out? This cannot be undone. Your sign-in email stays registered; only the demo data goes. · 删除你在演示中的全部数据（应用、聊天、应用数据）并退出登录？此操作无法撤销。你的登录邮箱账户保留，只删除演示数据。', fail: 'Could not send the link — try again · 发送失败，请重试',
  rate: '发送太频繁，请约一小时后再试 · Too many links sent — try again in about an hour',
  same: '请在这个浏览器里打开邮件中的链接 · Open the link in this same browser',
  other: '这个登录链接需要在申请它的同一个浏览器里打开。请在这里重新获取链接。· This sign-in link must be opened in the same browser that asked for it. Get a new link here.',
  privacy: '我们会记录你使用了哪些应用及次数（不含聊天内容），用于改进 superelf；登录邮箱对演示管理员可见。 · We record which apps you use and how often (not what you write) to improve superelf; your sign-in email is visible to the demo admin.',
  bad: '这个登录链接已失效或已用过。请在这里重新获取链接。· This sign-in link has expired or was already used. Get a new link here.',
});
const RATE_CODE = 'over_email_send_rate_limit';   // Supabase's built-in email cap (429)
// The header title (demo.title, e.g. "superelf"); a name the member set reads "<name>'s <title>".
const demoTitle = (cfg) => (cfg.demo && typeof cfg.demo.title === 'string' ? cfg.demo.title.trim().slice(0, 40) : '');
const escHtml = (t) => t.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const demoNotice = (cfg) => (cfg.demo && typeof cfg.demo.notice === 'string' ? cfg.demo.notice.trim().slice(0, 500) : '');
// The front page the drawer's last row links to: config demo.home_url (http/https only), read per request.
export const DEFAULT_HOME_URL = 'https://superelf.app';
export const HOME_LABEL = 'About superelf · 关于 superelf ↗';
// The refused-first-visit card (#demoStop): a next step under the server's reason, 中文 first.
export const LIMIT_LABELS = Object.freeze({
  signin: '已有账号？登录 · Have an account? Sign in',
  join: '加入等候名单 · Join the waiting list',
  tomorrow: '或明天再试 · Or try again tomorrow',
});
const NEW_USER_CODE = 'demo_new_user';   // = refusal('new_user') in lib/demo-quota.mjs
// Apps the demo home leaves off its shelf (web/home-v2.js PAHome): config demo.home_hide, a list of
// app slugs, read per request (e.g. ["diabetes"]: a health app is not what a visitor should try first).
export function demoHomeHide(cfg) {
  const h = cfg.demo && cfg.demo.home_hide;
  return Array.isArray(h) ? h.filter((x) => typeof x === 'string' && /^[a-z0-9-]{1,64}$/.test(x)).slice(0, 50) : [];
}
export function demoHomeUrl(cfg) {
  const raw = cfg.demo && typeof cfg.demo.home_url === 'string' ? cfg.demo.home_url.trim() : '';
  if (!raw) return DEFAULT_HOME_URL;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : DEFAULT_HOME_URL;
  } catch { return DEFAULT_HOME_URL; }   // a malformed config value: the default link, never a broken one
}
export const SB_KEY = 'sb_session';
const OUT_KEY = 'sb_signed_out';  // when this browser last signed out: other tabs drop replies to calls made before it
const PKCE_KEY = 'sb_pkce';      // the code verifier of the link this browser asked for
const PKCE_GOOGLE_KEY = 'sb_pkce_g';   // Google's own verifier: one flow never overwrites the other's (an email link and a Google round trip can both be outstanding)
const NOTE_KEY = 'sb_link_note'; // sessionStorage: why the link did not sign in, kept across the boot reload
const NOTE_KEEP_MS = 30_000;      // …for this long, so a later manual reload does not repeat it
const REFRESH_EARLY_S = 300;      // refresh the access token this long before it expires
const REFRESH_CHECK_MS = 60_000;
const LOGOUT_WAIT_MS = 4000;      // sign-out waits at most this long for the revoke and a pending sync

// #pPin's label: a demo account has no PIN (Supabase signs it in). #demoSignin wears the header's own
// .ibtn look; its popover is the shell's shared .cmenu-pop; #demoDel is a quiet danger row (--danger).
// #healthWrap: the Tailscale health upload is an owner-node feature; so are briefings (#secBriefs: web/index.html loadBriefs asks nothing on the demo). #dot (node link) and .pa-new (new-since-your-last-visit) mean nothing to a visitor.
const DEMO_STYLE = '<style>#shellVfy,#login,#dot,#healthWrap,#secBriefs,label:has(>#pPin){display:none!important}.pa-new::after{display:none!important}'
  + '#demoSignin{font-size:13px;color:var(--accent);white-space:nowrap}header h1{flex-shrink:0;max-width:45vw}'
  + '@media(max-width:480px){header{gap:2px;padding:10px 8px}header .ibtn{padding:7px 6px}}'
  + '#demoAuth{top:56px;right:12px;padding:10px;max-width:calc(100vw - 24px);font-size:13px;color:var(--text)}'
  + '#demoAuth form{display:flex;gap:6px;flex-wrap:wrap}#demoAuth input{flex:1;min-width:0;font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}'
  + '#demoAuth button.primary{padding:7px 12px}@media(max-width:480px){#demoAuth{left:12px}#demoAuth input{flex:1 1 100%;font-size:16px}#demoAuth button.primary{flex:1 1 100%;min-height:44px}}#demoGoogle{display:block;width:100%;min-height:44px}#demoAuthOr{margin:8px 0 6px;font-size:12px;color:var(--muted);text-align:center}#demoAuthNote{margin-top:6px;color:var(--muted)}#demoAuthNote:first-child{margin-top:0}#demoAuthPriv{margin:8px 0 0;max-width:320px;font-size:12px;color:var(--muted)}'
  + '#demoDelRow{margin-top:10px;font-size:13px}#demoDel{background:none;border:none;padding:4px 0;font:inherit;color:var(--danger);cursor:pointer;text-decoration:underline}'
  + '#scrollBtn{bottom:var(--pill-clear,104px)}'   // the tip and notice make the bar taller than the shell's fixed 68px
  + '#drawer{overflow-y:auto}#secChats.open{min-height:160px}#drawer:has(#chatSearch.on){overflow:hidden}'   // a short screen: the drawer scrolls, so its last row (#demoHome) stays reachable and Chats keeps room
  + '#demoHome{margin-top:auto;flex-shrink:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line);font-size:13px;color:var(--muted);text-decoration:none}'
  + '#demoStop{position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;margin:0;border:0;box-sizing:border-box}#demoStop[open]{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:14px;padding:24px 16px;background:var(--bg,#fff);color:var(--text,#1c1e1d);font-size:16px;line-height:1.5;text-align:center}'
  + '#demoStop p{margin:0}#demoStopMsg{outline:none}#demoStop a,#demoStop button{font:inherit;color:var(--accent,#0f6355)}#demoStop button{background:none;border:none;padding:4px;width:auto;max-width:100%;cursor:pointer;text-decoration:underline}#demoStop .muted{color:var(--muted,#666);font-size:14px}'
  + '#demoDelMsg{color:var(--danger)}#demoNotice{margin:0;font-size:11px;opacity:.7;text-align:center}</style>';

// Boot. `s` is the stored Supabase session {a: access token, r: refresh token, e: expires_at (s)}.
// Sign-in return: ?code=… is exchanged ONLY with the PKCE verifier this browser stored when it asked
// for the link (PKCE_KEY), so a link someone else requested can never sign this browser in (login
// CSRF); access tokens in a #fragment are ignored. Every minute (and at boot) a signed-in tab rebinds
// its current token to its node session (the server keeps that binding in memory) and reloads if
// the node session changed. Sign-out sets A.stopped: no pending call may write credentials after it.
const bootScript = (c) => `<script>(function(){var NK='${NOTE_KEY}',K='pa_session',SK='${SB_KEY}',PK='${PKCE_KEY}',PG='${PKCE_GOOGLE_KEY}',OK='${OUT_KEY}',U='Demo unavailable · 演示暂不可用',C=${JSON.stringify(c).replace(/</g, '\\u003c')};
function get(k){try{return localStorage.getItem(k);}catch(e){return null;}}
function put(k,v){if(A.stopped&&v!=null)return;try{if(v==null)localStorage.removeItem(k);else localStorage.setItem(k,v);}catch(e){/* a blocked storage: no session can be kept; start() then says so on the page */}}
function outSince(t0){return (+get(OK)||0)>=t0;}
function sb(){try{return JSON.parse(get(SK)||'null');}catch(e){return null;}}
var A=window.PADemoAuth={session:sb,conf:C,stopped:false,last:'',busy:Promise.resolve(),clear:function(){put(SK,null);put(PK,null);put(PG,null);}};
function keep(j){if(j&&j.access_token)put(SK,JSON.stringify({a:j.access_token,r:j.refresh_token||'',e:j.expires_at||0}));}
function auth(path,body){return fetch(C.url+'/auth/v1/token?grant_type='+path,{method:'POST',headers:{apikey:C.anonKey,'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {r:r,j:j};});});}
var B=${JSON.stringify({ bad: SIGNIN_LABELS.bad, other: SIGNIN_LABELS.other })},q=new URLSearchParams(location.search),hs=new URLSearchParams(location.hash.slice(1)),code=q.get('code'),vs=[[PK,get(PK)],[PG,get(PG)]].filter(function(x){return x[1];}),ver=vs.length,err=q.get('error_description')||hs.get('error_description');
if(err)A.error=B.bad;else if(code&&!ver)A.error=B.other;   // plain words; the raw Supabase text means nothing to a visitor
function hold(m){try{if(m)sessionStorage.setItem(NK,JSON.stringify({m:m,t:Date.now()}));else sessionStorage.removeItem(NK);}catch(e){/* no storage: the boot reload may drop the note; the link is already spent either way */}}
if(A.error)hold(A.error);else{try{var nk=JSON.parse(sessionStorage.getItem(NK)||'null');if(nk&&Date.now()-nk.t<${NOTE_KEEP_MS})A.error=nk.m;else hold(null);}catch(e){hold(null);}}   // the first node session reloads the page once: the note must outlive that reload
A.hold=hold;
if(code||err||hs.get('access_token'))history.replaceState(null,'',location.pathname);
function swap(i){var v=vs[i];return auth('pkce',{auth_code:code,code_verifier:v[1]}).then(function(x){if(x.r.ok){if(get(v[0])===v[1])put(v[0],null);hold(null);keep(x.j);}else if(i+1<vs.length)return swap(i+1);else hold(A.error=B.bad);});}   // a wrong verifier leaves the code unspent, so the next one may try; only the verifier used is cleared, and only if no newer request replaced it
var first=code&&ver&&C.url?swap(0).catch(function(){hold(A.error=B.bad);}):Promise.resolve();A.first=first;
var of=window.fetch;window.fetch=function(u){var self=this,args=arguments;if(String(u).indexOf('/api/logout')<0)return of.apply(self,args);
var s0=sb(),rv=s0&&s0.a&&C.url?of(C.url+'/auth/v1/logout',{method:'POST',keepalive:true,headers:{apikey:C.anonKey,authorization:'Bearer '+s0.a}}).catch(function(){/* revoking is best effort: the local session is cleared either way */}):null;
A.stopped=true;A.clear();try{localStorage.setItem(OK,String(Date.now()));}catch(e){/* other tabs then sign out on their next 401 */}
var o=Object.assign({},args[1]);try{localStorage.removeItem(K);}catch(e){/* the reload below re-checks it */}
return Promise.race([Promise.all([rv,A.busy]),new Promise(function(r){setTimeout(r,${LOGOUT_WAIT_MS});})]).then(function(){o.signal=AbortSignal.timeout(${LOGOUT_WAIT_MS});if(A.last)o.headers=Object.assign({},o.headers,{authorization:'Bearer '+A.last});return of.call(self,u,o);});};   // a sync in flight may have swapped the node token: end the newest one; the shell reloads after this answers
function say(m,code){var go=function(){var o=document.getElementById('demoStop')||document.createElement('dialog'),L=${JSON.stringify(LIMIT_LABELS)};o.id='demoStop';o.setAttribute('role','alert');o.textContent='';
function el(tag,txt){var e=document.createElement(tag);e.textContent=txt;o.appendChild(e);return e;}var msg=el('p',m);msg.id='demoStopMsg';msg.tabIndex=-1;msg.autofocus=true;o.setAttribute('aria-labelledby','demoStopMsg');
if(code==='${NEW_USER_CODE}'){if(C.url&&C.anonKey){var b=el('button',L.signin);b.id='demoStopSignin';b.type='button';b.onclick=function(){o.remove();dispatchEvent(new Event('${SIGNIN_EVENT}'));};}
var j=el('button',L.join);j.id='demoStopJoin';j.type='button';j.onclick=function(){o.remove();dispatchEvent(new Event('${JOIN_EVENT}'));};el('p',L.tomorrow).className='muted';}
var lg=document.getElementById('login'),shut=function(){if(lg&&lg.open&&o.isConnected)lg.close();};shut();if(lg)new MutationObserver(shut).observe(lg,{attributes:true,attributeFilter:['open']});o.addEventListener('cancel',function(e){e.preventDefault();});document.body.appendChild(o);if(!o.open)o.showModal();};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();}   // over the shell, never instead of it (the shell's scripts keep their elements); modal; the shell's #login modal (hidden on the demo) is kept closed while the card is up, or it would sit on top and leave the page inert to clicks
function start(){var s=sb(),t=get(K),hd={},t0=Date.now();if(A.stopped)return Promise.resolve();if(s&&s.a){hd['${AUTH_HEADER}']=s.a;if(t)hd.authorization='Bearer '+t;}
return of('${DEMO_START_PATH}',{method:'POST',credentials:'same-origin',headers:hd}).then(function(r){return r.json().then(function(j){if(j.token)A.last=j.token;if(A.stopped||(s&&outSince(t0)))return;
if(r.status===401&&j.code==='${SIGNIN_CODE}'&&s){A.clear();return start();}
if(!r.ok||!j.token){if(!t)say(j.error||U,j.code);return;}put(K,j.token);if(get(K)!==j.token)return say(U);if(j.token!==t)location.reload();});}).catch(function(){if(!get(K))say(U);});}
function refresh(){var s=sb();if(!s||!s.r||!C.url||!C.anonKey||s.e-Date.now()/1000>${REFRESH_EARLY_S})return Promise.resolve();
var t0=Date.now();return auth('refresh_token',{refresh_token:s.r}).then(function(x){if(outSince(t0))return;if(x.r.ok)keep(x.j);else if(x.r.status===400||x.r.status===401||x.r.status===403)A.clear();/* 429/5xx: kept, retried next minute */})
.catch(function(){/* offline: the old token stays until it expires; the server then answers "sign in again" */});}
function sync(){if(A.stopped)return;var had;A.busy=first.then(function(){had=!!sb();return refresh();}).then(function(){var t=get(K);if(had&&!sb())put(K,null),t=null;if(!t||sb())return start();
return of('/api/ping',{headers:{authorization:'Bearer '+t}}).then(function(r){if(r.status===401){put(K,null);return start();}}).catch(function(){/* offline: the shell shows its own offline line */});});}
window.addEventListener('storage',function(e){if(e.key===OK){A.stopped=true;location.reload();}});
sync();setInterval(sync,${REFRESH_CHECK_MS});})();</script>`;

// The account controls, inside the shell's own UI. Signed out: one "Sign in" in the header (beside ⚙)
// opening an email popover; asking for a link stores a fresh PKCE verifier and sends only its SHA-256
// challenge. Signed in: the ⚙ dialog's own Sign out is THE sign-out (the fetch wrapper above makes it
// end the node visit AND the Supabase session); "Delete my account" sits under it and, once the server
// has deleted, signs out through that same button.
const SIGNIN_SCRIPT = `<script>document.addEventListener('DOMContentLoaded',function(){var A=window.PADemoAuth;if(!A)return;var L=${JSON.stringify(SIGNIN_LABELS)},C=A.conf,PK='${PKCE_KEY}',PG='${PKCE_GOOGLE_KEY}';
var lo=document.getElementById('logoutBtn'),gear=document.getElementById('settings'),pop=null,btn=null;
function el(tag,txt,par){var e=document.createElement(tag);if(txt)e.textContent=txt;par.appendChild(e);return e;}
function popup(){if(pop)return pop;pop=el('div','',document.body);pop.id='demoAuth';pop.className='cmenu-pop';return pop;}
function close(){if(pop){pop.remove();pop=null;if(A.hold)A.hold(null);}}
document.addEventListener('pointerdown',function(e){if(pop&&!pop.contains(e.target)&&e.target!==btn)close();});
function note(m){var n=document.getElementById('demoAuthNote')||el('div','',popup());n.id='demoAuthNote';n.textContent=m;}
function b64(u){return btoa(String.fromCharCode.apply(null,new Uint8Array(u))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
function pkce(){var v=new Uint8Array(32);crypto.getRandomValues(v);var ver=b64(v);return crypto.subtle.digest('SHA-256',new TextEncoder().encode(ver)).then(function(d){return {ver:ver,ch:b64(d)};});}
addEventListener('pageshow',function(){if(g)g.disabled=false;});   // back from Google (bfcache)
function unstash(){try{sessionStorage.removeItem('${PREFILL_STASH}');}catch(e){/* blocked storage: nothing was kept */}}
function google(){g.disabled=true;unstash();pkce().then(function(k){localStorage.setItem(PG,k.ver);location.assign(C.url+'/auth/v1/authorize?provider=google&redirect_to='+encodeURIComponent(location.origin+'/')+'&code_challenge='+k.ch+'&code_challenge_method=s256');}).catch(function(){g.disabled=false;note(L.fail);});}   // Supabase sends the visitor back with ?code=, exchanged at boot with this verifier (as the email link)
function prefill(){try{return sessionStorage.getItem('${PREFILL_STASH}')||'';}catch(e){return '';/* blocked storage: no prefill */}}
var g=null;
function ask(){if(pop)return close();var p=popup();g=el('button',L.google,p);g.type='button';g.id='demoGoogle';g.className='primary';g.onclick=google;el('div',L.or,p).id='demoAuthOr';
var f=el('form','',p),i=el('input','',f),b=el('button',L.send,f);i.type='email';i.required=true;i.placeholder=L.email;i.autocomplete='email';i.id='demoAuthEmail';i.value=prefill();b.type='submit';b.className='primary';el('p',L.privacy,p).id='demoAuthPriv';var P=window.PADemoPop;if(P){P.head(p,P.T.signin,close);P.go(g);P.go(b);}(i.value?g:i).focus();
f.onsubmit=function(ev){ev.preventDefault();if(b.disabled)return;b.disabled=true;var ver;
pkce().then(function(k){ver=k.ver;
return fetch(C.url+'/auth/v1/otp?redirect_to='+encodeURIComponent(location.origin+'/'),{method:'POST',headers:{apikey:C.anonKey,'content-type':'application/json'},
body:JSON.stringify({email:i.value.trim(),create_user:true,code_challenge:k.ch,code_challenge_method:'s256'})});})
.then(function(r){if(r.ok){localStorage.setItem(PK,ver);unstash();if(A.hold)A.hold(null);f.remove();note(L.sent);el('div',L.same,popup()).id='demoAuthSame';return;}   // the verifier is kept only once a link is really on its way: a refused resend leaves the earlier link usable
return r.json().catch(function(){return {};}).then(function(j){b.disabled=false;note(r.status===429||j.error_code==='${RATE_CODE}'||j.code==='${RATE_CODE}'?L.rate:L.fail);});}).catch(function(){b.disabled=false;note(L.fail);});};}
if(A.session()){if(lo){var row=document.createElement('div'),d=el('button',L.del,row),m=el('span','',row);row.id='demoDelRow';d.id='demoDel';d.type='button';m.id='demoDelMsg';lo.parentNode.parentNode.insertBefore(row,lo.parentNode.nextSibling);
d.onclick=function(){if(!confirm(window.PALang?PALang.t(L.delAsk):L.delAsk))return;var t='';try{t=localStorage.getItem('pa_session')||'';}catch(e){/* no session: the server answers 401, shown below */}m.textContent='';
fetch('${DEMO_DELETE_PATH}',{method:'POST',headers:{authorization:'Bearer '+t}}).then(function(r){if(!r.ok)return r.json().then(function(j){m.textContent=' '+(j.error||String(r.status));});lo.click();}).catch(function(){m.textContent=' '+L.delFail;});};}}
else{if(lo)lo.style.display='none';btn=document.createElement('button');btn.id='demoSignin';btn.className='ibtn';btn.type='button';btn.textContent=C.url&&C.anonKey?L.in:L.off;
if(C.url&&C.anonKey){btn.onclick=ask;window.addEventListener('${SIGNIN_EVENT}',function(){if(!pop)ask();});}else btn.disabled=true;if(gear)gear.parentNode.insertBefore(btn,gear);}
(A.first||Promise.resolve()).then(function(){if(A.error&&!A.session()&&C.url&&C.anonKey){if(!pop)ask();note(A.error);}});});</script>`;   // a link that could not sign in: say why, with the email box ready

// The client gets the PUBLIC values only (project URL, anon key) — read per request, so a config
// edit needs no restart; bootScript escapes `<`, so a value can never close the <script> it sits in.
// The notice under the chat box: its text is config (demo.notice), shown as plain text. It is the LAST
// child of the fixed bar #f (after #f it sat in the page flow, hidden under the input).
const noticeScript = (text) => (text ? `<script>document.addEventListener('DOMContentLoaded',function(){var f=document.getElementById('f');if(!f)return;var n=document.createElement('div');n.id='demoNotice';
n.textContent=${JSON.stringify(text).replace(/</g, '\\u003c')};f.appendChild(n);});</script>` : '');
// The drawer's last row: a plain top-level link (target _top: never inside an app iframe). The demo
// drawer scrolls, so opening chat search scrolls it back to the top, where its overlay sits.
const homeScript = (url) => `<script>document.addEventListener('DOMContentLoaded',function(){var d=document.getElementById('drawer');if(!d)return;var a=document.createElement('a');a.id='demoHome';
a.href=${JSON.stringify(url).replace(/</g, '\\u003c')};a.target='_top';a.textContent=${JSON.stringify(HOME_LABEL)};d.appendChild(a);
var q=document.getElementById('drawerSearch');if(q)q.addEventListener('click',function(){d.scrollTop=0;});});</script>`;   // the search overlay covers the drawer from its top
export function injectDemoBoot(html, cfg) {
  const a = authConfig(cfg);
  const c = { url: a.url, anonKey: a.anonKey, home: demoHomeUrl(cfg), hide: demoHomeHide(cfg) };
  const title = demoTitle(cfg);
  const titled = title ? html.replace('<h1>管家</h1>', () => `<h1 data-product="${escHtml(title)}">${escHtml(title)}</h1>`) : html;
  return titled.replace('</head>', () => DEMO_STYLE + POP_UI + bootScript(c) + SIGNIN_SCRIPT + BUILD_UI + noticeScript(demoNotice(cfg)) + homeScript(demoHomeUrl(cfg)) + WAITLIST_UI + ADMIN_UI + '</head>');
}
