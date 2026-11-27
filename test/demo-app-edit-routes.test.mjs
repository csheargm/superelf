// 访客改自己的应用 · the demo guest's app chat changes THEIR OWN app (R6: the owner's exact transcript, on the
// real demo route). A FAKE Ollama answers by the prompt it gets: a plan (or a lie) before Apply, a whole page after.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { NO_CHANGE_NOTE, EDIT_UNCHANGED_NOTE, CHANGE_PATHS } from '../lib/app-chat-honesty.mjs';
import { PLAN_MARKER, APPLY_LABEL } from '../lib/app-edit-confirm.mjs';
import { UNDO_HINT } from '../lib/demo-app-edit.mjs';
import { SAME_PAGE } from '../lib/app-edit-lane.mjs';
import { APP_MARKER, withOwnPolicy } from '../lib/demo-app.mjs';
import { ensureAskAi } from '../lib/demo-askai.mjs';
import { SEARCH_MARKER } from '../lib/demo-search.mjs';
import { waitBuilt } from './helpers-demo-build.mjs';

const MODELS = [{ id: 'fast', label: 'Fast', provider: 'ollama', model: 'fake-fast' }, { id: 'smart', label: 'Smart · 智能', provider: 'ollama', model: 'fake-smart' }];
const DEMO = { enabled: true, auth: { required: false }, behind_cloudflare: true, ai_calls_per_user_per_day: 50, ai_calls_per_ip_per_day: 500, new_users_per_ip_per_day: 50, user_disk_mb: 2, total_disk_gb: 5 };
const ASK = 'can you allow user to select day, week, month and year view?';
const LIE = 'Done — the Calendar Planner now has a Day / Week / Month / Year view switcher at the top.';
const PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Calendar Planner</h1><div id="cal"></div></body></html>';
const pageWith = (extra) => PAGE.replace('<div id="cal">', `${extra}<div id="cal">`);
let mode = 'plan', nextExtra = '', searches = 0;
function startOllamaStub() {
  return new Promise((r) => { const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }).on('end', () => {
      if (req.url === '/api/web_search') { searches++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ results: [{ title: 'Weather', url: 'https://weather.example/today', content: 'sunny' }] })); return; }
      const msgs = JSON.parse(b).messages, apply = msgs.some((m) => m.role === 'user' && m.content.startsWith('Change this app:'));
      const searched = msgs.some((m) => m.role === 'system' && (m.content.startsWith('Web search results') || m.content.startsWith('Web search is not available')));
      const text = (mode === 'search' || mode === 'search-plan') && !apply ? (!searched ? `${SEARCH_MARKER} weather today` : mode === 'search' ? 'The weather answer from search.' : `I will show today's weather in the header.\n${PLAN_MARKER}`)
        : mode === 'search-empty' && !apply ? `${SEARCH_MARKER} weather today`
        : mode === 'search-apply-only' && !apply ? (searched ? `<invoke>x</invoke>\n${PLAN_MARKER}` : `${SEARCH_MARKER} weather today`)
        : apply && mode === 'bad' ? 'no page blocks here'
        : apply && (mode === 'same' || mode === 'verbatim') ? `Kept it.\n\n\`\`\`html\n${mode === 'same' ? PAGE : withOwnPolicy(ensureAskAi(PAGE, 'Calendar Planner'))}\n\`\`\`` : mode === 'marker' && !apply ? `${APP_MARKER} {"edit":"calendar-planner","title":"Calendar Planner","request":"make the title red"}`
        : apply ? `I added it.\n\n\`\`\`html\n${pageWith(nextExtra)}\n\`\`\`\n\n\`\`\`json\n{"title":"Calendar Planner"}\n\`\`\``
        : mode === 'lie' ? LIE : `I will add a Day / Week / Month / Year switcher above the calendar.\n${PLAN_MARKER}`;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: text }, done: true }) + '\n');
    }); }); srv.listen(0, '127.0.0.1', () => r(srv)); });
}
const lines = async (r) => (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
let ollama, demo;
before(async () => {
  ollama = await startOllamaStub();
  const port = await freePort();
  const base = `http://127.0.0.1:${ollama.address().port}`;
  const root = mkWebRoot({ port, extraConfig: { ollama_url: base, chat_models: MODELS, users: [], demo: { ...DEMO, web_search_url: `${base}/api/web_search` } } });
  fs.mkdirSync(path.join(root, 'workspace.example', 'apps'), { recursive: true });
  process.env.OLLAMA_API_KEY = 'test-key-not-real';   // inherited by the web.mjs child only
  demo = { port, root, web: startWeb(root) };
  await waitReady(port);
});
after(async () => { if (demo) { await stopWeb(demo.web); rmTemp(demo.root); } ollama.close(); delete process.env.OLLAMA_API_KEY; });

async function visit(ip) {
  const r = await fetch(`http://127.0.0.1:${demo.port}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip } });
  const j = await r.json();
  return { token: j.token, uid: j.uid };
}
const chat = (v, body) => fetch(`http://127.0.0.1:${demo.port}/api/chat`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.9', authorization: `Bearer ${v.token}` }, body: JSON.stringify({ app: 'calendar-planner', ...body }) }).then(lines);
function seedApp(v) {
  const ws = findWs(v); const dir = path.join(ws, 'apps', 'calendar-planner');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'index.html'), PAGE); fs.writeFileSync(path.join(dir, 'meta.json'), '{"title":"Calendar Planner"}');
  return path.join(dir, 'index.html');
}
const findWs = (v) => path.join(demo.root, `workspace-${v.uid}`);   // lib/demo.mjs: workspace-<id> under the node root
const done = (ev) => ev.find((e) => e.type === 'done');
const confirmOf = (ev) => ev.find((e) => e.type === 'app-change-confirm');

test('the owner\'s transcript: ask → plan + 改 · Apply; typed "yes" → the page really changes; second change by the button; undo', async () => {
  const v = await visit('198.51.100.21'); const file = seedApp(v); mode = 'plan';
  const ev1 = await chat(v, { message: ASK, model: 'smart' });
  const convoId = ev1.find((e) => e.type === 'convo').id;
  assert.equal(confirmOf(ev1).label, APPLY_LABEL, 'an Apply button is offered');
  assert.ok(!done(ev1).text.includes(PLAN_MARKER) && !done(ev1).text.includes(NO_CHANGE_NOTE));
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE, 'a plan writes nothing');
  nextExtra = '<nav id="views"><button>Day</button><button>Week</button><button>Month</button><button>Year</button></nav>';
  const ev2 = await chat(v, { message: 'yes', model: 'smart', convoId });
  const ed = ev2.find((e) => e.type === 'app-edit');
  assert.equal(ed && ed.applied, true, 'the server applied the change');
  const after1 = fs.readFileSync(file, 'utf8');
  assert.ok(after1.includes('<nav id="views">'), 'the app really has the switcher');
  assert.ok(after1.includes('Content-Security-Policy') && after1.includes('PA_CHAT_UI'), 'the demo page keeps its policy and Ask AI');
  assert.ok(done(ev2).text.includes(UNDO_HINT) && !done(ev2).text.includes(EDIT_UNCHANGED_NOTE));
  // a second change in the same conversation, by the button's own message
  const ev3 = await chat(v, { message: 'also add a Today button', model: 'smart', convoId });
  nextExtra = '<nav id="views"><button>Day</button><button>Week</button><button>Month</button><button>Year</button><button id="today">Today</button></nav>';
  const ev4 = await chat(v, { message: confirmOf(ev3).message, model: 'smart', convoId });
  assert.equal(ev4.find((e) => e.type === 'app-edit').applied, true);
  assert.ok(fs.readFileSync(file, 'utf8').includes('id="today"'));
  const ev5 = await chat(v, { message: 'undo', convoId });
  assert.equal(ev5.find((e) => e.type === 'app-edit').undone, true);
  assert.equal(fs.readFileSync(file, 'utf8'), after1, 'undo restores the page before the last change');
});

