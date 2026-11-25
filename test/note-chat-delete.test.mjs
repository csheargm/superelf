// Deleting a note's AI chat · 删除笔记的 AI 对话
//
// A note remembers its conversation (e.chat), and the drawer row shows ✨ when it has one. There
// was no way to remove it: deleting the note destroyed the handwriting too, and deleting the
// thread from the ☰ chat list left the note pointing at it. The row's ⋯ now offers the middle
// case — drop the conversation, keep the note.
//
// The dangerous part is not the deletion, it is the MENU. It was two fixed labels dispatched by
// POSITION, so inserting a conditional entry above "Delete 删除" renumbered it: on exactly the
// rows that show the new entry, picking it would have deleted the whole note. The menu is now
// built as a list of actions that carry their own behaviour, and that is what these tests pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, APP_SRC } from './helpers-app.mjs';

const NOTES = APP_SRC['notes (live)'];

// ── the menu, RUN ────────────────────────────────────────────────────────────────────────────
// Source-reading cannot tell "offers Delete AI chat" from "offers it and deletes the note".
function menuModule() {
  const src = /async function rowMenu\(id,anchor\)\{[\s\S]*?\n    \}/.exec(CHAT);
  assert.ok(src, 'rowMenu must be extractable');
  return (item, choose) => {
    const did = [];
    const it = Object.assign({ id: 'n1', title: 'New Note' }, item);
    let offered = null;
    const api = new Function('itemOf', 'pacSheet', 'pacPrompt', 'pacConfirm', 'host', 'refresh', `
      ${src[0]}
      return rowMenu;`)(
      () => it,
      async (_h, labels) => { offered = labels.map((l) => l.label); return choose(offered); },
      async () => 'renamed',
      async () => true,                               // the user confirms
      {},
      async () => { did.push('refresh'); },
    );
    return api('n1').then(() => ({ offered, did, it }));
  };
}

const withCalls = (extra) => {
  const did = [];
  return {
    did,
    item: Object.assign({
      onRename: async () => did.push('rename'),
      onDelete: async () => did.push('DELETED THE NOTE'),
    }, extra(did)),
  };
};

test('a note WITH a chat is offered the entry, and picking it deletes only the chat', async () => {
  const run = menuModule();
  const { did, item } = withCalls((d) => ({ onDeleteAi: async () => d.push('deleted the chat') }));
  const r = await run(item, (labels) => labels.findIndex((l) => /AI chat/.test(l)));
  assert.deepEqual(r.offered, ['Rename 重命名', 'Delete AI chat 删除 AI 对话', 'Delete 删除']);
  assert.ok(did.includes('deleted the chat'), 'the chat went');
  assert.ok(!did.includes('DELETED THE NOTE'), 'and the note did NOT — this is the whole scar');
});

test('"Delete 删除" still deletes the note when the AI entry sits above it', async () => {
  // The other half of the renumbering bug: the entry that moved must still do its own job.
  const run = menuModule();
  const { did, item } = withCalls((d) => ({ onDeleteAi: async () => d.push('deleted the chat') }));
  await run(item, (labels) => labels.indexOf('Delete 删除'));
  assert.ok(did.includes('DELETED THE NOTE'));
  assert.ok(!did.includes('deleted the chat'));
});

test('a note with NO chat is never offered it', async () => {
  // The ✨ badge and this entry read the same flag, so the menu cannot promise to delete a
  // conversation that is not there.
  const run = menuModule();
  const { did, item } = withCalls(() => ({}));
  const r = await run(item, (labels) => labels.indexOf('Delete 删除'));
  assert.deepEqual(r.offered, ['Rename 重命名', 'Delete 删除']);
  assert.ok(did.includes('DELETED THE NOTE'), 'and Delete is still where the user expects it');
});

test('dismissing the sheet does nothing at all', async () => {
  const run = menuModule();
  const { did, item } = withCalls((d) => ({ onDeleteAi: async () => d.push('deleted the chat') }));
  for (const dismissed of [null, undefined, -1]) {
    const r = await run(item, () => dismissed);
    assert.deepEqual(did, [], `pick=${String(dismissed)} must run nothing`);
    assert.ok(!r.did.includes('refresh'), 'and must not even redraw');
  }
});

