// Does this message ask for a RECURRING job, or is it just a question?
//
// Deterministic on purpose. Asking a model "is this a job request?" on every single chat turn
// costs a call per message and can answer differently tomorrow; and getting it wrong is
// expensive in one direction — hijacking an ordinary question with a job card is far more
// annoying than missing one, which the user simply rephrases.
//
// So the bar is deliberately HIGH: a recurrence phrase AND something to do. "what's the pollen
// today" is a question. "every morning tell me the pollen" is a job.
import { whenFrom } from './when.mjs';

// Recurrence, not just any time reference. "today"/"now" are the opposite of a job.
export const RECURS = /\b(every|each)\s+(day|morning|afternoon|evening|night|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bdaily\b|\bweekly\b|\bevery ?day\b|\bnightly\b|每天|每日|每周|每晚|每早/i;
// Something for the assistant to DO on that cadence.
export const DOES = /\b(tell|send|remind|alert|give|check|watch|report|brief|notify|show|summari[sz]e|email|ping)\b|提醒|告诉|发送|检查|汇报|通知/i;
// Explicit asks win outright — the user has already said the word.
export const EXPLICIT = /\b(create|make|set ?up|schedule|add)\b[^.?!]{0,30}\b(job|task|routine|automation)\b|建个?任务|创建任务|设置任务|定时任务/i;
// A question about right now is never a job, however it is phrased.
export const RIGHT_NOW = /\b(right now|at the moment|currently)\b|^\s*(what|who|when|where|why|how|is|are|does|do|can|should)\b[^]*\b(today|now|tonight)\b/i;

// "how do I create a job?" is a question ABOUT jobs, not a request for one. how/what/why/
// when/where/who open an enquiry; "can you…" / "please…" open a request, and those still count.
export const ASKS_ABOUT = /^\s*(how|what|why|when|where|who|whats|what's)\b/i;

export function looksLikeJob(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 400) return { job: false, why: 'not a short instruction' };
  if (ASKS_ABOUT.test(s)) return { job: false, why: 'a question about the topic, not an instruction' };
  if (EXPLICIT.test(s)) return { job: true, why: 'asked for a job in so many words' };
  if (RIGHT_NOW.test(s) && !RECURS.test(s)) return { job: false, why: 'a question about now' };
  const recurs = RECURS.test(s);
  const does = DOES.test(s);
  // whenFrom is the same parser the resolver uses (R3): if it cannot express the cadence,
  // this is not a job we could build anyway.
  const when = whenFrom(s);
  if (recurs && does && !when.unsupported) return { job: true, why: 'a recurring instruction' };
  if (recurs && does && when.unsupported) return { job: false, why: when.unsupported };
  return { job: false, why: recurs ? 'no action named' : 'no recurrence named' };
}
