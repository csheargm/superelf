// Background app builds · 后台建应用 (demo). Owner 2026-11-21: "can I switch the UI … while the thing is
// working behind the scene". A "make me an app" chat turn no longer waits for the build: it starts ONE
// server-side job per visitor and answers at once. The job outlives the chat request (no client abort;
// each model call keeps the demo's own deadline), writes the app (lib/demo-app.mjs makeDemoApp), then
// leaves a done/failed note in the chat that asked. Its state is a file in the visitor's workspace
// root — outside apps/ and data/, so no app can write it — and GET BUILD_JOB_PATH reads it, so a
// reload or another tab sees it. A job that was 'building' when the node stopped is not in memory
// any more: the first read marks it failed (never stuck "building").
// Caps are charged as before: consumeAppBuild once by the caller, one AI call per build attempt.
import path from 'node:path';
import { writeJsonFile } from './atomicwrite.mjs';
import { readJsonState, FILE_OK, FILE_UNREADABLE } from './readjson.mjs';
import { makeDemoApp, appModelOf } from './demo-app.mjs';
import { dropAppHistory } from './app-edit.mjs';
import { consumeAiCall, demoLimit } from './demo-quota.mjs';
export { BUILD_JOB_PATH } from './demo.mjs';

export const BUILD_JOB_FILE = 'demo-build.json';
export const BUILD_MESSAGES = Object.freeze({
  busy: 'An app is already being built — wait for it to finish · 已有一个应用正在创建，请等它完成',
  interrupted: 'The build stopped because the demo restarted — please ask again · 演示重启，创建已中断，请重新提出',
  full: 'Too many apps are being built right now — please try again in a minute · 当前创建的应用过多，请稍后再试',
});
const ERROR_MAX = 300;

export const buildingText = (title) => `Building **${title}**… — you can switch apps or leave; it appears in your app list when done · `
  + `正在创建「${title}」…可以切换或离开，完成后会出现在应用列表中`;
export const doneText = (title, edited, link) => `Done · 完成 — ${edited ? 'updated' : 'created'} **${title}** · `
  + `${edited ? '已更新' : '已创建'}「${title}」: [Open · 打开](${link})`;
export const failedText = (why) => `⚠ The app was not built · 应用未创建: ${why}`;

// The shell's own link to an app: /#app=<slug> on the origin the visitor used (web/ demo build UI opens it in place).
export function appLink(headers, slug) {
  const host = String(headers.host || '');
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return `/#app=${slug}`;
  return `${/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https'}://${host}/#app=${slug}`;
}

