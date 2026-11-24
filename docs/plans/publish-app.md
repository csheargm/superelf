# Plan — Publish an app (ADR 0039)

1. Scanner: export `scanText()` from tools/privacy-scan.mjs + fail-closed term loader; tests for
   missing/empty term files and a hit returning file:line:text.
2. lib/publish/collect.mjs: code-only allow-list, path containment, size cap; tests (data/,
   symlink, `..`).
3. adminconfig `github_publish_token` (secret, advanced); test it never serializes.
4. lib/publish/github.mjs: branch/tree/commit/PR via REST, check-run polling, merge; tested
   against a local fake GitHub server that enforces the real API's 409/422 guards.
5. lib/publish/release.mjs: throwaway clone, bump-version, push, retry on moved main (max 3).
6. Endpoint + owner check + per-slug lock; ⋯ menu item, token-needed state, scan-hit sheet,
   one-time tip, notice. Playwright (webkit) e2e on a throwaway node with the fake GitHub.
7. Overlay: ops/private/update-if-released.sh + systemd timer/service; dry-run test on a
   throwaway clone (red tip, unreleased tip, lock held → no deploy).
8. Ship each step via the normal flow; first real publish is the owner's call.
