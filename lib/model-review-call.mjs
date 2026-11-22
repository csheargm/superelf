// Asking a model, timed · 计时调用模型 (docs/adr/0017)
//
// One answer per call, with the app's own request shape (web.mjs streamOllama: {model, messages,
// stream:true}, nothing else), so a model is measured as the apps meet it. Two times per call:
//   firstTextMs  when the first non-empty `message.content` arrived — what a person waits for. A
//                thinking model streams its reasoning in another field first; that is not text.
//   ms           the whole answer.
// A call never throws: a non-2xx (the server's own reason, lib/model-health.mjs ollamaHttpError),
// an error line in the stream, a dropped connection, the per-call timeout and an empty answer all
// come back as a failure with its reason. A timed-out answer is a failure even with text so far.
import { ollamaHttpError } from './model-health.mjs';
import { sanitizeLine } from './webutil.mjs';
import { checkAnswer } from './model-review-tests.mjs';

const ERROR_MAX = 200;

// Feed one NDJSON line into the answer; returns the stream's own error, if it sent one.
function takeLine(line, acc, now) {
  const s = line.trim();
  if (!s) return null;
  let j;
  try { j = JSON.parse(s); } catch { return null; }   // a partial or foreign line: Ollama sends whole JSON lines
  if (j.error) return String(j.error);
  const t = j.message && j.message.content;
  if (t) { if (acc.first === null) acc.first = now(); acc.text += t; }
  return null;
}

async function readStream(body, acc, now) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const err = takeLine(buf.slice(0, nl), acc, now);
      buf = buf.slice(nl + 1);
      if (err) return err;
    }
  }
  return takeLine(buf + dec.decode(), acc, now);
}

export async function askModel({ url, model, messages, timeoutMs, auth = {}, fetchImpl = fetch, now = Date.now }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = now();
  const acc = { text: '', first: null };
  const done = (error) => ({ ok: !error, text: acc.text, error: error ? sanitizeLine(error, ERROR_MAX) : null,
    firstTextMs: acc.first === null ? null : acc.first - t0, ms: now() - t0 });
  try {
    const r = await fetchImpl(url + '/api/chat', { method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ model, messages, stream: true }) });
    if (!r.ok || !r.body) return done(ollamaHttpError(r.status, await r.text().catch(() => '')).message);
    const err = await readStream(r.body, acc, now);
    if (err) return done(err);
    return done(acc.text.trim() ? null : 'empty answer');
  } catch (e) {
    return done(ac.signal.aborted ? `no full answer within ${timeoutMs / 1000}s` : String((e && e.message) || e));
  } finally {
    clearTimeout(timer);
    ac.abort();   // stop a stream we no longer read
  }
}

// Run fn over items with at most `limit` in flight; results in input order. fn must not throw
// (askModel never does), so one slow model never stalls the others' slots.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Every (model, test) pair once, bounded by the settings; `budget` counts calls across both rounds
// and refuses to go past max_calls (the plan sizes the rounds to fit, so this is the backstop).
// Each result: { model, test, ok, text, error, firstTextMs, ms, fail } — `fail` is the call's error
// or the format check's reason (lib/model-review-tests.mjs checkAnswer), null for a pass.
export async function runCalls({ pairs, url, auth, settings, budget, fetchImpl, now }) {
  if (budget.used + pairs.length > budget.max) {
    throw new Error(`model review: ${budget.used + pairs.length} Ollama calls planned, max_calls is ${budget.max}`);
  }
  budget.used += pairs.length;
  return mapLimit(pairs, settings.concurrency, async ({ model, test }) => {
    const r = await askModel({ url, model, auth, messages: test.messages, timeoutMs: settings.call_timeout_s * 1000, fetchImpl, now });
    return { model, test: test.id, ...r, fail: r.error || checkAnswer(test, r.text) };
  });
}
