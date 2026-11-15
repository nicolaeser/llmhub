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

## Branch and version contract

| Branch | Purpose | Published image tags |
| --- | --- | --- |
| `dev/<kebab-topic>` | One feature or change; quality checks only | None |
| `development` | Integration of finished features | `vdevYYYY.MM.DD.sha7`, `dev-sha7`, `dev` |
| `main` | Release | `vYYYY.MM.DD.sha7`, `sha7`, `latest` |

Start new work with `git fetch origin` and `git switch -c dev/<kebab-topic> origin/development`. If the integration branch does not exist, resolve that explicitly instead of silently branching from `main`. Preserve existing worktrees and uncommitted work. Creating commits, publishing branches, and merging follow the user's authorization.

The date comes from the built commit's committer timestamp and the suffix is its first seven SHA characters. For a merged feature this is the merge commit, not the feature tip. `scripts/build-version.mjs` enforces `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`. Rebuilding the same commit must produce the same version. Only successful release pipelines move `dev` or `latest`; development releases are prereleases. Historical `dev-YYYY.MM.DD.sha7` and `sha-…` tags remain readable but are no longer published.

## Procedure

1. Confirm the `Dockerfile` `CMD` is still `node start.mjs` and that `scripts/start.mjs` still runs `migrate-deploy.mjs` before `server.js`.
2. Confirm `src/instrumentation.ts` still ensures the catalog and starts the in-process worker.
3. `npm run build` (runs `prebuild` gates) or `docker build .`. CI publishes the image on pushes to `main` and `development` and bundles the Google OAuth client secret from the repository secret `ANTIGRAVITY_CLIENT_SECRET`. A local build without `--secret id=antigravity_client_secret,src=<file>` has none, so Google sign-in asks for it in the Subscriptions tab of `/providers`.
4. Check `/internal-api/health` and `/internal-api/ready` on the published origin. Health may report `worker.mode` `local` when Redis is unset; that is valid. `/internal-api/version` must show the release version, not `development`.
5. First operator is created at `/internal-api/setup` when the user table is empty.
6. With `docker-compose.au.yml`, the `updater` container is healthy and the console's status badge shows the updater connected; an update recreates the app and leaves `docker compose up -d --dry-run` with nothing to recreate.

## Validation

- `prebuild` checks pass
- Schema or boot changes pass `npm run test:migrations` against a disposable local PostgreSQL server and the integration suite
- `src/tests/build-version.test.ts` and the release/updater tests pass after version changes
- Health 200
- Ready 200 when Postgres is up
- Version reports the published `BUILD_ID`

## Rollback

Migrations are forward-only. For a schema-incompatible image rollback, restore the pre-upgrade backup. Failed migrations require explicit Prisma recovery using the current image; see [database-migration.md](database-migration.md). Plan the compatibility content-copy upgrade with enough free space and a maintenance window; automatic update readiness expires after ten minutes.

## Definition of done

Web starts, migrations are idempotent, catalog exists, and no user exists until setup.
