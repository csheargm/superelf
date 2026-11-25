// Saved pictures · 保存的图片信纸 (web/stationery-ui.inline.html store + web/stationery-picker.inline.html cell ✕)
//
// A photo used as stationery is KEPT in templates/pictures.json so every note lists it, and can be deleted.
// Pinned against the shipped code: save lists it (after its bytes arrive), a reload agrees, delete unlists it,
// a list we could not read is never written over, a bad id is refused, and the id rule matches PANote's
// notebook stationery rule (R3: the two copies must agree).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STN_HTML, loadStationery, tick } from './helpers-stationery.mjs';

const PIC = 'uploads/1_photo.jpg';
const URL_OK = 'data:image/jpeg;base64,AAAA';
const memIo = (files = {}, failRead = null) => ({ files, writes: [],
  read: async (p) => (p === failRead ? { status: 'failed', error: 'boom' }
    : p in files ? { status: 'loaded', data: JSON.parse(files[p]) } : { status: 'absent', data: null }),
  write: async function (p, t) { this.writes.push(p); files[p] = t; return { ok: true }; } });
const pics = (S) => S.list().filter((t) => t.source === 'picture').map((t) => [t.id, t.name]);
const withPics = () => { const S = loadStationery(); S.pictures(async () => URL_OK); return S; };

test('savePicture lists the picture for every note; a reload agrees; deletePicture unlists it', async () => {
  const S = withPics(); const io = memIo(); const st = S.store(io);
  assert.deepEqual(await st.savePicture({ id: PIC, name: 'Picture 1' }), { ok: true });
  assert.deepEqual(pics(S), [[PIC, 'Picture 1']]);
  assert.deepEqual(JSON.parse(io.files['templates/pictures.json']), { v: 1, items: [{ id: PIC, name: 'Picture 1' }] });
  const S2 = withPics(); assert.equal((await S2.store(io).loadMine()).ok, true); await tick(); await tick();
  assert.deepEqual(pics(S2), [[PIC, 'Picture 1']], 'a reload lists it');
  assert.deepEqual(await st.deletePicture(PIC), { ok: true });
  assert.deepEqual(pics(S), [], 'gone from the list');
  assert.deepEqual(JSON.parse(io.files['templates/pictures.json']).items, []);
  assert.equal(S.has({ id: PIC, source: 'picture' }), true, 'a note that uses it still draws it');
});
test('saving twice keeps one entry; a bad id is refused and nothing is written', async () => {
  const S = withPics(); const io = memIo(); const st = S.store(io);
  await st.savePicture({ id: PIC, name: 'a' }); await st.savePicture({ id: PIC, name: 'b' });
  assert.deepEqual(pics(S), [[PIC, 'b']]);
  const n = io.writes.length;
  for (const id of ['a b', 'a\nb', '', null, 'x'.repeat(201)]) assert.equal((await st.savePicture({ id, name: 'x' })).ok, false, String(id));
  assert.equal(io.writes.length, n);
});
test('a pictures list that could not be read is never written over; loadMine reports it', async () => {
  const S = withPics(); const io = memIo({}, 'templates/pictures.json'); const st = S.store(io);
  const m = await st.loadMine(); assert.equal(m.ok, false); assert.match(m.error, /pictures: boom/);
  assert.equal((await st.savePicture({ id: PIC, name: 'x' })).ok, false);
  assert.equal((await st.deletePicture(PIC)).ok, false);
  assert.equal(io.writes.length, 0);
});
test('a refused write is reported and the picture is not listed', async () => {
  const S = withPics(); const io = memIo(); io.write = async () => ({ ok: false, error: 'disk full' });
  assert.deepEqual(await S.store(io).savePicture({ id: PIC, name: 'x' }), { ok: false, error: 'disk full' });
  assert.deepEqual(pics(S), []);
});
test('R3: the saved-picture id rule is the same as PANote\'s notebook stationery id rule', () => {
  const NOTE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
  const rule = /const PIC_ID=(\/\^\[[^\n]*?\$\/);/.exec(STN_HTML)[1];
  assert.ok(NOTE.includes(`!${rule}.test(r.id)`), 'note-ui uses the same id regex');
});
