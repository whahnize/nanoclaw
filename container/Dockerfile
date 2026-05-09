# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir notebooklm-py

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# ---------------------------------------------------------------------------
# Sub-AC 3.3 — bake the web-fetch wrapper CLI into the agent image.
#
# The web-fetch skill is also synced per-group at runtime by
# src/container-runner.ts into /home/node/.claude/skills/web-fetch/, but
# that path is only convenient for `python3 /home/node/.claude/skills/...`
# invocations. Baking the wrapper into the image and exposing it on $PATH
# as the bare command `web-fetch` lets the LLM agent call ONE command
# (`web-fetch <url>`) without knowing where the source files live or which
# of the two runtimes (agent-browser primary vs. cf-fetch-server sidecar)
# is serving the request.
#
# Files copied are limited to the runtime modules — test_*.py and
# __pycache__/ are excluded so the image stays lean.
# ---------------------------------------------------------------------------
COPY skills/web-fetch/web_fetch.py \
     skills/web-fetch/cf_detect.py \
     skills/web-fetch/sidecar_client.py \
     skills/web-fetch/orchestrator.py \
     /opt/web-fetch/

# Default sidecar URL. Sub-AC 3.2 already injects this via `-e` from
# src/container-runner.ts at NanoClaw spawn time (and that injection is
# what governs production runs); the ENV here is a sane image-level
# default so ad-hoc `docker run nanoclaw-agent web-fetch …` still resolves
# the sidecar without extra flags. Override at runtime with
# `-e CF_FETCH_SIDECAR_URL=…`. Webshare proxy credentials are NEVER set
# here — they live ONLY in the host's launchd plist (see
# host-helpers/cf-fetch-server/launchd.plist.template).
ENV CF_FETCH_SIDECAR_URL=http://host.docker.internal:8765

# /opt/web-fetch is the canonical baked-in location; expose it via env so
# operators inspecting the container can see exactly where the wrapper
# lives, and so any future tooling can find the source without grepping.
ENV WEB_FETCH_HOME=/opt/web-fetch

# Tiny shim on $PATH so the agent invokes `web-fetch <url>` directly. We
# use a shell script (not a symlink) because web_fetch.py imports its
# sibling modules via os.path.dirname(os.path.abspath(__file__)) — a
# symlink would resolve __file__ to /usr/local/bin/web-fetch and break
# the sibling import. The shim hard-codes the absolute interpreter path
# to /opt/web-fetch/web_fetch.py so __file__ always points back into the
# baked-in source tree.
RUN printf '#!/bin/sh\n# NanoClaw web-fetch wrapper (Sub-AC 3.3).\n# Forwards to the baked-in CLI; preserves all argv.\nexec python3 /opt/web-fetch/web_fetch.py "$@"\n' \
        > /usr/local/bin/web-fetch \
    && chmod 0755 /usr/local/bin/web-fetch \
    && chmod 0644 /opt/web-fetch/*.py

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\n[ -d /workspace/extra/notebooklm ] && ln -sfn /workspace/extra/notebooklm /home/node/.notebooklm || true\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
