# ADR 0047 — 分享 · Share an app by link

Status: accepted (2026-11-26)

## Decision
Anyone — the owner on their node, or any signed-in demo visitor — can tap ⋯ → 分享 · Share in an open app
and get an unguessable link `try.superelf.app/s/<id>`. Whoever opens it signs in on the demo and gets
their OWN copy of the app in their own demo workspace (own data). Nothing goes to GitHub, no CI.

## How
- Snapshot on the demo only: `<root>/app-shares/<id>/`, page code only (Publish's collector:
  no `data/`, no links, code kinds only). Re-sharing the same app keeps the id; old snapshots move to
  `.versions/<id>/`. Existing copies are never touched. Index: `app-shares/index.json`.
- Ids: 128 random bits, base64url (22 chars). Unknown and taken-down ids are the same 404.
- Privacy: Publish's scan (lib/publish/scan.mjs). Owner node: strict terms, fail closed. Demo: generic
  rules + PII only (it holds no owner terms). A demo user is told the rule and line, never the matched text.
- Owner node → demo: `POST /api/share/ingest`, HMAC-SHA256 over ts, nonce and the body's hash with
  config `share_ingest_secret` (both nodes, read at use time, never in the repo). 300 s skew, nonces
  refused twice (in memory: a restart inside the window could accept one replay, which only re-shares
  the same snapshot). The demo re-checks paths and re-scans. No secret: ingest is a 404 and Share says
  「未配置分享通道 · Share channel not set up」.
- Limits, config `shares` (use time): `per_day` 10, `max_mb` 2, `joins_per_link` 50,
  `exempt_per_creator_per_day` 30, `demo_url`.
- New-visitor cap: the link page sets an httpOnly `superelf_share` cookie (1 h). A genuinely new
  visitor with a live link (under `joins_per_link` joins; creator under the daily exemption) skips
  ONLY the per-network new-visitor count. Sessions, AI, build and disk caps all still apply.
- Email: owner node only (AgentMail), fixed bilingual text + link. The demo has no AgentMail: Copy
  only, said in the sheet.
- Admin: Demo admin → 分享 · Shares: who made it, who joined, used it?, 下架 · Take down.
- Demo users still never publish to GitHub: nothing here talks to GitHub; their Publish stays refused.

## Owner step (once)
`openssl rand -hex 32`, then put it as `"share_ingest_secret"` in both config.json files (private node
and demo container). No restart.
