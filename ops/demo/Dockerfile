# superelf public demo image · 演示镜像 — multi-arch (linux/arm64 for an arm VM, amd64 too).
# Build context is the repo root: docker compose -f ops/demo/docker-compose.yml build
# CODE ONLY: Dockerfile.dockerignore whitelists what is copied, so no config.json, workspace,
# session, log or key can reach the image. Secrets arrive at run time (.env, mounted files).
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends gnupg rclone openssl ca-certificates tar \
 && rm -rf /var/lib/apt/lists/*
# AGENT_CLIS (the private owner node only, ops/private/docker-compose.yml): the Claude Code and
# Codex CLIs the owner lane runs. Empty for the demo, which stays Ollama-only. Pinned versions.
# Each CLI must RUN after install: a build that lost an optional native package fails here.
ARG AGENT_CLIS=
RUN if [ -n "$AGENT_CLIS" ]; then \
      apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/* \
      && npm install -g --no-fund --no-audit --include=optional $AGENT_CLIS && npm cache clean --force \
      && for c in $AGENT_CLIS; do \
           case "$c" in @anthropic-ai/claude-code@*) b=claude;; @openai/codex@*) b=codex;; *) echo "no run check known for $c; add one here" >&2; exit 1;; esac; \
           "$b" --version >/dev/null || { echo "$c installed but '$b --version' fails (optional native package missing? disk full?)" >&2; exit 1; }; \
         done; \
    fi
# RENDER_BROWSER (the private owner node only): a playwright-core version. Installs it and the Chromium
# headless shell (the smallest Chromium Playwright ships) under /opt/render, so the core lane can render a
# changed page at iPhone width before it replies (lib/selfpub/render.mjs, docs/adr/0044). Empty for the
# demo. The launch at the end proves the browser starts in this image.
ARG RENDER_BROWSER=
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/render/browsers SELFPUB_PLAYWRIGHT=/opt/render/node_modules/playwright-core/index.mjs
RUN if [ -n "$RENDER_BROWSER" ]; then \
      case "$RENDER_BROWSER" in *[!0-9.]*) echo "RENDER_BROWSER must be a version like 1.58.2" >&2; exit 1;; esac \
      && mkdir -p /opt/render && cd /opt/render && echo '{"private":true}' > package.json \
      && npm install --no-fund --no-audit "playwright-core@$RENDER_BROWSER" \
      && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
      && npm cache clean --force && rm -rf /var/lib/apt/lists/* \
      && node -e 'import(process.env.SELFPUB_PLAYWRIGHT).then(async (m) => { const b = await m.chromium.launch(); await b.close(); })'; \
    fi
WORKDIR /opt/superelf
COPY . /opt/superelf
# The repo's built-in app pages go to builtin-apps/, NOT workspace/ or shared-apps/: the entrypoint copies the
# image over the node folder, and an installed (possibly edited) app must never be overwritten blind.
# web.mjs updates only unedited copies from here at start (lib/builtin-app-update.mjs).
RUN mkdir -p builtin-apps \
 && if [ -d workspace/apps ]; then mv workspace/apps builtin-apps/workspace-apps; fi \
 && if [ -d shared-apps ]; then mv shared-apps builtin-apps/shared-apps; fi \
 && rm -rf workspace
# REVISION: the exact commit this image holds (lib/buildid.mjs readRevision), plus its date. The
# entrypoint's copy then replaces the node folder's file on every start, so the footer and PAUpdate
# (docs/adr/0026) see each deploy. Required: a build without it fails here, never a stale stamp.
# Passed by ops/demo/revision.sh (rebuild-demo.sh, rebuild-private.sh) through compose build args.
ARG REVISION
ARG REVISION_DATE
# case, not grep -x: grep matches per line, so a multi-line value would pass. Rejected values are not echoed.
RUN case "$REVISION" in *[!0-9a-f]*|'') false;; esac && [ "${#REVISION}" -eq 40 ] || { echo "build arg REVISION must be the full 40-hex commit sha; run ops/demo/rebuild-demo.sh" >&2; exit 1; } \
 && case "$REVISION_DATE" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) false;; esac || { echo "build arg REVISION_DATE must be YYYY-MM-DD" >&2; exit 1; } \
 && printf '%s\n%s\n' "$REVISION" "$REVISION_DATE" > /opt/superelf/REVISION
RUN chmod +x /opt/superelf/ops/demo/entrypoint.sh /opt/superelf/backup.sh /opt/superelf/restore.sh \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin superelf
ENV NODE_ENV=production
EXPOSE 8787
ENTRYPOINT ["/opt/superelf/ops/demo/entrypoint.sh"]