test('a row whose only action is the chat still gets a ⋯', () => {
  const cond = /const menu=\(([^)]+)\)\?/.exec(CHAT);
  assert.ok(cond, 'the ⋯ visibility test must be findable');
  assert.match(cond[1], /onDeleteAi/, 'or the entry exists and cannot be reached');
});

// ── the wiring ───────────────────────────────────────────────────────────────────────────────
test('the badge and the menu entry are driven by the same fact', () => {
  // ai:true with no onDeleteAi is a lie in one direction; onDeleteAi on a row with no chat is a
  // lie in the other. listDrawer wires the handler only where the row says it has one.
  const line = /onDeleteAi:\(o\.onDeleteAi&&([^)]+)\)\?/.exec(CHAT);
  assert.ok(line, 'listDrawer must gate onDeleteAi');
  assert.equal(line[1], 'it.ai', 'gated on the SAME flag the ✨ badge renders from');
  assert.match(CHAT, /it\.ai\?'<span class="pac-lai"/, 'and that flag is what draws the badge');
});

test('there is ONE definition of deleting a conversation', () => {
  // The ☰ chat list has always deleted threads through this broker kind. A host that hand-rolled
  // a second postMessage would drift from it (R3).
  assert.match(CHAT, /deleteConvo:\(convoId\)=>req\(\{kind:'convo-delete',convoId\}\)/,
    'PAChat exposes it');
  const calls = CHAT.match(/kind:'convo-delete'/g) || [];
  assert.equal(calls.length, 2, `convo-delete is sent from the ☰ path and the shared helper only (found ${calls.length})`);
  assert.doesNotMatch(NOTES, /convo-delete/, 'the app must go through PAChat, not its own postMessage');
});

// ── the app's handler, RUN ───────────────────────────────────────────────────────────────────
function appHandler(reply) {
  const src = /onDeleteAi:async\(id\)=>\{[\s\S]*?\n  \},/.exec(NOTES);
  assert.ok(src, "the app's onDeleteAi must be extractable");
  const log = [];
  const entry = { id: 'n1', chat: 'c9' };
  const fn = new Function(
    'entryById', 'PAChat', 'paNotice', 'IDX_PATH', 'askData', 'railChat', 'fsChat', 'curId', 'syncAsk', 'syncDrawer',
    `return ({ ${src[0].replace(/,$/, '')} }).onDeleteAi;`)(
    () => entry,
    { deleteConvo: async () => { log.push('server delete'); return reply; } },
    (m) => log.push('notice: ' + m),
    'idx',
    { unbindConvo: () => { log.push('unbind'); delete entry.chat; } },
    { newChat: () => log.push('reset surface') },
    null,   // fsChat: no full-screen chat made (a wide screen)
    'n1',
    () => log.push('syncAsk'),
    () => log.push('syncDrawer'),
  );
  return { fn, log, entry };
}

test('the note releases its pointer only after the server confirms', async () => {
  const a = appHandler({ ok: true });
  await a.fn('n1');
  assert.deepEqual(a.log, ['server delete', 'unbind', 'reset surface', 'syncAsk', 'syncDrawer']);
  assert.equal(a.entry.chat, undefined, 'the note no longer claims a chat, so ✨ goes out');
});

test('a refused delete keeps the binding and says so', async () => {
  // Releasing first would leave a live thread with nothing pointing at it: gone from the note,
  // still on the server, and unreachable from anywhere.
  const b = appHandler({ ok: false, error: 'offline' });
  await b.fn('n1');
  assert.equal(b.entry.chat, 'c9', 'the note still points at its conversation');
  assert.ok(b.log.some((l) => l.startsWith('notice:')), 'and the user is told (R5)');
  assert.ok(b.log.some((l) => /offline/.test(l)), 'with the reason');
  assert.ok(!b.log.includes('unbind'), 'nothing was released');
});

test('the open chat surface is reset, not left showing a deleted thread', async () => {
  const c = appHandler({ ok: true });
  await c.fn('n1');
  assert.ok(c.log.indexOf('reset surface') > c.log.indexOf('unbind'),
    'the panel is cleared after the pointer is dropped, or it re-sends to a dead id');
});
