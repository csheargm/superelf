# ADR 0020 — The model review's email leads with the answer and draws its scores as bars (HTML part + text)

Status: accepted · 2026-10-21 · amends ADR 0017 decision 8

## Context

- The owner on the 2026-10-21 review email: "was not very readable and useful, make it more easily
  understandable, graphs so I can easily grasp the test".
- What arrived: one plain-text block. A result line, the chooser, then a score table whose columns
  were aligned with spaces. Gmail shows plain text in a proportional font and collapses the spaces,
  so the table read as a run of numbers. Then 17 lines "New models not picked", one per model, 9 of
  them the same reason. A model that cannot see pictures showed Vision `0.0`, which reads as a
  terrible score, not "no eyes".
- The app shows the same body through its markdown renderer (web/index.html `renderMd`), which
  draws a GFM pipe table as a table but collapses space-aligned columns too.
- lib/notify.mjs sent every briefing as plain text only, and lib/agentmail.mjs never sent `html`.
  The AgentMail send route takes `text` and `html` together (docs.agentmail.to, checked
  2026-10-21).

## Decision

1. **One view, two renderings.** lib/model-review-report.mjs `reviewView` builds the report once;
   `reviewBrief` writes the briefing text, lib/model-review-email.mjs `reviewHtml` writes the HTML.
   The job returns `{ body, html }`.
2. **The order, in both.** The answer in one line ("No change: your current models are still the
   best fit · 无变化：当前模型仍是最佳"), the numbers behind it in one line; each change (or would-be
   change) and why, one line each; up to 3 closest challengers in plain words ("… overall +0.2,
   needs +0.5 to replace it"); the scores; the other newcomers grouped by reason, one line per
   reason ("9 slower in the quick round …"); the chooser; the test in one sentence, the cost, and
   Undo when something changed. English first, then 中文, as the other briefings do.
3. **The HTML part has three bar charts**: Fast quality and Deep quality, each on a 0-5 scale that
   starts at 0, with that group's lanes and the round-2 newcomers; and seconds to the first word for
   every round-2 model, from 0, "shorter is better". Each row names its role in words under the
   model (in use / the one to beat / new / picked / replaced), so colour is never the only cue. A
   compact table of all numbers follows.
4. **Gmail-safe HTML**: tables and inline styles only. No `<style>` block, SVG, image, script,
   link, or external URL, so nothing is blocked, fetched or stripped, and no "show images" prompt.
   Every dynamic string is escaped. A long model name wraps instead of widening a phone screen.
5. **Vision `—`, never `0.0`**, for a model that scored 0 or gave no answer on the picture task:
   it could not see the picture. The legend says so.
6. **The text stays**, as the email's plain-text part and in the app: the same order, with the
   scores as a markdown pipe table, which the app draws as a table.
7. **Delivery, only as far as needed.** lib/autonomy.mjs `runJob` stores a job's `html` on the
   briefing when the job returns one. lib/notify.mjs sends it, emoji-stripped, beside the text.
   lib/agentmail.mjs adds `html` to the send only when given. Every other job returns no `html`,
   so its email is exactly what it was: `{ to, subject, text }`. lib/actions.mjs `annotateBriefing`
   drops a stored `html` when it appends to the body, so the email never shows an HTML part that
   no longer says what the body says.
8. **Structured reasons, so the report can group and explain.** lib/model-review-pick.mjs
   `pickRound2` returns `{ kind, why }` per dropped newcomer (`failed`, `slower`, `untested`);
   `decideChanges` returns each note as `{ code, why, model, group, kind, bar, adv }` and the lane
   each group had to beat (`bars`). The update rule itself is unchanged.

## Options not taken

- **Images of charts (PNG) or SVG.** Gmail blocks or strips both in many setups, and a picture
  hides the numbers from search and from a screen reader.
- **HTML for every briefing.** No other job asked for it; their text stays as it was.
- **A `<style>` block with classes.** Gmail keeps some, Outlook and many apps drop them; inline
  styles render the same everywhere.
- **Rendering the HTML in notify from the briefing text.** The text does not carry the stats, and
  parsing our own output back would be a second format to keep in step.

## Consequences

- The HTML part is about 45 KB for a 12-model review, under Gmail's 102 KB clip
  (test/model-review-email.test.mjs pins a large review under 80 KB).
- A briefing file for the model review is that much larger; the app's list reads only the preview.
- The challenger lines show per-group seconds to the first word, which the rule uses; the speed
  chart shows the median over all text tasks. Both are labelled.
- Tests: test/model-review-email.test.mjs (verdicts, Vision `—`, bar scale, Gmail-safety, grouping,
  size); test/notify.test.mjs and test/agentmail.test.mjs (html + text, every other briefing
  unchanged, stale html dropped); test/model-review-flow.test.mjs (the real scheduler path, then one
  email with both parts through the real notifier to a stubbed AgentMail).
