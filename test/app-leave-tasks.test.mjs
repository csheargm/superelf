// ADR 0014 and ADR 0018 together, for Tasks: a change made while a save is out, then ← Home.
//
// Tasks sends one save at a time (two out at once could land out of order). A change made while one is
// out sets `again`, and save() sends the list as it is then, in the turn that handles the reply
// (pinned by test/app-read-guard-tasks.test.mjs). Before ADR 0018 the page was blanked on ← Home, so
// that follow-up was never sent: the tick was lost in every real Chrome and WebKit run (2026-10-17).
// Now a left page is held while it has a request in flight, the reply reaches it, and the follow-up
// lands. Here: the shell's own broker and app-frame code (helpers-shell-broker) and a real web.mjs over
// a throwaway root, replaying Tasks' saves of tasks.md in its order, on a clock the test moves. Left
// out: PAStore's first read (so real ids start at pas2) and the face.json save Tasks sends in the same
// turn as each list save; that one only keeps a request in flight longer, so it cannot end the hold.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadShellBroker, appFrameConstant, repliedTo as replied } from './helpers-shell-broker.mjs';
import { fakeClock } from './helpers-sandbox-app.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

let root, web, base;
before(async () => { const port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); base = `http://127.0.0.1:${port}`; });
after(async () => { await stopWeb(web); rmTemp(root); });

const QUIET = appFrameConstant('APP_LEAVE_QUIET_MS'), ACK = appFrameConstant('APP_LEAVE_ACK_MS');
const PAST_ANY_QUIET = ACK + QUIET;   // past every quiet the hold could start, still far below its 20 s cap
const ADDED = '## Today\n- [ ] Call Mom\n- [ ] Buy milk\n';
const TICKED = '## Today\n- [x] Call Mom\n- [ ] Buy milk\n';
const tasksMd = () => fs.readFileSync(path.join(root, 'workspace', 'data/tasks/tasks.md'), 'utf8');
const save = (id, md) => ({ id, kind: 'save-data', what: 'data', path: 'tasks.md', data: md });   // PAStore's request
const tasksPage = (clock) => {
  const B = loadShellBroker(base, { token: OWNER_TOKEN, app: 'tasks', timers: clock });
  const page = B.live();
  return { B, page, hello: () => B.deliver(page.win, { pa: 'here' }) };   // PALeave's hello: the page runs
};

test('USER FLOW: a Tasks change made while its save is out survives ← Home: the held page sends it when that save is back', async () => {
  const clock = fakeClock();
  const { B, page, hello } = tasksPage(clock);
  await hello();
  const first = B.post(save('pas1', ADDED), page);     // "Buy milk" added: its save is out…
  B.leave();                                           // …"Call Mom" is ticked (again=true), then ← Home
  await B.deliver(page.win, { pa: 'left' });           // PALeave's answer: Tasks has no pagehide handler
  clock.advance(PAST_ANY_QUIET);
  assert.equal(B.held.size, 1, "held while the add's save is out");
  await first;
  assert.equal(replied(page, 'pas1')?.ok, true, "the add's reply reaches the held page");
  const second = B.post(save('pas2', TICKED), page);   // save() sees `again`: the list as it is now, same turn
  clock.advance(PAST_ANY_QUIET);
  assert.equal(B.held.size, 1, 'held while the follow-up is out');
  await second;
  assert.equal(replied(page, 'pas2')?.ok, true, B.said('pas2'));
  assert.equal(tasksMd(), TICKED, 'both changes are in tasks.md');
  clock.advance(QUIET - 1);
  assert.equal(B.held.size, 1, 'the quiet starts from the last reply');
  clock.advance(1);
  assert.equal(B.held.size, 0, 'then the page is removed');
});

// R14 control: the same requests in the order before ADR 0018, when ← Home blanked the frame at once.
test('CONTROL (R14): with the frame blanked first, the follow-up has no app, and the tick is lost', async () => {
  const { B, page, hello } = tasksPage(fakeClock());
  await hello();
  const first = B.post(save('pas1', ADDED), page);     // out before the frame is blanked: it still lands
  page.src = 'about:blank';                            // what goHome did before ADR 0018, on the same element
  await first;
  await B.post(save('pas2', TICKED), page);            // WebKit: the gone page's message, with no app in view
  assert.notEqual(replied(page, 'pas2')?.ok, true, B.said('pas2'));
  assert.equal(tasksMd(), ADDED, 'the tick never reaches tasks.md');
});
