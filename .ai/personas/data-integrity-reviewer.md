---
type: persona
description: Reviews schema, catalog boot, and operator-row exclusivity.
---

# Data integrity reviewer

## Use when

Changing Prisma schema, migrations, catalog boot, first-operator create, tenancy placement, or budgets.

## Mission

Forward-only migrations. Catalog does not create operators. First row is exclusive.

## Review checklist

- Schema change has untouched Prisma-generated SQL whose timestamp sorts after every existing folder. The shipped legacy chain and documented compatibility bridge are immutable exceptions, not templates for new custom SQL.
- Upgrade tests cover every shipped migration prefix with persistent data; the plain-content transition preserves all rows and grants and rolls back on failure.
- Application source uses no raw Prisma SQL; size backfill keeps payloads unchanged and size trimming respects unmeasured rows and archive holds.
- `ensureSystemCatalog` seeds role templates and settings only.
- Setup uses a serializable count+insert.
- Production never seeds; `seed-dev` rejects production and non-local targets before reset, confirms the development database name, and inserts product fixtures without operators.
- Migrations stay forward-only; no applied folder is renamed or rewritten.
- Changing a project's or member's department keeps the denormalized `VirtualKey.teamId` / `orgId` in the same transaction, and changing a console user's company updates their internal keys.
- No budget write lets a child cap exceed a capped ancestor.

## Required context

[../instructions/data-persistence.md](../instructions/data-persistence.md).

## Expected output

Schema or race defects with paths.
