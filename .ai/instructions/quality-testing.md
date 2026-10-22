---
type: instruction
description: Load for tests, typecheck, lint, or quality gates.
scope: repository
---

# Quality and testing

Load before adding tests or changing the check scripts that CI and `prebuild` run.

## Mandatory rules

- Unit tests are `node:test` files directly in `src/tests/` (`npm test` runs the quoted glob `src/tests/*.test.ts` via `tsx`, so Node expands it and subdirectories are not picked up). Prefer pure modules over rendering App Router pages. Unit tests never touch a database.
- `npm test` sets `NODE_ENV=development` and `DATABASE_URL` and `APP_SECRET` fallbacks; `npm run test:integration` sets `NODE_ENV=development` too.
- Integration tests are `src/tests/integration/**/*.test.ts`, run by `npm run test:integration` against the migrated database in `DATABASE_URL` (no fallback; `APP_SECRET` has one). Files run one at a time (`--test-concurrency=1`). `src/tests/integration/support/register.mjs` resolves `next/headers` to `support/next-request.mjs` (`setRequestHeaders` sets the request headers, cookies stay in memory), and `support/database.ts` provides `uniqueName`, `createUser`, `ownerSession`, and `closeDatabase` (register it with `after`). Each test creates uniquely named rows and deletes them in `finally`, so the suite can run repeatedly against a development database; never assume an empty table.
- Assert behavior, not source text: call the service, route handler, or helper (as a test principal through `runAsPrincipal`, with a fake `globalThis.prisma` from `src/tests/support/` for pure logic, or against the real database in `src/tests/integration/` when a rule depends on queries or transactions). Read source files only for structural guarantees that have no runtime probe, such as Dockerfile and compose layout, migration history, colocation, i18n parity, or the absence of raw SQL.
- `prebuild` must keep `i18n:check`, `styles:check`, and `heroui:check`.
- Typecheck with `npx tsc --noEmit`. Do not weaken `strict`.
- ESLint 10 flat config (`eslint.config.mjs`): `@eslint/js` recommended, `typescript-eslint` recommended, and `eslint-plugin-react-hooks` `recommended-latest` (React Compiler rules). Empty `catch {}` is a lint error: log failures that affect billing, alerts, request logs, credentials, or stored data with `logger` and `errorFields` (`src/lib/logging/format.ts`), and express expected fallbacks with named helpers (`parseJsonOrNull`, `readJsonOr`, `readTextOr` in `src/lib/utils/json.ts`; `cancelQuietly` in `src/lib/utils/streams.ts`). In `src/`, every caught error goes into a log line through `errorFields` (name, code, and the first message line capped at 300 characters), never `String(err)` or a raw `err.message`, which can carry multi-line driver or upstream output with request values. Fix every finding instead of disabling rules.
- `npm run i18n:check` checks en/de key parity and that every message parses as ICU. ICU select keys must not contain `-`.
- Install scripts are denied in `package.json` `allowScripts`; nothing in the build needs them. Review new entries with `npm install-scripts ls` before approving. The root `postinstall` (`prisma generate`) is the project's own script, not a dependency's: `npm ci` leaves a generated client so `tsc` and the tests work at once, and `prisma.config.ts` reads `process.env.DATABASE_URL` instead of Prisma's throwing `env()` so generate needs no database URL (migrate commands still require one).
- Migration order: `npm run migrations:check -- <base-ref>` (`scripts/check-migration-order.mjs`, default `origin/development`) fails when a migration folder that the base ref lacks does not have a later timestamp than the base ref's newest folder, or when a base folder was renamed or removed. `src/tests/migration-history.test.ts` covers the rule through `migrationOrderProblems` and also requires every timestamp to be a real UTC date and time.
- Colocation policy lives in `src/tests/route-view-policy.ts`; it skips `src/tests` and `src/generated` when it walks the source tree. Tests live in `src/tests/` (excluded from the image by `.dockerignore`) and reach the repository root with `new URL("../..", import.meta.url)`, one level deeper from `src/tests/integration/`. Tests must not read `.ai/`; it is documentation only and never enters the image. `src/tests/updater.test.ts` and `src/tests/redactor.test.ts` import the updater and redactor modules from `scripts/updater/` and `scripts/redactor/` directly, because both ship as plain `.mjs` outside `src/`. `src/tests/pii-detector.test.ts` imports `support/redactor-env.ts` first, so `LLMHUB_REDACTOR_URL` is set before the environment is parsed, and answers the redaction protocol from a stub in the gateway harness.
- CI (`.github/workflows/pipeline.yml`, called by `verify.yml` for pull requests and `release.yml` for pushes) runs the `quality` job on a `postgres:18-alpine` service: `npm ci` (generates the client), the migration order check, `prisma migrate deploy`, the schema drift check, `npm test`, `npm run test:integration`, i18n, styles, heroui, tsc, and lint, before the `image` job builds both architectures, runs `scripts/smoke-image.sh` against each, and fails on fixable HIGH or CRITICAL Trivy findings. Pull requests also run dependency review and `npm audit --omit=dev --audit-level=high` (`verify.yml`). `codeql.yml` runs CodeQL separately.

## Prohibited patterns

- Do not add Jest or Vitest alongside `node:test`.
- Do not hit live upstream LLM providers or SMTP from unit or integration tests.
- Do not check in `.env` fixtures with real secrets.

## Commands

- `npm test`
- `DATABASE_URL=... npm run test:integration` after `npm run db:migrate`
- `npm run i18n:check && npm run styles:check && npm run heroui:check`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run migrations:check -- origin/development` after `git fetch origin`
- `npm audit --omit=dev --audit-level=high`
