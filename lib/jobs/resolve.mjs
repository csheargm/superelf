// Resolver（意图解析）— a sentence becomes a job plan, without interrogating the user.
//
// "alert me if the pollen count is high today" → {tool:'pollen', args:{zip,threshold},
// schedule:{time:'06:30'}}. The model picks the tool and fills its arguments; everything it
// returns is VALIDATED against the manifest before it can become a job.
//
// Order (docs/JOB_ENGINE_PLAN §4): an existing tool first, then existing code, then generated
// code, and ASK only as a last resort — and then with concrete choices, not an open question.
// This step covers the first: the runnable catalogue.
//
// Deterministic parts stay deterministic. The schedule comes from lib/jobs/when.mjs, not from
// the model: a regex settles "every morning" exactly, for free, the same way every time.
import { whenFrom, DEFAULT_TIME } from './when.mjs';
import { validateJob } from './store.mjs';

export const RESOLVE_TIMEOUT_MS = 60000;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// What the model is told. Only RUNNABLE tools are offered: proposing one with no runner would
// produce a job that can never do anything — indistinguishable from a quiet day.
export function buildResolvePrompt(prompt, { tools, runnable, profile = {} }) {
  const cat = runnable.map((n) => {
    const m = tools[n] || {};
    return `- ${n}: ${m.purpose || ''}\n  inputs: ${JSON.stringify(m.inputs || {})}\n  outputs: ${JSON.stringify(m.outputs || {})}`;
  }).join('\n');
  const known = [profile.postcode ? `postcode: ${profile.postcode}` : '', profile.name ? `name: ${profile.name}` : '']
    .filter(Boolean).join('\n') || '(nothing on file)';
  return [
    'Turn the request into ONE scheduled job, using exactly one of these tools.',
    '', 'TOOLS', cat, '', 'WHAT WE ALREADY KNOW ABOUT THE USER', known, '',
    'Answer with ONLY a JSON object, no prose and no code fence:',
    '{"title":"<short bilingual title, EN · 中文>","tool":"<one of the tool names above>",',
    ' "args":{...},"missing":["<an input you genuinely cannot infer>"]}',
    '',
    'Rules:',
    '- Fill every required input you can INFER. Use what is known about the user above.',
    '- "missing" lists ONLY inputs you cannot infer and which would make the job wrong if',
    '  guessed. Leave it empty whenever you can proceed. Do not ask for anything optional.',
    '- Never invent a postcode, address, URL or credential. If one is needed and unknown, it',
    '  belongs in "missing".',
    '- Pick the tool that answers the request most directly. `research` answers anything from',
    '  the live web when no specific tool fits.',
    '', 'REQUEST', String(prompt || ''),
  ].join('\n');
}

// A model reply is prose-adjacent by nature. Take the first balanced {...} and parse it; a
// reply we cannot parse is a FAILURE, never a job that quietly does nothing.
export function parseResolveReply(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  if (i < 0) return { ok: false, error: 'the model did not answer with JSON' };
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) { end = j + 1; break; } }
  }
  if (end < 0) return { ok: false, error: 'the model’s JSON was truncated' };
  try { return { ok: true, value: JSON.parse(s.slice(i, end)) }; }
  catch (e) { return { ok: false, error: `the model’s JSON did not parse: ${e.message}` }; }
}

// Which declared inputs are required and absent. The manifest marks a required input by
// saying so in its description — that is the only contract the tools already carry.
export function missingInputs(manifest, args) {
  const inputs = (manifest && manifest.inputs) || {};
  return Object.entries(inputs)
    .filter(([k, desc]) => /required/i.test(String(desc)) && (args || {})[k] === undefined)
    .map(([k]) => k);
}

// {ok:true, job} — ready to save (PAUSED by the caller).
// {ok:false, ask:[…]} — genuinely needs the user; each entry names one input.
// {ok:false, error} — could not resolve; say why rather than produce a dud.
export async function resolvePrompt(prompt, { ask, tools, runnable, profile = {}, now = new Date() } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: 'say what the job should do · 请描述任务内容' };
  if (typeof ask !== 'function') return { ok: false, error: 'resolver has no model to ask' };
  if (!runnable || !runnable.length) return { ok: false, error: 'no runnable tools · 暂无可用工具' };

  // Schedule first, deterministically. Silence about time is not an error — it defaults to
  // daily; but a schedule we cannot express must be reported, not rounded.
  const when = whenFrom(text);
  if (when.unsupported) return { ok: false, error: when.unsupported };

  let reply;
  try { reply = await ask(buildResolvePrompt(text, { tools, runnable, profile })); }
  catch (e) { return { ok: false, error: `could not reach the model · 无法连接模型: ${String(e && e.message || e)}` }; }
  const parsed = parseResolveReply(reply);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const v = parsed.value || {};

  if (!runnable.includes(v.tool)) {
    return { ok: false, error: `no tool for that yet · 暂无对应工具（have: ${runnable.join(', ')}）` };
  }
  const manifest = (tools || {})[v.tool] || {};
  const args = (v.args && typeof v.args === 'object' && !Array.isArray(v.args)) ? v.args : {};
  // Trust the MANIFEST over the model about what is missing: a model that forgets to list a
  // required input would otherwise produce a job that fails on its first run.
  const need = [...new Set([...(Array.isArray(v.missing) ? v.missing : []), ...missingInputs(manifest, args)])]
    .filter((k) => Object.prototype.hasOwnProperty.call(manifest.inputs || {}, k));
  if (need.length) {
    return { ok: false, ask: need.map((k) => ({ input: k, describe: String((manifest.inputs || {})[k] || ''), tool: v.tool })),
      draft: { title: v.title, tool: v.tool, args, schedule: when.schedule || { time: DEFAULT_TIME } } };
  }

  const job = {
    id: slug(v.id || v.title || v.tool) || v.tool,
    title: String(v.title || v.tool).slice(0, 80),
    prompt: text,
    schedule: when.schedule || { time: DEFAULT_TIME },
    plan: { kind: 'tool', tool: v.tool, args },
    deliver: 'own-message',           // its own message when it runs (the daily-brief fold is gone)
    enabled: false,                   // ALWAYS paused: reviewed before it can message anyone
    author: 'chat',
  };
  const check = validateJob(job);     // the store is the authority, not this module
  if (!check.ok) return { ok: false, error: `resolved to an invalid job: ${check.error}` };
  return { ok: true, job: check.job, usedDefaultTime: !when.schedule };
}
