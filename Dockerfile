ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-trixie-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM base AS prismacli
WORKDIR /pc
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    node -e 'const fs = require("node:fs"); \
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); \
      const all = { ...pkg.dependencies, ...pkg.devDependencies }; \
      const keep = ["prisma", "dotenv", "pg"]; \
      for (const name of keep) if (!all[name]) throw new Error(name + " is missing from package.json"); \
      fs.writeFileSync("package.json", JSON.stringify({ name: pkg.name, private: true, \
        dependencies: Object.fromEntries(keep.map((name) => [name, all[name]])), \
        allowScripts: { prisma: true, "@prisma/engines": true } }));' \
  && npm install --omit=dev --no-audit --no-fund \
  && node node_modules/prisma/build/index.js --version

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    APP_SECRET=build-only-placeholder-not-a-secret-000000 \
    sh -c "npx prisma generate && npm run build"

FROM base AS runner
LABEL org.opencontainers.image.title="LLM Hub" \
      org.opencontainers.image.description="Self-hosted OpenAI-compatible LLM gateway with an admin console" \
      org.opencontainers.image.source="https://github.com/nicolaeser/llmhub"
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=prismacli --chown=node:node /pc/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --chown=node:node prisma/schema ./prisma/schema
COPY --chown=node:node prisma/migrations ./prisma/migrations
COPY --chown=node:node prisma.config.ts scripts/migrate-deploy.mjs ./
ARG BUILD_ID=development
ENV BUILD_ID=${BUILD_ID}
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/internal-api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["sh", "-c", "node migrate-deploy.mjs && exec node server.js"]
