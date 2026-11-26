// The release time of the running version（运行版本的发布时间）for the Settings footer.
// tools/bump-version.mjs writes `time` (UTC ISO) into each new version-notes.json entry — the ONE
// source (R3). The server only hands it over; web/version-time.js formats it in the viewer's zone.
import fs from 'node:fs';
import path from 'node:path';

export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

// The `time` of version-notes.json's entry v<version>, or '' (an older release, or no notes file).
export function releaseTime(root, version) {
  let notes;
  try { notes = JSON.parse(fs.readFileSync(path.join(root, 'version-notes.json'), 'utf8')); }
  catch { return ''; }   // no or broken notes file: the footer falls back to the date — a version line must never fail the page
  const t = notes && notes[`v${version}`] && notes[`v${version}`].time;
  return ISO_UTC_RE.test(String(t || '')) ? t : '';
}
