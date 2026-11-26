// The owner's real 2026-11-26 change, as a fake agent writes it: a version line on Home across three files
// (web/index.html new #hVer after the app grid, web/home-v2.js syncVer() from render(), web/home-v2.css .home-ver).
// Shared by the render test and the card e2e so both draw the same change (R3).
import fs from 'node:fs';
import path from 'node:path';

export const VERLINE_FILES = ['web/home-v2.css', 'web/home-v2.js', 'web/index.html'];
export const VERLINE_EDITS = {
  'web/index.html': ['<div class="grid" id="eApps"></div>', '<div class="grid" id="eApps"></div>\n    <p class="home-ver" id="hVer" hidden></p>'],
  'web/home-v2.js': ['  function setName(n){', "  function syncVer(){ const l=document.getElementById('ver-lbl'), el=document.getElementById('hVer'); if(!l||!el) return; const v=l.textContent.replace(/^管家 · /,'').trim(); el.textContent=v; el.hidden=!v; }\n  function setName(n){"],
  'web/home-v2.js#call': ['    syncHeader();\n    return lay;', '    syncHeader(); syncVer();\n    return lay;'],
};
export const VERLINE_CSS = '\n.home-ver{text-align:center;font-size:12px;color:var(--muted);margin:12px 0}\n';

export function writeVerLine(dir) {
  for (const [key, [from, to]] of Object.entries(VERLINE_EDITS)) {
    const f = path.join(dir, key.split('#')[0]), src = fs.readFileSync(f, 'utf8');
    if (!src.includes(from)) throw new Error(`version-line anchor gone from ${key}: update this helper`);
    fs.writeFileSync(f, src.replace(from, () => to));
  }
  fs.appendFileSync(path.join(dir, 'web', 'home-v2.css'), VERLINE_CSS);
}
