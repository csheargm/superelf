// 回答清理 · App chat answers, applies and undoes (live 2026-11-24, v5.18.x): the four things the owner saw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanReply, shownUserText, scrubPaths, REPLY_EMPTY_TEXT } from '../lib/reply-clean.mjs';
import { appReadArgs, appJailArgs, READ_TOOLS } from '../lib/agent-origin.mjs';
import { applyNowPrompt, applyMessage } from '../lib/app-edit-confirm.mjs';
import { dataFilesLine, editSystemPrompt } from '../lib/app-edit.mjs';

const LIVE = 'I\'ll look at the screenshot and the app\'s files.\n\n<invoke name="Read">\n<parameter name="file_path">/data/superelf/workspace/uploads/1_screen-calendar.png</parameter>\n</invoke>\n<invoke name="Glob">\n<parameter name="pattern">apps/calendar/**</parameter>\n</invoke>';

test('the live reply: tool-call markup never reaches a bubble; markup alone is a failure, said in both languages', () => {
  const c = cleanReply(LIVE);
  assert.doesNotMatch(c.text, /invoke|parameter|\/data\//);
  assert.equal(c.emptied, false);
  const only = cleanReply('\n<invoke name="Glob">\n<parameter name="pattern">apps/calendar/**</parameter>\n</invoke>');
  assert.deepEqual(only, { text: '', emptied: true });
  assert.match(REPLY_EMPTY_TEXT, /[一-鿿].* · [A-Za-z]/, 'bilingual');
  assert.equal(cleanReply('<function_calls><invoke name="X"><parameter name="a">1').text, '', 'an unclosed call to the end');
  assert.equal(cleanReply('Plain <b>bold</b> answer.').text, 'Plain <b>bold</b> answer.', 'CONTROL: other markup stays');
});

test('the plan marker is stripped; the Apply tap shows without its confirm id', () => {
  assert.equal(cleanReply('I will make the title red.\n[[apply]]').text, 'I will make the title red.');
  assert.equal(shownUserText(applyMessage('g_fYbcpP7Hod5kz1')), '改 · Apply');
  assert.equal(shownUserText('make it red'), 'make it red', 'CONTROL');
});

test('node paths become plain words', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  try {
    const t = scrubPaths(`Read ${ws}/apps/calendar/index.html and ${fs.realpathSync(ws)}/uploads/1_s.png.`, ws);
    assert.equal(t, 'Read apps/calendar/index.html and 你的截图 · your screenshot.');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('PAChat cleans every render path through the same file (live stream, history, Copy, Read aloud)', () => {
  const ui = fs.readFileSync(new URL('../web/chat-ui.inline.html', import.meta.url), 'utf8');
  const web = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(ui, /\/\* PA_REPLY_CLEAN_JS \*\//);
  assert.match(web, /\{ marker: '\/\* PA_REPLY_CLEAN_JS \*\/', file: 'reply-clean\.js' \}/);
  assert.match(ui, /async function paint\(d,md\)\{\n\s*md=shownAi\(md\);/, 'every painted reply (live final, history)');
  assert.match(ui, /if\(kind==='ai'\) rawText=shownAi\(rawText\);/, 'Copy and Read aloud');
  assert.match(ui, /cur=shownAi\(acc\)/, 'the live stream');
  assert.match(ui, /shownMe\(shownUserText\(q\)\)/, 'the user bubble of a tap');
});

test('an unconfirmed owner turn READS (Read/Glob/Grep), never --tools=; no bypass, no settings', () => {
  const a = appReadArgs(['--model', 'sonnet', '--dangerously-skip-permissions', '--tools=', '--settings', '{}'], ['/w/data/cal/', '/w/uploads/s.png']);
  assert.equal(a[a.indexOf('--tools') + 1], READ_TOOLS.join(','));
  assert.ok(!a.some((x) => x === '--tools=' || x === '--dangerously-skip-permissions' || x === '--settings'));
  assert.deepEqual(a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--allowedTools') + 3), ['Read(//w/data/cal/**)', 'Read(//w/uploads/s.png)']);
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'default');
  const j = appJailArgs(['--model', 'sonnet'], '/w/apps/cal', ['/w/data/cal/']);
  assert.deepEqual(j.slice(j.indexOf('--allowedTools') + 1, j.indexOf('--allowedTools') + 3), ['Edit(//w/apps/cal/**)', 'Read(//w/data/cal/**)']);
});

test('Apply runs fresh with the plan as its turn (a resumed read-only session refused to edit, live)', () => {
  const web = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(web, /const resumeId = oneShot \|\| jailed \? null : convo\.sessionId;/);
  assert.match(web, /const turnMsg = jailed \? applyNowPrompt\(edit\.plan\) : message;/);
  assert.match(web, /cwd: appCwd \|\| wsDir\(user\)/, 'both edit lanes run in the app folder');
  const t = applyNowPrompt('Make the title red.');
  assert.match(t, /Make the title red\./); assert.doesNotMatch(t, /\([A-Za-z0-9_-]{12,}\)/);
});

test('the question turn is told the app\'s data files as a fact, not a guess', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  try {
    const dir = path.join(ws, 'apps', 'calendar'); fs.mkdirSync(dir, { recursive: true });
    const edit = { slug: 'calendar', dir, confirmed: false };
    assert.match(dataFilesLine(edit), /no saved data yet/);
    fs.mkdirSync(path.join(ws, 'data', 'calendar'), { recursive: true }); fs.writeFileSync(path.join(ws, 'data', 'calendar', 'events.json'), '[]');
    assert.match(dataFilesLine(edit), /events\.json/);
    assert.match(editSystemPrompt(edit), /events\.json[\s\S]*current directory is the app's folder/);
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
