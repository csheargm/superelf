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
ARG AGENT_CLIS=
RUN if [ -n "$AGENT_CLIS" ]; then \
      apt-get update && apt-get install -y --no-install-recommends git ripgrep && rm -rf /var/lib/apt/lists/* \
      && npm install -g --no-fund --no-audit $AGENT_CLIS && npm cache clean --force; \
    fi
WORKDIR /opt/superelf
COPY . /opt/superelf
RUN chmod +x /opt/superelf/ops/demo/entrypoint.sh /opt/superelf/backup.sh /opt/superelf/restore.sh \
 && useradd --uid 10001 --create-home --shell /usr/sbin/nologin superelf
ENV NODE_ENV=production
EXPOSE 8787
ENTRYPOINT ["/opt/superelf/ops/demo/entrypoint.sh"]
