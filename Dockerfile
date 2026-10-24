# ---- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim
WORKDIR /app

# Tools the agent uses in "code"/"github" bundles: git, gh, ripgrep, python, curl, jq.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep python3 python3-pip python3-venv unzip tini gnupg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# git authenticates to GitHub through gh, which reads GH_TOKEN (set per bundle at run time).
RUN git config --system credential.https://github.com.helper '!gh auth git-credential' \
  && git config --system init.defaultBranch main

ENV NODE_ENV=production \
    DATA_DIR=/data \
    BUNDLES_FILE=/app/config/bundles.json \
    AGENT_USER=agent

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY config ./config
COPY bin ./bin

# Privilege separation: the bot process runs as root (so it can own the database and
# drop privileges), and every agent process runs as the unprivileged "agent" user via
# setpriv (bin/claude-as-agent.sh). The agent can't read the bot's environment
# (Discord token), /data/bot (database), or other root-owned files.
RUN useradd --create-home --uid 10001 --shell /bin/bash agent \
  && chmod 0755 /app/bin/claude-as-agent.sh \
  && mkdir -p /data
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
