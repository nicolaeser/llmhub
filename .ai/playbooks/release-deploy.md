---
type: playbook
description: Procedure for building and running the app.
---

# Release and deploy

## Use when

Building, changing boot, or publishing the web process.

## Required context

[operations.md](../instructions/operations.md), [database-migration.md](database-migration.md).

## Prerequisites

A `.env` file exists (`generate-env.sh` for self-hosting). Postgres is reachable.

## Procedure

1. Confirm the `Dockerfile` `CMD` still runs `migrate-deploy.mjs` before `server.js`.
2. Confirm `src/instrumentation.ts` still ensures the catalog and starts the in-process worker.
3. `npm run build` (runs `prebuild` gates) or `docker build .`. CI publishes the image on pushes to `main` and `development`.
4. Check `/internal-api/health` and `/internal-api/ready` on the published origin. Health may report `worker.mode` `local` when Redis is unset; that is valid. `/internal-api/version` must show the release version, not `development`.
5. First operator is created at `/internal-api/setup` when the user table is empty.

## Validation

- `prebuild` checks pass
- Health 200
- Ready 200 when Postgres is up
- Version reports the published `BUILD_ID`

## Rollback

Roll back the image. Migrations are forward-only.

## Definition of done

Web starts, migrations are idempotent, catalog exists, and no user exists until setup.
