---
type: instruction
description: Load for environment, Docker, boot, or runtime health work.
scope: repository
---

# Operations

Load before changing `Dockerfile`, `docker-compose.yml`, `docker-compose.dev.yml`, `scripts/migrate-deploy.mjs`, `generate-env.sh`, `src/schemas/env.ts`, `src/instrumentation.ts`, or health endpoints.

## Mandatory rules

- Keep the environment minimal. `src/schemas/env.ts` is the only list: `DATABASE_URL` and `APP_SECRET` (min 32) are required; `NEXT_PUBLIC_APP_URL` defaults to `http://localhost:3000`; `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `SMTP_URL`, `SMTP_FROM`, `OIDC_CLIENT_SECRET`, `REDIS_URL`, and `BUILD_ID` are optional. Read env through `env` from `src/lib/env.ts`, never `process.env.X` (except `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`). Must not add env vars for values that can be hardcoded or saved in Admin settings.
- Compose files hardcode images (`postgres:18-alpine`, `redis:8-alpine`) and ports. Data lives in bind mounts next to the compose file: `./postgres-data` at `/var/lib/postgresql`, `./redis-data` at `/data` (production Redis adds `--appendonly yes`), and `./rustfs-data` for dev RustFS. `postgres-data` and `redis-data` must stay in `.gitignore`, `.dockerignore`, and ESLint `globalIgnores`; must not switch back to named volumes (`test/docker.test.ts`). Database user, database name, and credentials come only from the generated `.env`: `${POSTGRES_USER}`, `${POSTGRES_DB}`, `${POSTGRES_PASSWORD}`, and `${REDIS_PASSWORD}` in both files (Redis runs with `--requirepass` and `REDISCLI_AUTH` for its healthcheck), `${S3_ACCESS_KEY_ID}` / `${S3_SECRET_ACCESS_KEY}` for dev RustFS, without `:?` or defaults. The app service also loads `.env` through `env_file`; compose overrides `DATABASE_URL` and `REDIS_URL` with in-network hosts built from those values.
- `docker-compose.yml` runs `ghcr.io/nicolaeser/llmhub:latest` on `127.0.0.1:3000` behind a reverse proxy (Caddy) with Postgres and Redis on the internal network; only the `POSTGRES_*` and `REDIS_PASSWORD` values are interpolated, the app reads `.env` through `env_file`. `docker-compose.dev.yml` builds `.` as `llmhub:dev` and publishes Postgres `127.0.0.1:5433`, Redis `127.0.0.1:6379`, RustFS `127.0.0.1:9000` / `9001`, app `127.0.0.1:3000`.
- `generate-env.sh [app-url]` only writes `.env` (mode 600) and refuses to overwrite one. With a URL it writes the production set `NEXT_PUBLIC_APP_URL`, `APP_SECRET`, `POSTGRES_USER`, `POSTGRES_DB` (both fixed to `llmhub`), `POSTGRES_PASSWORD`, `REDIS_PASSWORD`. Without one it writes a local development `.env` that also has `DATABASE_URL` (Postgres on `127.0.0.1:5433`), `REDIS_URL` (with the Redis password), and the RustFS S3 keys. These compose-only values are not app env and must not enter `src/schemas/env.ts`.
- `APP_SECRET` is the only secret. `src/lib/crypto.ts` derives HKDF-SHA256 subkeys from it: `data` seals provider credentials, secret admin settings, and TOTP secrets and keys recovery-code hashes; `signing` (`signingSecret()`) signs session cookies, OIDC state, and Playground try-bearers. It must stay stable across deploys; rotating it invalidates sealed data and every session.
- S3 is optional (`src/lib/s3/`). Only the access keys come from env; bucket, region, endpoint, prefix, addressing, public base URL, and domain bucket live in Admin settings. Local RustFS uses the S3 keys from the generated `.env`.
- `SMTP_URL` is one `smtp://` or `smtps://user:pass@host:port` URL (`src/lib/mail/send.ts`). Without it password reset is off: the link is hidden and the route answers `RESET_DISABLED`. Reset links and tokens are never logged. The OIDC client id lives in Admin settings, only `OIDC_CLIENT_SECRET` stays in env.
- Optional Redis via `REDIS_URL` runs the in-process worker on BullMQ and shares RPM/TPM. Without it the same jobs run on a timer. Must not await Redis before Next binds. Must not require a worker sidecar.
- `BUILD_ID` is baked into the runner stage (`ARG BUILD_ID=development`); both CI workflows pass the release version (`vYYYY.MM.DD.<sha>` or `dev-YYYY.MM.DD.<sha>`) as a build arg, and `/internal-api/version` reports it (`development` when unset). The console top bar shows it and, unless Admin settings turn `update_check` off, compares it with the GitHub releases of the same channel (`src/lib/updates/`, cached for six hours) to show Update available.
- The image `CMD` is `node migrate-deploy.mjs && exec node server.js`; there is no entrypoint script. `scripts/migrate-deploy.mjs` validates `DATABASE_URL` and `APP_SECRET`, waits for Postgres, takes an advisory lock, and runs `prisma migrate deploy` then `prisma migrate status`, so a replaced image applies new migrations on every start. Only the container start migrates; locally run `npm run db:migrate`.
- The `Dockerfile` is multi-stage, and every stage builds on `node:24-trixie-slim` without extra system packages (trixie ships `libssl3`; Next handles `SIGTERM` itself): `base`, `deps` (`npm ci`), `prismacli` (production install of just `prisma`, `dotenv`, and `pg` from the lockfile with their install scripts allowed, so the schema engine is fetched at build time), `builder` (`prisma generate` + `next build`), and `runner`. The runner holds the Prisma CLI closure, the Next.js standalone output, `prisma/schema`, `prisma/migrations`, `prisma.config.ts`, and `migrate-deploy.mjs`; it runs as the image's `node` user with a Node `fetch` `HEALTHCHECK` on `/internal-api/health`. `next build` gets non-secret `DATABASE_URL` and `APP_SECRET` placeholders inline in the `RUN` because `src/lib/db/prisma.ts` validates env on import.
- The client IP is the last `X-Forwarded-For` hop, the one the reverse proxy appends (`clientIp` in `src/lib/http/api.ts`). `X-Real-IP` and `CF-Connecting-IP` are never trusted. Throttles, key IP allowlists, and session records depend on this, so the app port must only be reachable through the proxy.
- CI is `.github/workflows/development.yml` and `.github/workflows/main.yml`. Each runs `quality` then `build` on pushes and PRs to its branch. Pushes publish to `${REGISTRY}/${IMAGE_NAME}` and create a GitHub release: `main` → `latest` + `vYYYY.MM.DD.<sha>`, `development` → `dev` / `development` + `dev-YYYY.MM.DD.<sha>` prerelease. PRs build `linux/amd64` without pushing. The workflow token is `contents: read`; only `build` gets `contents: write` and `packages: write`. Keep actions on their current major versions.
- `src/instrumentation.ts` ensures the system catalog on the Node runtime, then calls `startWorker` from `src/worker/boot.ts`. With BullMQ, `registerWorkerSchedules` (`src/worker/schedules.ts`) upserts the minute maintenance and two-hour `models` schedulers plus one deduplicated model sync at boot (skipped while the cached catalog is fresh); the local fallback runs the same two jobs on `setInterval`. Must not start workers during `next build` or on Edge.
- Health: `GET /internal-api/health` (liveness, includes `worker.mode`). Ready: `GET /internal-api/ready` (Prisma read). Version: `GET /internal-api/version` (`BUILD_ID`, start time). There are no other health, version, or metrics routes.
- There is no seed. The first account is created at `/internal-api/setup` (layout gate redirects home once any user exists; the action re-checks the count in a serializable transaction).

## Prohibited patterns

- Do not bake production secrets into an image.
- Do not document a host port that disagrees with compose `ports`.

## Commands

- `sh generate-env.sh` (local) or `sh generate-env.sh https://hub.example.com` (server)
- `docker compose -f docker-compose.dev.yml up -d postgres redis rustfs`
- `docker compose -f docker-compose.dev.yml up --build`
- `npm run db:migrate`
- `npm run dev`
