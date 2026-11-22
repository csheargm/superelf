// When（时间解析）— "every morning", "weekdays at 9am", "每天早上7点" → {time,day}.
//
// DETERMINISTIC on purpose. This is the house style: codify a judgement into rules when you
// can. A model that guesses 07:00 is a
// token spend, a latency, and a thing that can answer differently tomorrow — for a phrase
// that a regex settles exactly.
//
// The engine's schedule is {time:'HH:MM', day?:0-6} — daily, or weekly on one weekday. That
// is deliberately narrow, so anything richer ("every 30m", "in 2h") is NOT invented here; it
// is reported as unsupported rather than silently rounded to something else.
import { TIME_RE } from '../schedule.mjs';   // the ONE HH:MM shape (R3)

export const DEFAULT_TIME = '07:00';         // "every morning" with no hour given
const DAYS = [['sunday|sun|周日|星期日|礼拜日', 0], ['monday|mon|周一|星期一', 1], ['tuesday|tue|周二|星期二', 2],
  ['wednesday|wed|周三|星期三', 3], ['thursday|thu|周四|星期四', 4], ['friday|fri|周五|星期五', 5], ['saturday|sat|周六|星期六', 6]];
// Named parts of day, used only when no explicit hour appears.
const PARTS = [[/\b(morning|早上|早晨|上午)\b/i, '07:00'], [/\b(noon|midday|中午)\b/i, '12:00'],
  [/\b(afternoon|下午)\b/i, '15:00'], [/\b(evening|晚上|傍晚)\b/i, '19:00'], [/\b(night|夜里|夜晚)\b/i, '21:00']];
export const UNSUPPORTED = /\bevery\s+\d+\s*(m|min|minute|h|hour)|\bin\s+\d+\s*(m|min|minute|h|hour)|\bhourly\b|\beach hour\b/i;
// Mon-Fri and weekends are sets of days; the schedule holds ONE day or none. Treating
// "weekdays" as daily would run the job on Saturday and Sunday as well — five becomes seven,
// silently. Say so instead.
export const MULTI_DAY = /\bweekdays?\b|\bweekends?\b|\bmon(day)?\s*[-–to]+\s*fri(day)?\b|工作日|周末/i;

const pad = (n) => String(n).padStart(2, '0');

// "9am", "9:30pm", "at 7", "07:30", "早上7点"
export function timeIn(text) {
  const s = String(text || '');
  let m = /\b([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?\b/i.exec(s);
  if (m) {
    let h = Number(m[1]);
    if (m[3]) { const pm = /pm/i.test(m[3]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
    return `${pad(h)}:${m[2]}`;
  }
  m = /\b(1[0-2]|0?\d)\s*(am|pm)\b/i.exec(s);
  if (m) { let h = Number(m[1]); const pm = /pm/i.test(m[2]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; return `${pad(h)}:00`; }
  // Chinese hour with a part-of-day marker. The marker carries the AM/PM the digit does not:
  // 晚上9点 is 21:00, and reading it as 09:00 would fire the job twelve hours early.
  m = /(早上|早晨|上午|中午|下午|晚上|傍晚|夜里|夜晚)\s*(\d{1,2})\s*点?/.exec(s);
  if (m) {
    let h = Number(m[2]);
    const pm = /下午|晚上|傍晚|夜里|夜晚/.test(m[1]);
    if (pm && h < 12) h += 12;
    if (/中午/.test(m[1]) && h === 12) h = 12;
    if (h >= 0 && h <= 23) return `${pad(h)}:00`;
  }
  m = /\bat\s+(\d{1,2})\b/i.exec(s);
  if (m) { const h = Number(m[1]); if (h >= 0 && h <= 23) return `${pad(h)}:00`; }
  m = /(\d{1,2})\s*点/.exec(s);
  if (m) { const h = Number(m[1]); if (h >= 0 && h <= 23) return `${pad(h)}:00`; }
  return null;
}

export function dayIn(text) {
  const s = String(text || '');
  for (const [pat, n] of DAYS) if (new RegExp(`\\b(${pat})\\b|${pat}`, 'i').test(s)) return n;
  return undefined;
}

// Returns {schedule} | {unsupported:'…'} | {} when nothing about time was said at all.
// Never guesses a WEEKDAY — "every morning" is daily, and inventing "Monday" would quietly
// make a job fire one seventh as often as asked.
export function whenFrom(text) {
  const s = String(text || '');
  if (UNSUPPORTED.test(s)) {
    return { unsupported: 'intervals and one-shots are not supported yet — a job runs once a day, or weekly on one day · 目前仅支持每天或每周一次' };
  }
  if (MULTI_DAY.test(s)) {
    return { unsupported: 'a run on several named days is not supported yet — pick daily, or one weekday · 暂不支持多天，请选每天或每周某天' };
  }
  const explicit = timeIn(s);
  const part = explicit ? null : (PARTS.find(([re]) => re.test(s)) || [])[1];
  const day = dayIn(s);
  const said = explicit || part || day !== undefined || /\b(daily|every ?day|each day|每天|每日|weekly|每周)\b/i.test(s);
  if (!said) return {};
  const time = explicit || part || DEFAULT_TIME;
  if (!TIME_RE.test(time)) return {};
  return { schedule: day === undefined ? { time } : { time, day } };
}
