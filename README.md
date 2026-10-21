# LLM Hub

LLM Hub is a self-hosted gateway for large language models. Applications call one OpenAI- and Anthropic-compatible API (`/api/v1`) with LLM Hub keys, and LLM Hub routes each request to the provider accounts you connect, enforces budgets, rate limits, and data rules, and records usage and cost. An admin console manages providers, models, companies, keys, budgets, and logs.

It ships as one container image backed by PostgreSQL, with optional Redis and S3-compatible storage.

## Features

- **Compatible API.** `/api/v1` serves chat completions, completions, Responses, Anthropic Messages (including token counting), embeddings, moderations, rerank, OCR, images, audio, files, batches, videos, and vector stores with search, so existing OpenAI and Anthropic SDKs work by changing the base URL and key.
- **Providers and routing.** OpenAI, Anthropic, OpenRouter (global and EU), xAI, the Kimi API Platform (global and China), the Meta Model API, Google Gemini API, Google Vertex AI (service account key with project and location, or an express mode API key; Gemini, Claude, Imagen, and partner models), and any OpenAI-compatible endpoint. Model groups map one alias to several deployments with strategies such as least in-flight, weighted random, lowest cost, priority, round robin, and quota-aware routing, plus fallbacks, cooldowns on upstream failures, and a provider health view. A model catalog discovers provider models every two hours and keeps aliases up to date.
- **Subscription accounts.** Optionally connect ChatGPT, Claude, SuperGrok, Google Antigravity, Kimi Code (kimi.com or kimi.ai), Meta Muse Code, and Devin plans through a device or callback sign-in, or move them over once from CLIProxyAPI or EasyCLIProxyAPI (auth files, pasted JSON, or straight from a running CLIProxyAPI through its management API; every account is checked with its provider first and can be removed at the source so the two never invalidate each other's rotating tokens). A session stays on one account and moves to the next account with its full conversation when that account hits its limit or loses its sign-in. They are served from a separate endpoint (`/api/subscription/v1`) and never mix with API-key traffic. The server reads each account's plan limits about every five minutes (once across all replicas, sooner right after a limit resets, backing off when a provider rate-limits the check) and pushes changes live to open consoles, so open tabs never add provider calls and a manual refresh adds at most one per account per minute.
- **Companies and budgets.** Companies, departments, projects, and people form the tenancy model. API keys belong to a project, a person, or a console user. Every level can carry a spend cap with a reset period and temporary boosts; a child cap can never exceed a capped parent. Keys also support RPM and TPM limits, a per-request cost limit, model allowlists, reusable model templates (providers, regions, zero data retention, no training, maximum retention), client IP allowlists, endpoint restrictions, access time windows, expiry, and rotation.
- **Safety and privacy.** PII detection with masking or blocking, configurable guardrail rules on input and output, and policy overrides per company, project, or key. Request and response bodies are stored separately from log metadata, can be switched off per key, user, or person, and follow their own retention period (30 days by default, like request logs).
- **Usage and cost.** Daily usage rollups, dashboards, chargeback by company, department, and project, price markups, CSV, JSONL, PDF, and Markdown exports, and scheduled usage report emails. Prompt cache tokens are billed at provider rates, and an optional response cache with semantic matching answers repeated requests.
- **Operations.** Request, spend, and audit logs with filters, retention rules for every log type, signed alert webhooks in JSON, Slack, or Teams format (upstream exhaustion, budget thresholds, spend anomalies, expiring or blocked keys, PII blocks, provider model changes).
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

`generate-env.sh` writes the production `.env` next to `docker-compose.yml` and walks you through the setup. It checks for Docker Compose and the compose file, then asks for the domain (`hub.example.com` becomes `https://hub.example.com`), the release channel (`latest`, `dev`, or a pinned release tag), the host port, and whether client addresses come from the reverse proxy or from Cloudflare (`IP_MODE`). Mail, the OpenID Connect client secret, and S3 keys are optional; the SMTP URL is built from host, encryption, user, and password. It sets `NODE_ENV=production`, generates `APP_SECRET`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD`, shows a summary with masked secrets, writes the file with mode 600, and prints the reverse proxy block and the next commands. Without a terminal, or with `--yes`, it takes the defaults and reads answers from the environment (`NEXT_PUBLIC_APP_URL=https://hub.example.com ./generate-env.sh --yes`). An existing `.env` is replaced only with `--force`, which keeps its values and leaves the previous file in `.env.bak`. Keep `APP_SECRET` stable: it encrypts stored provider keys and signs sessions.

The app listens on `127.0.0.1:3000` (`LLMHUB_PORT`). Put a reverse proxy with TLS in front of it, for example Caddy:

```text
hub.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Sign-in limits, sessions, the audit log, and key IP allowlists use the client address that `IP_MODE` selects. The default `proxy` takes the last `X-Forwarded-For` entry, the one your reverse proxy appends, so port 3000 must only be reachable through the proxy. With Cloudflare in front, set `IP_MODE=cloudflare` and accept web traffic only from Cloudflare. Postgres and Redis keep their data in `./postgres-data` and `./redis-data` next to the compose file and are not published on host ports. Migrations run on every container start.

Open `https://hub.example.com/internal-api/setup` to create the owner account. Every account sets up two-factor authentication at its first sign-in. Self-registration stays off until you enable it in Settings. Then connect a provider on the Providers page, create a key on the Keys page, and call the API:

```bash
curl https://hub.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer $LLMHUB_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'
```

Health and version probes are `GET /internal-api/health` (liveness, includes the worker mode), `GET /internal-api/ready` (database read), and `GET /internal-api/version` (release version and start time).

## Configuration

The app reads the variables below; `.env.example` is the template for local development. Everything else, such as S3 bucket settings, the OIDC issuer and client id, registration, retention, PII and guardrail policies, and alert webhooks, is configured on the Settings page and stored in the database. Request logs and stored prompts and responses are deleted after 30 days and account security activity after 90 days unless Settings → Logging & alerts sets other values (0 keeps them); installations that never saved those settings move to these defaults when they upgrade.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | none | `production` or `development`. Any other value stops the container before it starts. The compose file and the image set `production`. |
| `DATABASE_URL` | yes | none | PostgreSQL connection string. The compose files build it from the `POSTGRES_*` values and override any value in `.env`. |
| `APP_SECRET` | yes | none | At least 32 characters. Derives the keys that encrypt provider credentials, secret settings, and TOTP secrets, and signs sessions and sign-in state. Changing it invalidates all of these. |
| `NEXT_PUBLIC_APP_URL` | no | `http://localhost:3000` | Public origin of the console. Used for same-origin checks, redirects, password reset links, the OIDC callback, and passkeys (which need HTTPS with a domain, or `localhost`). |
| `REDIS_URL` | no | unset | Redis connection URL. Runs background jobs on BullMQ queues and shares rate limits, the response cache, and provider cooldowns between replicas. Without it each process runs the jobs on timers and keeps limits and cache in memory. The compose files set it from `REDIS_PASSWORD`. |
| `IP_MODE` | no | `proxy` | Where the client address comes from. `proxy`: the last `X-Forwarded-For` entry, appended by a reverse proxy that is the only way to reach the app. `cloudflare`: `CF-Connecting-IP`; the origin must accept traffic only from Cloudflare (its address ranges or a Cloudflare Tunnel). `direct`: the TCP peer of the connection, for an app port that clients reach without a proxy; every forwarding header is ignored. Other headers never count, an address that cannot be read counts as unknown, and any other value stops the start. |
| `S3_ACCESS_KEY_ID` | no | unset | Access key for S3-compatible storage. Provider preset, bucket, region, endpoint, and addressing are set in Settings → Storage, which also tests the connection. |
| `S3_SECRET_ACCESS_KEY` | no | unset | Secret key for S3-compatible storage. |
| `SMTP_URL` | no | unset | `smtp://user:pass@host:587` or `smtps://user:pass@host:465`. Enables password reset and usage report emails. Without it password reset is turned off. |
| `SMTP_FROM` | no | `llmhub@localhost` | Sender address for outgoing mail. |
| `OIDC_CLIENT_SECRET` | no | unset | Client secret for OIDC single sign-on. The issuer, client id, group to role rules, and SSO-only mode are set in Settings → Sign-in; the redirect URI is `NEXT_PUBLIC_APP_URL/sso/callback`. |
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

`docker-compose.yml` and `docker-compose.au.yml` cap the memory of each container and rotate container logs (`json-file`, five files of 10 MB per container). `generate-env.sh` does not write the caps; add them to `.env` only to change the defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLMHUB_MEMORY_LIMIT` | `4g` | Memory cap of the app. Node sizes its heap at about half of it, so lower values also shrink the heap. |
| `POSTGRES_MEMORY_LIMIT` | `2g` | Memory cap of Postgres. |
| `REDIS_MEMORY_LIMIT` | `1g` | Memory cap of Redis. |

The updater in `docker-compose.au.yml` is capped at 256 MB. On `docker compose stop`, `down`, or an update, the app gets 330 seconds to finish open requests and streams (`stop_grace_period`), because API requests may run for up to 300 seconds.

The image sets `PORT=3000`, `HOSTNAME=0.0.0.0`, and `NODE_ENV=production`.

### Storage

S3 is optional. Without it, uploaded files, batch input and output, generated images and videos, stored responses, and vector store files are kept in PostgreSQL as `bytea` rows, which grows the database and its backups. With S3 configured (both access keys in `.env` and the bucket in Settings → Storage), new objects go to the bucket, the database keeps only their metadata, and request logs can also be archived to the bucket. Objects stored before S3 was enabled stay in PostgreSQL.

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

## Automatic updates

`docker-compose.au.yml` is `docker-compose.yml` plus an updater container. The app, Postgres, and Redis services are identical; the app only gains the label `llmhub.updater.target=true`. The updater runs from the same image (`node updater.mjs`) and keeps the app on the newest image of its tag:

1. Every five minutes it asks the registry for the digest behind the tag the app runs and compares it with the running image.
2. When automatic updates are on, or when someone presses Update now in the console, it pulls the image, stops the app, starts a new container with the same settings, environment overrides, labels, networks, and aliases, and waits until the image's health check reports healthy (up to ten minutes, because migrations run on start).
3. If the new container stops or turns unhealthy, it removes it and starts the previous container again. A digest that failed is not installed automatically again until a newer image is published; Update now retries it.
4. After a successful update it removes the old container and the old image if nothing else uses it, and then replaces its own container with the new image.

Use it instead of `docker-compose.yml`, in the same directory and with the same `.env`:

```bash
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/docker-compose.au.yml
docker compose -f docker-compose.au.yml up -d
```

Use `-f docker-compose.au.yml` for later compose commands, or add `COMPOSE_FILE=docker-compose.au.yml` to `.env` so a plain `docker compose` uses it. Switching an existing stack keeps its data: Postgres and Redis are unchanged, and only the app container is recreated.

The updater service sets `pull_policy: always`, so every `docker compose -f docker-compose.au.yml up` pulls the newest image of `LLMHUB_TAG` first and recreates the app and the updater if it changed. A host that still has an older image of the tag, for example one pulled before the updater existed, would otherwise start the updater from an image without `updater.mjs` (`Cannot find module '/app/updater.mjs'`). The command therefore needs the registry to be reachable.

The badge in the console's top bar shows the live connection to the server (Live, Updating, Reconnecting, Offline). Its menu and Settings → General → Automatic updates show the updater, the running and newest image digest, the last check and its result, and offer Check now, Update now, and the Install updates automatically switch (`settings:manage`). Automatic updates start switched off; while an updater is connected and they are off, the console offers to turn them on.

The updater gets only what it needs:

- The Docker socket. Pulls and registry lookups run through the Docker daemon.
- `APP_SECRET`, from which it derives the key that signs its messages to the app. It does not receive the rest of `.env`.
- The default compose network, on which it reaches the app at `http://app:3000/internal-api/updater`. It publishes no ports and accepts no connections.
- User `0:0`, because the socket belongs to root on the host and the image's `node` user cannot open it.

Every ten seconds it posts its status to the app and reads back the switch and any requested check or update; both directions are signed. These variables configure the updater only; the app does not read them:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_SECRET` | from `.env` | Must match the app. The updater derives its signing key from it. |
| `LLMHUB_UPDATER_APP_URL` | `http://app:3000` | Address of the app inside the compose network. |
| `LLMHUB_UPDATER_PROJECT` | detected | Compose project whose containers the updater manages, when it cannot inspect its own container. |

Security: access to the Docker socket is equivalent to root access on the host, so anyone who controls the updater container or the image it pulls controls the server. That is why the socket lives in a separate container without ports instead of in the app, which handles outside traffic. Only use this file on hosts where that is acceptable. The updater only recreates running containers of its own compose project that carry the label `llmhub.updater.target=true`, and it only pulls public images; registries that need a login are not supported.

Pinned tags: when `LLMHUB_TAG` is a release tag (`vYYYY.MM.DD.<sha>` or `dev-YYYY.MM.DD.<sha>`), a commit tag (`sha-<sha>`, `dev-<sha>`), or a digest, the updater reports the tag as pinned and never replaces the image. Set `LLMHUB_TAG` to `latest` or `dev` to receive updates. Back up the database regularly when automatic updates are on, because a new image applies its migrations on start and migrations are forward-only.

To stop automatic installs, turn off the switch; the updater keeps checking and offers Update now. To remove the updater, drop `COMPOSE_FILE` from `.env` if you set it and run `docker compose -f docker-compose.yml up -d --remove-orphans`; this removes the updater and recreates the app without the label. An older updater refreshes itself after the next app update; `docker compose -f docker-compose.au.yml up -d` refreshes it by hand, together with the app.

## Development

Requirements: Node.js 24 or newer and Docker.

```bash
cp .env.example .env
openssl rand -hex 32
docker compose -f docker-compose.dev.yml up -d postgres redis rustfs
npm ci
npm run db:migrate
npm run dev
```

Put the generated value into `APP_SECRET` in `.env`. `npm ci` also generates the Prisma client; run `npx prisma generate` again after changing the schema (it needs no database). `.env.example` sets `NODE_ENV=development` and points `DATABASE_URL` at Postgres on `127.0.0.1:5433`, `REDIS_URL` at Redis on `127.0.0.1:6379` (BullMQ), and the S3 keys at RustFS on `127.0.0.1:9000` (console on `127.0.0.1:9001`). `docker compose -f docker-compose.dev.yml up --build` builds and runs the production image locally.

| Command | Purpose |
| --- | --- |
| `npm test` | Unit tests (`src/tests/*.test.ts`, no database needed). |
| `npm run test:integration` | Integration tests (`src/tests/integration/`) against the migrated database in `DATABASE_URL`. They create and remove their own rows. |
| `npx tsc --noEmit` | Type check. |
| `npm run lint` | ESLint. |
| `npm run i18n:check`, `npm run styles:check`, `npm run heroui:check` | Translation parity and UI conventions; also run before every build. |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL`. |

To run the integration tests against the development database:

```bash
DATABASE_URL="postgresql://llmhub:<POSTGRES_PASSWORD>@127.0.0.1:5433/llmhub" npm run test:integration
```

CI runs the same checks and the integration tests against a fresh PostgreSQL 18 database, verifies that the migrations match the Prisma schema and that new migrations sort after the newest one on the base branch (`npm run migrations:check -- origin/development`), reviews new dependencies and audits production dependencies on pull requests, builds the image natively for `linux/amd64` and `linux/arm64`, and starts each build against PostgreSQL to check health, readiness, and the reported version (`scripts/smoke-image.sh <image> <expected-version>` runs the same check locally), then fails the build when Trivy finds a HIGH or CRITICAL vulnerability that has a fix. On pushes to `main` and `development` the image is tagged and published to GitHub Container Registry only after both architectures pass.

Contributor and architecture notes live in [`.ai/`](.ai/SUMMARY.md).

## License

All rights reserved. This repository is published without a license, and no license is granted to use, copy, modify, or distribute this software or any part of it.