test('a lying model on every lane: "Done" with no write is corrected, the page is untouched', async () => {
  const v = await visit('198.51.100.22'); const file = seedApp(v); mode = 'lie';
  for (const m of MODELS) {
    const ev = await chat(v, { message: ASK, model: m.id });
    assert.ok(done(ev).text.endsWith(EDIT_UNCHANGED_NOTE), `lane ${m.id}: the claim is corrected`);
    assert.equal(ev.find((e) => e.type === 'app-edit').applied, false);
    assert.equal(confirmOf(ev), undefined);
  }
  const yes = await chat(v, { message: 'yes', model: 'fast' });   // no plan pending: a yes applies nothing
  assert.ok(done(yes).text.endsWith(EDIT_UNCHANGED_NOTE));
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE);
});

test('a guest cannot change another visitor\'s app, nor apply another visitor\'s plan', async () => {
  const a = await visit('198.51.100.23'), b = await visit('198.51.100.24');
  const fileA = seedApp(a); mode = 'plan';
  const evA = await chat(a, { message: ASK });
  const evB = await chat(b, { message: confirmOf(evA).message });   // B has no calendar-planner: the no-write lane, A's id unused
  assert.ok(!evB.some((e) => e.type === 'app-edit'));
  assert.ok(CHANGE_PATHS.demo && !CHANGE_PATHS.demo.includes('main chat'), 'never sent to the main chat');
  fs.mkdirSync(path.join(findWs(b), 'apps', 'calendar-planner'), { recursive: true }); fs.writeFileSync(path.join(findWs(b), 'apps', 'calendar-planner', 'index.html'), PAGE);
  const evB2 = await chat(b, { message: confirmOf(evA).message });   // now B has one of the same name: A's id is still A's
  assert.ok(evB2.some((e) => e.type === 'error'), 'another visitor\'s Apply id is refused');
  assert.equal(fs.readFileSync(fileA, 'utf8'), PAGE);
});

