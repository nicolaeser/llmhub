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
- The operator model is `User` with one `roleId` and `isOwner`. `Role` stores a `permissions` string array and an optional `templateKey`. Auth state lives in `Session`, `UserTotp`, `RecoveryCode`, `UserPasskey`, `LoginChallenge`, `AuthCeremony`, `UserSecurityEvent`, and `ManagementKey` (`prisma/schema/auth.prisma`). SSO and SCIM identity lives in `UserIdentity` (`issuer` + `subject` unique, `userId` + `issuer` unique, cascade delete), `User.externalId` (SCIM, unique), and `ScimGroup` / `ScimGroupMember` (cascade on group and user).
- Containers apply `prisma/migrations` on every start through `scripts/migrate-deploy.mjs`, which runs the bundled Prisma CLI (`prisma migrate deploy`, then `prisma migrate status`) under a Postgres advisory lock. Locally `npm run db:migrate` runs the same CLI. The app itself never migrates.
- `RequestLog` keeps metadata only. Prompt and response bodies live in `RequestLogContent` (1:1 by `logId`, cascade delete), so log lists and counts never load bodies; content retention deletes those rows and keeps the metadata.
- `RequestLog` and `SpendEvent` are write-heavy. Their tenancy indexes pair the column with `createdAt` because the logs explorer, exports, dashboard p95, usage reports, and spend anomaly alerts filter a scope plus a time range and sort by `createdAt`: `RequestLog` `(keyId|userId|teamId|orgId|projectId|memberId, createdAt)` plus `createdAt` and `status`; `SpendEvent` `(keyId|userId|orgId|projectId, createdAt)` plus `createdAt`, `model`, `teamId`, `memberId`. Replace a single-column index with the composite instead of adding both. `GatewayAuditLog` reads only by `createdAt`; `UsageDaily` reads by day ranges through its primary key, which leads with `day`.
- String status and kind columns stay `TEXT` validated in code; do not convert them to Postgres enums. Migrations run on every container start, and an enum cast fails on any unknown legacy value, which would stop the container from booting.
- Deleting a console user goes through `removeUserWithInternalKeys` (`src/lib/auth/user-removal.ts`, used by `deleteUser` and SCIM delete): one transaction deletes the user's internal keys, their `TempBudget` rows (`entityType: "key"`), and the user's own boosts, then the user (`isOwner: false` guard); the audit row records `revokedKeys`. Project and person keys stay with `userId` set to null.
- Money columns are `Decimal(20,10)`. `UsageDaily` is the per-day rollup keyed by day, key, team, org, project, member, user, and model; it is updated with an atomic upsert per request.
- Budget holders are `VirtualKey`, `User`, `Member`, `Project`, `Team`, and `Organization`, each with `maxBudget`, `spend`, `budgetDuration`, and `spendResetAt`. `TempBudget` rows (`entityType` `key` | `user` | `member` | `project` | `team` | `org`) are boosts; the maintenance sweep deletes expired ones.
- `Organization` is a customer company, `Team` its department, `Project` belongs to a company (`orgId`) and optionally a department, and `Member` is a person of a company (not a console user). `User.orgId` is a console user's company access scope (`null` is a platform user; `onDelete: Restrict`). Tenancy is denormalized: a key stores `orgId` and `teamId` copied from its project or member, and an internal key stores its owner's `orgId`. Company actions update those copies in the same transaction when a project's or person's department changes, and changing a console user's company updates their internal keys; any new write path must do the same. Deleting a project or member deletes its keys.
- `ModelTemplate` links to keys through `VirtualKeyTemplate` (`onDelete: Restrict` on the template, so a template in use cannot be deleted). Provider data-handling facts (`zdr`, `retentionDays`, `region`, `noTraining`) live on `ProviderConnection` and feed template matching. Account access lives in `ProviderAssignment` (one nullable foreign key per scope: organization, team, project, member, or key, cascade delete, unique per provider and target) together with `ProviderConnection.restricted`; per-provider routing lives in `AccountRouting` (`kind` primary key), including the automatic banked-reset policy `autoReset` (default off), `autoResetPercent` (default 99), and `autoResetScope` (`pool` or `account`, `TEXT` checked in code; migration `20261019143000_account_auto_reset`). Subscription sign-ins live in `ProviderLogin` (1:1 by `providerId`, cascade delete) with sealed tokens, `status` `active` | `expired`, `version` / `leaseUntil` for refresh, and `refreshedAt` / `retryAt` / `failures` for the refresh schedule and backoff (migration `20261019210000_provider_login_refresh`); token refreshes never touch `ProviderConnection.updatedAt`, which model discovery uses for optimistic writes. Subscription limits live in `ProviderLimitSnapshot` (1:1 by `providerId`, cascade delete): `limits` and the banked-reset view `resets` as JSON, `resetsAt`, `error`, `fetchedAt` (last success), `checkedAt` (last attempt), `nextAt`, `retryAt`, `failures`, `loginVersion`, the fetch lease `leaseUntil` / `leaseToken`, and `version`, which grows with every content write and drives live change detection (migration `20261020090000_provider_limit_snapshots`); it is written directly, never through `ProviderConnection`, so `updatedAt` there stays untouched. Add-account links live in `SubAddLink` (`tokenHash` unique, `kinds`, `maxAccounts` null for unlimited, monotonic `added`, `expiresAt`, `revokedAt`, `restricted`), its restriction targets in `SubAddTarget` (same nullable-foreign-key shape as `ProviderAssignment`, unique per link and target), and each contributed account in `SubAddAccount` (1:1 by `providerId`, cascade delete with the provider, `manageHash` indexed; migration `20261019230000_sub_add_links`).
- Small operational state lives in `Setting` rows rather than tables: banked-reset claims and leases (`provider_reset:<providerId>`, `provider_reset_lock:<providerId>`, `provider_reset_auto_lock:<kind>`, `provider_reset_pool:<kind>`), the updater's last report (`updater_status`) and pending console request (`updater_command`), next to the existing locks such as `model_catalog_lock` and `maintenance_sweep_lock`.
- `piiPolicy` and `guardrailPolicy` on `Organization`, `Project`, and `VirtualKey` are nullable JSON overrides; `null` inherits.
- There is no seed. `ensureSystemCatalog` upserts the role templates once (`Setting` `role_templates_seeded`) and default settings at boot; it never creates users or credentials.
- Migrations are forward-only. History starts at `20261006000000_init`, then `20261006093045_pii_policy_overrides` and four folders sharing `20261006120000_` (`management_keys`, `model_templates`, `request_log_content`, `structure_budgets`), which apply in lexical name order, then `20261006140000_role_assistant_tools` and `20261006150000_customer_tenancy` (members, `Project.orgId`, team-bound and old personal keys moved into one project per department or company, console users reset to platform scope), and later folders, including seven sharing `20261009120000_` (`cache_stats`, `guardrail_policies`, `key_access_restrictions`, `key_max_request_cost`, `prompt_cache_usage`, `usage_reports`, `vector_stores`), and `20261013110000_remove_assistant` (drops `Role.assistantToolsDisabled` and strips `assistant:use` from role permissions). Applied folders are never renamed. A new migration must use a later timestamp than every folder; `src/tests/migration-history.test.ts` fails on any other shared timestamp, on renamed applied folders, and on `--` comments. Generated SQL is committed without comments; data backfills (as in `structure_budgets`) are hand-written `UPDATE`s in the same file.

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
- `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code` after `npm run db:migrate` to prove there is no drift (CI runs it)
