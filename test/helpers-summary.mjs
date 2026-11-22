// The ONE loader (R3) of PASummaryRefs (web/summary-refs.inline.html) and PASummaryTitle
// (web/summary-title.inline.html) for the summary suites: the shipped scripts evaluated on the test's own
// window, as the page does before drawer-summary's script (drawer-summary carries both markers above its
// own <script>). `doc` is the test's document stand-in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REFS_HTML = fs.readFileSync(path.join(ROOT, 'web', 'summary-refs.inline.html'), 'utf8');
const i0 = REFS_HTML.indexOf('<script id="psr-script">');
export const REFS_SRC = REFS_HTML.slice(REFS_HTML.indexOf('>', i0) + 1, REFS_HTML.indexOf('</script>', i0));
export const TITLE_HTML = fs.readFileSync(path.join(ROOT, 'web', 'summary-title.inline.html'), 'utf8');
const t0 = TITLE_HTML.indexOf('<script id="pst-script">');
export const TITLE_SRC = TITLE_HTML.slice(TITLE_HTML.indexOf('>', t0) + 1, TITLE_HTML.indexOf('</script>', t0));
export function loadTitle(win = {}) {
  // eslint-disable-next-line no-new-func
  new Function('window', TITLE_SRC)(win);
  return win.PASummaryTitle;
}
export function loadRefs(win = {}, doc = { createElement: () => ({}) }) {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', REFS_SRC)(win, doc);
  loadTitle(win);
  return win.PASummaryRefs;
}
// PASummaryImages (web/summary-images.inline.html) and PASummaryFollowup (web/summary-followup.inline.html),
// the two parts drawer-summary carries the markers of after the title's (note-features.md I): the shipped
// scripts evaluated on the test's window, the same way as the refs and the title.
export const IMAGES_HTML = fs.readFileSync(path.join(ROOT, 'web', 'summary-images.inline.html'), 'utf8');
const m0 = IMAGES_HTML.indexOf('<script id="psi-script">');
export const IMAGES_SRC = IMAGES_HTML.slice(IMAGES_HTML.indexOf('>', m0) + 1, IMAGES_HTML.indexOf('</script>', m0));
export const FOLLOWUP_HTML = fs.readFileSync(path.join(ROOT, 'web', 'summary-followup.inline.html'), 'utf8');
const f0 = FOLLOWUP_HTML.indexOf('<script id="psf-script">');
export const FOLLOWUP_SRC = FOLLOWUP_HTML.slice(FOLLOWUP_HTML.indexOf('>', f0) + 1, FOLLOWUP_HTML.indexOf('</script>', f0));
export function loadImages(win = {}) {
  // eslint-disable-next-line no-new-func
  new Function('window', IMAGES_SRC)(win);
  return win.PASummaryImages;
}
export function loadFollowup(win = {}, doc = { createElement: () => ({}) }) {
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', FOLLOWUP_SRC)(win, doc);
  return win.PASummaryFollowup;
}
