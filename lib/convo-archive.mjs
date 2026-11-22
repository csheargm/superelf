// Conversation eviction（对话淘汰）— turns that fall off the cap are ARCHIVED,
// never erased.
//
// THE SCAR: web.mjs chat() ended every turn with
//     if (convo.messages.length > 200) convo.messages = convo.messages.slice(-200);
// and the TRUNCATED array is what saveConvo wrote. The oldest turns — text the
// user typed — were gone from DISK, not merely out of the model's context
// window (that bound is a SEPARATE slice(-20) in chat(), which is legitimate
// and stays). No tombstone, no notice, reported as an ordinary success. Exactly
// the class lib/meals.mjs abolished: "the old slice(-cap) silently destroyed
// the oldest records while answering 200".
//
// THE RULE, one sentence: user-typed text may leave the live conversation only
// by being written somewhere else FIRST, and the person is told. DELETE
// /api/convos already follows it for a whole chat (renamed into
// conversations/.trash); this is the same move for the HEAD of one chat, into
// conversations/.archive/<ts>-<id>.json — same directory, same name shape.
//
// Why archive and not refuse (the lib/meals.mjs answer): a meal month rolls
// over on its own, so refusing at the cap costs the user nothing. A chat thread
// never rolls over — refusing would freeze it permanently at turn 200. Archive
// keeps the thread usable AND keeps every word.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './webutil.mjs';

export const CONVO_MAX_MESSAGES = 200;        // messages kept in the LIVE file
export const CONVO_ARCHIVE_DIR = '.archive';  // sibling of .trash, inside conversations/

// convoDir  — the user's conversations/ directory.
// convoPath — that conversation's own file path, ALREADY id-validated by the
//             caller's convoFile() (R3: ONE id validator, and it lives in
//             web.mjs beside the read and the write that share it).
// convo     — the live object; its `messages` array is REPLACED on success.
//
// Returns null when nothing is over the cap, else { count, file }.
//
// ORDER IS THE WHOLE POINT: the archive is written BEFORE convo.messages is
// trimmed, so a failing write throws with the live array still whole — the
// caller's save then stores everything and nothing is lost. There is no state
// in which the turns are off the live file but not yet on disk (R5: the failure
// is loud, and it is never a half-eviction).
export function archiveOverflow(convoDir, convoPath, convo) {
  if (typeof convoPath !== 'string' || !convoPath) throw new Error('archiveOverflow: refusing to archive a conversation with an invalid id');
  if (!convo || !Array.isArray(convo.messages)) throw new Error('archiveOverflow: conversation has no messages array');
  const over = convo.messages.length - CONVO_MAX_MESSAGES;
  if (over <= 0) return null;
  const dir = path.join(convoDir, CONVO_ARCHIVE_DIR);   // created by writeFileAtomic — no second mkdirSync (R1)
  // The .trash tombstone's name shape. An archive must NEVER land on an
  // existing one — two evictions inside one millisecond would destroy the very
  // turns this function exists to keep — so a taken name gets a counter.
  const base = path.basename(convoPath), stamp = Date.now();
  let name = `${stamp}-${base}`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stamp}-${n}-${base}`;
  writeFileAtomic(path.join(dir, name), JSON.stringify({
    id: convo.id, title: convo.title || '', archived: stamp,
    reason: `evicted at the ${CONVO_MAX_MESSAGES}-message cap`,
    messages: convo.messages.slice(0, over),
  }));
  convo.messages = convo.messages.slice(over);
  return { count: over, file: `${CONVO_ARCHIVE_DIR}/${name}` };
}
