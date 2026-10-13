# LLM Hub

LLM Hub is a self-hosted gateway for large language models. Applications call one OpenAI- and Anthropic-compatible API (`/api/v1`) with LLM Hub keys, and LLM Hub routes each request to the provider accounts you connect, enforces budgets, rate limits, and data rules, and records usage and cost. An admin console manages providers, models, companies, keys, budgets, and logs.

It ships as one container image backed by PostgreSQL, with optional Redis and S3-compatible storage.

## Features

- **Compatible API.** `/api/v1` serves chat completions, completions, Responses, Anthropic Messages (including token counting), embeddings, moderations, rerank, OCR, images, audio, files, batches, videos, and vector stores with search, so existing OpenAI and Anthropic SDKs work by changing the base URL and key.
- **Providers and routing.** OpenAI, Anthropic, OpenRouter (global and EU), xAI, and any OpenAI-compatible endpoint. Model groups map one alias to several deployments with strategies such as least in-flight, weighted random, lowest cost, priority, round robin, and quota-aware routing, plus fallbacks, cooldowns on upstream failures, and a provider health view. A model catalog discovers provider models every two hours and keeps aliases up to date.
- **Subscription accounts.** Optionally connect ChatGPT, Claude, SuperGrok, and Google Antigravity plans through a device or callback sign-in. They are served from a separate endpoint (`/api/subscription/v1`) and never mix with API-key traffic.
- **Companies and budgets.** Companies, departments, projects, and people form the tenancy model. API keys belong to a project, a person, or a console user. Every level can carry a spend cap with a reset period and temporary boosts; a child cap can never exceed a capped parent. Keys also support RPM and TPM limits, a per-request cost limit, model allowlists, reusable model templates (providers, regions, zero data retention, no training, maximum retention), client IP allowlists, endpoint restrictions, access time windows, expiry, and rotation.
- **Safety and privacy.** PII detection with masking or blocking, configurable guardrail rules on input and output, and policy overrides per company, project, or key. Request and response bodies are stored separately from log metadata, can be switched off per key, user, or person, and follow their own retention period.
- **Usage and cost.** Daily usage rollups, dashboards, chargeback by company, department, and project, price markups, a what-if cost calculator, CSV, JSONL, PDF, and Markdown exports, and scheduled usage report emails. Prompt cache tokens are billed at provider rates, and an optional response cache with semantic matching answers repeated requests.
- **Operations.** Request, spend, and audit logs with filters, retention rules for every log type, signed alert webhooks in JSON, Slack, or Teams format (upstream exhaustion, budget thresholds, spend anomalies, expiring or blocked keys, PII blocks, provider model changes), and a console assistant that answers questions about usage and configuration.
- **Access control.** Console accounts with mandatory two-factor authentication (TOTP, passkeys, recovery codes), editable roles and permissions, company-scoped console users, OIDC single sign-on, SCIM provisioning, and personal management keys for the `/api/mgmt` automation API.

## Quick start

You need Docker with the Compose plugin, bash 5, and a domain that points to the server.

```bash
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/generate-env.sh
chmod +x generate-env.sh
./generate-env.sh
docker compose up -d
```

`generate-env.sh` writes the production `.env` next to `docker-compose.yml`. It asks for the image tag, the public URL, the host port, and the optional mail, single sign-on, and S3 values, sets `NODE_ENV=production`, and generates `APP_SECRET`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD`. It shows a summary with masked secrets and writes the file with mode 600. Without a terminal, or with `--yes`, it takes the defaults and reads answers from the environment (`NEXT_PUBLIC_APP_URL=https://hub.example.com ./generate-env.sh --yes`). An existing `.env` is replaced only with `--force`, which keeps its values and leaves the previous file in `.env.bak`. Keep `APP_SECRET` stable: it encrypts stored provider keys and signs sessions.

The app listens on `127.0.0.1:3000` (`LLMHUB_PORT`). Put a reverse proxy with TLS in front of it, for example Caddy:

```text
hub.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

The app trusts the last `X-Forwarded-For` hop as the client address, so port 3000 must only be reachable through the proxy. Postgres and Redis keep their data in `./postgres-data` and `./redis-data` next to the compose file and are not published on host ports. Migrations run on every container start.

Open `https://hub.example.com/internal-api/setup` to create the owner account. Every account sets up two-factor authentication at its first sign-in. Self-registration stays off until you enable it in Admin settings. Then connect a provider on the Providers page, create a key on the Keys page, and call the API:

```bash
curl https://hub.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer $LLMHUB_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'
```

Health and version probes are `GET /internal-api/health` (liveness, includes the worker mode), `GET /internal-api/ready` (database read), and `GET /internal-api/version` (release version and start time).

## Configuration

