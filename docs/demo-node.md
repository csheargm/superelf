# Public demo node（公开演示节点）· try.superelf.app

A **public demo（公开演示）** of superelf on a VM (Ubuntu 24.04, arm64), in Docker, reached
only through a **Cloudflare Tunnel（隧道）**. Visitors are anonymous; they get simple chat and the
apps from `workspace.example` — nothing else.

## What demo mode allows · 演示模式允许什么

- `config.json` `"demo": { "enabled": true, ... }` (or `"demo": true`) turns it on, read per request.
  The container also sets `SUPERELF_DEMO=1`, which forces demo mode on whatever `config.json` says.
- **Fail closed（默认拒绝）:** every route not on the allow-list in `lib/demo.mjs` answers 403. No
  sign-in, owner, admin, jobs, uploads, the owner's Tavily web search route, `/api/ask`, and **no Claude/Codex agent lane**:
  demo chat (`lib/demo-routes.mjs`) uses `provider: "ollama"` lanes only.
- Visitors: an anonymous id in an HttpOnly cookie, a `workspace-anon-…` folder each, listed in
  `demo-users.json` (never in `config.json`).
- **Quotas（配额）** (`lib/demo-quota.mjs`, all in `config.json` `"demo"`, read at use time):

| Key | Default | Over the cap |
|---|---|---|
| `ai_calls_per_user_per_day` | 30 | 429, EN + 中文 message |
| `ai_calls_per_ip_per_day` | 150 | 429 (IP = `cf-connecting-ip`, stored only as a salted hash; `x-forwarded-for` is never trusted; outside the container `cf-connecting-ip` counts only with `"behind_cloudflare": true`) |
| `sessions_per_ip_per_day` | 50 | 429 |
| `save_max_mb` | 2 | 413 for a larger save |
| `chat_timeout_s` | 120 | the reply stops with an error |
| `reply_max_kb` | 256 | the reply stops with an error |
| `parallel_saves` / `parallel_chats` | 8 / 16 | 503 busy (node-wide, in flight) |
| `searches_per_user_per_day` / `_per_ip_` | 200 / 600 | 429 (Bible search) |
| `new_users_per_ip_per_day` | 10 | 429 |
| `user_disk_mb` | 20 | 507 on chat and save |
| `total_disk_gb` | 0.5 (5 when unset) | 507; new visitors refused |
| `test_bypass_token` | unset (no bypass) | the owner's own checks · 自测: a request with header `x-superelf-test` equal to this (24+ chars) is not counted as a visit/new visitor, skips the per-network AI cap and is audited as `demo-test-visitor`; node and per-visitor caps still apply. Set only in the live `config.json`, never in a repo |
| `app_builds_per_user_per_day` / `_per_ip_` | 5 / 15 | the build stops with the EN + 中文 reason |
| `web_search_per_day` / `web_search_per_ip_per_day` | 10 / 50 | said in a status line; the answer comes without search |
| `ai_calls_node_per_day` | 3000 | 429 for everyone: the hosted-model cost ceiling |
| `admin_emails` | `[]` (no admin) | sign-in emails that see 演示管理 · Demo admin (below); compared ignoring case; never sent to the browser |
| `admin_subs` | unset | optional: Supabase user ids the admin must also match (an immutable pin beside the email) |
| `usage_retention_days` | 90 | days of usage rollups kept in `demo-usage/` (1–3650) |

Models, Ask AI in demo apps and web search: see `docs/demo-models.md`.

Days are UTC. Caps are checked before each write, so one write can cross a cap; the hard stop
is the data disk itself, a 1 GB ext4 image (`DEMO_DISK_GB`, default 1; the data plus room to stage a backup and a restore), so the host disk can never fill. The
container refuses to start unless that disk is mounted (marker `.superelf-demo-disk`).

## Sign-in · 登录 (lib/demo-auth.mjs, lib/demo-boot.mjs)

AI (chat, app building, Ask AI, web search) needs a scripturetolife.org account — the same Supabase
project (`demo.auth.supabase_url`). Signed out, a visitor still gets the shell and the sample apps.
- Sign-in: email → Supabase magic link (`/auth/v1/otp` with PKCE, `redirect_to` = this page); the
  returned `?code=` is exchanged only with the verifier this browser stored (no login CSRF); the
  session is kept in localStorage and refreshed before expiry.