test('GPT review r1: no guest edit beside a main-chat app build (it may rewrite the same app)', async () => {
  const { guestEditOf } = await import('../lib/demo-app-edit.mjs');
  const { BUILD_MESSAGES } = await import('../lib/demo-build-job.mjs');
  const v = await visit('198.51.100.25'); seedApp(v);
  const user = { id: v.uid, role: 'member', workspace: findWs(v) };
  assert.throws(() => guestEditOf({ user, app: 'calendar-planner', message: ASK, convoId: 'c1', building: true }), (e) => e.status === 409 && e.message === BUILD_MESSAGES.busy);
  assert.equal(guestEditOf({ user, app: 'calendar-planner', message: ASK, convoId: 'c1' }).slug, 'calendar-planner');
  assert.equal(guestEditOf({ user, app: 'no-such-app', message: ASK, convoId: 'c1', building: true }), null, 'not their app: the no-write lane, nothing to lock');
});

const req = (v, p) => fetch(`http://127.0.0.1:${demo.port}${p}`, { headers: { 'cf-connecting-ip': '198.51.100.9', authorization: `Bearer ${v.token}` } });
test('GPT review r2: a page that is the same once the demo\'s own additions are in is no change (no write, no Undo step)', async () => {
  const v = await visit('198.51.100.26'); const file = seedApp(v);
  const shaped = withOwnPolicy(ensureAskAi(PAGE, 'Calendar Planner')); fs.writeFileSync(file, shaped);
  for (const m of ['same', 'verbatim']) {   // the bare page, and the stored page echoed whole (GPT review r3)
    mode = 'plan'; const ev1 = await chat(v, { message: ASK });
    mode = m; const ev2 = await chat(v, { message: confirmOf(ev1).message, convoId: ev1.find((e) => e.type === 'convo').id });
    assert.ok(done(ev2).text.includes(SAME_PAGE), m);
    assert.equal(ev2.find((e) => e.type === 'app-edit').applied, false);
    assert.equal(fs.readFileSync(file, 'utf8'), shaped);
  }
  const evU = await chat(v, { message: 'undo' });
  assert.equal(evU.find((e) => e.type === 'app-edit').undone, undefined, 'no Undo step was made');
  mode = 'plan';
});

const quota = (v) => { const c = JSON.parse(fs.readFileSync(path.join(demo.root, 'demo-quota.json'), 'utf8')).counts; return Object.fromEntries(Object.entries(c).filter(([k]) => k.includes(v.uid))); };
test('an ordinary question in the guest\'s own app chat gets the web search step, each call charged', async () => {
  const v = await visit('198.51.100.28'); const file = seedApp(v); mode = 'search'; const was = searches;
  const ev = await chat(v, { message: 'what is the weather today?' });
  assert.equal(searches, was + 1, 'the search endpoint was really called');
  assert.ok(ev.some((e) => e.type === 'status'), 'the search step is said');
  const t = done(ev).text;
  assert.ok(t.includes('The weather answer from search.') && t.includes('https://weather.example/today') && !t.includes(SEARCH_MARKER), t);
  assert.equal(t.split('weather.example/today').length, 2, 'the sources footer is stored once');
  assert.equal(ev.filter((e) => e.type === 'delta').map((e) => e.text).join('').split('weather.example/today').length, 2, 'and streamed once');
  const q = quota(v);
  assert.equal(q[`user:${v.uid}`], 2, `the chat call and the answer call are both charged: ${JSON.stringify(q)}`);
  assert.ok(Object.entries(q).some(([k, n]) => k !== `user:${v.uid}` && n === 1), `the search is charged: ${JSON.stringify(q)}`);
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE);
  mode = 'plan';
});

