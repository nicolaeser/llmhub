---
type: instruction
description: Load for tests, typecheck, lint, or quality gates.
scope: repository
---

# Quality and testing

Load before adding tests or changing the check scripts that CI and `prebuild` run.

## Mandatory rules

- Unit tests are `node:test` files directly in `test/` (`npm test` runs the quoted glob `test/*.test.ts` via `tsx`, so Node expands it and subdirectories are not picked up). Prefer pure modules over rendering App Router pages. Unit tests never touch a database.
- `npm test` sets `DATABASE_URL` and `APP_SECRET` fallbacks.
- Integration tests are `test/integration/**/*.test.ts`, run by `npm run test:integration` against the migrated database in `DATABASE_URL` (no fallback; `APP_SECRET` has one). Files run one at a time (`--test-concurrency=1`). `test/integration/support/register.mjs` resolves `next/headers` to `support/next-request.mjs` (`setRequestHeaders` sets the request headers, cookies stay in memory), and `support/database.ts` provides `uniqueName`, `createUser`, `ownerSession`, and `closeDatabase` (register it with `after`). Each test creates uniquely named rows and deletes them in `finally`, so the suite can run repeatedly against a development database; never assume an empty table.
- `prebuild` must keep `i18n:check`, `styles:check`, and `heroui:check`.
- Typecheck with `npx tsc --noEmit`. Do not weaken `strict`.
- ESLint 10 flat config (`eslint.config.mjs`): `@eslint/js` recommended, `typescript-eslint` recommended, and `eslint-plugin-react-hooks` `recommended-latest` (React Compiler rules). Empty `catch {}` is allowed; fix every other finding instead of disabling rules.
- `npm run i18n:check` checks en/de key parity and that every message parses as ICU. ICU select keys must not contain `-`.
- Install scripts are denied in `package.json` `allowScripts`; nothing in the build needs them. Review new entries with `npm install-scripts ls` before approving.
- Colocation policy lives in `test/route-view-policy.ts`. Tests must not read `.ai/`; it is documentation only and never enters the image.
- CI (`.github/workflows/pipeline.yml`, called by `main.yml` and `development.yml`) runs the `quality` job on a `postgres:18-alpine` service: generate, `prisma migrate deploy`, the schema drift check, `npm test`, `npm run test:integration`, i18n, styles, heroui, tsc, and lint, before the `image` job. `codeql.yml` runs CodeQL separately.

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
