# System overview

Load when work crosses the console, `/api/v1` gateway, auth, or process boot.

LLM Hub is a Next.js 16 App Router app: OpenAI- and Anthropic-compatible `/api/v1` API, management `/api/mgmt`, session-cookie admin console, SCIM, and OIDC SSO.

## Processes

- Web (`next start` / `next dev`) serves HTML, server actions, `/api/v1`, `/api/mgmt`, `/internal-api`, `/sso`, `/scim`.
- Postgres is the durable store (Prisma 7 + `@prisma/adapter-pg`).
- Optional RustFS/S3 holds files, batches, videos, and log archives.
- `src/instrumentation.ts` starts an in-process worker (`src/worker/`) after catalog boot: a maintenance sweep every minute (it also revalidates SSO sessions with the identity provider, see `sso_revalidation`), the cached model catalog refresh every two hours, and alert webhook delivery. Optional Redis (`REDIS_URL`) runs it on the BullMQ `maintenance`, `models`, and `webhooks` queues (`QUEUE_NAMES`, `src/lib/jobs/queues.ts`) and shares RPM/TPM; without it the same jobs use process timers and inline delivery. Redis is never awaited at bind time. No separate worker process.
- Optional updater container (`docker-compose.au.yml`, `scripts/updater.mjs`): same image, holds the Docker socket, and replaces the app container with newer images of its tag on request or automatically.

## Route groups

- `src/app/(app)/` — authenticated console. Layout requires a session.
- `src/app/account/` — login, register, password reset. Public except when a session already exists.
- `src/app/internal-api/` — health, ready, version, the console live stream (`live`), the signed updater bridge (`updater`), account HTTP, playground chat, API reference try-out, log/usage export, the MCP Anything draft upload, first-admin setup.
- `src/app/api/v1/` — OpenAI-compatible gateway. Virtual keys only (plus console try-tokens). `src/app/api/subscription/v1/` serves the same API from signed-in subscription accounts.
- `src/app/api/mgmt/` — management API over the console actions. Management keys only.
- `src/app/sso/` and `src/app/scim/` — enterprise login and provisioning.

`src/proxy.ts` gates HTML routes. Its matcher skips `/api`, `/internal-api` (except the `/internal-api/setup` page), `/sso`, `/scim`, and static assets. `/internal-api/setup` is reachable only while no `User` exists.

## Vocabulary

- Operator: a `User` row. The first operator is created at `/internal-api/setup` as the owner with the `admin` template role.
- Role: an editable permission bundle; templates are `admin`, `operator`, `finance`, `viewer`.
- Company (`Organization`): a customer. Departments (`Team`) hold shared budgets and RPM/TPM limits; projects (`Project`) and people (`Member`, the company's own users who never sign in) belong to a company and optionally a department. Managed on the Companies page (`src/app/(app)/companies/`, `src/types/structure.ts`).
- Console user (`User`): signs in to the console. Without `orgId` a platform user; with `orgId` restricted to that company and `COMPANY_PERMISSIONS`.
- Budget: `maxBudget` plus optional period on a key, console user, member, project, department, or company. Temporary boosts (`TempBudget`) raise a cap until they expire.
- API key (`VirtualKey`): hashed credential for `/api/v1`, bound to one project (project key) or one member (personal key), or an internal key of the console user who owns it; plus model list, model templates, RPM/TPM, client IP allowlist, and guardrail overrides (`PolicyOverride`), with a request-content logging switch.
- Model template (`ModelTemplate`, "model preset" in the English UI, on the Models page): reusable model-access rule set (aliases, glob patterns, providers, data regions, ZDR, no-training, maximum retention) attached to keys; matching aliases are resolved at authentication time.
- Request log: one `RequestLog` row per metered gateway request, including cache hits, upstream failures, and PII blocks (tenancy, endpoint, routing, status, tokens, cost, PII markers). Prompt and response bodies live in `RequestLogContent`.
- Request label: an allowlisted `key:value` pair a client attaches to a request for chargeback (`RequestLog.labels`, rolled up in `UsageLabelDaily`); the platform and each company keep their own key allowlist. The older single `tag` stays alongside.
- Agent session: the request log rows of one Claude Code, Codex, or other agent run, grouped by the client's session id, with totals for cost, tokens, requests, account switches, and errors, listed on the Logs page's Sessions tab and opened as a chat or request timeline on `/logs/session`.
- New-model mode (`ProviderConnection.newModels`): per provider, whether first-seen models follow the catalog's default rules (`auto`), are routed at once (`active`), or start disabled (`disabled`).
- Management key (`ManagementKey`): hashed personal credential for `/api/mgmt`, scoped to a subset of the owner's permissions.
- SCIM token: hashed in `Setting` `scim_token_hash`; created in Settings → Sign-in.
- Enterprise: JSON settings in `Setting` `enterprise` (registration, OIDC, S3, global PII policy, cache TTL, retention, alert webhooks, budget alert thresholds, log archive, request-content logging, automatic updates). Webhook secrets are sealed and never sent to the client.

## Boot

`src/instrumentation.ts` initializes Sentry when a DSN is set (`src/sentry.server.config.ts`), ensures the system catalog on Node, then starts the in-process worker. Migrations run only in the image `CMD`, on every container start. There is no seed. Instrumentation skips `next build`; on Edge it only loads `src/sentry.edge.config.ts`. Health includes `worker.mode`: `bullmq`, `local`, or `unavailable`.
