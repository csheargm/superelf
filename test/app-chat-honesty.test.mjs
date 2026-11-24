// 应用对话不再假装已修改 · lib/app-chat-honesty.mjs — the rule, the offer and the backstop (known-limits heuristic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APP_CHAT_NO_CHANGE_RULE, noChangeRule, CHANGE_PATHS, NO_CHANGE_NOTE, CHANGE_APP_LABEL, asksForChange, changeRequestOf,
  claimsChange, honestReply, finishHonest, editUnchangedNote, EDIT_UNCHANGED_NOTE } from '../lib/app-chat-honesty.mjs';

test('R3: the rule lives in ONE file; web.mjs and the demo route import it', () => {
  const lib = fs.readdirSync('lib').filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync('lib/' + f, 'utf8'));
  assert.equal(lib.filter((s) => s.includes('This chat CANNOT change this app')).length, 1);
  assert.match(fs.readFileSync('web.mjs', 'utf8'), /noChangeRule\(chatRole\)/);
  assert.match(fs.readFileSync('lib/demo-routes.mjs', 'utf8'), /noChangeRule\('demo'\)/);
});

test('the rule forbids claiming a change and names the real way per person', () => {
  assert.match(APP_CHAT_NO_CHANGE_RULE, /CANNOT change this app/);
  assert.match(APP_CHAT_NO_CHANGE_RULE, /"Done"/); assert.match(APP_CHAT_NO_CHANGE_RULE, /已添加/);
  assert.ok(noChangeRule('owner').includes(CHANGE_APP_LABEL), 'owner: the button and the ⋯ menu');
  assert.match(noChangeRule('member'), /only open to the owner/);
  assert.match(noChangeRule('demo'), /main chat/);
  assert.equal(noChangeRule('nobody'), `${APP_CHAT_NO_CHANGE_RULE} ${CHANGE_PATHS.member}`, 'unknown → the path that promises least');
});

test('the owner\'s case: the request is found, "yes" carries the earlier request', () => {
  const ask = 'can you allow user to select day, week, month and year view?';
  assert.ok(asksForChange(ask));
  assert.ok(asksForChange('能不能加一个周视图'));
  assert.ok(asksForChange('请把按钮改成蓝色'));
  assert.ok(!asksForChange('yes'));
  assert.ok(!asksForChange('what is this app for?'));
  assert.ok(!asksForChange('今天有什么安排'));
  assert.equal(changeRequestOf('yes', [ask]), ask);
  assert.equal(changeRequestOf('yes', []), '');
});

const CLAIMS = [
  'Done — the Calendar Planner now has a Day / Week / Month / Year view switcher at the top.',
  "I've added a week view button for you.",
  'The app now supports dark mode.',
  'A year view has been added to the calendar.',
  'I added a week view to the calendar.',   // GPT review: the plain past tense
  '已添加日/周/月/年视图切换功能。',
  '好的，已经修改了按钮的颜色。',
  '改好了，现在应用里有周视图。',
];
const HONEST = [
  'This chat cannot change the app. Tap 改这个应用 · Change this app to ask for it.',
  'To add an event, type the title and press Add.',
  'I added up the hours: 12 in total.',   // no app word: not a claim about the app
  'Once done, reopen the app to see it.',   // GPT review: "done" mid-sentence is not a claim
  '这个对话不能修改应用，请用「改这个应用」。',
  '你今天有三个会议。',
];
test('the backstop flags the pinned claims (en/zh) and leaves the pinned honest replies alone', () => {
  for (const c of CLAIMS) assert.ok(claimsChange(c), c);
  for (const h of HONEST) assert.ok(!claimsChange(h), h);
});

test('honestReply: note on a claim, the offer only where the panel works', () => {
  const r = honestReply({ reply: CLAIMS[0], message: 'yes', priorUserTexts: ['can you allow user to select day, week, month and year view?'], inApp: true, canEdit: true });
  assert.equal(r.note, NO_CHANGE_NOTE);
  assert.deepEqual(r.offer, { type: 'app-change', label: CHANGE_APP_LABEL, request: 'can you allow user to select day, week, month and year view?' });
  assert.equal(honestReply({ reply: CLAIMS[0], message: 'yes', inApp: true, canEdit: false }).offer, null, 'a member or guest gets no button');
  const honest = honestReply({ reply: HONEST[0], message: 'please add a week view', inApp: true, canEdit: true });
  assert.equal(honest.note, ''); assert.equal(honest.offer.request, 'please add a week view', 'an honest reply to a request still gets the real way');
  assert.equal(honestReply({ reply: 'Sure.', message: 'what is this?', inApp: true, canEdit: true }).offer, null);
  assert.equal(honestReply({ reply: `${CLAIMS[0]}\n\n${NO_CHANGE_NOTE}`, message: 'x', inApp: true }).note, '', 'never twice');
});

test('finishHonest streams the note and the offer, and returns the stored text', () => {
  const lines = [];
  const out = finishHonest({ reply: CLAIMS[0], message: 'yes', prior: [{ role: 'me', text: 'please add a year view' }, { role: 'md', text: 'Sure, shall I?' }], inApp: true, canEdit: true, line: (o) => lines.push(o) });
  assert.equal(out, `${CLAIMS[0]}\n\n${NO_CHANGE_NOTE}`);
  assert.deepEqual(lines.map((l) => l.type), ['delta', 'app-change']);
  assert.equal(lines[1].request, 'please add a year view');
});

test('Change this app: a "Done" for a turn that changed nothing is corrected', () => {
  assert.equal(editUnchangedNote('Done — added the week view.', { changed: false }), EDIT_UNCHANGED_NOTE);
  assert.equal(editUnchangedNote('Done — added the week view.', { changed: true, applied: true }), '');
  assert.equal(editUnchangedNote('Nothing needed changing.', { changed: false }), '');
});