test('GPT review: a plan given after a search keeps its Apply button', async () => {
  const v = await visit('198.51.100.30'); seedApp(v); mode = 'search-plan';
  const ev = await chat(v, { message: 'show the weather in the header' });
  assert.equal(confirmOf(ev) && confirmOf(ev).label, APPLY_LABEL, JSON.stringify(ev));
  assert.ok(!done(ev).text.includes(PLAN_MARKER));
  mode = 'plan';
});

test('GPT review: an answer that is only another search marker is a failed turn, never an empty success', async () => {
  const v = await visit('198.51.100.31'); seedApp(v); mode = 'search-empty';
  const ev = await chat(v, { message: 'what is the weather today?' });
  assert.ok(!done(ev) || done(ev).ok === false, JSON.stringify(ev));
  assert.ok(ev.some((e) => e.type === 'error'), 'the failure is said');
  mode = 'plan';
  const ev1 = await chat(v, { message: ASK });
  const convoId = ev1.find((e) => e.type === 'convo').id;
  assert.ok(confirmOf(ev1));
  mode = 'search-apply-only';
  const ev2 = await chat(v, { message: 'show the weather', convoId });
  assert.ok(!confirmOf(ev2) && ev2.some((e) => e.type === 'error'), `a bare Apply marker after a search offers no Apply: ${JSON.stringify(ev2)}`);
  const ev3 = await chat(v, { message: 'yes', convoId });
  assert.ok(!ev3.some((e) => e.type === 'app-edit' && e.applied), 'a later yes never applies the superseded plan');
  mode = 'plan';
});

test('GPT review: a rewrite the final checks roll back is a failed turn, not a saved success', async () => {
  const v = await visit('198.51.100.32'); const file = seedApp(v); mode = 'plan';
  const ev1 = await chat(v, { message: ASK });
  const convoId = ev1.find((e) => e.type === 'convo').id;
  nextExtra = '<script>function ( {</script>';
  const ev2 = await chat(v, { message: confirmOf(ev1).message, convoId });
  const ed = ev2.find((e) => e.type === 'app-edit');
  assert.ok(ed && ed.changed && !ed.applied, JSON.stringify(ev2));
  assert.equal(done(ev2).ok, false);
  const saved = await (await req(v, `/api/convos/${convoId}`)).json();
  assert.equal(saved.messages[saved.messages.length - 1].failed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE, 'rolled back');
  nextExtra = ''; mode = 'plan';
});

test('a rewrite that fails both attempts is a failed turn, not a saved success', async () => {
  const v = await visit('198.51.100.29'); seedApp(v); mode = 'plan';
  const ev1 = await chat(v, { message: ASK });
  const convoId = ev1.find((e) => e.type === 'convo').id;
  mode = 'bad';
  const ev2 = await chat(v, { message: confirmOf(ev1).message, convoId });
  assert.equal(done(ev2).ok, false);
  const saved = await (await req(v, `/api/convos/${convoId}`)).json();
  assert.equal(saved.messages[saved.messages.length - 1].failed, true, 'saved as failed, so later turns do not see it as an answer');
  mode = 'plan';
});

test('GPT review r2: a main-chat rewrite drops the app-chat Undo history, so "undo" never steps back past it', async () => {
  const v = await visit('198.51.100.27'); const file = seedApp(v);
  fs.writeFileSync(path.join(path.dirname(file), 'meta.json'), '{"title":"Calendar Planner","madeBy":"demo"}');
  mode = 'plan'; nextExtra = '<nav id="views"></nav>';
  const ev1 = await chat(v, { message: ASK });
  await chat(v, { message: confirmOf(ev1).message, convoId: ev1.find((e) => e.type === 'convo').id });
  assert.ok(fs.existsSync(path.join(findWs(v), '.app-versions', 'calendar-planner')), 'the app chat left an Undo step');
  mode = 'marker'; nextExtra = '<p id="rebuilt"></p>';
  const evM = await chat(v, { message: 'make the calendar planner title red', app: undefined });
  assert.ok(evM.some((e) => e.type === 'build'), 'the main chat started a rewrite');
  const job = await waitBuilt((p) => req(v, p), v);
  assert.equal(job.status, 'done');
  assert.ok(fs.readFileSync(file, 'utf8').includes('id="rebuilt"'));
  assert.ok(!fs.existsSync(path.join(findWs(v), '.app-versions', 'calendar-planner')), 'the old Undo steps are gone');
  mode = 'plan';
  const evU = await chat(v, { message: 'undo' });
  assert.equal(evU.find((e) => e.type === 'app-edit').undone, undefined);
  assert.ok(fs.readFileSync(file, 'utf8').includes('id="rebuilt"'), 'the rewrite stays');
});
