/* ══ PA_MERGE_BEGIN ══ */
// Rule A（冲突规则 A）, docs/plans/offline-first.md §4 — the merge the sync applies when the node's
// copy of a file moved while this device was away. Pure: no DOM, no storage, no clock beyond the
// stamps inside the data. One source for the shell (inlined, lib/shellhtml.mjs) and for Node
// (lib/offline-merge.mjs evaluates this same file); test/offline-merge.test.mjs runs the fixtures.
//
// A notebook (`pages[]`, written by PANote: ids and `updated` per page) merges per page id:
//   · a page on one side only is kept — unless the base held it and the side that still has it
//     left it untouched since the base: then the other side deleted it on purpose, and it goes;
//   · a page on both sides with the same bytes is one page (an equal `updated` alone is not: a
//     stamp is a hint, the bytes are the truth — review finding 3);
//   · changed on one side only (the other equals the base, byte for byte) → that side's page, no copy;
//   · changed on both → the later `updated` wins and the loser is appended as a new page headed
//     '冲突副本 · Conflict copy (<from>, MM-DD HH:mm)'. Nothing is lost; the owner deletes a page.
//   · a tombstone ({deleted:true}, the Journal's delete) wins over the other side when that side
//     still holds the base's bytes (nothing moved there), and loses to a notebook edited since the
//     base: a deletion is cheap to redo, an edit is not (review finding 2). With no base the edit
//     wins: whether the other side moved is unknown, and a kept note costs less than a lost one.
// An index (`entries[]`, journal.json) merges per entry id the same way, without copies: a row is
// metadata, the note itself carries the content. Any other JSON: the local text wins (LWW by file).
// With no base (a path never read online on this device) every same-id difference counts as changed
// on both sides — a copy rather than a silent loss.
const OFF_CONFLICT_TITLE='冲突副本 · Conflict copy';
const OFF_FROM_LOCAL='iPad', OFF_FROM_REMOTE='家中节点 · home node';
const mergeUpd=(o)=>Number(o&&o.updated)||0;
const mergeIsNotebook=(o)=>!!(o&&typeof o==='object'&&Array.isArray(o.pages));
const mergeIsIndex=(o)=>!!(o&&typeof o==='object'&&Array.isArray(o.entries));
const mergeIsTomb=(o)=>!!(o&&typeof o==='object'&&o.deleted===true&&!Array.isArray(o.pages));
const mergeSame=(a,b)=>JSON.stringify(a)===JSON.stringify(b);   // equivalent = the same bytes (both sides are written by the same code, so key order agrees)
const mergeEsc=(s)=>String(s).replace(/[&<>]/g,(c)=>c==='&'?'&amp;':c==='<'?'&lt;':'&gt;');
const mergeNewId=()=>Math.random().toString(36).slice(2,10);   // PANote's genId shape
function mergeStamp(t){ const d=new Date(t||0), p=(n)=>String(n).padStart(2,'0'); return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); }
const mergeTitle=(from,t)=>OFF_CONFLICT_TITLE+' ('+from+', '+mergeStamp(t)+')';
// The loser as a page of its own: a heading line over its text, the ink and images as they were.
function mergeCopyPage(p,from,newId){
  return {...p,id:newId(),created:p.created||p.updated,updated:p.updated,pageHtml:'<p><b>'+mergeEsc(mergeTitle(from,p.updated))+'</b></p>'+(p.pageHtml||'')};
}
// Per id over two lists (`win` first: the newer side keeps its order), with the base's row per id.
// `onBoth(w,l,baseRow)` → the row to keep. A row on one side only is kept unless the base held it
// and this side left it untouched (the same bytes) since: then the other side deleted it on purpose.
function mergeById(win,lose,base,onBoth){
  const baseById=new Map(base.map((r)=>[r.id,r]));
  const loseById=new Map(lose.map((r)=>[r.id,r]));
  const keep=(r)=>{ const b=baseById.get(r.id); return b==null||!mergeSame(r,b); };
  const out=[];
  for(const w of win){
    const l=loseById.get(w.id); loseById.delete(w.id);
    if(l) out.push(onBoth(w,l,baseById.get(w.id))); else if(keep(w)) out.push(w);
  }
  for(const l of loseById.values()) if(keep(l)) out.push(l);
  return out;
}
// → {nb, copies}: the merged notebook and how many conflict copies it carries.
function mergeNotebook(local,remote,base,opts={}){
  const newId=opts.newId||mergeNewId, fromLocal=opts.fromLocal||OFF_FROM_LOCAL, fromRemote=opts.fromRemote||OFF_FROM_REMOTE;
  const unmoved=(side)=>!!base&&mergeSame(side,base);   // the other side still holds the base's bytes: the tombstone stands
  if(mergeIsTomb(local)&&!mergeIsTomb(remote)) return unmoved(remote)?{nb:local,copies:0,note:'local tombstone over unmoved remote'}:{nb:remote,copies:0,note:'remote edit over local tombstone'};
  if(mergeIsTomb(remote)){ if(mergeIsTomb(local)) return {nb:local,copies:0,note:'both tombstones'}; return unmoved(local)?{nb:remote,copies:0,note:'remote tombstone over unmoved local'}:{nb:local,copies:0,note:'local edit over remote tombstone'}; }
  const localWins=mergeUpd(local)>=mergeUpd(remote);
  const [win,lose,winFrom,loseFrom]=localWins?[local,remote,fromLocal,fromRemote]:[remote,local,fromRemote,fromLocal];
  const copies=[];
  const pages=mergeById(win.pages,lose.pages,mergeIsNotebook(base)?base.pages:[],(w,l,b)=>{
    if(mergeSame(w,l)) return w;                                  // one page, the same bytes on both
    if(b&&mergeSame(l,b)) return w;                               // changed on the winning side only
    if(b&&mergeSame(w,b)) return l;                               // changed on the losing side only
    const [k,c,from]=mergeUpd(w)>=mergeUpd(l)?[w,l,loseFrom]:[l,w,winFrom];   // both: later wins (a tie: the newer notebook's side), the loser is kept as a copy
    copies.push(mergeCopyPage(c,from,newId)); return k;
  });
  const nb={...win,updated:Math.max(mergeUpd(local),mergeUpd(remote)),pages:[...pages,...copies]};
  return {nb,copies:copies.length};
}
// → the merged index: union by entry id, the later `updated` per row, deletions honoured against the base.
function mergeIndex(local,remote,base){
  const entries=mergeById(local.entries,remote.entries,mergeIsIndex(base)?base.entries:[],(l,r)=>(mergeUpd(l)>=mergeUpd(r)?l:r));   // a row is metadata: the later stamp, a tie to local
  return {...local,entries};
}
// The sync's entry: texts in, text out. `remote` is the node's file now; `base` the text this device
// read before it went away (null when unknown). → {text, merged:false} when the node did not move
// (the same bytes as the base: the local text goes up as it is), else {text, merged:true, copies, kind}.
function mergeOffline(localText,remoteText,baseText,opts){
  const WHAT_ZH={base:'基准',node:'节点',local:'本机'};
  const parse=(t,what)=>{ try{ return JSON.parse(t); }catch(err){ throw new Error('无法读取'+WHAT_ZH[what]+'文件 · cannot read the '+what+' file: '+(err&&err.message||err)); } };
  const base=baseText==null?null:parse(baseText,'base');
  const remote=parse(remoteText,'node');
  if(base&&remoteText===baseText) return {text:localText,merged:false};   // an equal stamp alone is no proof (finding 3)
  const local=parse(localText,'local');
  if((mergeIsNotebook(local)||mergeIsTomb(local))&&(mergeIsNotebook(remote)||mergeIsTomb(remote))){
    const r=mergeNotebook(local,remote,base,opts); return {text:JSON.stringify(r.nb),merged:true,copies:r.copies,kind:'notebook'};
  }
  if(mergeIsIndex(local)&&mergeIsIndex(remote)) return {text:JSON.stringify(mergeIndex(local,remote,base)),merged:true,copies:0,kind:'index'};
  return {text:localText,merged:true,copies:0,kind:'file'};   // neither shape: the local write stands (LWW by file; the node keeps its .bak)
}
/* ══ PA_MERGE_END ══ */
