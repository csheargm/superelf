// The model review's fake CLIs · 模型评测的假命令行 (test/model-review-flow.test.mjs)
//
// Two fakes the REAL runners launch (lib/runner.mjs runClaude, lib/codex.mjs runCodex), laid out
// as test/helpers-platform.mjs writeFakeCli lays them out on this OS:
//   claude  the grader AND the Claude agent lane. A grading prompt (<<<ANSWER) is scored by each
//           answer's hidden [q=N] mark, or answered with garbage when the mode file says so. Any
//           other prompt is a review test, answered from the answers file: two streamed deltas,
//           then the result, so the runner's first-text timing is exercised.
//   codex   the GPT agent lane: only its final message, written to the -o file, as the real one.
// Every run of the fake claude is appended to `log` ({ argv, stdin }), the test's evidence.
import path from 'node:path';
import { writeFakeCli } from './helpers-platform.mjs';

const CLAUDE_SRC = ({ log, mode, answers }) => `#!/usr/bin/env node
import fs from 'node:fs';
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: s }) + '\\n');
  if (!s.includes('<<<ANSWER')) {
    const a = JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, 'utf8')).find((x) => x.ask === s);
    if (!a) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'fake claude: unknown prompt' }) + '\\n'); return; }
    const delta = (text) => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) + '\\n';
    process.stdout.write(delta(a.claude.slice(0, 3)));
    setTimeout(() => { process.stdout.write(delta(a.claude.slice(3)) + JSON.stringify({ type: 'result', subtype: 'success', result: a.claude, session_id: 's' }) + '\\n'); }, 30);
    return;
  }
  const tag = (/<<<ANSWER [A-Z] ([0-9a-f]+)>>>/.exec(s) || [])[1];
  const re = new RegExp('<<<ANSWER ([A-Z]) ' + tag + '>>>\\\\n([\\\\s\\\\S]*?)\\\\n<<<END \\\\1 ' + tag + '>>>', 'g');
  const out = {}; let m;
  while ((m = re.exec(s))) { const q = /\\[q=(\\d)\\]/.exec(m[2]); out[m[1]] = q ? Number(q[1]) : 1; }
  const mode = fs.existsSync(${JSON.stringify(mode)}) ? fs.readFileSync(${JSON.stringify(mode)}, 'utf8') : 'ok';
  const result = mode === 'garbage' ? 'Answer A is clearly the best.' : JSON.stringify(out);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result, session_id: 's' }) + '\\n');
});
`;

const CODEX_SRC = ({ answers }) => `#!/usr/bin/env node
import fs from 'node:fs';
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const out = process.argv[process.argv.indexOf('-o') + 1];
  const a = JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, 'utf8')).find((x) => s.endsWith('\\n\\n' + x.ask));
  if (a) fs.writeFileSync(out, a.codex);   // no match: no file, and the real runner reports "no output"
});
`;

// { claude, codex }: the commands to configure. `answers` is a JSON file [{ ask, claude, codex }].
export function writeFakeReviewClis({ dir, log, mode, answers }) {
  return { claude: writeFakeCli(dir, 'claude', CLAUDE_SRC({ log, mode, answers })), codex: writeFakeCli(dir, 'codex', CODEX_SRC({ answers })) };
}
