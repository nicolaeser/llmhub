---
type: instruction
description: Load for Prisma schema, migrations, or generated-client work.
scope: repository
---

# Data persistence

Load before changing `prisma/`, `src/lib/db/prisma.ts`, `src/generated/prisma`, or modules that write `User`, keys, tenancy, budgets, settings, or spend.

## Mandatory rules

- Prisma 7 with the `prisma-client` generator and `@prisma/adapter-pg` (`prisma/schema/`, `src/lib/db/prisma.ts`).
- Generate output is `src/generated/prisma`. That directory is gitignored; run `npx prisma generate` after schema changes.
- Schema lives in `prisma/schema/` (`main.prisma`, `auth.prisma`, `gateway.prisma`). Migrations live in `prisma/migrations/`.
- The operator model is `User` with one `roleId` and `isOwner`. `Role` stores a `permissions` string array and an optional `templateKey`. Auth state lives in `Session`, `UserTotp`, `RecoveryCode`, `UserPasskey`, `LoginChallenge`, `AuthCeremony`, `UserSecurityEvent`, and `ManagementKey` (`prisma/schema/auth.prisma`).
- Containers apply `prisma/migrations` on every start through `scripts/migrate-deploy.mjs`, which runs the bundled Prisma CLI (`prisma migrate deploy`, then `prisma migrate status`) under a Postgres advisory lock. Locally `npm run db:migrate` runs the same CLI. The app itself never migrates.
- `RequestLog` keeps metadata only. Prompt and response bodies live in `RequestLogContent` (1:1 by `logId`, cascade delete), so log lists and counts never load bodies; content retention deletes those rows and keeps the metadata.
- Money columns are `Decimal(20,10)`. `UsageDaily` is the per-day rollup keyed by day, key, team, org, project, user, and model; it is updated with an atomic upsert per request.
- Budget holders are `VirtualKey`, `User`, `Project`, `Team`, and `Organization`, each with `maxBudget`, `spend`, `budgetDuration`, and `spendResetAt`. `TempBudget` rows (`entityType` `key` | `user` | `project` | `team` | `org`) are boosts; the maintenance sweep deletes expired ones.
- Tenancy is denormalized: a key stores `teamId` and `orgId` derived from its project and team, and a user's `orgId` follows its team. Structure actions update those copies in the same transaction when a team or project moves; any new write path must do the same.
- `ModelTemplate` links to keys through `VirtualKeyTemplate` (`onDelete: Restrict` on the template, so a template in use cannot be deleted). Provider data-handling facts (`zdr`, `retentionDays`, `region`, `noTraining`) live on `ProviderConnection` and feed template matching.
- `Organization.piiPolicy` and `VirtualKey.piiPolicy` are nullable JSON PII overrides; `null` inherits.
- There is no seed. `ensureSystemCatalog` upserts the role templates once (`Setting` `role_templates_seeded`) and default settings at boot; it never creates users or credentials.
- Migrations are forward-only. History starts at `20261006000000_init`, then `20261006093045_pii_policy_overrides` and four folders sharing `20261006120000_` (`management_keys`, `model_templates`, `request_log_content`, `structure_budgets`), which apply in lexical name order. A new migration must use a later timestamp. Generated SQL is committed without comments; data backfills (as in `structure_budgets`) are hand-written `UPDATE`s in the same file.

## Architecture

- Import the client from `@/lib/db/prisma`.
- Do not import Prisma into Client Components.

## Prohibited patterns

- Do not check in generated Prisma client.
- Do not add a seed script.
- Do not use Prisma raw SQL in application code.

## Commands

- `npx prisma generate`
- `npx prisma migrate dev` for new SQL
- `npm run db:migrate` (`prisma migrate deploy`)
- `npx prisma migrate diff --from-empty --to-schema prisma/schema --script` to inspect the full schema SQL