The app reads the variables below; `.env.example` is the template for local development. Everything else, such as S3 bucket settings, the OIDC issuer and client id, registration, retention, PII and guardrail policies, and alert webhooks, is configured in Admin settings and stored in the database.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | none | `production` or `development`. Any other value stops the container before it starts. The compose file and the image set `production`. |
| `DATABASE_URL` | yes | none | PostgreSQL connection string. The compose files build it from the `POSTGRES_*` values and override any value in `.env`. |
| `APP_SECRET` | yes | none | At least 32 characters. Derives the keys that encrypt provider credentials, secret settings, and TOTP secrets, and signs sessions and sign-in state. Changing it invalidates all of these. |
| `NEXT_PUBLIC_APP_URL` | no | `http://localhost:3000` | Public origin of the console. Used for same-origin checks, redirects, password reset links, the OIDC callback, and passkeys (which need HTTPS with a domain, or `localhost`). |
| `REDIS_URL` | no | unset | Redis connection URL. Runs background jobs on BullMQ queues and shares rate limits, the response cache, and provider cooldowns between replicas. Without it each process runs the jobs on timers and keeps limits and cache in memory. The compose files set it from `REDIS_PASSWORD`. |
| `S3_ACCESS_KEY_ID` | no | unset | Access key for S3-compatible storage. Bucket, region, endpoint, and addressing are set in Admin settings. |
| `S3_SECRET_ACCESS_KEY` | no | unset | Secret key for S3-compatible storage. |
| `SMTP_URL` | no | unset | `smtp://user:pass@host:587` or `smtps://user:pass@host:465`. Enables password reset and usage report emails. Without it password reset is turned off. |
| `SMTP_FROM` | no | `llmhub@localhost` | Sender address for outgoing mail. |
| `OIDC_CLIENT_SECRET` | no | unset | Client secret for OIDC single sign-on. The issuer and client id are set in Admin settings. |
| `BUILD_ID` | no | `development` | Release version reported by `/internal-api/version` and used by the update check. Published images set it at build time; do not set it yourself. |

The compose files also read these values from `.env`. They configure the Postgres and Redis containers and are not read by the app:

| Variable | Default from `generate-env.sh` | Purpose |
| --- | --- | --- |
| `LLMHUB_TAG` | `latest` | Image tag of `ghcr.io/nicolaeser/llmhub`. |
| `LLMHUB_PORT` | `3000` | Host port on `127.0.0.1` for the reverse proxy. |
| `POSTGRES_USER` | `llmhub` | Database user. |
| `POSTGRES_DB` | `llmhub` | Database name. |
| `POSTGRES_PASSWORD` | random | Database password. |
| `REDIS_PASSWORD` | random | Redis password (`--requirepass`). |

The image sets `PORT=3000`, `HOSTNAME=0.0.0.0`, and `NODE_ENV=production`.

### Storage

S3 is optional. Without it, uploaded files, batch input and output, generated images and videos, stored responses, and vector store files are kept in PostgreSQL as `bytea` rows, which grows the database and its backups. With S3 configured (both access keys in `.env` and the bucket in Admin settings), new objects go to the bucket, the database keeps only their metadata, and request logs can also be archived to the bucket. Objects stored before S3 was enabled stay in PostgreSQL.

## Backup and restore

All durable state lives in PostgreSQL, in S3 if you use it, and in `.env`. Back up `.env` together with the database: without the same `APP_SECRET`, encrypted provider credentials and two-factor secrets cannot be read. Redis only holds queues, counters, and caches and does not need a backup.

Create a backup from the directory that holds `docker-compose.yml`:

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "llmhub-$(date +%Y%m%d-%H%M%S).dump"
```

Restore a backup into the running database:

```bash
docker compose stop app
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' < llmhub-20261012-120000.dump
docker compose start app
```

Restore with the same or a newer image than the one that wrote the backup. A newer image applies its migrations when it starts.

## Upgrading

`docker-compose.yml` runs `ghcr.io/nicolaeser/llmhub:${LLMHUB_TAG}`, `latest` by default. For controlled upgrades, set `LLMHUB_TAG` in `.env` to a release tag instead, for example `v2026.10.12.abc1234`. Every release on the [releases page](https://github.com/nicolaeser/llmhub/releases) lists its tags and image digest. The `dev` tag follows the `development` branch and is published as a prerelease.

1. Back up the database and `.env` as described above.
2. Change `LLMHUB_TAG` in `.env`.
3. Run `docker compose pull app && docker compose up -d`.
4. Check `/internal-api/ready` and `/internal-api/version`.

Each container start applies pending migrations under a database lock before the server starts, so several replicas can start at the same time. Migrations are forward-only. To roll back, restore the backup taken before the upgrade and start the previous tag.

## Development

Requirements: Node.js 24 or newer and Docker.

```bash
cp .env.example .env
openssl rand -hex 32
docker compose -f docker-compose.dev.yml up -d postgres redis rustfs
npm ci
npx prisma generate
npm run db:migrate
npm run dev
```

Put the generated value into `APP_SECRET` in `.env`. `.env.example` sets `NODE_ENV=development` and points `DATABASE_URL` at Postgres on `127.0.0.1:5433`, `REDIS_URL` at Redis on `127.0.0.1:6379` (BullMQ), and the S3 keys at RustFS on `127.0.0.1:9000` (console on `127.0.0.1:9001`). `docker compose -f docker-compose.dev.yml up --build` builds and runs the production image locally.

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests (`test/*.test.ts`, no database needed). |
| `npm run test:integration` | Integration tests (`test/integration/`) against the migrated database in `DATABASE_URL`. They create and remove their own rows. |
| `npx tsc --noEmit` | Type check. |
| `npm run lint` | ESLint. |
| `npm run i18n:check`, `npm run styles:check`, `npm run heroui:check` | Translation parity and UI conventions; also run before every build. |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL`. |

To run the integration tests against the development database:

```bash
DATABASE_URL="postgresql://llmhub:<POSTGRES_PASSWORD>@127.0.0.1:5433/llmhub" npm run test:integration
```

CI runs the same checks and the integration tests against a fresh PostgreSQL 18 database, verifies that the migrations match the Prisma schema, and publishes the image to GitHub Container Registry on pushes to `main` and `development`.

Contributor and architecture notes live in [`.ai/`](.ai/SUMMARY.md).

## License

All rights reserved. This repository is published without a license, and no license is granted to use, copy, modify, or distribute this software or any part of it.
