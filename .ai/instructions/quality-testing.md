---
type: instruction
description: Load for tests, typecheck, lint, or quality gates.
scope: repository
---

# Quality and testing

Load before adding tests or changing the check scripts that CI and `prebuild` run.

## Mandatory rules

- Unit tests are `node:test` files under `test/**/*.test.ts` via `tsx`. Prefer pure modules over rendering App Router pages.
- `npm test` sets `DATABASE_URL` and `APP_SECRET` fallbacks.
- `prebuild` must keep `i18n:check`, `styles:check`, and `heroui:check`.
- Typecheck with `npx tsc --noEmit`. Do not weaken `strict`.
- ESLint 10 flat config (`eslint.config.mjs`): `@eslint/js` recommended, `typescript-eslint` recommended, and `eslint-plugin-react-hooks` `recommended-latest` (React Compiler rules). Empty `catch {}` is allowed; fix every other finding instead of disabling rules.
- `npm run i18n:check` checks en/de key parity and that every message parses as ICU. ICU select keys must not contain `-`.
- Install scripts are denied in `package.json` `allowScripts`; nothing in the build needs them. Review new entries with `npm install-scripts ls` before approving.
- Colocation policy lives in `test/route-view-policy.ts`. Tests must not read `.ai/`; it is documentation only and never enters the image.
- CI (`.github/workflows/development.yml`, `.github/workflows/main.yml`) runs the `quality` job (generate, test, i18n, styles, heroui, tsc, lint) before the image `build` job.

## Prohibited patterns

- Do not add Jest or Vitest alongside `node:test`.
- Do not hit live upstream LLM providers or SMTP from unit tests.
- Do not check in `.env` fixtures with real secrets.

## Commands

- `npm test`
- `npm run i18n:check && npm run styles:check && npm run heroui:check`
- `npx tsc --noEmit`
- `npm run lint`