// x: { d, disk, callModel, isBusy(id) } from lib/demo-routes.mjs; it calls flush(user) whenever a chat
// turn or rename of that visitor ends, so a note held back while one ran is written then.
export function makeBuildJobs(x) {
  const { d } = x;
  const running = new Map();   // visitor id → job, in memory only: what a restart forgets
  const pending = new Map();   // visitor id → ended job whose chat note waits for that visitor's turn to end
  const fileOf = (user) => path.join(user.workspace, BUILD_JOB_FILE);
  const save = (user, job) => writeJsonFile(fileOf(user), job);

  function read(user) {
    const r = readJsonState(fileOf(user));
    if (r.state === FILE_UNREADABLE) throw new Error(`the build status could not be read · 无法读取创建状态 (${r.error})`);
    if (r.state !== FILE_OK || !r.value || typeof r.value !== 'object') return null;
    const job = r.value;
    if (job.status === 'building' && !running.has(user.id)) {   // the node restarted under it
      const failed = { ...job, status: 'failed', error: BUILD_MESSAGES.interrupted, ended: Date.now() };
      save(user, failed);
      if (x.isBusy(user.id)) pending.set(user.id, failed); else note(user, failed);
      return failed;
    }
    return job;
  }

  // Refusals the caller checks BEFORE charging the build cap.
  const refusal = (user) => (running.has(user.id) ? BUILD_MESSAGES.busy
    : running.size >= demoLimit(d.cfg, 'parallel_chats') ? BUILD_MESSAGES.full : null);

  // Starts the job and returns its record at once; never throws after the record is saved.
  function start({ user, intent, lane, ip, convoId, link }) {
    read(user);   // an interrupted record is closed (and said in its chat) before this one replaces it
    const job = { id: d.newId(), status: 'building', title: intent.title || intent.edit || 'your app · 你的应用', convoId, started: Date.now() };
    save(user, job);
    running.set(user.id, job);
    run(user, job, { intent, lane, ip, link });
    return job;
  }

  async function run(user, job, c) {
    let end;
    try {
      const made = await makeDemoApp({ dir: path.join(user.workspace, 'apps'), intent: c.intent, contract: d.appContract,
        maxBytes: demoLimit(d.cfg, 'app_max_kb') * 1024, maxApps: demoLimit(d.cfg, 'apps_per_user'), ask: (m) => buildCall(user, c, m) });
      if (made.edited) dropAppHistory(user.workspace, made.slug);   // a main-chat rewrite: an app-chat Undo must never step back past it (GPT review r2, lib/demo-app-edit.mjs)
      end = { status: 'done', slug: made.slug, title: made.title, edited: made.edited, link: c.link(made.slug) };
    } catch (e) {
      end = { status: 'failed', error: String((e && e.message) || e).slice(0, ERROR_MAX) };
    }
    const done = { ...job, ...end, ended: Date.now() };
    if (x.isBusy(user.id)) pending.set(user.id, done);   // that turn's own save would drop the note: flush() settles it
    else settle(user, done);
  }

  // Note first, then the record: a shell that sees the job end always finds the note. Until then
  // the job still reads 'building' (and stays in `running`, so it is not taken for interrupted).
  function settle(user, done) {
    note(user, done);
    try { save(user, done); }
    catch (e) { d.audit('demo-build-state-failed', { who: user.id, error: e.message }); /* the note already tells the visitor; a later read then shows 'failed' (not running) */ }
    running.delete(user.id);
    d.audit('demo-build', { who: user.id, status: done.status });
  }

  // One build attempt = one AI call against the daily caps, as when it ran inside the chat turn.
  async function buildCall(user, c, messages) {
    const q = consumeAiCall({ cfg: d.cfg, store: d.store, userId: user.id, ip: c.ip });
    if (!q.ok) throw new Error(q.error);
    const full = x.disk(user);
    if (!full.ok) throw new Error(full.error);
    const text = await x.callModel(null, { ...c.lane, model: appModelOf(d.cfg, c.lane) }, messages, null, demoLimit(d.cfg, 'app_max_kb') * 2);
    const after = x.disk(user);   // again: a save beside this slow call may have filled the folder
    if (!after.ok) throw new Error(after.error);
    return text;
  }

  // The done/failed line in the chat that asked (load + save in one synchronous step, never while a turn or rename holds the chat).
  function note(user, job) {
    try {
      const r = job.convoId ? d.loadConvoState(user, job.convoId) : null;
      if (!r || r.state !== FILE_OK) return;   // the chat was deleted meanwhile: the shell's indicator still says it
      const text = job.status === 'done' ? doneText(job.title, job.edited, job.link) : failedText(job.error);
      r.value.messages.push(job.status === 'done' ? { role: 'md', text } : { role: 'md', text, failed: true });
      r.value.updated = Date.now();
      d.saveConvo(user, r.value);
    } catch (e) { d.audit('demo-build-note-failed', { who: user.id, error: e.message }); /* the indicator (job file) still shows the outcome */ }
  }

  function flush(user) {
    const job = pending.get(user.id);
    if (!job || x.isBusy(user.id)) return;
    pending.delete(user.id);
    if (running.get(user.id) && running.get(user.id).id === job.id) settle(user, job); else note(user, job);   // else: an interrupted record, already saved
  }

  return { read, start, refusal, flush, running: (id) => running.has(id), count: () => running.size };
}
