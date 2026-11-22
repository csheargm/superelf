# 0037 — Unshared app pages are private

Date: 2026-11-22 · Status: accepted

## Context
`GET /app/<uid>/<slug>/...` ran before the sign-in check and served any member's app page and code
to anyone who knew the uid and slug, signed out included. Data files were already 404, but the app's
HTML/JS (its design, any text in it) leaked for apps the author never shared.

## Decision
- An app page loads only if its `meta.json` has `shared: true`, or the viewer is its author, or the
  viewer has the owner role. Everyone else gets **404** (the same as a missing file), so existence is
  not revealed. Missing/broken meta = unshared. Logic: `lib/app-page-access.mjs`.
- The iframe loads the page by navigation (`src`), which carries no Authorization header. So every
  authenticated `GET /api/ping` (the shell pings at boot and after sign-in) sets an HttpOnly cookie
  `pa_app` = the session token, `Path=/app/; SameSite=Strict` (+ `Secure` on https). Path scope means
  the cookie is never sent to `/api/*`: no CSRF surface; only the app-page route reads it. It is the
  session itself, so logout (which also clears it) and expiry revoke it. A bearer header is accepted
  too (srcdoc route fetch, tests).
- Signed-out state (sign-out, or any boot with no live session): the shell posts `/app/-/signout`
  (the cookie's own path; destroys its session, clears it) and deletes every `/app/` entry from the
  `pa-*` service-worker caches, so the next account on the browser can read neither. The srcdoc
  route fetches with `credentials:'same-origin'` so the cookie rides it.
- Demo nodes keep visitors' app pages public-by-link (unchanged); `/app/shared/` is shared by definition.

## Consequences
A shared-then-unshared app stops loading for others at once. App sub-resources need no cookie: APP_CSP
already forbids loading anything from the server inside the app (no `'self'`).
