# LLM Hub

LLM Hub is a self-hosted gateway for large language models. Applications call one OpenAI- and Anthropic-compatible API (`/api/v1`) with LLM Hub keys, and LLM Hub routes each request to the provider accounts you connect, enforces budgets, rate limits, and data rules, and records usage and cost. An admin console manages providers, models, companies, keys, budgets, and logs.

It ships as one container image backed by PostgreSQL, with optional Redis and S3-compatible storage.

## Features

- **Compatible API.** `/api/v1` serves chat completions, completions, Responses, Anthropic Messages (including token counting), embeddings, moderations, rerank, OCR, images, audio, files, batches, videos, and vector stores with search, so existing OpenAI and Anthropic SDKs work by changing the base URL and key.
- **Providers and routing.** OpenAI, Anthropic, OpenRouter (global and EU), xAI, the Kimi API Platform (global and China), the Meta Model API, Google Gemini API, Google Vertex AI (service account key with project and location, or an express mode API key; Gemini, Claude, Imagen, and partner models), and any OpenAI-compatible endpoint. Model groups map one alias to several deployments with strategies such as least in-flight, weighted random, lowest cost, priority, round robin, and quota-aware routing, plus fallbacks, cooldowns on upstream failures, and a provider health view. A model catalog discovers provider models every two hours and keeps aliases up to date.
- **Subscription accounts.** Optionally connect ChatGPT, Claude, SuperGrok, Google Antigravity, Kimi Code (kimi.com or kimi.ai), Meta Muse Code, and Devin plans through a device or callback sign-in, or move them over once from CLIProxyAPI or EasyCLIProxyAPI (auth files, pasted JSON, or straight from a running CLIProxyAPI through its management API; every account is checked with its provider first and can be removed at the source so the two never invalidate each other's rotating tokens). A session stays on one account and moves to the next account with its full conversation when that account hits its limit or loses its sign-in. When every account is at its limit, the error names the time the first account frees up for that model (weekly limits included), so Codex and Claude Code in gateway mode resume on their own. An optional window kickoff sends a one-line message with a chosen model as soon as an account's usage window resets, so the next window starts at once. They are served from a separate endpoint (`/api/subscription/v1`) and never mix with API-key traffic. The server reads each account's plan limits about every five minutes (once across all replicas, sooner right after a limit resets, backing off when a provider rate-limits the check) and pushes changes live to open consoles, so open tabs never add provider calls and a manual refresh adds at most one per account per minute.
- **Companies and budgets.** Companies, departments, projects, and people form the tenancy model. API keys belong to a project, a person, or a console user. Every level can carry a spend cap with a reset period and temporary boosts; a child cap can never exceed a capped parent. Keys also support RPM and TPM limits, a per-request cost limit, model allowlists, reusable model templates (providers, regions, zero data retention, no training, maximum retention), client IP allowlists, endpoint restrictions, access time windows, expiry, and rotation.
- **Safety and privacy.** PII detection with masking, blocking, or restoring, by fixed patterns, a redaction model (PII-Tracer, self-hosted with `docker-compose.rm.yml` or any provider that speaks the same protocol), or both; configurable guardrail rules on input and output, and policy overrides per company, project, or key. Request and response bodies are stored separately from log metadata, can be switched off per key, user, or person, and follow their own retention period (30 days by default, like request logs).
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

`generate-env.sh` writes the production `.env` next to `docker-compose.yml` and walks you through the setup. It checks for Docker Compose and the compose file, then asks for the domain (`hub.example.com` becomes `https://hub.example.com`), the release channel (`latest`, `dev`, or a pinned release tag), the host port, and whether client addresses come from the reverse proxy or from Cloudflare (`IP_MODE`). Mail, the OpenID Connect client secret, S3 keys, and the URL of a redaction model that runs elsewhere are optional; the SMTP URL is built from host, encryption, user, and password. It sets `NODE_ENV=production`, generates `APP_SECRET`, `POSTGRES_PASSWORD`, and `REDIS_PASSWORD`, shows a summary with masked secrets, writes the file with mode 600, and prints the reverse proxy block and the next commands. Without a terminal, or with `--yes`, it takes the defaults and reads answers from the environment (`NEXT_PUBLIC_APP_URL=https://hub.example.com ./generate-env.sh --yes`). An existing `.env` is replaced only with `--force`, which keeps its values and leaves the previous file in `.env.bak`. Keep `APP_SECRET` stable: it encrypts stored provider keys and signs sessions.

The app listens on `127.0.0.1:3000` (`LLMHUB_PORT`). Put a reverse proxy with TLS in front of it, for example Caddy:

```text
hub.example.com {
  reverse_proxy 127.0.0.1:3000 {
    health_uri /internal-api/ready
    health_interval 2s
    lb_try_duration 90s
    lb_try_interval 500ms
  }
}
```

The health check and `lb_try_duration` keep updates and restarts invisible to clients: while the app drains or starts, Caddy holds new requests for up to 90 seconds and sends them to the app as soon as it is ready again, instead of answering 502.

Sign-in limits, sessions, the audit log, and key IP allowlists use the client address that `IP_MODE` selects. The default `proxy` takes the last `X-Forwarded-For` entry, the one your reverse proxy appends, so port 3000 must only be reachable through the proxy. With Cloudflare in front, set `IP_MODE=cloudflare` and accept web traffic only from Cloudflare. Postgres and Redis keep their data in `./postgres-data` and `./redis-data` next to the compose file and are not published on host ports. Migrations run on every container start. The `keeper` keeps subscription sign-ins alive on its own (see [Subscription sign-ins](#subscription-sign-ins)).

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
| `LLMHUB_REDACTOR_URL` | no | unset | Base URL of a PII redaction service that speaks the [redaction protocol](#redaction-protocol). While it is set, every start keeps an internal provider and the internal-only alias `pii-tracer` pointing at it; without it that provider is switched off. `docker-compose.rm.yml` sets it to `http://redactor:8080`. |
| `SENTRY_DSN` | no | unset | Sentry DSN for server errors and failed background jobs. Without it Sentry stays off and sends nothing. See [Error reporting](#error-reporting). |
| `SENTRY_ENVIRONMENT` | no | `production` | Environment name on Sentry events (`development` when `NODE_ENV` is `development`). |
| `SENTRY_RELEASE` | no | `BUILD_ID` | Release name on Sentry events. |
| `SENTRY_TRACES_SAMPLE_RATE` | no | `0` | Share of requests sent to Sentry as performance traces, from `0` to `1`. Any other value stops the start. |
| `NEXT_PUBLIC_SENTRY_DSN` | no | unset | Sentry DSN for errors in the browser. It is compiled into the console when the image is built, so it has to be a build argument; published images are built without it. The server also uses it when `SENTRY_DSN` is unset. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | no | unset | Build time only: upload source maps to Sentry during `npm run build` when a DSN is set as well. |

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

The caps are upper limits, not reservations. Keep their sum below the memory of the server: when the server itself runs out, the kernel stops whichever process it picks, which can interrupt a migration or a Redis write in the middle. On a server with 2 GB, for example, set `LLMHUB_MEMORY_LIMIT=1g`, `POSTGRES_MEMORY_LIMIT=512m`, and `REDIS_MEMORY_LIMIT=256m` and add swap. `free -h` shows the memory, and `journalctl -k | grep -i oom` shows whether the kernel stopped a process.

The keeper and the updater in `docker-compose.au.yml` are capped at 256 MB each. On `docker compose stop` or `down`, the app gets 330 seconds to finish open requests and streams (`stop_grace_period`), because API requests may run for up to 300 seconds. While it drains, it keeps accepting connections but answers new API requests with `503 server_restarting`, `Retry-After: 15`, and `x-should-retry: true` (Anthropic clients see `overloaded_error`), so Claude Code, Codex, and SDKs retry instead of reporting an exhausted subscription or budget, and `/internal-api/ready` answers 503. It exits as soon as no API request is open. An update through the updater drains for at most 25 seconds, so the outage stays short.

The image sets `PORT=3000`, `HOSTNAME=0.0.0.0`, and `NODE_ENV=production`.

### Storage

S3 is optional. Without it, uploaded files, batch input and output, generated images and videos, stored responses, and vector store files are kept in PostgreSQL as `bytea` rows, which grows the database and its backups. With S3 configured (both access keys in `.env` and the bucket in Settings → Storage), new objects go to the bucket, the database keeps only their metadata, and request logs can also be archived to the bucket. Objects stored before S3 was enabled stay in PostgreSQL.

### Error reporting

Sentry is optional. Without a DSN the SDK is never initialized and makes no network calls. With it, the server reports unhandled request errors and failed background jobs. Events never carry request or response bodies, cookies, credential or client address headers, users, database queries, or local variables; URL parameter values and add-account link tokens are replaced with `[Filtered]`, error messages are cut to their first line, and requests the app sends to providers, webhooks, and MCP servers are neither recorded nor given trace headers.

Browser errors need `NEXT_PUBLIC_SENTRY_DSN` when the image is built, for example `docker build --build-arg NEXT_PUBLIC_SENTRY_DSN=https://…`, because the console is compiled with it; the content security policy then allows that Sentry host. `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_RELEASE`, and `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` set the browser values the same way.

### Disk usage

The updater checks for 2 GB of free space before every update, and the console shows the free space next to it. To see what fills the disk, run from the directory that holds `docker-compose.yml`:

```bash
df -h /
docker system df
sudo du -sh postgres-data redis-data /var/lib/docker /var/lib/containerd 2>/dev/null
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15"'
```

Container logs are capped at 50 MB per container. In the database, request logs and stored prompts and responses follow the retention in Settings → Logging & alerts; uploaded files, batch files, and vector store files stay in PostgreSQL without S3 (see [Storage](#storage)) until their own retention removes them. `docker image prune` removes images that no container uses, including old Postgres and Redis images.

## Subscription sign-ins

Subscription accounts (Claude, ChatGPT/Codex, Kimi, SuperGrok, Antigravity, and the others you sign in to) use tokens that the provider replaces at every refresh. A refresh token that was used once is dead, so losing the newest one means signing in again. The keeper protects them:

- It runs from the app image (`node keeper/keeper.mjs`) and refreshes due sign-ins every minute, also while the web server is down, restarting, or waiting for a failed migration and while Redis is down. It only needs PostgreSQL. It uses the same code and the same database lease as the app, so the two never refresh the same account at the same time.
- The current compose files run it as the separate `keeper` container, which also keeps working while the app container is stopped or replaced, and set `LLMHUB_KEEPER=separate` on the app. Without that variable, for example with a compose file from before November 2026, the app container runs the keeper itself: its start command (`node start.mjs`) starts the keeper after the first migration attempt, keeps it running while a failed migration is retried, and restarts it when it exits. Nothing has to be changed for that.
- Every refreshed token is written to the login journal before it goes into the database: one encrypted file per refresh (AES-256-GCM with a key derived from `APP_SECRET`, mode 600) in `/login-journal`. The current compose files mount the named volume `login-journal` there for the app and the keeper. Without it, the image's anonymous volume holds the journal, and `docker compose up` and the updater hand it to every new app container. The keeper also copies new sign-ins from the database into the journal every minute. It keeps the three newest entries per account, removes an account's entries when the account is removed in LLM Hub, and removes entries whose account is missing from the database 30 days after their last change.
- When the database holds older tokens for an account than the journal, because saving failed, the process stopped before it could save, or a backup was restored, the newer tokens are written back before anything refreshes, so a used refresh token is never sent again. Entries of another account are never restored.
- Without PostgreSQL nothing refreshes, because the database lease keeps two processes from refreshing the same account; the newest tokens wait in the journal, and refresh tokens last far longer than an access token.

`docker compose ps keeper` shows whether it is healthy, and `docker compose logs keeper` (or `docker compose logs app` when the app runs it) shows refreshes, restored sign-ins (`provider.sign_in_tokens_restored`), and failed steps. `docker compose down -v` deletes the journal with the volume, so leave out `-v`.

## Backup and restore

All durable state lives in PostgreSQL, in S3 if you use it, and in `.env`. Back up `.env` together with the database: without the same `APP_SECRET`, encrypted provider credentials and two-factor secrets cannot be read. The login journal is not a backup; it only holds the newest sign-in tokens. Redis only holds queues, counters, and caches and does not need a backup. It writes a snapshot at most once a minute instead of an append-only file, so a crash loses at most a minute of queue and counter changes but never leaves a file that keeps Redis from starting, and a failed snapshot, for example on a full disk, does not stop Redis from accepting writes.

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

Restore with the same or a newer image than the one that wrote the backup. A newer image applies its migrations when it starts. Leave the keeper running: subscription accounts whose tokens were refreshed after the backup get their newer tokens back from the login journal within a minute, without signing in again.

## Upgrading

`docker-compose.yml` runs `ghcr.io/nicolaeser/llmhub:${LLMHUB_TAG}`, `latest` by default. For controlled upgrades, set `LLMHUB_TAG` in `.env` to a release tag instead, for example `v2026.10.12.abc1234`. Every release on the [releases page](https://github.com/nicolaeser/llmhub/releases) lists its tags and image digest. The `dev` tag follows the `development` branch and is published as a prerelease.

1. Back up the database and `.env` as described above.
2. Change `LLMHUB_TAG` in `.env`.
3. Download `docker-compose.yml` (or `docker-compose.au.yml`) of the release again when it changed, then run `docker compose pull && docker compose up -d`.
4. Check `/internal-api/ready` and `/internal-api/version`.

Compose files from before November 2026 keep working without changes. The app container then runs the keeper itself and keeps the login journal in the image's anonymous volume (see [Subscription sign-ins](#subscription-sign-ins)). Those files run Redis with an append-only file; the updater moves it to snapshots once (see [Automatic updates](#automatic-updates)), and without the updater it stays as it is. Downloading the current file is optional. It adds the separate keeper container, the `login-journal` volume, and the snapshot settings for Redis:

```bash
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/docker-compose.yml
docker compose up -d
```

Use `docker-compose.au.yml` instead when you run the updater. When Redis moves to snapshots, it is stopped normally and writes a final snapshot, which the new container loads, so queues and counters stay. `redis-data/appendonlydir` is no longer read afterwards and can be deleted.

If your Caddy block is still the plain `reverse_proxy 127.0.0.1:3000`, replace it with the block from [Quick start](#quick-start) and reload Caddy (`systemctl reload caddy` or `caddy reload`). Its health check on `/internal-api/ready` and `lb_try_duration` hold new requests while the app drains and restarts and hand them to the new container; without them, clients get 502 during every restart and must retry on their own. The first update to a release with the drain mode is still installed by the previous updater and image, which wait up to 330 seconds for open streams; from the next update on, the app drains for at most 25 seconds.

Each container start applies pending migrations under a database lock before the server starts, so several replicas can start at the same time. When a migration fails, the container keeps running without the web server, logs `start.migration_failed`, and tries again after 10 seconds, 30 seconds, 1, and 2 minutes, then every 5 minutes; meanwhile it reports unhealthy, and the updater rolls an update back. Migrations are forward-only. To roll back, restore the backup taken before the upgrade and start the previous tag.

### A migration failed

Migrations newer than `20261110120000_model_extra_names` run inside one transaction. When one fails, for example on a full disk or because the container was killed, none of it stays in the database: the start script marks it rolled back and prints the reason, the container restarts and runs it again, and the previous image still starts after a rollback. When Prisma recorded no reason, Postgres logged it (`docker compose logs postgres`).

An older migration that fails can leave part of its changes behind. Every start then stops with `a failed migration blocks the start` (Prisma error P3009), with the previous image as well, and the log names the migration and the database error. Fix the cause, undo what the migration applied (its SQL is in `prisma/migrations/<name>/migration.sql` at the release tag), and mark it rolled back so the next start applies it again:

```bash
docker compose stop app
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT migration_name, logs FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"'
docker compose run --rm --no-deps --entrypoint node app ./node_modules/prisma/build/index.js migrate resolve --rolled-back <name>
docker compose up -d
```

For `20261110120000_model_extra_names`, undo it with `ALTER TABLE "ModelGroup" DROP COLUMN IF EXISTS "extraNames";` before marking it rolled back.

## Automatic updates

`docker-compose.au.yml` is `docker-compose.yml` plus an updater container. The app, Postgres, Redis, and keeper services are identical; the app and the keeper only gain the label `llmhub.updater.target=true`, so both move to every new image. The updater runs from the same image (`node updater.mjs`) and keeps the app on the newest image of its tag:

1. Every five minutes it asks the registry for the digest behind the tag the app runs and compares it with the running image.
2. When automatic updates are on, or when someone presses Update now in the console, it first removes older images of the app that no container uses and checks that at least 2 GB are free on the disk that holds Docker. It pulls the image, checks that at least 512 MB are still free, stops the app with a drain of 30 seconds (running requests finish, new API requests are asked to retry), starts a new container with the same settings, environment overrides, labels, networks, and aliases, and waits until the image's health check reports healthy (up to ten minutes, because migrations run on start).
3. If the new container stops, turns unhealthy, or restarts three times without becoming healthy, it removes it and starts the previous container again. A digest that failed is not installed automatically again until a newer image is published; Update now retries it. With less than 2 GB free, the update stops before the app is touched, automatic updates wait, and the console warns about the disk; once space is freed, the same digest installs again.
4. After a successful update it removes the old container, recreates stopped containers that carry the label on the new image without starting them, removes the old image if nothing else uses it, and then replaces its own container with the new image. No labelled container is left on the old image.

A new container keeps the anonymous volumes of the one it replaces, as with `docker compose up`, so a stack without the `login-journal` volume keeps its login journal across updates. After an update, the updater also moves Redis from an append-only file to snapshots once, when its container runs exactly the command of the compose files from before November 2026 (`redis-server --appendonly yes --requirepass …`), reports healthy, and at least 2 GB are free. It stops Redis, which writes a final snapshot, and starts it with `--appendonly no --save "60 1" --stop-writes-on-bgsave-error no` and otherwise unchanged settings. If Redis could not shut down cleanly, for example because the snapshot failed, or the new container does not turn healthy, it starts the previous container again, which still has its append-only file. It touches no other Redis and no other container of the stack. Delete `redis-data/appendonlydir` before you ever start Redis with `--appendonly yes` again, because Redis would load that outdated file instead of the snapshot.

Use it instead of `docker-compose.yml`, in the same directory and with the same `.env`:

```bash
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/docker-compose.au.yml
docker compose -f docker-compose.au.yml up -d
```

Use `-f docker-compose.au.yml` for later compose commands, or add `COMPOSE_FILE=docker-compose.au.yml` to `.env` so a plain `docker compose` uses it. Switching an existing stack keeps its data: Postgres, Redis, and the login journal are unchanged, and only the app and keeper containers are recreated.

The updater service sets `pull_policy: always`, so every `docker compose -f docker-compose.au.yml up` pulls the newest image of `LLMHUB_TAG` first and recreates the app and the updater if it changed. A host that still has an older image of the tag, for example one pulled before the updater existed, would otherwise start the updater from an image without `updater.mjs` (`Cannot find module '/app/updater.mjs'`). The command therefore needs the registry to be reachable.

The badge in the console's top bar shows the live connection to the server (Live, Updating, Reconnecting, Offline). Its menu and Settings → General → Automatic updates show the updater, the running and newest image digest, the free disk space, the last check and its result, and offer Check now, Update now, and the Install updates automatically switch (`settings:manage`). Automatic updates start switched off; while an updater is connected and they are off, the console offers to turn them on.

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

Security: access to the Docker socket is equivalent to root access on the host, so anyone who controls the updater container or the image it pulls controls the server. That is why the socket lives in a separate container without ports instead of in the app, which handles outside traffic. Only use this file on hosts where that is acceptable. The updater only touches containers of its own compose project that carry the label `llmhub.updater.target=true` (running ones are recreated and checked, stopped ones are recreated without being started), and it only pulls public images; registries that need a login are not supported.

Pinned tags: when `LLMHUB_TAG` is a release tag (`vYYYY.MM.DD.<sha>` or `dev-YYYY.MM.DD.<sha>`), a commit tag (`sha-<sha>`, `dev-<sha>`), or a digest, the updater reports the tag as pinned and never replaces the image. Set `LLMHUB_TAG` to `latest` or `dev` to receive updates. Back up the database regularly when automatic updates are on, because a new image applies its migrations on start and migrations are forward-only.

To stop automatic installs, turn off the switch; the updater keeps checking and offers Update now. To remove the updater, drop `COMPOSE_FILE` from `.env` if you set it and run `docker compose -f docker-compose.yml up -d --remove-orphans`; this removes the updater and recreates the app without the label. An older updater refreshes itself after the next app update and reprints the previous updater's logs so `docker compose logs updater` still shows that run; `docker compose -f docker-compose.au.yml up -d` refreshes it by hand, together with the app.

## PII redaction model

Fixed patterns find structured values such as email addresses, card numbers, and national IDs, but not names or postal addresses in free text. A PII policy can therefore detect with **Patterns** (the default, so nothing changes until you switch), with a **Redaction model**, or with **Model and patterns**. Set it in Guardrails → PII, for the global policy and for each override. Secrets and credentials always go through the patterns first and never reach the model. Model spans use the same placeholders and numbering as pattern matches, so mask, block, and restore mode, the request logs, and the placeholder chips work as before. When the model fails or runs out of time, the policy either falls back to patterns and logs a warning, or blocks the request with `503 pii_detector_unavailable`.

`docker-compose.rm.yml` runs [PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer) (MIT, a 0.6B bidirectional Qwen3 encoder) on CPU next to the app. It is an override file for `docker-compose.yml` or `docker-compose.au.yml`:

```bash
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/docker-compose.rm.yml
docker compose -f docker-compose.yml -f docker-compose.rm.yml up -d
```

Add `COMPOSE_FILE=docker-compose.yml:docker-compose.rm.yml` (or `docker-compose.au.yml:docker-compose.rm.yml`) to `.env` so a plain `docker compose` uses both files. It adds three services on a network without internet access and publishes no ports:

- `redactor-fetch` downloads the [GGUF build](https://huggingface.co/perplexity-ai/PII-Tracer-GGUF) at a pinned commit into the `redactor-models` volume on the first start (about 1.2 GB), checks every file against its pinned hash, and exits. Later starts only check the files. It is the only redactor service with internet access.
- `redactor-model` runs the pinned `llama.cpp` server image as user `65534` with `--embeddings --pooling none`, which returns one hidden state per token.
- `redactor` runs `node redactor.mjs` from the app image. It tokenizes through the model server, applies the classification head, decodes the BIOES tags with the constrained Viterbi decoder from the model card, maps tokens back to character offsets, and answers the protocol below.

The app gets `LLMHUB_REDACTOR_URL=http://redactor:8080` and, on every start, an internal provider with the alias `pii-tracer`, which is also the default redaction model. The app does not wait for the redactor: until it is healthy, policies that use the model fall back or block as configured.

`redactor-fetch` and `redactor` run the app image and carry the label `llmhub.updater.target=true`, so with `docker-compose.au.yml` the updater moves them to the new image together with the app: it recreates `redactor` and waits until it is healthy, and recreates the finished `redactor-fetch` without starting it; the next `docker compose up` runs it again as before. Download the file again if it is older and run `docker compose up -d` once, otherwise both keep running the old image after an update.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLMHUB_REDACTOR_REVISION` | pinned commit | Commit of `perplexity-ai/PII-Tracer-GGUF` to download. Other commits are checked against the hashes Hugging Face lists for them. |
| `LLMHUB_REDACTOR_WINDOW` | `2048` | Tokens per model pass (at most 4096). Longer inputs are split into overlapping windows. Memory grows with the window. |
| `LLMHUB_REDACTOR_CPUS` | `4` | CPU cores and threads for the model server. |
| `REDACTOR_MEMORY_LIMIT` | `4g` | Memory cap of the model server. A 2048-token window peaked at 2.8 GB; 4096 needs about 4.4 GB. |

On 4 cores of a shared x86 server the f16 model took 0.2 to 0.6 seconds for a sentence or a short paragraph and about 26 seconds for a 7,300-character document (2,655 tokens), so expect seconds of extra latency per request on CPU. Text the model has already seen is cached for 10 minutes, so earlier turns of a conversation are not detected again; a request with more than 200,000 characters of new text is treated like a model failure. For heavier traffic, run the model on a GPU with [PII-Tracer-vLLM](https://huggingface.co/perplexity-ai/PII-Tracer-vLLM) behind an adapter that speaks this protocol, and point `LLMHUB_REDACTOR_URL` or an internal provider at it. The model card documents English; it does not state how well German is covered, so test your own samples with the Test button in Guardrails → PII.

### Redaction protocol

Any service can serve as the redaction model: add it as an OpenAI-compatible provider marked internal (with an API key if it needs one, sent as a bearer token) and pick its alias in Guardrails → PII. The hub calls it as a system request, which is metered as `internal:pii` and never stored with content. Requests follow the Hugging Face token classification shape:

```http
POST <base URL>/v1/token-classification
Content-Type: application/json

{"model": "pii-tracer", "inputs": ["Hi, I'm Daniel Whitfield, you can reach me at daniels@meridiancap.com.", "No PII here."]}
```

```json
[[{"entity_group": "private_person", "score": 0.9999, "start": 8, "end": 24},
  {"entity_group": "private_email", "score": 0.9999, "start": 46, "end": 69}], []]
```

- The answer holds one list of spans per input, in order; a string `inputs` gets a single list.
- `start` and `end` count Unicode code points (Python string indexes), with `end` exclusive.
- The label is read from `entity_group`, `entity`, or `label`, without a `B-`, `I-`, `E-`, or `S-` prefix. PII-Tracer labels map to `private_person` → `PERSON`, `private_email` → `EMAIL_ADDRESS`, `private_phone` → `PHONE_NUMBER`, `private_address` → `ADDRESS`, `private_url` → `URL`, `private_date` → `DATE_TIME`, `account_number` → `ACCOUNT_NUMBER`, `secret` → `SECRET`, and `other_pii` → `OTHER_PII`. Catalog ids such as `IBAN_CODE` and the names `person`, `per`, `email`, `phone`, `address`, `street_address`, `date`, and `password` work too; other labels are ignored.
- `score` (0 to 1) is optional, and `word` is ignored.
- The hub sends at most 16 inputs and 16,000 characters per request, cuts longer texts into pieces of up to 2,000 characters that overlap by 200, and runs at most two requests at a time per app process.

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

CI runs the same checks and the integration tests against a fresh PostgreSQL 18 database, verifies that the migrations match the Prisma schema and that new migrations sort after the newest one on the base branch (`npm run migrations:check -- origin/main`), reviews new dependencies and audits production dependencies on pull requests, builds the image natively for `linux/amd64` and `linux/arm64`, and starts each build against PostgreSQL to check health, readiness, and the reported version (`scripts/smoke-image.sh <image> <expected-version>` runs the same check locally), then fails the build when Trivy finds a HIGH or CRITICAL vulnerability that has a fix. On pushes to `main` and `development` the image is tagged and published to GitHub Container Registry only after both architectures pass.

Contributor and architecture notes live in [`.ai/`](.ai/SUMMARY.md).

## License

All rights reserved. This repository is published without a license, and no license is granted to use, copy, modify, or distribute this software or any part of it.
