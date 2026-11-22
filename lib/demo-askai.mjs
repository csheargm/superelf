// Ask AI in every demo-made app · 演示应用必带「问 AI」 (superelf.md clause (a)).
//
// WHY: on the owner's node every app mounts the shared PAChat at <!--PA_CHAT_UI-->. A demo app is
// written by a small hosted model, and whether it remembers the marker depends on the model. So the
// server makes it true, whatever the model wrote: a page that already mounts PAChat keeps its own
// mount (the marker is added before its first script if it was forgotten); any other page gets the
// marker plus a small mount — a floating "Ask AI · 问 AI" button opening PAChat.fullscreen. The
// component itself is inlined at serve time by sendAppHtml (web.mjs), never copied here (R3). Its
// turns go through the demo chat route with the app's slug, under the same per-visitor AI caps.
export const PA_CHAT_MARKER = '<!--PA_CHAT_UI-->';
export const ASK_AI_ID = 'pa-askai';
export const ASK_AI_LABEL = 'Ask AI · 问 AI';
const SCREEN_TEXT_MAX = 3000;   // chars of the app's visible text sent with each Ask AI turn

// A PAChat call inside a <script> body (comments dropped) — a mention in markup or a comment is not a mount.
const MOUNT_RE = /\bPAChat\s*\.\s*(fullscreen|panel|mount)\s*\(/;
const mountsPaChat = (html) => [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
  .some((m) => MOUNT_RE.test(m[1].replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')));
// Every shared-component marker kept at its FIRST place only: sendAppHtml inlines each occurrence,
// so a small page repeating a marker would expand to megabytes on a public GET.
export const onceEachMarker = (html) => { const seen = new Set();
  return html.replace(/<!--PA_[A-Z_]+-->|\/\* PA_[A-Z_]+ \*\//g, (m) => (seen.has(m) ? '' : (seen.add(m), m))); };
// A title becomes a JS string literal: JSON.stringify escapes quotes, and </ is broken up so the
// title can never close the <script> element it sits in.
const jsString = (s) => JSON.stringify(String(s || 'this app')).replace(/</g, '\\u003c');

export function askAiMount(title) {
  return `${PA_CHAT_MARKER}
<script>(function(){
  if(!window.PAChat||document.getElementById(${jsString(ASK_AI_ID)})) return;
  var TITLE=${jsString(title)};
  var screenText=function(){ var out=[]; Array.prototype.forEach.call(document.body.children,function(el){
    if(el.id!==${jsString(ASK_AI_ID)}&&!el.classList.contains('pac-fs')&&el.tagName!=='SCRIPT') out.push(el.innerText||''); });
    return out.join('\\n').replace(/\\s+\\n/g,'\\n').slice(0,${SCREEN_TEXT_MAX}); };
  var chat=PAChat.fullscreen({ placeholder:'Ask about this app · 询问此应用…', persist:'askai-chats',
    system:function(){ return 'You help the user with the mini-app "'+TITLE+'". What the app shows right now:\\n'+screenText(); } });
  var b=document.createElement('button'); b.id=${jsString(ASK_AI_ID)}; b.type='button'; b.textContent=${jsString(ASK_AI_LABEL)};
  b.style.cssText='position:fixed;right:16px;bottom:16px;z-index:40;padding:10px 14px;border:0;border-radius:22px;background:#3b5bdb;color:#fff;font:600 15px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.25)';
  b.onclick=function(){ chat.open('general'); };
  document.body.appendChild(b);
})();</script>`;
}

// The page with Ask AI guaranteed. Pure and idempotent; it removes only repeated markers.
export function ensureAskAi(html, title) {
  const s = onceEachMarker(String(html));
  if (mountsPaChat(s)) {
    if (s.includes(PA_CHAT_MARKER)) return s;
    return /<script\b/i.test(s) ? s.replace(/<script\b/i, (m) => PA_CHAT_MARKER + m) : s + PA_CHAT_MARKER;
  }
  const mount = askAiMount(title), page = s.split(PA_CHAT_MARKER).join('');   // the mount brings its own marker
  return /<\/body\s*>/i.test(page) ? page.replace(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i, (m) => mount + m) : page + mount;
}

// True when a page carries a working Ask AI hook: the marker AND a PAChat mount (the bench's check).
export const hasAskAi = (html) => String(html).includes(PA_CHAT_MARKER) && mountsPaChat(String(html));
