---
type: playbook
description: Procedure for Prisma schema and migration changes.
---

# Database migration

## Use when

Changing `prisma/schema/`, adding a migration, or altering generate/output behavior.

## Required context

[data-persistence.md](../instructions/data-persistence.md), [system-overview.md](../knowledge/system-overview.md).

## Prerequisites

Postgres available for `prisma migrate dev`. There is no seed.

## Procedure

1. Edit `prisma/schema/*.prisma` only. Keep `User` as the operator model.
2. Run `npx prisma generate`.
3. Run `npx prisma migrate dev` locally to create SQL under `prisma/migrations/`. The folder timestamp must sort after every existing migration. Without a database, copy `prisma/schema/` before editing and run `npx prisma migrate diff --from-schema <copy> --to-schema prisma/schema --script`; `--from-migrations` needs a `shadowDatabaseUrl`, which `prisma.config.ts` does not set. Remove `--` comment lines before committing.
4. Update TypeScript callers and tests that depend on field names.
5. Confirm `.gitignore` still excludes `src/generated/`.
6. Confirm the `Dockerfile` `CMD` still runs `migrate-deploy.mjs` before `server.js`.

## Validation

- Generate + `npx tsc --noEmit`
- Review the new `migration.sql`
- After `npm run db:migrate` on a scratch database, `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --script` prints an empty migration

## Rollback

Do not rewrite applied SQL. Add a forward migration.

## Definition of done

Schema, generated types, and callers agree. Catalog boot seeds role templates without creating operators.
