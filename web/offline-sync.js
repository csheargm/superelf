/* ══ PA_SYNC_BEGIN ══ */
// PASync — the drain of the on-device write queue（重连同步）, docs/plans/offline-first.md §3.
// Runs on the browser's `online` event, when the page becomes visible, on PAUpdate's cadence
// (UPDATE_POLL_MS, web/update.js) and on a tap of the state line; once at boot. One drain at a
// time; a second call while one runs returns 'running'.
// Sequence: /api/build reachable (the real signal: the `online` event fires before any node
// answered) → the queue's rows for the signed-in user, in seq order, the LAST text per path →
// entry-*.json before the rest (journal.json names pages the node must already hold) → per path
// the node's current file → rule A (web/offline-merge.js) against the base this device read before
// it went away → POST → on 200 the path's rows go and the mirror row is the posted text; a 4xx/5xx
// stops the drain, keeps every row and puts the node's sentence on the line (R5); a network
// failure stops it quietly (the count stays: still away). While it runs, PAUpdate's shellBusy
// reads inFlight() so the shell never reloads under a drain.
// Before the POST the exact outgoing text is written to the mirror row as `prepared`: a drain cut
// off after the node committed but before the cleanup (a reload, a crash) leaves the row, and the
// next drain finds its own text on the node — then nothing is merged or posted again (a second
// merge would mint a second conflict copy), only the cleanup runs (review finding 1).
// A path whose mirror row is no longer `queued` was saved online since (the node holds newer
// text): its rows are dropped without a POST. Only write()'s online save clears the flag — an online
// read of a queued path answers the mirror and leaves the row (web/offline-client.js read()).
const offIsEntry=(p)=>/(^|\/)entry-[^/]+\.json$/.test(p);
const offDataPath=(slug,path)=>'data/'+slug+'/'+path;   // the broker's appData namespace (web/index.html) for a row that names its slug
// The last row per path, entries first, seq order within (rows come sorted by seq).
function syncOrder(rows){
  const last=new Map(); for(const r of rows) last.set(offKey(r.uid,r.slug,r.path),r);
  return [...last.values()].sort((a,b)=>(offIsEntry(a.path)?0:1)-(offIsEntry(b.path)?0:1)||a.seq-b.seq);
}
// deps: db → PAOffline.db (null: nothing to drain); uid(); now(); reachable() → /api/build answered (PAOrigin: public, else the home name);
// read(slug,path) → the broker's relay reply for GET /api/data; post(slug,path,text) → the relay
// reply for POST /api/save-data; merge(localText,remoteText,baseText) → mergeOffline; state(patch) →
// PAOffline.syncState; onTrigger(fn) → wires the events that call fn (null in tests).
function makeSync(d){
  let running=false;
  const log=[];   // what the last drain did, per path (status(), the hand proof in session 4)
  const sameFile=(row)=>(r)=>offKey(r.uid,r.slug,r.path)===offKey(row.uid,row.slug,row.path);
  const recount=async(patch)=>d.state({...patch,pending:await d.db.count(OFF_WRITES)});
  const dropRows=async(batch)=>{ for(const r of batch) await d.db.del(OFF_WRITES,r.seq); };
  // → 'ok' | 'failed' | 'unreachable'
  async function syncPath(row,batch){
    const key=offKey(row.uid,row.slug,row.path), file=await d.db.get(OFF_FILES,key);
    if(file&&!file.queued){ await dropRows(batch); log.push({path:row.path,did:'superseded'}); return 'ok'; }
    const remote=await d.read(row.slug,row.path);
    if(!remote.ok&&remote.code==='network') return 'unreachable';
    if(!remote.ok&&remote.code!=='not-found'){ d.state({sync:'',fail:remote.error||remote.code}); return 'failed'; }
    let text=row.text, did='sent';
    const committed=remote.ok&&file&&file.prepared!=null&&remote.text===file.prepared;   // the last drain's POST reached the node; its cleanup did not
    if(committed){ text=file.prepared; did='committed'; }
    else if(remote.ok){
      let m; try{ m=d.merge(row.text,remote.text,file&&file.base!=null?file.base:null); }
      catch(err){ d.state({sync:'',fail:offMsg(err)}); return 'failed'; }   // a file neither side can read: not guessed at (R5)
      if(m.merged){ text=m.text; did='merged'+(m.copies?' ('+m.copies+' copy)':''); }
    }
    if(!committed){
      if(file) await d.db.put(OFF_FILES,{...file,prepared:text});   // the ts stays: a save under the POST is still told apart below
      const r=await d.post(row.slug,row.path,text);
      if(!r||!r.ok){ if(r&&r.code==='network') return 'unreachable'; d.state({sync:'',fail:(r&&(r.error||r.code))||'no reply · 无回复'}); return 'failed'; }
    }
    // A save queued while the POST was in flight re-queued the row (a newer ts): it keeps its text
    // and its queued flag and takes the posted text as its base, or the next drain would drop it as
    // superseded without a POST. Only an untouched row becomes the plain warm row of the posted text.
    const cur=await d.db.get(OFF_FILES,key);
    if(cur&&cur.queued&&cur.ts!==(file&&file.ts)){ const {prepared:_p,...rest}=cur; await d.db.put(OFF_FILES,{...rest,base:text}); }
    else await d.db.put(OFF_FILES,{key,uid:row.uid,slug:row.slug,path:row.path,text,bytes:offBytes(text),ts:d.now(),queued:false,base:null});
    await dropRows(batch); log.push({path:row.path,did}); await recount({});
    return 'ok';
  }
  // → 'running' | 'no-db' | 'empty' | 'unreachable' | 'failed' | 'drained' | 'error'
  async function drainOnce(){
    const uid=d.uid();
    const rows=(await d.db.all(OFF_WRITES)).filter((r)=>r.uid===uid).sort((a,b)=>a.seq-b.seq);
    if(!rows.length){ d.state({sync:'',fail:''}); return 'empty'; }
    if(!(await d.reachable())) return 'unreachable';
    d.state({net:'online',sync:'syncing',fail:''}); log.length=0;
    for(const row of syncOrder(rows)){
      const res=await syncPath(row,rows.filter(sameFile(row)));
      if(res==='unreachable'){ d.state({net:'offline',sync:''}); return res; }
      if(res!=='ok') return res;
    }
    await recount({sync:'',fail:''}); return 'drained';
  }
  async function drain(){
    if(running) return 'running';
    if(!d.db) return 'no-db';
    running=true;
    try{ return await drainOnce(); }
    catch(err){ d.state({sync:'',fail:offMsg(err)}); return 'error'; }   // a store that failed mid-drain: on the line, rows kept
    finally{ running=false; }
  }
  if(d.onTrigger) d.onTrigger(drain);
  return { drain, inFlight:()=>running, status:()=>({running,log:log.slice()}) };
}
const PASync=makeSync({
  db:PAOffline.db, uid:()=>UID, now:()=>Date.now(),
  reachable:()=>PAOrigin.reachable(),   // /api/build on the public name, else the home name with the same build (web/offline-origin.js): never from a cache
  read:(slug,path)=>relayCall('/api/data/'+offDataPath(slug,path).split('/').map(encodeURIComponent).join('/'),undefined,'text','text'),
  post:(slug,path,text)=>relayCall('/api/save-data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:offDataPath(slug,path),data:text})},'raw'),
  merge:mergeOffline, state:PAOffline.syncState,
  onTrigger:(fn)=>{
    window.addEventListener('online',()=>fn());
    document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') fn(); });
    setInterval(()=>{ if(document.visibilityState==='visible') fn(); },UPDATE_POLL_MS);   // PAUpdate's cadence (web/update.js)
    document.addEventListener('click',(e)=>{ if(e.target&&e.target.id==='offLine') fn(); });   // the line itself: tap to retry
  },
});
/* ══ PA_SYNC_END ══ */