- Server: `POST /api/demo/start` with the token in `x-demo-auth` verifies it against the project's
  JWKS (ES256/RS256 only — the project signs ES256, so the `/auth/v1/user` fallback for HS256 is not
  built and HS256 is refused), checks exp, aud (`authenticated`), iss (`<url>/auth/v1`) and refuses
  Supabase anonymous users, and maps the user to `sb-<sha256(sub)[:16]>` with its own workspace.
  Each node session is bound in memory to its latest token, re-verified on every chat turn.
- Quotas count per signed-in user; per-IP and node-wide caps stay. No email or sub is stored.
- Config, read at use time: `demo.auth = { supabase_url, supabase_anon_key, required }`;
  `required` defaults to true (no auth block = AI refused, fail closed).
- `demo.notice` (config text) shows under the chat box. `demo.blocked_users` (Supabase user ids
  or emails, read at use time): those users get 403 on every AI turn.
- "Delete my account · 删除账户" (signed-in only, `POST /api/demo/delete-account`, after a confirm):
  removes that user's workspace (apps, chats, app data), their quota rows and sessions, and signs
  out. The shared scripturetolife.org account is not touched.
- Anonymous visitors' earlier data is not migrated to a signed-in workspace (demo data is disposable).
- Owner: add the demo origin (https://try.superelf.app) to Supabase > Authentication > URL
  Configuration > Redirect URLs, and put the project's public anon key in `demo.auth.supabase_anon_key`.

## Waiting list · 等候名单 (lib/demo-waitlist.mjs)

Visitors who want their own private superelf leave an email (optional note) from the drawer row
"Want your own private superelf? · 想要自己的私人 superelf？", or from the front page's link to
`https://try.superelf.app/?join=1`, which opens the same form. `POST /api/waitlist` exists on demo
nodes only. Caps (`config.json` `"demo"`): `waitlist_per_ip_per_day` 5 (429), `waitlist_max_entries`
5000 (507). The same email twice is stored once; the reply is the same either way, and never
carries other entries. No email is sent.

**Privacy · 隐私:** stored in `waitlist.jsonl` in the data root (beside `demo-users.json`, mode 600,
outside every visitor workspace): one JSON line per entry, `{t, email, name, note}`. No IP, cookie
or visitor id. It is in the nightly backup like the rest of the data root. **Retention:** kept until
private hosting opens and each person is written to, then the file is deleted; any single entry is
removed on request.

- Read: `docker compose -p superelf-demo exec superelf cat /data/superelf/waitlist.jsonl`
  (run in `ops/demo/`; `/data/superelf` is the node folder, `entrypoint.sh`).
- Delete one entry: stop the node first, so no sign-up is appended while the file is rewritten
  (run in `ops/demo/`): `docker compose -p superelf-demo stop superelf`, then
  `docker compose -p superelf-demo run --rm --no-deps --entrypoint sh superelf -c "cd /data/superelf && grep -vF '\"email\":\"ann@example.org\"' waitlist.jsonl > waitlist.tmp; [ \$? -le 1 ] && chmod 600 waitlist.tmp && mv waitlist.tmp waitlist.jsonl"`
  (a fixed-string match on the whole stored value, emails lower-cased; the file is replaced only
  when grep succeeded), then `docker compose -p superelf-demo start superelf`. Delete
  all: the same, with `rm /data/superelf/waitlist.jsonl` as the command.
- Known limit: the form needs the demo shell, so a network over `new_users_per_ip_per_day` sees the
  quota message instead (docs/TODO.md).

## Demo admin · 演示管理 (lib/demo-admin.mjs, lib/demo-usage.mjs, ADR 0045)

- A visitor signed in by the email link (Supabase `amr` otp/magiclink, no phone claim) whose email is in `demo.admin_emails` gets ⋯ → 演示管理 · Demo admin: Today
  (visits, new visitors, networks by short hash, 清零 · Reset on a network at the cap), People (name,
  email, first/last visit, AI today vs cap, AI over 14 days, their apps), Apps (people, opens, AI,
  builds, edits), Waiting list, 14-day trend. Anyone else gets 404 from `/api/demo/admin/*`.
- Recorded: per UTC day, per visitor and app: opens (once a minute, real apps only), AI turns (a chat or Ask AI request, not each model call inside a build), builds, edits; visits and new visitors
  per network short hash (8 hex of the salted hash). Never message text, prompts, searches or IPs.
  The owner's test requests (`x-superelf-test`) are not counted.
- A signed-in visitor's sign-in email and account name are kept in `demo-users.json` (the sign-in
  popover says so). Delete my account removes them and every usage row of that visitor.
