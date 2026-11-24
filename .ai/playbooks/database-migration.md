---
type: playbook
description: Procedure for forward-only Prisma schema changes and existing-installation upgrades.
---

# Database migration

## Use when

Changing `prisma/schema/`, adding a migration, or altering database boot.

## Required context

[data-persistence.md](../instructions/data-persistence.md), [system-overview.md](../knowledge/system-overview.md).

## Compatibility boundary

The 63 shipped migrations pinned in `src/tests/support/legacy-migrations.json` are immutable, including their custom SQL. `20261115145000_prisma_compatibility` is the single new customized exception: an atomic, data-preserving conversion of partitioned request content to a plain table and removal of the database-only policy target check. Prisma cannot generate that conversion. Never squash this history, change its checksums, or replace it with `0_init` on existing installations.

The following `20261115145340_request_content_size` and all future regular migrations must be untouched Prisma output, including generated comments. Do not add transaction wrappers or data updates. Application code uses the Prisma Client API only; `prisma-client-policy.test.ts` forbids raw SQL without an allowlist. System catalog rows are idempotent runtime upserts, never migration seed statements.

## Procedure

1. Use a disposable development PostgreSQL database. Apply the existing chain with `npm run db:migrate`. For schema generation, configure a separate disposable `SHADOW_DATABASE_URL` if the database role cannot create databases. Never point it at an application database.
2. Edit `prisma/schema/*.prisma`. Keep `User` as the operator model. Implement unsupported database features in domain services and cover their write paths and concurrency invariants.
3. Run `npx prisma migrate dev --name <change>`. Review the generated SQL for destructive operations and locks; revise the schema and regenerate an unpublished migration when necessary. Do not edit generated SQL. A new timestamp must sort after the complete existing history.
4. Run `npm run db:generate` and update callers. Generated types stay ignored under `src/generated/`.
5. After fetching the comparison branch, run `npm run migrations:check -- <base-ref>`; it rejects removed/renamed migrations, changed SQL, and out-of-order additions.
6. Run the production schema step, `node scripts/migrate-deploy.mjs`, against a scratch database. It invokes only the bundled `prisma migrate deploy`, retries unreachable-database errors, and never baselines or resolves failures automatically. Keep `scripts/start.mjs` as the web supervisor and keeper compatibility path.
7. Run `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code` to prove no drift.

## Validation

- `DATABASE_URL=<local disposable server URL> npm run test:migrations` creates and removes its own databases. It tests all historical prefixes with data, fresh installs, non-public schemas, concurrent starts, immutable history, generated SQL, rollback of the compatibility copy, P3009 recovery, and P3005 refusal. Never supply production credentials.
- `npm test`, `npm run test:integration`, `npx tsc --noEmit`, and the repository UI, localization, lint, and build gates.
- Bootstrap changes also require the seed production guard and concurrent first-operator tests. Development reset/fixtures are documented in [data-persistence.md](../instructions/data-persistence.md#development-fixtures).

## Deployment and recovery

Back up before upgrading. The compatibility copy needs space for a second content table and its indexes and blocks log writes. Measure it on a restored copy, reserve a maintenance window, and pause automatic updates if it may exceed the updater's ten-minute readiness deadline.

P3005 means a nonempty database has no migration history: refuse boot. Adoption is a manual, backed-up, schema-verified procedure; for this existing chain, resolve only the exact migrations already represented by that database. Do not blindly mark the whole history applied.

P3009/P3018 requires operator investigation. Prisma-generated migrations may be partly applied. Correct or complete the schema, then use the documented `prisma migrate resolve --rolled-back <name>` or `--applied <name>` as appropriate. Never rewrite `_prisma_migrations` manually. The compatibility bridge itself is transactional and rolls back its copy on failure. Use the current image for recovery: older images may incorrectly assume all later migrations are transactional and automatically resolve them.

## Definition of done

Schema, generated client, and domain services agree. Historical databases keep operators, credentials, settings, usage, and content. New deployments need neither a production seed nor an automatic baseline. Document validation limits and any maintenance-window requirements.
