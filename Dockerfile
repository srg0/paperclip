FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl git openssh-client wget ripgrep python3 \
  && mkdir -p -m 755 /etc/apt/keyrings /etc/apt/sources.list.d \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
ARG CLAUDE_CODE_VERSION=2.1.101
ARG OPENAI_CODEX_VERSION=0.120.0
ARG OPENCODE_AI_VERSION=1.4.3
ARG CURSOR_AGENT_INSTALL_URL=https://cursor.com/install
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN set -eu; \
  retry() { \
    attempts="$1"; shift; \
    count=1; \
    while [ "$count" -le "$attempts" ]; do \
      if "$@"; then return 0; fi; \
      if [ "$count" -eq "$attempts" ]; then return 1; fi; \
      sleep "$((count * 10))"; \
      count="$((count + 1))"; \
    done; \
  }; \
  npm config set fetch-retries 5; \
  npm config set fetch-retry-factor 2; \
  npm config set fetch-retry-mintimeout 20000; \
  npm config set fetch-retry-maxtimeout 120000; \
  npm config set fetch-timeout 300000; \
  retry 5 npm install --global --omit=dev --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
  retry 5 npm install --global --omit=dev --no-audit --no-fund "@openai/codex@${OPENAI_CODEX_VERSION}"; \
  retry 5 npm install --global --omit=dev --no-audit --no-fund "opencode-ai@${OPENCODE_AI_VERSION}"; \
  export HOME=/usr/local/share/cursor-agent-home; \
  rm -rf "${HOME}" /tmp/cursor-install.sh; \
  mkdir -p "${HOME}"; \
  retry 5 curl --retry 5 --retry-all-errors --connect-timeout 20 --max-time 300 -fsSL "${CURSOR_AGENT_INSTALL_URL}" -o /tmp/cursor-install.sh; \
  bash /tmp/cursor-install.sh; \
  cursor_agent_bin="$(find "${HOME}"/.local/share/cursor-agent/versions -path '*/cursor-agent' -type f | sort | tail -n 1)"; \
  test -n "${cursor_agent_bin}"; \
  ln -snf "${cursor_agent_bin}" /usr/local/bin/cursor-agent; \
  ln -snf /usr/local/bin/cursor-agent /usr/local/bin/agent; \
  rm -f /tmp/cursor-install.sh; \
  mkdir -p /paperclip; \
  chown -R node:node /paperclip /usr/local/share/cursor-agent-home

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