- Reset deletes only that network's `session:` and `new:` counters for today, audited as
  `demo-admin-reset`.

## Files · 文件 (`ops/demo/`)

`Dockerfile` (code only, whitelist in `Dockerfile.dockerignore`), `docker-compose.yml` (project
`superelf-demo`: `superelf` + `cloudflared`, **no published ports**, never 80/443/8448, never the
another project), `entrypoint.sh`, `config.demo.json` (seeded on first start), `.env.example`,
`rebuild-demo.sh`, `superelf-demo-backup.service` + `.timer`.

## Owner to-do · 主人需要做的事

1. **Domain（域名）:** `superelf.app` is registered at **Porkbun**. Add it as a site in Cloudflare
   (Free plan), then in Porkbun > Domain Management > `superelf.app` > Authoritative Nameservers
   replace Porkbun's nameservers with the two Cloudflare shows. Wait until Cloudflare says the site
   is Active (the tunnel needs Cloudflare DNS). The demo lives at `try.superelf.app`; the bare
   `superelf.app` is kept for the front page (`site/`), see `docs/plans/per-user-hosting.md`.
2. **Tunnel（隧道）:** Zero Trust > Networks > Tunnels > Create (cloudflared). Public hostname
   subdomain `try`, domain `superelf.app` (= `try.superelf.app`) → service `http://superelf:8787`. Copy the token.
   Keep SSL/TLS > Edge Certificates > **Always Use HTTPS** on (the visitor cookie is `Secure`;
   `.app` is HSTS-preloaded, so browsers use HTTPS anyway).
3. **On the VM:** `git clone https://github.com/csheargm/superelf ~/sandbox/superelf-demo`, then
   `cd ~/sandbox/superelf-demo/ops/demo && cp .env.example .env && chmod 600 .env`, and paste
   `TUNNEL_TOKEN=` and `OLLAMA_API_KEY=` (ollama.com > Settings > Keys) into `.env`.
   The models in `config.demo.json` `chat_models` must be names the ollama.com API serves
   (e.g. `gpt-oss:20b`; no `:cloud` suffix).
4. **Backup passphrase（备份密码）**, root-only file:
   `sudo install -d -m 700 /etc/superelf-demo && sudo sh -c '[ -e /etc/superelf-demo/backup-pass ] || (umask 377 && openssl rand -base64 24 > /etc/superelf-demo/backup-pass)'`
   (run twice, it keeps the existing key: a new key would make every earlier backup unreadable).
   Save the passphrase in your password manager — backups cannot be opened without it.
5. **rclone Google Drive（谷歌云盘）:** on a machine with a browser run `rclone config` (remote name
   `gdrive`), then copy its `rclone.conf` to the VM: `sudo install -d -m 700 /etc/superelf-demo/rclone`
   and `sudo install -m 600 rclone.conf /etc/superelf-demo/rclone/`. The folder must stay writable
   (rclone refreshes its token there).
6. **Start（启动）:** `ops/demo/rebuild-demo.sh` (add `--restore latest` to bring back the newest
   backup into an empty data disk).
7. **Nightly backup（夜间备份）:** edit `WorkingDirectory` in `ops/demo/superelf-demo-backup.service`
   if your user is not `ubuntu`, then
   `sudo cp ops/demo/superelf-demo-backup.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now superelf-demo-backup.timer`.
   Test once: `sudo systemctl start superelf-demo-backup.service && journalctl -u superelf-demo-backup -n 20`.

## Backup on Linux · Linux 备份

`backup.sh` on Linux reads the passphrase from `config.json` `"backup_pass_file"` (absolute path,
first line, must not be readable by group/other); macOS still uses the Keychain. `restore.sh` uses
`SUPERELF_BACKUP_PASS_FILE` when set. In the container both run in the `backup` service (root, the
passphrase mounted read-only at `/run/secrets/backup-pass`).

A restore that stops half-way leaves `data/superelf` non-empty: empty it with
`sudo find data/superelf -mindepth 1 -delete` (hidden files too) before retrying. Until a restore
finishes, `data/.restoring` exists and the nightly backup refuses to run.

## Not covered · 未包含

The owner's own node is not a demo node: never turn `"demo"` on there. Cloudflare WAF/rate rules
are optional extra protection in front of these caps.
