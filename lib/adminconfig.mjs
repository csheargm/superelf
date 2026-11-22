// Node settings（节点设置）core for GET/PUT /api/admin/config — a WHITELISTED
// view of config.json, never the raw file.
//
// Contract:
//  - SECRETS ARE WRITE-ONLY: a secret's value NEVER leaves the server. The
//    view carries only status SET/empty, and the `value` property is attached
//    STRUCTURALLY only to kind 'value' rows (test/adminconfig.test.mjs proves
//    the whole serialized view contains no secret value even when SET).
//  - Every write is validated per field and lands via the atomic writeJsonFile.
//  - DELIBERATELY EXCLUDED — file-only, edited by hand + restart, because
//    identity/infra changes deserve the file, not a settings box:
//      web_token — the node's bootstrap credential; rotating it from a web
//                  form could lock the owner out of the session doing it;
//      users[]   — identities and password hashes; managed via /api/admin/users
//                  member by member, never as raw JSON through an input;
//      web_port (ports) — a typo'd port bricks the node for every remote
//                  device, including the very UI that made the change.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile, baseUrlOk } from './webutil.mjs';
import { validatePreapprovedTypes } from './actions.mjs';

const bad = (msg) => { throw new Error(msg); };
// A secret is an opaque credential: sane length, no whitespace or controls.
const secretOk = (v) => typeof v === 'string' && v.length >= 4 && v.length <= 512 && !/[\s\u0000-\u001f]/.test(v);

// validate(value, cfg) returns the normalized value to store or throws a
// bilingual error. `boot: true` = web.mjs captures the field at load, so a
// change applies only after Apply & restart（重启后生效）; boot:false fields
// are not captured at boot (read fresh where they are used).
// Both base URLs: http(s)://host[:port], the trailing slash dropped (the ONE gate, baseUrlOk).
const baseUrlField = (v) => (baseUrlOk(v) ? v.replace(/\/+$/, '') : bad('Invalid base URL — http(s)://host[:port], no query · 基址无效（需 http(s)://主机[:端口]，不带查询参数）'));
export const CONFIG_FIELDS = [
  { key: 'tavily_key', kind: 'secret', boot: true, label: 'Tavily search key · 搜索密钥' },
  { key: 'exa_key', kind: 'secret', boot: true, label: 'Exa search key · Exa 密钥' },
  { key: 'firecrawl_key', kind: 'secret', boot: true, label: 'Firecrawl key · 网页抓取密钥' },
  { key: 'agentmail_key', kind: 'secret', boot: true, label: 'AgentMail key · 邮件通道密钥' },
  { key: 'google_client_id', kind: 'secret', boot: false, label: 'Google client id · 客户端 ID' },
  { key: 'google_client_secret', kind: 'secret', boot: false, label: 'Google client secret · 客户端密钥' },
  { key: 'max_concurrent', kind: 'value', boot: true, label: 'Max concurrent requests · 最大并发数',
    validate: (v) => { const n = parseInt(v, 10); if (isNaN(n) || n < 1 || n > 20) bad('Must be 1–20 · 需为 1 到 20 的整数'); return n; } },
  // Base of URLs handed to OTHER devices (the health-setup QR). Empty =
  // derive from the request Host; SET wins (a localhost-opened profile
  // otherwise QR-encodes an URL the phone cannot reach). ONE gate with the
  // boot check (lib/config.mjs) — baseUrlOk in lib/webutil.mjs.
  { key: 'public_base_url', kind: 'value', boot: true, label: 'Public base URL (QR/links) · 对外访问基址', validate: baseUrlField },
  // The node's name on the home network, for the shell's offline fallback (lib/local-origin.mjs,
  // docs/plans/offline-first.md §6). Read at use time: no restart.
  { key: 'local_origin', kind: 'value', boot: false, label: 'Home-network origin (offline fallback) · 家中网络地址（离线回退）', validate: baseUrlField },
  { key: 'health_llm', kind: 'value', boot: true, label: 'Health digest model · 健康简报模型',
    validate: (v, cfg) => {
      const lane = ((cfg && cfg.chat_models) || []).find((mm) => mm.id === v);
      if (!lane) bad(`Unknown model id · 未知模型（${((cfg && cfg.chat_models) || []).map((mm) => mm.id).join(', ')}）`);
      if (lane.provider !== 'ollama') bad('health_llm must be an ollama lane · 需为 ollama 模型');
      return v;
    } },
  // The claude CLI's --model VALUE (the cfg.assess_summarizer contract in
  // lib/config.mjs), not a chat_models id — shape-checked only.
  { key: 'assess_summarizer', kind: 'value', boot: true, label: 'Verify summarizer model · 校验汇总模型',
    validate: (v) => (/^[A-Za-z0-9][\w.:-]{0,63}$/.test(v) ? v : bad('Invalid model name · 模型名无效')) },
  // Same loader gate as boot (lib/actions.mjs): unknown types and ANY
  // outward-facing type are refused — never writable from the UI either.
  { key: 'preapproved_action_types', kind: 'value', boot: true, label: 'Pre-approved action types · 预批准类型',
    validate: (v) => validatePreapprovedTypes(Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean)) },
];
const byKey = new Map(CONFIG_FIELDS.map((f) => [f.key, f]));

const isSet = (v) => !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length));
// A /PASTE/ placeholder (config.example.json style) is NOT a configured secret
// — same semantics as the loader's researchEnabled / agentmailEnabled checks.
const fieldSet = (f, v) => isSet(v) && !(f.kind === 'secret' && /PASTE/.test(String(v)));

// The GET view. Structural no-leak rule: `value` exists ONLY on kind 'value'
// rows — a secret row never carries the property at all, set or not.
export function adminConfigView(raw, cfg) {
  return CONFIG_FIELDS.map((f) => {
    const row = { key: f.key, kind: f.kind, label: f.label, boot: f.boot, status: fieldSet(f, raw[f.key]) ? 'SET' : 'empty' };
    if (f.kind === 'value' && isSet(raw[f.key])) row.value = raw[f.key];
    return row;
  });
}

// One validated write. Blank/empty = CLEAR (the key is deleted — loaders then
// re-apply their defaults). config.json is read FRESH and written via the
// atomic writeJsonFile, so a concurrent hand edit of another key is never
// clobbered by a stale snapshot. Throws on unknown keys and bad values —
// the route reports the message; it must audit the KEY NAME ONLY, never values.
export function applyConfigWrite(root, key, value, cfg) {
  const f = byKey.get(key) || bad('Unknown or non-editable key · 不可编辑的配置项');
  const file = path.join(root, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const clear = value === '' || value === null || value === undefined || (Array.isArray(value) && !value.length);
  if (clear) delete raw[key];
  else if (f.kind === 'secret') raw[key] = secretOk(value) ? value : bad('Secret looks invalid (4–512 chars, no spaces) · 密钥格式无效');
  else raw[key] = f.validate(typeof value === 'string' ? value.trim() : value, cfg);
  writeJsonFile(file, raw);
  return { key, status: fieldSet(f, raw[key]) ? 'SET' : 'empty' }; // same SET semantics as the view
}
