# Per-user hosting（每人一个实例）· from public demo to a real service

Status: plan, not started. Owner decision 2026-11-21: grow the public demo
into a service by giving **each household its own node** (per-user instance ·
每人一个实例), not one shared multi-user server (multi-tenant · 多租户).

Owner decision 2026-11-23, who gets what（谁用什么）:

| Who | Gets | Where |
|---|---|---|
| A single person（个人） | a kept demo account ("keep my notes"); demo caps still apply | `try.superelf.app` |
| A family（家庭） | its own node; the family admin adds members | `<name>.superelf.app` |
| The owner（站长） | the private node, Tailscale only | stage 0 VM |

## Why one node per family

- superelf is built for one owner per node. The walls (workspace isolation,
  confined lanes, app data under `data/<slug>/`) already keep one person's data
  in one place. A node per family reuses those walls instead of re-checking every
  data path for cross-user leaks.
- A bug in one node cannot show another family's notes.
- Cost: more memory per user. A free-tier VM (4 cores, 24 GB, arm64) holds
  a few dozen small nodes; past that, paid hosting.

## Domain names（域名）· superelf.app (Porkbun)

| Name | Use | Stage |
|---|---|---|
| `superelf.app` | front page (`site/`) | now |
| `try.superelf.app` | public demo: anonymous guests, plus single people with a kept account (capped) | now |
| `<name>.superelf.app` | one family's own node | pilot onward |

The demo is called **try**, not **demo**, so the name still fits once real
users arrive: "try" stays the free sample and the home of single people's
kept accounts; families get their own address. `.app` is HTTPS-only (HSTS preload); every name needs a valid
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
   Anonymous visitors, AI and disk caps. A single person who signs in with
   email and picks "keep my notes" keeps their data on the demo; the demo
   caps still apply, and they never get a node of their own.
2. **Invite-only family pilot (5–10 families).** One container per family
   from the same image as the demo, each with:
   - its own data volume and its own nightly encrypted backup;
   - email sign-in (link + code) for the family admin, who adds members;
   - a per-family AI cap read from config (no restart to change it);
   - a "delete my data" action that removes the volume and its backups.
   A small router (Caddy or the Cloudflare tunnel) maps `<user>.superelf.app`
   to that family's container.
3. **Paid service, only if the pilot shows weekly use.** Payment (Stripe),
   privacy policy and terms, uptime alerts, a status page, automatic
   updates rolled out to one node first.

## Provisioning（开通）

One script, `ops/user/add-family.sh <name> <admin-email>`:
create the volume → start the container from the demo image in user mode →
add the route → send the admin's sign-in link. `remove-family.sh` reverses each step.
No hand edits on the VM.

## Risks

- **AI cost** is the main money risk: hard per-account and per-family caps from day one.
- **Data trust**: users' notes live on our server. Encrypted backups, a
  security review before each release, no admin reading of user data.
- **Owner time** (day job): everything automated; no per-family hand-holding.

## Moving between tiers（升级）

- Single person → family: export the kept demo account, import it as one
  member of the new family node, then delete it from the demo.
- A family member never lives on the demo; a family leaving deletes its node
  (volume and backups) with `remove-family.sh`.

## Not in scope

- One shared multi-user server.
- A node of its own for a single person (they use a kept demo account).
- Public access to the private node: after stage 0 it lives on the VM, still
  reachable over Tailscale only, and is never routed through `superelf.app`.
