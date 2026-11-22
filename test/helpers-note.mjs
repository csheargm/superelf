// Shared fixtures for the note-search suites (R3: one record factory, one synthetic notebook shape).
// Synthetic only — never owner data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finishRecord } from '../lib/note-index.mjs';
import { INK_MIN_H } from '../lib/note-boxes.mjs';

export const stroke = { c: '#141414', w: 0.002, p: [[0.1, 0.2, 0.5]] };
export const nb = (html, updated = 1700000000000) => ({ v: 2, id: 'n', created: 1, updated, template: 'blank', bgColor: '#fff', pages: [{ id: 'p', created: 1, updated, strokes: [stroke], pageHtml: html, images: [] }] });
export const mkws = (prefix = 'pa-note-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const put = (ws, slug, rel, obj) => { const f = path.join(ws, 'data', slug, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
export const paths = (hits) => hits.map((h) => h.path + (h.scope ? '#' + h.scope : ''));
// A hand-built record in the live shape: what buildFileRecords emits (tags and idx derived by
// finishRecord). `src` may name ink/photo text; `need`/`done` default to "nothing owed"; `boxes` and
// `geo` (phase 3: the OCR lines and the page geometry that places them) default to none / one sheet.
export const rec = (path, scope, page, updated, typed, { ink = '', photo = '', labels = [], need = {}, done = {}, boxes = {}, geo = {} } = {}) => finishRecord({
  path, scope, page, updated, src: { typed, ink, photo }, tags: [], labels, boxes: { ink: [], photo: [], ...boxes }, geo: { ink: INK_MIN_H, imgs: [], ...geo },
  need: { ink: null, photo: null, ...need }, done: { ink: null, photo: null, ...done }, ocrError: {}, idx: null,
});
