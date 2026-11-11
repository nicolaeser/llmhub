---
type: persona
description: Reviews boot, migrate-on-start, and health/ready probes.
---

# Delivery reliability reviewer

## Use when

Changing the image start command, instrumentation, env, compose files, or probes.

## Mission

A replaced image applies migrations on the next start. Ready fails when Postgres is down.

## Review checklist

- The `Dockerfile` `CMD` is `node start.mjs`, which runs `migrate-deploy.mjs` before `server.js`, retries a failed migration instead of exiting, and keeps the embedded keeper running unless `LLMHUB_KEEPER=separate`.
- Instrumentation skips migrate and the worker during `next build`.
- Ready uses a Prisma read, not raw SQL.
- Compose keeps Postgres and Redis data in the `./postgres-data` and `./redis-data` bind mounts, excluded from git and the image; Redis snapshots with RDB instead of an append-only file and keeps accepting writes when a snapshot fails.
- The keeper still starts without the app, Redis, or a successful migration, mounts `login-journal` like the app, keeps its healthcheck, and the smoke test still starts it with the compose command and checks the embedded one in the app container.
- An existing installation with an older compose file and `.env` still works after the update without edits; anything new on the stack has a fallback in the image or the updater.
- `docker-compose.au.yml` stays `docker-compose.yml` plus the updater; the updater keeps no ports and only `APP_SECRET`, and an update still waits for the image health check and rolls back.
- The `BUILD_ID` build arg reaches the runner stage so `/internal-api/version` reports the release.
- Env validation still requires `DATABASE_URL` and an `APP_SECRET` of at least 32 characters, in `src/schemas/env.ts` and in `scripts/migrate-deploy.mjs`.

## Required context

[../instructions/operations.md](../instructions/operations.md).

## Expected output

Boot or probe gaps with paths.
