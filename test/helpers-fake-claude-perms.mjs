// A fake `claude` that keeps the REAL CLI's permission model (feedback: test-harness fidelity — a mock
// must replicate the guards of the system it stands for, or it hides the bug). Measured on CLI 2.1.327
// (lib/agent-origin.mjs appReadArgs / appJailArgs comments), it enforces from its own argv:
//   · `--tools=` → no tools at all: the model then PRINTS its calls as text (`<invoke name="Read">…`),
//     exactly what the owner saw live — so a no-tools lane fails here the way it failed there;
//   · `--tools Read,Glob,Grep` → only those; reads inside cwd, or under a Read(//abs/…) allow rule;
//   · `--permission-mode default` → a write needs an Edit(//abs/**) allow rule; deny rules win;
//   · `--dangerously-skip-permissions` → anything not denied.
// FAKE_PERMS_SRC is pasted into a fake's source; it defines perms(argv) → { read(f), write(f, text), text(s) }.
// write() refuses (returns false) exactly where the CLI would; text(s) streams s as the CLI's deltas.
export const FAKE_PERMS_SRC = String.raw`
function perms(argv) {
  const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path');
  const vals = (flag) => { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === flag) { for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('--'); j++) out.push(argv[j]); } return out; };
  const toolsEq = argv.find((a) => String(a).startsWith('--tools='));
  const tools = toolsEq !== undefined ? toolsEq.slice(8).split(',').filter(Boolean) : (argv.includes('--tools') ? vals('--tools').join(',').split(',').filter(Boolean) : null);
  const has = (t) => tools === null || tools.includes(t);
  const skip = argv.includes('--dangerously-skip-permissions');
  const allows = vals('--allowedTools'), denies = vals('--disallowedTools');
  const under = (abs, rule, tool) => { const m = new RegExp('^' + tool + '\\(/(/.*)\\)$').exec(rule); if (!m) return false; const r = m[1];
    if (r.endsWith('/**')) return abs.startsWith(r.slice(0, -2)); if (r.startsWith('/**/')) { const n = r.slice(4); return n === '.*' ? /(^|\/)\.[^/]*$/.test(abs) : n === '.*/**' ? /\/\.[^/]+\//.test(abs) : path.basename(abs) === n; } return abs === r; };
  const real = (f) => { const a = path.resolve(process.cwd(), f); try { return fs.realpathSync(a); } catch { try { return path.join(fs.realpathSync(path.dirname(a)), path.basename(a)); } catch { return a; } } };
  const cwd = fs.realpathSync(process.cwd());
  return {
    noTools: tools !== null && tools.length === 0,
    read(f) { const a = real(f); if (!has('Read')) return null; if (denies.some((d) => under(a, d, 'Read'))) return null;
      if (!skip && !(a === cwd || a.startsWith(cwd + '/')) && !allows.some((r) => under(a, r, 'Read'))) return null;
      try { return fs.readFileSync(a, 'utf8'); } catch { return null; } },
    write(f, text) { const a = real(f); if (!has('Edit') && !has('Write')) return false; if (denies.some((d) => under(a, d, 'Edit'))) return false;
      if (!skip && !allows.some((r) => under(a, r, 'Edit'))) return false; fs.writeFileSync(a, text); return true; },
    text(s) { for (const part of String(s).match(/[\s\S]{1,12}/g) || []) process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } }) + '\n'); },
  };
}
`;
