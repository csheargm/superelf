/* ══ PA_OFFLINE_BEGIN ══ */
// PAOffline — the shell's on-device write queue and warm set（本机写队列）, docs/plans/offline-first.md §2/§5.
// Apps run sandboxed with no storage of their own, so every note byte passes the shell's broker
// (kind 'data' / 'save-data'); this is where it goes when the node cannot be reached. IndexedDB
// `pa-offline`: `writes` (every save made with no node, in order, kept until session 3's sync
// confirms it) and `files` (the latest text per uid/slug/path — what a read answers offline).
// `files` is also filled by every successful online read and save (the warm set, capped by the
// node's config `offline.warm_files`, read at use time); a queued row is never trimmed.
// A failure that is not a network failure (a 4xx/5xx) is a real refusal and passes through
// untouched. No IndexedDB at all → the broker works exactly as before (nothing is pretended).
// The one state line (§5) lives in #offLine; deps come in so test/offline-queue.test.mjs runs
// makeOffline on an in-memory IndexedDB and a fake line.
const OFF_DB='pa-offline', OFF_DB_VERSION=1, OFF_WRITES='writes', OFF_FILES='files';
// 'this device', never 'this iPad': the same shell runs on a phone and a desktop (F5-6).
const OFF_TXT_OFFLINE='Offline · 离线 — saving on this device · 保存在本设备';
// Offline while the device itself has a network: the usual cause is the VPN (owner 2026-11-21: Tailscale
// quietly needed a re-sign-in). Shown only then, so a real no-network day keeps the short line.
const OFF_TXT_CHECK_VPN=' · check Tailscale or the node · 请检查 Tailscale 或节点';   // 'or the node': a plain-LAN install has no VPN
const OFF_TXT_PENDING=' to sync · 待同步';   // '· 3 to sync · 待同步' (§5)
const OFF_TXT_SYNCING='Syncing · 同步中';     // online with a queue, the drain running (web/offline-sync.js)
const OFF_TXT_SYNC_FAIL='Sync failed · 同步失败 — ';   // + the node's sentence; a tap on the line retries
const OFF_TXT_RETRY=' · tap to retry · 点按重试';
const OFF_NEEDS_NODE='Needs the home node · 需要家中节点';
const OFF_TXT_FULL='This device is full · 本设备存储已满 — not saved · 未保存';
const OFF_TXT_NOT_KEPT='Could not keep it on this device · 无法保存在本设备';
const OFF_TXT_NOT_HERE='Not on this device · 本设备上没有 — open it once online · 联网后打开一次';
const OFF_WARM_KEY='pa_offline_warm';          // localStorage (PASW.remember): the warm cap from the last online read of the config
const OFF_LOCAL_ORIGIN_KEY='pa_local_origin';  // localStorage (PASW.remember): config local_origin from that same read, for a boot with no public node (web/offline-origin.js)
const OFF_TXT_HOME='Home node · 家中节点';
const OFF_FULL_MS=4000;   // the full line shows this long after it changes, then shrinks to a corner pill (tap shows it again)
const OFF_MINI_OFFLINE='离线 Offline';      // the line, briefly, when the broker's base switched to the home name (§6)
// Broker kinds that need the node (§5): answered with OFF_NEEDS_NODE while offline, so a component
// shows one honest sentence instead of a connection failure. Reads, writes, 'bible' (the worker's
// cache) and the device prefs are not here.
const OFF_NODE_KINDS=new Set(['note-search','note-text','summary-followup','chat','ask','websearch','bible-search','upload','meal-photo','speech-start','note-page-image','attach-url']);
const offKey=(uid,slug,path)=>uid+'/'+slug+'/'+path;
const offText=(data)=>typeof data==='string'?data:JSON.stringify(data);
const offBytes=(text)=>new TextEncoder().encode(text).length;
const offIsQuota=(err)=>!!(err&&(err.name==='QuotaExceededError'||err.code===22));
const offMsg=(err)=>String((err&&err.message)||err||'unknown');
// A promise over one IndexedDB request.
const offReq=(r)=>new Promise((resolve,reject)=>{ r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error||new Error('IndexedDB request failed')); });
// The database, opened once (again after a failed open): get/put/add/del/all/count over the two stores.
function offDb(idb){
  let dbp=null;
  const open=()=>dbp||(dbp=new Promise((resolve,reject)=>{
    const r=idb.open(OFF_DB,OFF_DB_VERSION);
    r.onupgradeneeded=()=>{ const db=r.result;
      if(!db.objectStoreNames.contains(OFF_WRITES)) db.createObjectStore(OFF_WRITES,{keyPath:'seq',autoIncrement:true});
      if(!db.objectStoreNames.contains(OFF_FILES)) db.createObjectStore(OFF_FILES,{keyPath:'key'}); };
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>{ dbp=null; reject(r.error||new Error('IndexedDB open failed')); };
  }));
  const run=async(store,mode,fn)=>{ const db=await open(); return offReq(fn(db.transaction(store,mode).objectStore(store))); };
  return { get:(s,k)=>run(s,'readonly',(o)=>o.get(k)), put:(s,v)=>run(s,'readwrite',(o)=>o.put(v)), add:(s,v)=>run(s,'readwrite',(o)=>o.add(v)),
    del:(s,k)=>run(s,'readwrite',(o)=>o.delete(k)), all:(s)=>run(s,'readonly',(o)=>o.getAll()), count:(s)=>run(s,'readonly',(o)=>o.count()) };
}
// The warm cap: the node's config while it answers (read at use time), remembered for a boot with no node.
async function offWarmCapRefresh(d,status){
  try{ const cfg=await d.fetchJson(SW_OFFLINE_CONFIG_URL);
    if(Number.isInteger(cfg.warm_files)&&cfg.warm_files>0){ status.warm=cfg.warm_files; d.remember(OFF_WARM_KEY,cfg.warm_files); }
    if(typeof cfg.local_origin==='string') d.remember(OFF_LOCAL_ORIGIN_KEY,cfg.local_origin); }   // '' clears a name the config dropped
  catch(err){ status.error='config: '+offMsg(err); }   // the remembered cap (or none) stands; shown in status()
}
// A failure to warm never fails the online read/save it follows (the node holds the text); PAOffline keeps it in status.
const offWarmCap=(d,status)=>{ if(!status.warm){ const w=Number(d.recall(OFF_WARM_KEY)); status.warm=Number.isInteger(w)&&w>0?w:0; } return status.warm; };
// The base a queued write is merged against on sync (§4): the node's text as last read or saved
// online on this device — the row before the first queued write — carried along by later queued ones.
const offBaseOf=(prev)=>!prev?null:(prev.queued?(prev.base==null?null:prev.base):prev.text);
// The warm set: the latest text per path, the oldest non-queued rows dropped past the cap; a queued row never.
async function offMirror(d,status,uid,slug,path,text,queued){
  const key=offKey(uid,slug,path), ts=d.now();
  const base=queued?offBaseOf(await d.db.get(OFF_FILES,key)):null;
  await d.db.put(OFF_FILES,{key,uid,slug,path,text,bytes:offBytes(text),ts,queued,base});
  const cap=offWarmCap(d,status); if(!cap) return;
  const n=await d.db.count(OFF_FILES); if(n<=cap) return;
  const rows=(await d.db.all(OFF_FILES)).filter((r)=>!r.queued).sort((a,b)=>a.ts-b.ts);
  for(const r of rows.slice(0,n-cap)) await d.db.del(OFF_FILES,r.key);
}
// The one line (§5): offline → the word and the count; online → the drain's state (syncing, a
// failure with tap-to-retry) or the count while nothing syncs (never 'Syncing' with no sync running, R14);
// 'Home node' for a moment after the base switched to the home name (web/offline-origin.js).
function offLineText(status,deviceOnline){   // deviceOnline: navigator.onLine — the phone has a network, the node is still unreachable
  const n=status.pending, count=n?n+OFF_TXT_PENDING:'';
  if(status.net==='offline') return OFF_TXT_OFFLINE+(deviceOnline?OFF_TXT_CHECK_VPN:'')+(n?' · '+count:'');
  if(status.home) return OFF_TXT_HOME+(n?' · '+count:'');
  if(status.sync==='syncing') return OFF_TXT_SYNCING+(n?' · '+count:'');
  if(status.fail) return OFF_TXT_SYNC_FAIL+status.fail+OFF_TXT_RETRY;
  return count;
}
// The corner pill the line shrinks to: '' hides it (a sync failure never shrinks: it needs a tap).
function offMiniText(status){
  const n=status.pending?' · '+status.pending:'';
  if(status.net==='offline') return OFF_MINI_OFFLINE+n;
  return status.pending?'⇅'+n:'';
}
// deps: db → offDb(...) or null (no IndexedDB: pass-through); uid() → the signed-in user; now();
// onLine() → navigator.onLine; line() → #offLine or null; fetchJson(url) (authenticated) or throws;
// remember(k,v)/recall(k) → PASW's per-device memory; onNet(fn) → fn(true|false) on online/offline.
function makeOffline(d){
  const status={net:'online',pending:0,warm:0,error:'',sync:'',fail:'',home:false};
  const offline=()=>status.net==='offline';
  let shown='', timer=null;
  const later=d.setTimeout||((fn,ms)=>setTimeout(fn,ms)), cancel=d.clearTimeout||((t)=>clearTimeout(t));
  // Full line first, then the corner pill after OFF_FULL_MS so it never sits over the app (a tap on the pill shows it again).
  function shrink(el){ const mini=status.fail?'':offMiniText(status); if(status.fail) return;
    el.dataset.mini=mini; el.classList.add('mini'); el.classList.toggle('on',!!mini); }
  function expand(el){ if(timer) cancel(timer); el.classList.remove('mini'); el.classList.toggle('on',!!el.textContent);
    timer=later(()=>{ timer=null; shrink(el); },OFF_FULL_MS); }
  function render(){ const el=d.line(); if(!el) return ''; const text=offLineText(status,!!(d.onLine&&d.onLine())); el.textContent=text;
    if(!el.onclick) el.onclick=()=>{ if(el.classList.contains('mini')) expand(el); };
    if(text!==shown){ shown=text; expand(el); } else if(el.classList.contains('mini')) shrink(el); else el.classList.toggle('on',!!text);
    return text; }
  const syncState=(patch)=>{ Object.assign(status,patch); render(); };   // the drain (web/offline-sync.js) reports here: sync/fail/pending/net; PAOrigin: home
  const noteNet=(ok)=>{ const was=status.net; status.net=ok?'online':'offline'; if(was!==status.net||!ok) render(); };   // !ok re-renders too: the device's own network may have changed (the Tailscale hint)
  const refuse=(kind)=>(offline()&&OFF_NODE_KINDS.has(kind))?{ok:false,code:'offline',error:OFF_NEEDS_NODE,text:OFF_NEEDS_NODE}:null;
  const mirror=(uid,slug,path,text,queued)=>offMirror(d,status,uid,slug,path,text,queued);
  const warm=(uid,slug,path,text)=>mirror(uid,slug,path,text,false).catch((err)=>{ status.error='warm set: '+offMsg(err); });
  // → {row} (row undefined for a path never mirrored) or null when the store could not answer (R5: the reason in status).
  const mirrorRow=async(uid,slug,path)=>{ try{ return {row:await d.db.get(OFF_FILES,offKey(uid,slug,path))}; }catch(err){ status.error='mirror: '+offMsg(err); return null; } };
  // kind 'data': the node first; with no network, the mirror; a path never read here is 'offline'.
  // A path still queued answers the MIRROR even online: this device holds the newest text until the
  // drain posts it, and warming the node's older file over the row would make the drain drop the
  // queued edit as 'superseded' (write()'s online save is the one route to that). A row the store
  // could not show is not warmed over either.
  async function read(slug,path,call){
    if(!d.db) return call();
    const uid=d.uid(), r=await call();
    if(r&&r.ok){
      noteNet(true); const got=await mirrorRow(uid,slug,path), prev=got&&got.row;
      if(prev&&prev.queued) return {ok:true,text:prev.text,offline:true};
      if(got) await warm(uid,slug,path,r.text);
      return r;
    }
    if(!r||r.code!=='network') return r;
    noteNet(false);
    let row; try{ row=await d.db.get(OFF_FILES,offKey(uid,slug,path)); }catch(err){ return {ok:false,code:'offline',error:OFF_TXT_NOT_HERE+' ('+offMsg(err)+')'}; }
    return row?{ok:true,text:row.text,offline:true}:{ok:false,code:'offline',error:OFF_TXT_NOT_HERE};
  }
  // kind 'save-data': the node first; with no network, the queue — and only a row that is really
  // in the queue earns ok:true (a full or broken store answers a failure, never a vacuous ok, R14).
  async function write(slug,path,data,call){
    if(!d.db) return call();
    const uid=d.uid(), text=offText(data), r=await call();
    if(r&&r.ok){ noteNet(true); await warm(uid,slug,path,text); return r; }
    if(!r||r.code!=='network') return r;
    noteNet(false);
    const bytes=offBytes(text); let seq=null;
    try{ seq=await d.db.add(OFF_WRITES,{uid,slug,path,text,bytes,ts:d.now(),kind:'save-data'}); await mirror(uid,slug,path,text,true); }
    catch(err){
      if(seq!=null) await d.db.del(OFF_WRITES,seq).catch(()=>{ /* the log row stays beside a missing mirror row: the reply below already says not saved */ });
      return offIsQuota(err)?{ok:false,code:'offline-full',error:OFF_TXT_FULL}:{ok:false,code:'offline',error:OFF_TXT_NOT_KEPT+' ('+offMsg(err)+')'};
    }
    status.pending++; render();
    return {ok:true,offline:true,bytes};
  }
  // Boot: the queued count for the line, the network as the browser sees it, then the warm cap.
  async function boot(){
    if(d.onLine&&d.onLine()===false) status.net='offline';
    if(d.db){ try{ status.pending=await d.db.count(OFF_WRITES); }catch(err){ status.error='queue: '+offMsg(err); } }
    render();
    if(d.db&&!offline()) await offWarmCapRefresh(d,status);
    return status.net;
  }
  if(d.onNet) d.onNet(noteNet);
  return { read, write, refuse, noteNet, boot, render, offline, syncState, db:d.db, status:()=>({...status}) };
}
const PAOffline=makeOffline({
  db:(()=>{ try{ return window.indexedDB?offDb(window.indexedDB):null; }catch(_){ return null; /* storage blocked (private mode): no queue, the broker works as before */ } })(),
  uid:()=>UID, now:()=>Date.now(), onLine:()=>navigator.onLine, line:()=>$('#offLine'),
  fetchJson:async(u)=>{ const r=await api(u); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); },
  remember:PASW.remember, recall:PASW.recall,
  onNet:(fn)=>{ window.addEventListener('online',()=>fn(true)); window.addEventListener('offline',()=>fn(false)); },
});
/* ══ PA_OFFLINE_END ══ */
