# Per-user hosting（每人一个实例）· from public demo to a real service

Status: plan, not started. Owner decision 2026-11-21: grow the public demo
into a service by giving **each user their own node** (per-user instance ·
每人一个实例), not one shared multi-user server (multi-tenant · 多租户).

## Why one node per user

- superelf is built for one owner per node. The walls (workspace isolation,
  confined lanes, app data under `data/<slug>/`) already keep one person's data
  in one place. A node per user reuses those walls instead of re-checking every
  data path for cross-user leaks.
- A bug in one node cannot show another user's notes.
- Cost: more memory per user. A free-tier VM (4 cores, 24 GB, arm64) holds
  a few dozen small nodes; past that, paid hosting.

## Domain names（域名）· superelf.app (Porkbun)

| Name | Use | Stage |
|---|---|---|
| `superelf.app` | front page (`site/`) | now |
| `try.superelf.app` | public demo: anonymous, capped, no lasting personal data | now |
| `<user>.superelf.app` | one user's own node | pilot onward |

The demo is called **try**, not **demo**, so the name still fits once real
users arrive: "try" stays the free sample, and real users get their own
address. `.app` is HTTPS-only (HSTS preload); every name needs a valid
certificate.

## Stages

0. **Owner's private node to a VM（私人节点上云）.** The owner's node
   moves off the Mac so it stays up while the Mac is used for development.
   - Same image as the demo, started in private (owner) mode, in its own
     container with its own data volume. No shared folder with the demo.
   - Reachable over Tailscale only: it listens on the VM's Tailscale address,
     has no public route, and is never behind `superelf.app` or the tunnel.
   - Nightly encrypted backup (the demo's backup timer, its own passphrase).
   - Move: final backup on the Mac → restore on the VM → check notes, chats
     and app data → switch phone and iPad to the VM's Tailscale address →
     keep the Mac node stopped as a fallback for two weeks.
   - The Mac becomes the development copy; updates reach the VM by the
     rebuild script, tested on the Mac first.
1. **Public demo (now).** `try.superelf.app`, the `feat/public-demo` work.
   Anonymous visitors, AI and disk caps, no promise to keep data.
2. **Invite-only pilot (10–20 people).** One container per user from the same
   image as the demo, each with:
   - its own data volume and its own nightly encrypted backup;
   - email sign-in (link + code), no shared accounts;
   - a per-user AI cap read from config (no restart to change it);
   - a "delete my data" action that removes the volume and its backups.
   A small router (Caddy or the Cloudflare tunnel) maps `<user>.superelf.app`
   to that user's container.
3. **Paid service, only if the pilot shows weekly use.** Payment (Stripe),
   privacy policy and terms, uptime alerts, a status page, automatic
   updates rolled out to one node first.

## Provisioning（开通）

One script, `ops/user/add-user.sh <name> <email>`:
create the volume → start the container from the demo image in user mode →
add the route → send the sign-in link. `remove-user.sh` reverses each step.
No hand edits on the VM.

## Risks

- **AI cost** is the main money risk: hard per-user caps from day one.
- **Data trust**: users' notes live on our server. Encrypted backups, a
  security review before each release, no admin reading of user data.
- **Owner time** (day job): everything automated; no per-user hand-holding.

## Not in scope

- One shared multi-user server.
- Public access to the private node: after stage 0 it lives on the VM, still
  reachable over Tailscale only, and is never routed through `superelf.app`.
