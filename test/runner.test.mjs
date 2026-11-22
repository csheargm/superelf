import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamParser } from '../lib/runner.mjs';

const asst = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const result = (r, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: 's-1', ...extra });

test('emits interim assistant text and returns final result', () => {
  const seen = [];
  const p = createStreamParser({ onBlock: (t) => seen.push(t) });
  p.feed(asst('checking the file...') + '\n');
  p.feed(asst('done, here is the answer') + '\n' + result('done, here is the answer') + '\n');
  const final = p.finish();
  assert.deepEqual(seen, ['checking the file...', 'done, here is the answer']);
  assert.equal(final.ok, true);
  assert.equal(final.sessionId, 's-1');
  assert.equal(final.alreadyStreamed, true); // final text == last streamed → don't send twice
});

test('handles chunks split mid-line', () => {
  const seen = [];
  const p = createStreamParser({ onBlock: (t) => seen.push(t) });
  const line = asst('partial delivery works') + '\n';
  p.feed(line.slice(0, 10));
  p.feed(line.slice(10));
  p.feed(result('final'));
  const final = p.finish();
  assert.deepEqual(seen, ['partial delivery works']);
  assert.equal(final.text, 'final');
  assert.equal(final.alreadyStreamed, false);
});

test('error result marked not ok', () => {
  const p = createStreamParser({});
  p.feed(JSON.stringify({ type: 'result', is_error: true, result: 'boom', session_id: 's-2' }) + '\n');
  const final = p.finish();
  assert.equal(final.ok, false);
  assert.equal(final.text, 'boom');
});

test('non-JSON noise between events is ignored', () => {
  const p = createStreamParser({});
  p.feed('some warning text\n' + result('clean') + '\n');
  assert.equal(p.finish().text, 'clean');
});

test('no result event yields null final (caller falls back to raw)', () => {
  const p = createStreamParser({});
  p.feed('garbage output only\n');
  assert.equal(p.finish(), null);
});

test('tool_use fires onTool with a short brief', () => {
  const tools = [];
  const p = createStreamParser({ onTool: (n, b) => tools.push([n, b]) });
  p.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'tasks.md' } }] } }) + '\n');
  assert.deepEqual(tools, [['Read', 'tasks.md']]);
});

test('tool brief flattens newlines and truncates via the ONE shared sanitizer (R3: webutil sanitizeLine)', () => {
  const tools = [];
  const p = createStreamParser({ onTool: (n, b) => tools.push(b) });
  const feed = (input) => p.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } }) + '\n');
  feed({ command: 'echo hi\necho bye' });
  feed({ command: 'x'.repeat(80) });
  assert.equal(tools[0], 'echo hi echo bye', 'newlines flattened, nothing dropped');
  assert.equal(tools[1], 'x'.repeat(59) + '…', 'truncated with ellipsis at the shared cap');
});

test('text deltas fire onDelta', () => {
  const deltas = [];
  const p = createStreamParser({ onDelta: (t) => deltas.push(t) });
  p.feed(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }) + '\n');
  p.feed(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }) + '\n');
  assert.deepEqual(deltas, ['Hel', 'lo']);
});

test('tool_use-only assistant messages emit nothing', () => {
  const seen = [];
  const p = createStreamParser({ onBlock: (t) => seen.push(t) });
  p.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }) + '\n');
  assert.deepEqual(seen, []);
});
