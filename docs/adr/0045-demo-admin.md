# ADR 0045: Demo admin and usage counts · 演示管理与使用统计

Date: 2026-11-26. Status: accepted.

## Context
The owner asked to see who signed in to the public demo and which apps they use, to improve the apps.
The demo stored no email, no per-app activity and no history (quota counters reset daily).

## Decision
- Count, never content: per UTC day, per visitor and app slug, opens / AI calls / builds / edits, and
  visits per network short hash, in `<root>/demo-usage/YYYY-MM-DD.json`, kept `usage_retention_days`.
- Keep a signed-in visitor's sign-in email and name in `demo-users.json`, said in the sign-in popover.
- Gate on the demo itself: a verified Supabase token whose email is in `demo.admin_emails` (config,
  read at use time). Anyone else gets 404.
- Not on the private node: reading demo data from there needs a new cross-host channel and secrets.

## Consequences
- The demo now holds emails; Delete my account removes them and the visitor's usage rows.
- App opens are counted for the app's own visitor (demo apps live in each visitor's workspace); a
  reopen counts again after a minute. "AI" counts visitor turns, not model calls inside a build. An app's Ask AI has no app name (the broker does not send one), so it counts toward the visitor's AI total only. Reset names the exact salted hash; the 8-hex prefix is display only.
