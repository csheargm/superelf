// PAShellCam — 主对话截图 · the main chat's camera (owner 2026-11-26: "the main chat should have a button to
// take screenshot similar to mini app chat"). One tap draws what the user sees right now (the home, or the
// open chat) with the SAME engine, icon, time label and 3-shot rule as the app chat's camera: PASnap and
// PAShotFresh in web/snap.inline.html (R3: one copy). The picture is uploaded like a ＋ photo and rides the
// message as an attachment; its chip shows the thumbnail, the time it was taken and ×.
// Fails closed: an engine that cannot draw the page (PASnap rejects) says so and points at ＋; nothing is attached.
// Host hooks (web/index.html): the #cam button in #frow, attachments[] + renderChips(), add(), relayCall().
// Unit: test/shell-cam.test.mjs · e2e: test/shell-cam-e2e.test.mjs.
var PAShellCam=(function(){
  const T={
    cam:'截取当前画面 · Capture the screen as it looks now',
    tip:'新：点 📷 截取当前画面给 AI 看 · New: tap the camera to show the AI this screen',
    fail:'这个画面截不下来，请用 ＋ 添加照片或截屏 · This screen cannot be captured — add a photo or a screenshot with ＋',
    up:'截图上传失败 · The screenshot could not be uploaded',
  };
  const TIP_KEY='tip:main-chat-camera';
  const CSS='.chip.shot{position:relative;width:50px;height:50px;padding:0;border-radius:8px;overflow:hidden;max-width:none}'+
    '.chip.shot img{width:100%;height:100%;object-fit:cover;display:block}'+
    '.chip.shot .ctime{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);color:#fff;font-size:9px;line-height:12px;text-align:center;pointer-events:none}'+
    '#cam svg{width:22px;height:22px;display:block}'+
    '.chip.shot button{position:absolute;top:0;right:0;width:24px;height:24px;padding:0;background:rgba(0,0,0,.55);color:#fff;font-size:13px}';
  let seq=0, busy=false;
  // The thumbnail chip, for renderChips: a.thumb is the PNG data URL PASnap drew (escaped like every other value).
  function chipHtml(a,i,esc){
    return `<div class="chip shot"><img src="${esc(a.thumb)}" alt=""><span class="ctime">${esc(a.label||'')}</span><button type="button" title="移除 · Remove" aria-label="移除 · Remove" onclick="removeChip(${i})">×</button></div>`;
  }
  // Our own shots in the draft, oldest first, in PAShotFresh's shape (gen is always 0: the shell never reloads under a draft).
  const mine=(atts)=>atts.filter((a)=>a.shot).map((a)=>({path:a.path,gen:0,mine:true}));
  async function take(h){
    if(busy) return; busy=true;
    try{
      let url;
      try{ url=await PASnap.shot(); }
      catch(_){ h.say(T.fail); return; }   // fails closed: said, nothing attached (WebKit taint, blank, too large)
      const name='screen-home-'+Date.now()+'-'+(++seq)+'.png';
      const g=await h.upload({name,data:url.split(',')[1]});
      if(!(g&&g.ok&&g.path)){ h.say(T.up+((g&&g.error)?' — '+g.error:'')); return; }
      const atts=h.atts(), drop=PAShotFresh.makeRoom(mine(atts),0);   // the 4th drops the oldest of ours; a user's photo never
      for(let i=atts.length-1;i>=0;i--) if(drop.includes(atts[i].path)) atts.splice(i,1);
      atts.push({name,path:g.path,thumb:url,label:PAShotFresh.label(Date.now()),shot:true});
      h.render();
    } finally { busy=false; }
  }
  // The home ask box draws its two-line hint (#hPh) over the input at a fixed left that assumed ＋ alone: with 📷
  // beside ＋ it sat on the camera. Measured from the input's real left edge instead (never a hard-coded px), on
  // every size change of the input (the composer moves between the home and the chat, the phone rotates).
  function alignHint(){
    const box=document.getElementById('box'), ph=document.getElementById('hPh'); if(!box||!ph||typeof ResizeObserver!=='function') return;
    const fit=()=>{ const ask=ph.parentElement; if(!ask||!ask.contains(box)) return;
      const pad=parseFloat(getComputedStyle(box).paddingLeft)||0;
      ph.style.left=Math.round(box.getBoundingClientRect().left-ask.getBoundingClientRect().left+pad)+'px'; };
    new ResizeObserver(fit).observe(box); fit();
  }
  function bind(h){
    const b=document.getElementById('cam'); if(!b) return;
    b.innerHTML=PASnap.CAM_SVG; b.title=T.cam; b.setAttribute('aria-label',T.cam);
    const st=document.createElement('style'); st.id='shellCamCss'; st.textContent=CSS; document.head.appendChild(st);
    b.onclick=()=>take(h);
    alignHint();
    document.addEventListener('DOMContentLoaded',()=>{ if(!_SEEN.has(TIP_KEY)) PATipsShell.tip(TIP_KEY,'#cam',T.tip,{priority:true,dismissOnUse:true}); });   // the ONE tip mechanism, beside the button
  }
  return {bind,chipHtml,take,T,TIP_KEY};
})();
