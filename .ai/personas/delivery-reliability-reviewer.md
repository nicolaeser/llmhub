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

- The `Dockerfile` `CMD` runs `migrate-deploy.mjs` before `exec node server.js`.
- Instrumentation skips migrate and the worker during `next build`.
- Ready uses a Prisma read, not raw SQL.
- Compose keeps Postgres and Redis data in the `./postgres-data` and `./redis-data` bind mounts, excluded from git and the image.
- `docker-compose.au.yml` stays `docker-compose.yml` plus the updater; the updater keeps no ports, the internal network, dropped capabilities, and only `APP_SECRET`, and an update still waits for the image health check and rolls back.
- The `BUILD_ID` build arg reaches the runner stage so `/internal-api/version` reports the release.
- Env validation still requires `DATABASE_URL` and an `APP_SECRET` of at least 32 characters, in `src/schemas/env.ts` and in `scripts/migrate-deploy.mjs`.

## Required context

[../instructions/operations.md](../instructions/operations.md).

## Expected output

Boot or probe gaps with paths.
