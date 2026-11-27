// Tool registry（工具目录）— the catalogue a job's plan resolves against.
//
// A tool is a deterministic capability with a MANIFEST: what it needs, what it returns, and
// whether it has side effects. `effects: 'read-only'` is what lets a job run unattended.
//
// Most of this catalogue is not new code. lib/research, ics, health and meals were
// already tools — standalone modules with injected deps, none importing web.mjs.
// They were missing a manifest, not an implementation.
//
// `run(args, ctx)` — ctx carries what a tool cannot get by itself: the user, their profile,
// config and credentials, and lanes web.mjs owns. Keeping that in ctx is what stops this file
// importing web.mjs and makes every tool testable with a stub.
//
// `brief(reading, args)` turns a reading into a briefing body, or returns NULL to say nothing
// today. A tool with no brief cannot be a job's whole plan yet — it is a building block the
// resolver may combine later.
import * as pollen from '../tools/pollen.mjs';

const need = (ctx, what) => { const v = ctx && ctx[what]; if (!v) throw new Error(`tool needs ${what}, which this context does not carry`); return v; };

export const TOOLS = {
  pollen: {
    manifest: pollen.MANIFEST,
    run: (args) => pollen.pollenToday(args.zip),
    brief: (reading, args) => pollen.pollenBrief(reading, args.threshold || 'medium-high'),
  },

  // The general live-data lane: search + scrape + citations. This is what makes "watch X"
  // jobs possible without a bespoke tool each time — news, prices, a topic.
  research: {
    manifest: { name: 'research', purpose: 'Answer a question from the live web, with citations',
      inputs: { question: 'string (required)' },
      outputs: { text: 'markdown with [n] citations', ok: 'boolean' },
      // usesModel: this tool phrases its answer with an LLM, so a job may pin WHICH lane.
      // Pinning a model on a tool that uses none would be a setting that silently does
      // nothing — refused at save time instead (lib/jobs/store.mjs).
      effects: 'read-only', needs: ['tavily_key', 'firecrawl_key'], keyless: false, version: 1, usesModel: true },
    run: async (args, ctx) => {
      const q = String((args && args.question) || '').trim();
      if (!q) throw new Error('research: a question is required');
      return need(ctx, 'research')(q, ctx.model || null, ctx.user);   // ctx.model = this job's pinned lane, if any; ctx.user: whose reply language
    },
    brief: (r, args) => (r && r.ok && String(r.text || '').trim()
      ? { body: `# ${args.title || 'Research · 研究'}\n\n${r.text}` } : null),
  },

  // ── Declared, not yet runnable as a whole plan ────────────────────────────────────────
  // Manifests so the resolver can SEE them and the UI can list them. Each needs a small
  // adapter and a test before it gets a `run`; declaring one without that would be the
  // "wrong plan silently produces nothing" failure the plan warns about.
  // calendar: its feed setting (profile.calendarIcs) was removed with the daily brief
  // (2026-10-11). A calendar tool must bring its own setting back before it gets a `run`.
  calendar: { manifest: { name: 'calendar', purpose: "Today's events from the user's ICS feed",
    inputs: {}, outputs: { events: 'array' }, effects: 'read-only', needs: ['profile.calendarIcs'], keyless: true, version: 0, usesModel: false } },
  health: { manifest: { name: 'health', purpose: 'Recent health metrics for this user',
    inputs: { days: 'number' }, outputs: { rows: 'array' }, effects: 'read-only', needs: [], keyless: true, version: 0, usesModel: false } },
  meals: { manifest: { name: 'meals', purpose: 'Recent logged meals for this user',
    inputs: { days: 'number' }, outputs: { meals: 'array' }, effects: 'read-only', needs: [], keyless: true, version: 0, usesModel: false } },
};

export const toolNames = () => Object.keys(TOOLS).sort();
export const runnableTools = () => Object.keys(TOOLS).filter((k) => typeof TOOLS[k].run === 'function' && typeof TOOLS[k].brief === 'function').sort();
export const manifests = () => Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, t.manifest]));
