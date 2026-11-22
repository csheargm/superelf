// GPT review 2026-11-21 (rounds 7-8): PAChat open() tells a caller when its open was superseded,
// a same-key open waits for the in-flight load, and a history replay never appends after a newer load.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const S = fs.readFileSync(new URL('../web/chat-ui.inline.html', import.meta.url), 'utf8');
const body = S.slice(S.indexOf('async function openNow(k){'), S.indexOf('\n    }\n', S.indexOf('async function openNow(k){')));
test('every superseded exit of openNow() resolves false', () => {
  assert.doesNotMatch(body, /if\(my!==_loadSeq\) return;/);
  assert.ok((body.match(/if\(my!==_loadSeq\) return false;/g) || []).length >= 5);
});
test('a same-key open returns the in-flight open, not an early undefined', () => {
  assert.match(S, /if\(k===loadedKey\)\{ const c=_closeN; return Promise\.resolve\(_openP\)\.then\(r=>r===false\|\|_closeN!==c\?false:r\); \}/);
  assert.match(S, /const p=\(_openP=openNow\(k\)\); return p\.then\(r=>r===false\|\|_closeN!==c\?false:r\);/);
  assert.match(S, /drawer\.close\(\); _closeN\+\+;/);
});
test('the full-screen wrapper passes open()\'s result through', () => {
  assert.match(S, /open:\(k\)=>\{ show\(\); return api\.open\(k\); \}/);
});
test('both history replays re-check the token after the attachment await', () => {
  assert.equal((S.match(/const im=await attImgs\(mm\.attachments\); if\(my!==_loadSeq\) return false; const me=addMsg\('me',ct,im\);/g) || []).length, 2);
  assert.doesNotMatch(S, /addMsg\('me',ct, await attImgs/);
});
test('every app that awaits a chat open stops when it resolves false (no send into another thread)', () => {
  for (const p of ['workspace/apps/bible', 'workspace.example/apps/bible', 'workspace/apps/notes', 'workspace.example/apps/notes', 'shared-apps/bible', 'shared-apps/notes']) {
    const src = fs.readFileSync(new URL(`../${p}/index.html`, import.meta.url), 'utf8');
    const lines = src.split('\n').filter((l) => /await [A-Za-z]*[cC]hat\.open\(/.test(l));
    assert.ok(lines.length > 0, p);
    for (const l of lines) assert.match(l, /===false|opened=await/, `${p}: ${l.trim().slice(0, 80)}`);
  }
});
test('GPT round 13: replays recheck after addAI; boot Draw waits on a live load; Notes asks stop when the note changed', () => {
  assert.equal((S.match(/const ae=await addAI\(mm\.text\); if\(my!==_loadSeq\) return false;/g) || []).length, 2);
  for (const p of ['workspace/apps/bible', 'workspace.example/apps/bible', 'shared-apps/bible']) {
    const src = fs.readFileSync(new URL(`../${p}/index.html`, import.meta.url), 'utf8');
    assert.match(src, /load\(\)\.then\(ok=>\{ _booted=true; if\(ok!==false&&_openDrawOnLoad\)\{/, p);
  }
  for (const p of ['workspace/apps/notes', 'workspace.example/apps/notes', 'shared-apps/notes']) {
    const src = fs.readFileSync(new URL(`../${p}/index.html`, import.meta.url), 'utf8');
    assert.match(src, /===false\|\|\(?!?s?c?o?p?e?&?&?chatScope\(\)!==s\)?\) return false;/, p);
  }
});
test('GPT round 16: a turn that finishes after another thread opened saves its id to its own scope but never adopts it', () => {
  assert.match(S, /const k=key, myLoad=_loadSeq;/);
  assert.match(S, /setCid\(k,ev\.id\); if\(myLoad===_loadSeq\|\|key===k\)\{ curConvo=ev\.id; _sel=ev\.id; \}/);
  assert.match(S, /if\(!cid&&\(myLoad===_loadSeq\|\|key===k\)\) setTitle\(/);
});
