# ─────────────────────────────────────────────────────────────────────────────
# FlexPlus Scraper — Multi-stage Dockerfile
#
# Stages:
#   base      → shared Node 24 slim + system deps for Playwright
#   deps      → production npm install (cached layer)
#   build     → TypeScript compile
#   playwright→ Playwright browser install (cached separately for fast rebuilds)
#   runtime   → minimal production image, non-root user
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: base ─────────────────────────────────────────────────────────────
# Node 24 slim on Debian Bookworm.  We need Debian (not Alpine) because
# Playwright's Chromium binary links against glibc.
FROM node:24-bookworm-slim AS base

LABEL org.opencontainers.image.title="flexplus-scraper" \
      org.opencontainers.image.description="ETS Placement Flex headless scraper" \
      org.opencontainers.image.licenses="MIT"

# System packages required by Chromium / Playwright
# Consolidated in one RUN to minimise layers
RUN apt-get update && apt-get install -y --no-install-recommends \
      # Chromium runtime dependencies
      libnss3 \
      libnspr4 \
      libdbus-1-3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
      libpango-1.0-0 \
      libcairo2 \
      # Font support (prevents blank pages)
      fonts-liberation \
      fonts-noto-color-emoji \
      # Process management
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Stage 2: deps ─────────────────────────────────────────────────────────────
# Install production npm packages with BuildKit cache mount.
# Separated from source code so this layer is reused on code-only changes.
FROM base AS deps

COPY package*.json ./

# npm cache mount avoids re-downloading on every build
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ── Stage 3: playwright-browsers ─────────────────────────────────────────────
# Download Chromium into a dedicated layer so browser reinstalls only happen
# when the Playwright version changes, not on every source change.
FROM deps AS playwright-browsers

# Tell Playwright where to store its browsers inside the image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npx playwright install chromium --with-deps

# ── Stage 4: build ────────────────────────────────────────────────────────────
FROM base AS build

# Tell Playwright where to store/find its browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json tsconfig.json ./

# Install all deps (including devDependencies for tsc)
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy pre-downloaded Playwright browsers from the playwright-browsers stage
COPY --from=playwright-browsers /ms-playwright /ms-playwright

COPY src/ ./src/

RUN npm run build

# ── Stage 5: runtime ─────────────────────────────────────────────────────────
FROM base AS runtime

# ── Security: non-root user ──────────────────────────────────────────────────
RUN groupadd --gid 1001 flexplus && \
    useradd --uid 1001 --gid flexplus --shell /bin/bash --create-home flexplus

WORKDIR /app

# Copy compiled JS from build stage
COPY --from=build --chown=flexplus:flexplus /app/dist ./dist
COPY --from=build --chown=flexplus:flexplus /app/package*.json ./

# Copy production node_modules (no devDeps)
COPY --from=deps --chown=flexplus:flexplus /app/node_modules ./node_modules

# Copy pre-downloaded Playwright browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=playwright-browsers --chown=flexplus:flexplus /ms-playwright /ms-playwright

# Runtime data directory (SQLite DB will live here via volume mount)
RUN mkdir -p /app/data && chown flexplus:flexplus /app/data

# Drop to non-root
USER flexplus

# ── Environment defaults ──────────────────────────────────────────────────────
ENV NODE_ENV=production \
    PLAYWRIGHT_HEADLESS=true \
    DATABASE_PATH=/app/data/flexplus.db \
    LOG_LEVEL=info

# ── Health check ─────────────────────────────────────────────────────────────
# Lightweight check: verify the Node process + dist/main.js are reachable
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD IS_HEALTHCHECK=1 node --experimental-sqlite -e "require('./dist/main.js')" 2>/dev/null || exit 1

# ── Entrypoint ────────────────────────────────────────────────────────────────
# dumb-init ensures signals (SIGTERM) are forwarded to node, not swallowed
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "--experimental-sqlite", "dist/main.js"]
