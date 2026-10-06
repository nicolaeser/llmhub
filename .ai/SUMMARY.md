# Context index

Load `BASE.md` first. Then open only the documents below that match the task.

## Core

- [BASE.md](BASE.md) — Always-loaded conduct, safety, and compact routing; load before any other project work.
- [AI.md](AI.md) — Governance for this directory; load when creating or revising `.ai/` documents.
- [STYLE.md](STYLE.md) — Sole visual, layout, HeroUI, sizing, overflow, and accessibility contract; load for any UI, theme, motion, or a11y work.

## Knowledge

- [knowledge/system-overview.md](knowledge/system-overview.md) — Process split, worker jobs, route groups, and product vocabulary (structure, budgets, model templates); load when work crosses console, gateway, or boot.
- [knowledge/pitfalls.md](knowledge/pitfalls.md) — Verified traps and stale paths; load when debugging surprises or conflicting docs.
- [knowledge/next-intl-icu.md](knowledge/next-intl-icu.md) — ICU messages, formatters, and anti-patterns for next-intl; load when changing strings, counts, dates, money, or lists.

## Instructions

- [instructions/frontend.md](instructions/frontend.md) — Next.js 16, client state, HeroUI, `_components/`, console navigation, and proxy; load for App Router or component work.
- [instructions/backend.md](instructions/backend.md) — Server actions, gateway libraries, budgets, model access, PII resolution, alerts, model sync, request logging, and serializable writes; load for `src/lib` or `_action.ts`.
- [instructions/data-persistence.md](instructions/data-persistence.md) — Prisma split schema, auth, tenancy, budget, and template models, catalog boot, and migration history; load when changing schema or migrations.
- [instructions/api.md](instructions/api.md) — `/v1`, `/api`, `/internal-api`, SCIM, and SSO contracts plus error formats; load when changing HTTP routes or errors.
- [instructions/security-privacy.md](instructions/security-privacy.md) — Sessions, mandatory two-factor, passkeys, roles, permissions, management keys, setup, PII policy overrides, and request-content logging; load for login, account security, roles, keys, PII, logs, or data rights.
- [instructions/quality-testing.md](instructions/quality-testing.md) — node:test and prebuild gates; load when adding tests or CI-facing checks.
- [instructions/operations.md](instructions/operations.md) — Env, Docker and compose data mounts, boot migrate, worker schedules, build version, and probes; load for deploy or runtime config.
- [instructions/content-localization.md](instructions/content-localization.md) — en/de namespaces, ICU, and formatters; load when changing strings or public copy.

## Playbooks

- [playbooks/build-ui.md](playbooks/build-ui.md) — Steps to change a screen onto STYLE.md and HeroUI primitives; load when implementing or restyling UI.
- [playbooks/database-migration.md](playbooks/database-migration.md) — Forward-only Prisma migration steps; load when shipping schema SQL.
- [playbooks/release-deploy.md](playbooks/release-deploy.md) — Build, migrate-on-start, and probes; load when releasing or debugging boot.
- [playbooks/update-ai-context.md](playbooks/update-ai-context.md) — Re-audit this system; load when maintaining `.ai/`.

## Personas

- [personas/accessibility-reviewer.md](personas/accessibility-reviewer.md) — Keyboard, naming, contrast, and FieldError audit; apply on forms, overlays, or responsive chrome.
- [personas/style-enforcer.md](personas/style-enforcer.md) — Token, primitive, unit, and overflow review; apply on visual changes.
- [personas/application-security-reviewer.md](personas/application-security-reviewer.md) — Tenant isolation, secret, PII, and log-content review; apply on auth, management keys, internal-api, assistant tools, and request logs.
- [personas/data-integrity-reviewer.md](personas/data-integrity-reviewer.md) — Schema, migration order, catalog, tenancy copies, budget caps, and first-row exclusivity; apply on Prisma, setup, or structure changes.
- [personas/delivery-reliability-reviewer.md](personas/delivery-reliability-reviewer.md) — Preflight, migrate-on-start, compose data, and build-version review; apply on deploy or env.
- [personas/content-localization-steward.md](personas/content-localization-steward.md) — Locale parity and ICU review; apply on copy.
