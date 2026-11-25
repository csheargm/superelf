/* ══ APP_FRAME_BEGIN — web/app-frame.js, inlined into the shell at its marker (lib/shellhtml.mjs
   SHELL_PARTS). test/helpers-shell-broker.mjs runs this block with the broker. ══ */
// LEAVING AN APP · 离开应用 (docs/adr/0018-leaving-an-app-keeps-its-last-save.md).
// An app posts its last save from its pagehide handler (PANote, Notes). The shell used to blank the
// frame first (src='about:blank'), so that save came from a page that was already gone. Chrome then
// delivered it with e.source null, and the broker dropped it. WebKit delivered it from a frame whose
// URL no longer named the app, and the broker refused it (no slug). Either way, a stroke drawn just
// before ← Home was lost. Measured in both engines, 2026-10-13.
//
// So a leaving app's page is HELD, not blanked:
//   1. Its iframe leaves the #fr role. It is hidden and kept in place: moving an iframe reloads it.
//      A fresh iframe takes #fr, with the old one's handlers, for whatever opens next.
//   2. The page is told {pa:'leaving'}. PALeave (web/leave.inline.html, on every app page) runs the
//      page's own pagehide handlers then, and answers {pa:'left'}.
//   3. The broker keeps serving the held page as itself: replies go to its own window, and its
//      requests are filed under the slug it had when it was held.
//   4. The held iframe is removed once it has had no request in flight for APP_LEAVE_QUIET_MS after
//      its answer. A save that waits for one reply before it sends the next (Notes: the entry, then
//      the index) still gets in. The iframe is removed after APP_LEAVE_MAX_MS whatever happens.
// A removed iframe is unknown to the broker. Anything its page posts while unloading is dropped, in
// every engine, so it is never filed under the app that #fr holds by then. A page that has posted
// nothing, not even PALeave's {pa:'here'} (sent as it runs, ahead of the page's own scripts), is
// removed at once, as about:blank cancelled its load: on a page PALeave runs on, none of its own code has run.
const APP_LEAVE_ACK_MS=2000;     // no {pa:'left'} by then: the page cannot answer (it has no script, or it hangs)
const APP_LEAVE_QUIET_MS=500;    // after the answer, this long with nothing in flight ends the hold
const APP_LEAVE_MAX_MS=20000;    // = PANote's SAVE_TIMEOUT_MS: a save that is still waiting for its reply is given up on by then anyway
const APP_FRAME_HANDLERS=['onload','onfocus'];   // what the shell binds on #fr; the fresh frame carries them
const appFrameRecs=new WeakMap();   // iframe element → what the broker knows about the page in it
const appFramesHeld=new Set();      // the records of pages that are leaving and not yet removed
function appFrameRec(el){
  let r=appFrameRecs.get(el);
  if(!r){ r={el,slug:'',spoke:false,busy:0,held:false,left:false,quietT:0,ackT:0,maxT:0}; appFrameRecs.set(el,r); }
  return r;
}
// The page a message came from: the app in #fr, or a page held while it leaves. null for any other
// window, a removed page's last messages included.
function appFrameOf(win){
  if(!win) return null;   // Chrome: a page that is already gone posts with e.source null
  const live=$('#fr');
  if(live.contentWindow===win){ const r=appFrameRec(live); r.slug=frameSlug(); r.spoke=true; return r; }
  for(const r of appFramesHeld) if(r.el.contentWindow===win) return r;
  return typeof PAAppEdit!=='undefined'?PAAppEdit.frameRec(win):null;   // the edit panel (web/app-edit.js): a shell page filed under the app it edits, r.edit set
}
// The broker calls this with +1 when a request arrives and -1 when its handler is done. That is when
// it has been answered, except speech-start: its results come later and do not hold the page.
function appFrameBusy(r,d){ r.busy+=d; if(r.held) appFrameQuiet(r); }
function appFrameQuiet(r){
  clearTimeout(r.quietT); r.quietT=0;
  if(r.left&&r.busy<=0) r.quietT=setTimeout(()=>appFrameDrop(r),APP_LEAVE_QUIET_MS);
}
function appFrameLeft(r){ if(r.left) return; r.left=true; clearTimeout(r.ackT); appFrameQuiet(r); }
function appFrameDrop(r){
  if(!appFramesHeld.delete(r)) return;
  clearTimeout(r.quietT); clearTimeout(r.ackT); clearTimeout(r.maxT);
  r.el.remove();
}
// Every control that leaves an app calls this: goHome, and openApp before it loads the next app.
// With no app in #fr there is nothing to hold, and #fr is left as it is.
function appFrameLeave(){
  const el=$('#fr');
  const slug=frameSlug();
  if(!slug) return;
  const nu=el.cloneNode(false);
  nu.src='about:blank';   // set BEFORE it is inserted: the clone carries the app's URL and would load it again
  nu.removeAttribute('srcdoc'); nu.removeAttribute('data-app');   // and, on the srcdoc route (web/sw-client.js), the app's page itself
  for(const h of APP_FRAME_HANDLERS) nu[h]=el[h];
  el.removeAttribute('id'); el.style.display='none';
  el.before(nu);
  const r=appFrameRec(el);
  if(!r.spoke){ el.remove(); return; }
  r.slug=slug; r.held=true; appFramesHeld.add(r);
  r.ackT=setTimeout(()=>appFrameLeft(r),APP_LEAVE_ACK_MS);
  r.maxT=setTimeout(()=>appFrameDrop(r),APP_LEAVE_MAX_MS);
  el.contentWindow.postMessage({pa:'leaving'},'*');
}
// Every message is looked at, not only 'left': any message from the page in #fr shows its page runs (PALeave's here comes first).
window.addEventListener('message',(e)=>{
  const r=appFrameOf(e.source);
  if(r&&r.held&&e.data&&e.data.pa==='left') appFrameLeft(r);
});
/* ══ APP_FRAME_END ══ */
// BROWSER BACK · 浏览器返回 (owner report v5.22.4: mouse Back from an app left an empty grey page).
// Opening an app is one history entry of the shell's own: {paApp:{uid,slug,title}} at the same URL.
// Back from it (mouse Back, Alt+Left, the iOS edge swipe) is goHome, Forward reopens the app. An app
// opened over another app, or by a direct link, REPLACES the entry: Back from a link's app leaves the
// shell for the page before, as any link's Back does. Home's own controls step back off the entry,
// so a later Back never lands on an app that is no longer open.
const APP_HIST_KEY='paApp';
let appHistReplaceNext=false;   // set by a direct-link open (web/update.js openFromLink, the demo #app= link)
let appHistPopsToIgnore=0;      // Back steps the shell took itself (appHistoryLeft): not the user's
// `pushed` lives in the entry itself (it survives an update reload): only an entry the shell pushed is
// stepped back off; a link's entry is cleared in place, so Home never leaves the site.
function appHistoryOpened(uid,slug,title){
  const prev=history.state&&history.state[APP_HIST_KEY];
  const pushed=prev?!!prev.pushed:!appHistReplaceNext;
  const replace=appHistReplaceNext||!!prev;
  const st={[APP_HIST_KEY]:{uid,slug,title,pushed}};
  appHistReplaceNext=false;
  try{ if(replace) history.replaceState(st,''); else history.pushState(st,''); }catch(_){ /* no history API (sandboxed test page): Back then leaves the shell, as before */ }
}
function appHistoryLeft(){
  const a=history.state&&history.state[APP_HIST_KEY]; if(!a) return;
  if(!a.pushed){ try{ history.replaceState(null,''); }catch(_){ /* no history API: nothing to step off */ } return; }   // a link's app: stay on the site
  appHistPopsToIgnore++; history.back();
}
window.addEventListener('popstate',(e)=>{
  if(appHistPopsToIgnore>0){ appHistPopsToIgnore--; return; }
  const a=e.state&&e.state[APP_HIST_KEY];
  if(a) openApp(a.uid,a.slug,a.title);          // Forward: the app again (the entry is already its own: replaced, not pushed)
  else if(frameOpen()) goHome();                // Back: Home, fully drawn, with every menu and panel closed
});
