# LLM Hub

LLM Hub is a gateway for large language models (LLMs) that you run on your own server.

- Your applications send their requests to LLM Hub instead of directly to OpenAI, Anthropic, Google, or another provider.
- LLM Hub speaks the OpenAI and the Anthropic API. Existing SDKs and tools keep working: you only change the base URL and the API key.
- LLM Hub forwards each request to the provider accounts you connect. On the way, it checks budgets, rate limits, and data rules, and it records usage and cost.
- An admin console in the browser manages providers, models, companies, keys, budgets, and logs.

LLM Hub runs as one Docker image with PostgreSQL. Redis and S3-compatible storage are optional.

## Contents

- [Install](#install)
- [Features](#features)
- [Configuration](#configuration)
- [Subscription sign-ins](#subscription-sign-ins)
- [Session affinity](#session-affinity)
- [Backup and restore](#backup-and-restore)
- [Upgrading](#upgrading)
- [Automatic updates](#automatic-updates)
- [PII redaction model](#pii-redaction-model)
- [License](#license)

## Install

### What you need

- A Linux server with [Docker and the Docker Compose plugin](https://docs.docker.com/engine/install/).
- bash 5 or newer, for the setup script.
- A domain name that points to the server, for example `hub.example.com`.
- A reverse proxy that serves HTTPS, for example [Caddy](https://caddyserver.com/docs/install). Caddy gets TLS certificates on its own.

The default memory limits add up to about 7 GB. On a smaller server, lower them before the first start (see [Memory limits](#memory-limits)).

### 1. Download the setup script

Create a folder for LLM Hub and download the setup script into it. The compose files and the database data will also live in this folder.

```bash
mkdir llmhub && cd llmhub
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/generate-env.sh
chmod +x generate-env.sh
```

Without curl, use `wget https://raw.githubusercontent.com/nicolaeser/llmhub/main/generate-env.sh` instead.

### 2. Create the settings and compose files

```bash
./generate-env.sh
```

The script asks a few questions, writes the settings file `.env`, and downloads `docker-compose.yml` next to it. Press Enter to keep the value it shows. It asks for:

- **Domain.** `hub.example.com` becomes `https://hub.example.com`.
- **Release channel.** `latest` for stable releases, `dev` for previews, or a fixed release tag.
- **Port.** The port on `127.0.0.1` where the reverse proxy reaches the app (default `3000`).
- **Client addresses.** Whether visitors come through your own reverse proxy or through Cloudflare (`IP_MODE`).
- **Automatic updates.** Whether to install the updater container (see [Automatic updates](#automatic-updates)). The script then also downloads `docker-compose.au.yml`.
- **Optional extras.** Mail (for password reset emails), the secret for single sign-on (OIDC), S3 storage keys, the URL of a redaction model that runs elsewhere, and a Sentry DSN for error reports. Leave them empty if you don't need them.

The script creates all passwords and the `APP_SECRET` for you. It shows a summary with hidden secrets and saves the file so that only your user can read it (mode 600).

It also writes `COMPOSE_FILE` into `.env`: `docker-compose.yml`, or `docker-compose.yml:docker-compose.au.yml` with automatic updates. A plain `docker compose` then uses the right files, so you never need `-f`. When neither curl nor wget is installed, the script installs curl with the system package manager (through `sudo` if you are not root).

> [!IMPORTANT]
> Keep a backup of `.env`. `APP_SECRET` encrypts the stored provider keys and two-factor secrets and signs the sessions. If you lose it or change it, LLM Hub can no longer read them.

More options:

- `./generate-env.sh --yes` takes the default answers without asking. It also runs that way without a terminal. Give answers as environment variables, for example `NEXT_PUBLIC_APP_URL=https://hub.example.com AUTO_UPDATE=yes ./generate-env.sh --yes`. `AUTO_UPDATE` (`yes` or `no`) only answers the question and isn't written to `.env`.
- The script never overwrites an existing `.env` unless you add `--force`. With `--force` it keeps the existing values (including the secrets) and saves the old file as `.env.bak`.
- On every run, the script compares the compose files listed in `COMPOSE_FILE` with the current versions. It asks before it replaces a changed file and keeps the old one as `<file>.bak`; with `--yes` it replaces them. Files it doesn't know, such as your own `docker-compose.override.yml`, stay in `COMPOSE_FILE` untouched.

### 3. Start LLM Hub

```bash
docker compose up -d
```

This starts four containers: the app, PostgreSQL, Redis, and the keeper (it keeps subscription sign-ins alive, see [Subscription sign-ins](#subscription-sign-ins)). The app sets up the database on every start, so the first start can take a moment. `docker compose ps` shows `healthy` for each container when it is ready.

The app listens only on `127.0.0.1:3000`, so it can't be reached from the internet directly. PostgreSQL and Redis are not published on any host port. Their data is stored in `./postgres-data` and `./redis-data` next to `docker-compose.yml`.

### 4. Set up the reverse proxy

Add this block to your Caddy configuration (often `/etc/caddy/Caddyfile`) and use your own domain:

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

Then reload Caddy with `sudo systemctl reload caddy` (or `caddy reload`).

The health check makes restarts and updates invisible to clients. While the app restarts, Caddy holds new requests for up to 90 seconds and sends them on as soon as the app is ready again. Without it, clients get a `502` error.

LLM Hub uses the client's IP address for sign-in limits, sessions, the audit log, and IP allowlists on keys. Where this address comes from depends on `IP_MODE`:

- `proxy` (default): LLM Hub trusts the last `X-Forwarded-For` entry, which your reverse proxy adds. Make sure that port 3000 can only be reached through the proxy.
- `cloudflare`: use this when Cloudflare is in front of the server. Then accept web traffic only from Cloudflare (its IP ranges or a Cloudflare Tunnel).

### 5. Create the owner account

Open `https://hub.example.com/internal-api/setup` and create the owner account.

- Every account must set up two-factor authentication at its first sign-in.
- New people can't register on their own until you turn on registration in Settings.

### 6. Send your first request

1. On the **Providers** page, connect a provider, for example with an OpenAI API key.
2. On the **Keys** page, create an LLM Hub key.
3. Call the API with that key:

```bash
curl https://hub.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer $LLMHUB_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'
```

To use LLM Hub from your own code or tools, set the base URL to:

- `https://hub.example.com/api/v1` for OpenAI SDKs and OpenAI-compatible tools.
- `https://hub.example.com/api` for Anthropic SDKs and Claude Code. They add `/v1/messages` themselves.

The **Developer** page in the console has step-by-step guides for Claude Code, Codex, Cursor, and other tools.

### Check that it runs

| Address | What it tells you |
| --- | --- |
| `GET /internal-api/health` | The app is alive. Also shows the worker mode. |
| `GET /internal-api/ready` | The app can read the database and accepts requests. |
| `GET /internal-api/version` | The release version and the start time. |

## Features

- **One API for many providers.** `/api/v1` supports chat completions, completions, Responses, Anthropic Messages (with token counting), embeddings, moderations, rerank, OCR, images, audio, files, batches, videos, and vector stores with search.
- **Providers.** OpenAI, Anthropic, OpenRouter (global and EU), xAI, the Kimi API Platform (global and China), the Meta Model API, the Google Gemini API, Google Vertex AI, and any OpenAI-compatible endpoint. Vertex AI works with a service account key (with project and location) or an express mode API key, and serves Gemini, Claude, Imagen, and partner models.
- **Routing.** A model group maps one name (alias) to several deployments. It picks one by least in-flight requests, weighted random, lowest cost, priority, round robin, or remaining quota. Fallbacks and cooldowns handle failing providers, and a health view shows their state. Optional [session affinity](#session-affinity) keeps each conversation on one replica of a self-hosted model, so its prompt cache is reused. A model catalog finds new provider models every two hours and keeps aliases up to date.
- **Subscription accounts.** You can also connect ChatGPT, Claude, SuperGrok, Google Antigravity, Kimi Code (kimi.com or kimi.ai), Meta Muse Code, and Devin plans. See [Subscription sign-ins](#subscription-sign-ins).
- **Companies and budgets.** Companies, departments, projects, and people form the structure. An API key belongs to a project, a person, or a console user. Every level can have a spending limit with a reset period and temporary boosts. A lower level can never have a higher limit than the level above it.
- **Key limits.** Keys support requests and tokens per minute (RPM, TPM), a cost limit per request, model allowlists, reusable model templates (providers, regions, zero data retention, no training, maximum retention), client IP allowlists, endpoint restrictions, access time windows, expiry, and rotation.
- **Safety and privacy.** PII detection (personal data) can mask, block, or restore values. It finds them with fixed patterns, with a [redaction model](#pii-redaction-model), or with both. Guardrail rules check input and output, and policies can differ per company, project, or key.
- **Stored content.** Request and response bodies are stored apart from the log data. You can turn storing off per key, user, or person. They are deleted after 7 days by default, like request logs, and trimmed from the oldest once they pass 5 GB.
- **Usage and cost.** Daily usage numbers, dashboards, chargeback by company, department, and project, price markups, exports as CSV, JSONL, PDF, and Markdown, and usage reports by email. Prompt cache tokens are billed at provider prices. An optional response cache with semantic matching answers repeated requests.
- **Operations.** Request, spend, and audit logs with filters and their own retention rules. Signed alert webhooks in JSON, Slack, or Teams format, for example when providers run out, budgets reach a threshold, spending looks unusual, keys expire or get blocked, PII is blocked, provider models change, or an archive day fails. A daily [compliance archive](#compliance-archive) to S3.
- **Access control.** Console accounts with required two-factor authentication (authenticator app, passkeys, recovery codes), editable roles and permissions, console users limited to one company, OIDC single sign-on, SCIM provisioning, and personal management keys for the `/api/mgmt` automation API.

## Configuration

Most settings live in the console under **Settings** and are stored in the database. This includes the S3 bucket, the OIDC issuer and client ID, registration, retention, PII and guardrail policies, and alert webhooks. Only a few values come from `.env`. For local development, `.env.example` is the template.

Default retention: request logs and stored prompts and responses are deleted after 7 days, stored prompts and responses are capped at 5 GB, and account security activity is deleted after 90 days. These limits keep the database from filling the disk. Change them in **Settings → Logging & alerts** (0 keeps data forever or removes the size cap). Installations that never saved these settings get these defaults when they upgrade, so the first cleanup after the update can delete a lot of older logs.

### Variables the app reads

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | none | `production` or `development`. Any other value stops the container before it starts. The compose file and the image set `production`. |
| `DATABASE_URL` | yes | none | PostgreSQL connection string. The compose files build it from the `POSTGRES_*` values and replace any value in `.env`. |
| `APP_SECRET` | yes | none | At least 32 characters. Encrypts provider keys, secret settings, and two-factor secrets, and signs sessions and sign-in state. Changing it makes all of them unreadable. |
| `NEXT_PUBLIC_APP_URL` | no | `http://localhost:3000` | Public address of the console. Used for same-origin checks, redirects, password reset links, the OIDC callback, and passkeys. Passkeys need HTTPS with a domain, or `localhost`. |
| `REDIS_URL` | no | unset | Redis connection URL. With Redis, background jobs run on BullMQ queues, and replicas share rate limits, the response cache, and provider cooldowns. Without it, each process runs the jobs on timers and keeps limits and cache in memory. The compose files set it from `REDIS_PASSWORD`. |
| `IP_MODE` | no | `proxy` | Where the client address comes from. `proxy`: the last `X-Forwarded-For` entry, added by a reverse proxy that is the only way to reach the app. `cloudflare`: the `CF-Connecting-IP` header; the server must accept traffic only from Cloudflare (its IP ranges or a Cloudflare Tunnel). `direct`: the address of the TCP connection, for an app port that clients reach without a proxy; all forwarding headers are ignored. No other header ever counts. An address that can't be read counts as unknown. Any other value stops the start. |
| `S3_ACCESS_KEY_ID` | no | unset | Access key for S3-compatible storage. Provider, bucket, region, endpoint, and addressing are set in **Settings → Storage**, which can also test the connection. |
| `S3_SECRET_ACCESS_KEY` | no | unset | Secret key for S3-compatible storage. |
| `SMTP_URL` | no | unset | `smtp://user:pass@host:587` or `smtps://user:pass@host:465`. Turns on password reset and usage report emails. Without it, password reset is off. |
| `SMTP_FROM` | no | `llmhub@localhost` | Sender address for emails. |
| `OIDC_CLIENT_SECRET` | no | unset | Client secret for OIDC single sign-on. The issuer, client ID, group-to-role rules, and SSO-only mode are set in **Settings → Sign-in**. The redirect URI is `NEXT_PUBLIC_APP_URL/sso/callback`. |
| `BUILD_ID` | no | `development` | Release version shown by `/internal-api/version` and used by the update check. Published images set it when they are built. Don't set it yourself. |
| `LLMHUB_REDACTOR_URL` | no | unset | Base URL of a PII redaction service that speaks the [redaction protocol](#redaction-protocol). While it is set, every start keeps an internal provider and the internal-only alias `pii-tracer` pointing at it. Without it, that provider is turned off. `docker-compose.rm.yml` sets it to `http://redactor:8080`. |
| `SESSION_AFFINITY_SPILL_MARGIN` | no | `4` | For models with [session affinity](#session-affinity): how many more requests in flight a conversation's deployment may have than the least busy deployment of the model before the conversation moves. Higher keeps more conversations on their replica, lower spreads load sooner. A whole number of 0 or more; any other value stops the start. |
| `SENTRY_DSN` | no | unset | Sentry DSN for server errors and failed background jobs. Without it, Sentry stays off and sends nothing. See [Error reporting](#error-reporting). |
| `SENTRY_ENVIRONMENT` | no | `production` | Environment name on Sentry events (`development` when `NODE_ENV` is `development`). |
| `SENTRY_RELEASE` | no | `BUILD_ID` | Release name on Sentry events. |
| `SENTRY_TRACES_SAMPLE_RATE` | no | `0` | Share of requests sent to Sentry as performance traces, from `0` to `1`. Any other value stops the start. |
| `NEXT_PUBLIC_SENTRY_DSN` | no | unset | Sentry DSN for errors in the browser. It is built into the console when the image is built, so it must be a build argument. Published images are built without it. The server also uses it when `SENTRY_DSN` is unset. |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | no | unset | Only used while building: upload source maps to Sentry during `npm run build` when a DSN is set too. |

The image itself sets `PORT=3000`, `HOSTNAME=0.0.0.0`, and `NODE_ENV=production`.

### Variables for the compose files

The compose files also read these values from `.env`. They set up the containers. The app doesn't read them.

| Variable | Default from `generate-env.sh` | Purpose |
| --- | --- | --- |
| `LLMHUB_TAG` | `latest` | Image tag of `ghcr.io/nicolaeser/llmhub`. |
| `LLMHUB_PORT` | `3000` | Port on `127.0.0.1` for the reverse proxy. |
| `POSTGRES_USER` | `llmhub` | Database user. |
| `POSTGRES_DB` | `llmhub` | Database name. |
| `POSTGRES_PASSWORD` | random | Database password. |
| `REDIS_PASSWORD` | random | Redis password (`--requirepass`). |
| `COMPOSE_FILE` | `docker-compose.yml` | Compose files a plain `docker compose` uses, separated by `:`. Automatic updates add `docker-compose.au.yml`. |

### Memory limits

The compose files limit the memory of each container. `generate-env.sh` doesn't write these values. Add them to `.env` only if you want other limits:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLMHUB_MEMORY_LIMIT` | `4g` | Memory limit of the app. Node uses about half of it for its heap, so a lower limit also means a smaller heap. |
| `POSTGRES_MEMORY_LIMIT` | `2g` | Memory limit of PostgreSQL. |
| `REDIS_MEMORY_LIMIT` | `1g` | Memory limit of Redis. |

The keeper and the updater are limited to 256 MB each. The limits are maximums, not reserved memory. Keep their sum below the memory of the server. When the server itself runs out of memory, the kernel stops a process of its choice, and that can interrupt a database migration or a Redis write.

Example for a server with 2 GB: set `LLMHUB_MEMORY_LIMIT=1g`, `POSTGRES_MEMORY_LIMIT=512m`, and `REDIS_MEMORY_LIMIT=256m`, and add swap. `free -h` shows the memory, and `journalctl -k | grep -i oom` shows whether the kernel stopped a process.

Container logs rotate automatically: five files of 10 MB per container (`json-file`).

### Restarts without errors

On `docker compose stop` or `down`, the app gets 330 seconds to finish open requests and streams (`stop_grace_period`), because an API request can run for up to 300 seconds. During that time:

- It still accepts connections, but answers new API requests with `503 server_restarting`, `Retry-After: 15`, and `x-should-retry: true`. Anthropic clients see `overloaded_error`. Claude Code, Codex, and the SDKs then retry, instead of reporting an exhausted subscription or budget.
- `/internal-api/ready` answers `503`, so the reverse proxy holds new requests.
- It exits as soon as no API request is open.

An update through the [updater](#automatic-updates) waits at most 25 seconds, so the break stays short.

### Storage

S3 is optional. Without S3, LLM Hub keeps uploaded files, batch input and output, generated images and videos, stored responses, and vector store files in PostgreSQL (as `bytea` rows). This makes the database and its backups bigger.

With S3 (both keys in `.env` and the bucket in **Settings → Storage**), new files go to the bucket and the database keeps only their metadata. Logs can then also be archived to the bucket (see [Compliance archive](#compliance-archive)). Files saved before you turned on S3 stay in PostgreSQL.

### Compliance archive

**Settings → Compliance archive** copies data to S3-compatible storage once per finished day (UTC), shortly after midnight UTC:

- request logs (optionally with prompts and responses),
- the console audit trail,
- security activity,
- tool executions.

It uses the endpoint, region, and keys from **Settings → Storage**. The bucket can be a different one, for example a bucket with Object Lock. On the first run, it archives every day that is still in the database, oldest first.

**Files.** Each day and kind of data becomes one file under `<storage prefix>/<archive folder>/<data>/<year>/<month>/`, for example `compliance-archive/requests/2026/11/requests-2026-11-10.jsonl.gz`. Next to it is a `.manifest.json` with the record count, the SHA-256 of the records and of the file, the format, and the retention date.

**Formats.**

- `JSON Lines`: one JSON object per line, not compressed (`.jsonl`).
- `JSON Lines, gzip`: the same lines, compressed with gzip (`.jsonl.gz`).
- `Encrypted ZIP`: one `.jsonl` file per ZIP, compressed and encrypted with WinZip AES-256 (`.zip`). 7-Zip, WinZip, Keka, and `bsdtar --passphrase` can open it. The built-in ZIP support of Windows and macOS can't. The password is stored encrypted with `APP_SECRET` and is never shown again. LLM Hub can't recover it, so keep a copy in a password manager. A new password applies only to archives written after the change.

**How it runs.** Exports stream from PostgreSQL to the bucket in 16 MB parts (multipart upload), so memory use stays low even on large days. They run every five minutes in the background (on the `llmhub-archive` queue with Redis, otherwise on a timer in the app), on one replica at a time. A failed day is retried after 5 minutes, 15 minutes, 1 hour, and then up to once a day. A day that fails three times sends the `archive_failed` alert. **Settings → Compliance archive** lists the recent days with their result and can retry failed days.

**Retention in the database.** While the archive is on, the database retention in **Settings → Logging & alerts** deletes only rows of days that are archived. A day that waits or failed keeps its rows, and so does every later day, until it is archived. So the database can keep a few days while the bucket keeps years. Only the "Maximum content size in GB" limit can still delete prompts and responses that are not archived yet, because it protects the disk.

**Retention in the bucket.** "Days to keep archives" deletes older days from the bucket (0 keeps them). With Object Lock set to Governance or Compliance, each file gets that lock mode and a retain-until date at the end of its retention period. Nobody can change or delete it before that date (in Compliance mode, not even the bucket owner). Object Lock needs a bucket created with Object Lock turned on; other buckets fail with "The bucket does not support Object Lock". A lifecycle rule on the bucket works too and can move old archives to a cheaper storage class.

The switch "Archive request logs to object storage" under **Logging & alerts** is something else: it writes one unencrypted JSON file per request under `logs/requests/` as requests happen.

### Error reporting

Sentry is optional. Without a DSN, Sentry is never started and makes no network calls. With a DSN, the server reports unhandled request errors and failed background jobs.

Sentry events never contain request or response bodies, cookies, credential or client address headers, users, database queries, or local variables. URL parameter values and add-account link tokens are replaced with `[Filtered]`, and error messages are cut to their first line. Requests the app sends to providers, webhooks, and MCP servers are not recorded and get no trace headers.

Browser errors need `NEXT_PUBLIC_SENTRY_DSN` when the image is built, for example `docker build --build-arg NEXT_PUBLIC_SENTRY_DSN=https://…`, because it is built into the console. The content security policy then allows that Sentry host. `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_RELEASE`, and `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` set the browser values the same way.

### Disk usage

The updater needs 2 GB of free disk space before each update, and the console shows the free space next to it. To see what fills the disk, run these commands in the folder with `docker-compose.yml`:

```bash
df -h /
docker system df
sudo du -sh postgres-data redis-data /var/lib/docker /var/lib/containerd 2>/dev/null
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15"'
```

What usually takes space:

- **Stored prompts and responses.** Usually the biggest part of the database, because agent tools such as Claude Code and Codex send the whole conversation again with every request. **Settings → Logging & alerts** shows how much they use and limits them in two ways: "Content retention days" (7 by default) and "Maximum content size in GB" (5 by default, 0 for no limit; above it, the oldest eligible bodies are deleted first).
- **Files without S3.** Uploaded files, batch files, and vector store files stay in PostgreSQL (see [Storage](#storage)) until their own retention deletes them.
- **Container logs.** At most 50 MB per container.
- **Old images.** `docker image prune` removes images that no container uses, including old PostgreSQL and Redis images.

Prompts and responses live in a regular `RequestLogContent` table. The worker deletes expired bodies in bounded batches while retaining request metadata, costs, and usage. The size limit uses the UTF-8 bytes of serialized JSON payloads, excluding database/index overhead; the console shows that logical size and how many older rows still need measurement. Size-based cleanup waits for measurement to finish, keeps today's bodies, and respects compliance archive holds. Time-based retention continues during backfill. PostgreSQL reuses deleted space; deleting rows does not immediately shrink its files.

Upgrades from daily partition storage copy all existing bodies into the regular table without changing their contents. See [Updating an existing database](#updating-an-existing-database) before upgrading a large installation.

## Subscription sign-ins

Subscription accounts (Claude, ChatGPT/Codex, Kimi, SuperGrok, Antigravity, and the others) work with a sign-in instead of an API key. They are served from their own endpoint, `/api/subscription/v1`, and never mix with API key traffic.

**Connecting accounts.** Sign in through a device or callback sign-in in the console. You can also move accounts over once from CLIProxyAPI or EasyCLIProxyAPI: as auth files, as pasted JSON, or directly from a running CLIProxyAPI through its management API. LLM Hub checks every account with its provider first. It can also remove the account at the source, so the two tools never break each other's tokens.

**Limits.**

- A session stays on one account. When that account reaches its limit or loses its sign-in, the session moves to the next account with its full conversation.
- When every account is at its limit, the error says when the first account is free again for that model (weekly limits included). Codex and Claude Code in gateway mode then continue on their own.
- An optional window kickoff sends a one-line message with a chosen model as soon as an account's usage window resets, so the next window starts right away.
- The server reads each account's plan limits about every five minutes (once across all replicas, sooner right after a limit resets, and less often when a provider limits these checks). It pushes changes live to open consoles. Open tabs never cause provider calls, and a manual refresh adds at most one call per account per minute.

**Keeping sign-ins alive.** The provider replaces the token at every refresh. A refresh token works only once, so if the newest one gets lost, you have to sign in again. The keeper protects these tokens:

- It runs from the app image (`node keeper/keeper.mjs`) and refreshes due sign-ins every minute. It keeps working while the web server is down, restarting, or waiting for a failed migration, and while Redis is down. It only needs PostgreSQL. It uses the same code and the same database lease as the app, so the two never refresh the same account at the same time.
- The current compose files run it as its own `keeper` container. It keeps working while the app container is stopped or replaced. They also set `LLMHUB_KEEPER=separate` on the app. Without that variable (for example with a compose file from before November 2026), the app container runs the keeper itself: `node start.mjs` starts it after the first migration attempt, keeps it running while a failed migration is retried, and restarts it when it exits. You don't have to change anything for that.
- Every refreshed token is first written to the login journal and only then to the database. The journal has one encrypted file per refresh (AES-256-GCM with a key derived from `APP_SECRET`, mode 600) in `/login-journal`. The current compose files mount the named volume `login-journal` there for the app and the keeper. Without it, the journal lives in the image's anonymous volume, and `docker compose up` and the updater pass it on to every new app container.
- The keeper also copies new sign-ins from the database into the journal every minute. It keeps the three newest entries per account, removes an account's entries when you remove the account in LLM Hub, and removes entries of accounts that are missing from the database 30 days after their last change.
- Sometimes the database holds older tokens than the journal: saving failed, the process stopped before saving, or a backup was restored. Then the newer tokens are written back before anything refreshes, so a used refresh token is never sent again. Entries of another account are never restored.
- Without PostgreSQL nothing refreshes, because the database lease keeps two processes from refreshing the same account. The newest tokens wait in the journal, and refresh tokens last much longer than access tokens.

**Checking the keeper.**

- `docker compose ps keeper` shows whether it is healthy.
- `docker compose logs keeper` (or `docker compose logs app` when the app runs it) shows refreshes, restored sign-ins (`provider.sign_in_tokens_restored`), and failed steps.
- `keeper.database_waiting` followed by `keeper.database_ready` is not an error. It means the keeper started before PostgreSQL was ready (for example after a reboot) and waited up to two minutes.
- After a failed step (`keeper.step_failed`, with the reason from the database), it tries again after 5, 15, and 30 seconds.

> [!WARNING]
> `docker compose down -v` deletes the journal together with the volume. Leave out `-v`.

## Session affinity

Session affinity keeps every conversation on the same deployment of a model. Turn it on for a model group whose deployments are several replicas of one self-hosted model (vLLM, SGLang, llama.cpp, TGI).

**Why.** Each replica keeps a prefix cache (KV cache) of the prompts it has seen. Coding agents such as Claude Code, opencode, Cline, and Aider send the whole conversation again with every step, often 20,000 to 200,000 tokens, and it only grows. When a step lands on the replica that served the step before, that replica reuses its cache and only reads the new part. On another replica, the whole conversation is read again from the start. That slows the request and every other request on that replica. With long conversations, a step on the same replica can start in seconds where another replica first has to read the whole conversation again, and the time other requests wait for the replica drops too.

A load balancer in front of the replicas (Caddy, nginx, a Kubernetes service) can't do this. All requests come from LLM Hub without cookies, so it can't tell conversations apart. LLM Hub can.

**When to turn it on.** For a model group with two or more deployments that are replicas of the same model on your own servers, when clients send long conversations (agents, chat with long histories).

**When to leave it off.** For cloud APIs (OpenAI, Anthropic, and others manage their caches themselves), for model groups with one deployment, and for short independent requests such as embeddings, classification, or one-shot prompts. It is off by default, and without it nothing changes.

### How it works

It applies to every request routed through the model group: Chat Completions, Responses, and Anthropic Messages, and also embeddings and the other model endpoints. The routing strategy of the model group (for example least busy) still picks the deployment for the **first** request of a conversation. Session affinity then remembers that choice and sends the next requests of the same conversation there.

LLM Hub finds the conversation with the first of these keys:

1. A session key the client already sends: `prompt_cache_key` (Chat Completions and Responses), the cache key in Claude Code's `metadata`, or the `x-claude-code-session-id` header.
2. The `x-session-affinity` request header. Send it when your client wants to decide itself which requests belong together. At most 512 characters.
3. Otherwise a fingerprint of the start of the conversation: the system prompt and the first user message. For Chat Completions these are the `system` and `developer` messages and the first `user` message, for Anthropic Messages `system` and the first user message, and for Responses `instructions` and the first input item. Only text counts. Images and files count by a hash of their reference, line endings and trailing spaces are normalized, and only the first 64 KB of each part are read. Responses requests with a `conversation` use its ID; requests that continue with `previous_response_id` only have no fingerprint.

Every key is combined with the model group and the project or person of the API key (for a console user's own key, the key itself), so different projects never share an assignment. Answers, tool results, and new user messages at the end don't change the key. Because the fingerprint includes the first user message, users of the same client with the same system prompt still spread across the replicas. When a client compacts its conversation (a new start), the conversation gets a new key and may move. That costs nothing, because the replica has no cache for the new start anyway.

Keys are stored only as hashes. No prompt text goes to the request log, Redis, or the database for this.

Each assignment points to one deployment and stays for 30 minutes after the last request of the conversation. With Redis, all replicas of LLM Hub share the assignments (`llmhub:deployment-pin:v1:<group>:<session>`). Without Redis, or while it is down, each LLM Hub process keeps up to 20,000 assignments in memory.

For each request with a known conversation:

| Outcome | When | What happens |
| --- | --- | --- |
| `hit` | The assigned deployment is healthy, not cooling down, has a free concurrency slot, and is not overloaded. | It serves the request, and the assignment is extended. |
| `spill` | The assigned deployment has no free concurrency slot, or more than `SESSION_AFFINITY_SPILL_MARGIN` (default 4) requests in flight above the least busy deployment of the model. | The strategy picks another deployment, and the conversation moves there. |
| `failover` | The assigned deployment is unhealthy, cooling down, or already failed for this request. | The strategy picks another deployment, and the conversation moves there. |
| `new` | The conversation has no assignment yet. | The strategy picks, and the choice is remembered. |
| `off` | Session affinity is on, but no key could be found (for example a request without a user message). | The strategy picks as usual. |

Retries, fallbacks, and overflow models work as before. A deployment that already failed for a request is never chosen again for it because of an assignment. Subscription accounts keep their own session pinning (see [Subscription sign-ins](#subscription-sign-ins)).

### Set it up

Example: one model, `my-model`, runs as two replicas of an OpenAI-compatible inference server, reachable at `http://<replica-a>/v1` and `http://<replica-b>/v1` with the same API key.

1. On the **Providers** page, connect two OpenAI-compatible providers: `replica-a` with the base URL `http://<replica-a>/v1` and `replica-b` with `http://<replica-b>/v1`, both with the API key of the replicas. Each provider gets its own concurrency limit.
2. On the **Models** page, create the model `my-model` with the load-balance mode **Least busy**, add one endpoint per provider with the upstream model `my-model`, and turn on **Session affinity**.

With the management API:

```bash
curl https://hub.example.com/api/mgmt/models \
  -H "Authorization: Bearer $LLMHUB_MGMT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "my-model",
    "strategy": "least_inflight",
    "session_affinity": true,
    "deployments": [
      {"provider_id": "<replica-a provider id>", "model": "my-model"},
      {"provider_id": "<replica-b provider id>", "model": "my-model"}
    ]
  }'
```

For an existing model, send `PATCH /api/mgmt/models/<alias>` with `{"session_affinity": true}`. `GET /api/mgmt/models` shows the setting as `session_affinity`.

The result: each agent conversation stays on its replica, new conversations go to the less busy replica, and when one replica fails, the other takes over its conversations.

### Check that it works

- Responses from a model with session affinity carry the `x-llmhub-deployment` header with the ID of the deployment that served them.
- The request detail in **Logs** shows the outcome (`hit`, `new`, `spill`, `failover`, or `off`) and the hashed session key. A conversation that mostly shows `hit` stays on its replica.
- When conversations move too often or one replica stays much busier, change `SESSION_AFFINITY_SPILL_MARGIN` (see [Variables the app reads](#variables-the-app-reads)).

### Limits

- A compacted conversation starts over and may land on another replica.
- Load is spread per conversation, not per request. A few very large conversations can make one replica busier than the other until they spill.
- Without Redis, each LLM Hub process has its own assignments. With more than one LLM Hub replica, use Redis so they share them.

## Backup and restore

Everything that matters is stored in PostgreSQL, in S3 (if you use it), and in `.env`.

- Back up `.env` together with the database. Without the same `APP_SECRET`, encrypted provider keys and two-factor secrets can't be read.
- The login journal is not a backup. It only holds the newest sign-in tokens.
- Redis needs no backup. It only holds queues, counters, and caches. It saves a snapshot at most once a minute instead of an append-only file. A crash loses at most a minute of queue and counter changes, but never leaves a broken file that stops Redis from starting. A failed snapshot (for example on a full disk) doesn't stop Redis from accepting writes.

Create a backup in the folder with `docker-compose.yml`:

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "llmhub-$(date +%Y%m%d-%H%M%S).dump"
```

Restore a backup into the running database:

```bash
docker compose stop app
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' < llmhub-20261012-120000.dump
docker compose start app
```

Restore with the same image version that made the backup, or a newer one. A newer image applies its migrations when it starts. Leave the keeper running: accounts whose tokens were refreshed after the backup get their newer tokens back from the login journal within a minute, without signing in again.

## Upgrading

`docker-compose.yml` runs `ghcr.io/nicolaeser/llmhub:${LLMHUB_TAG}`, which is `latest` by default. For controlled upgrades, set `LLMHUB_TAG` in `.env` to a release tag instead, for example `v2026.10.12.abc1234`. Every release on the [releases page](https://github.com/nicolaeser/llmhub/releases) lists its tags and image digest. The `dev` tag follows the `development` branch and is published as a prerelease with a version such as `vdev2026.10.12.abc1234`. The `latest` tag follows `main`. Both dates come from the built commit, not the build time.

1. Back up the database and `.env` (see [Backup and restore](#backup-and-restore)).
2. Change `LLMHUB_TAG` in `.env`.
3. Run `docker compose pull && docker compose up -d`, using the same Compose file/options as your deployment. `pull` downloads the image; `up -d` replaces the containers. Existing Compose files remain supported. Download a newer file if you want its additional services or settings.
4. Check `/internal-api/ready` and `/internal-api/version`.

**Migrations.** Each container start applies new database migrations under a database lock before the server starts, so several replicas can start at the same time. When a migration fails, the container keeps running without the web server, logs `start.migration_failed`, and tries again after 10 seconds, 30 seconds, 1 minute, and 2 minutes, then every 5 minutes. The new updater reads migration status separately from health and preserves the replacement and backups when a database change makes container rollback unsafe. Migrations only go forward. To go back to an older version, restore the backup from before the upgrade and start the previous tag.

**Older compose files.** Compose files from before November 2026 keep working without changes. The app container then runs the keeper itself and keeps the login journal in the image's anonymous volume (see [Subscription sign-ins](#subscription-sign-ins)). Those files run Redis with an append-only file. The updater switches it to snapshots once (see [Automatic updates](#automatic-updates)); without the updater it stays as it is. Getting the current files is optional. They add the separate keeper container, the `login-journal` volume, and the snapshot settings for Redis. Download the current `generate-env.sh` and let it fetch them; it keeps your `.env` values:

```bash
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/generate-env.sh
./generate-env.sh --force
docker compose up -d
```

Older installations with the updater used a full copy of `docker-compose.yml` as `docker-compose.au.yml` and ran `docker compose -f docker-compose.au.yml`. That copy keeps working. Today `docker-compose.au.yml` only adds the updater to `docker-compose.yml`, so it no longer works alone. The script detects the old setup (`COMPOSE_FILE=docker-compose.au.yml` in `.env`, or the file next to it), offers automatic updates as the default, downloads both files, and sets `COMPOSE_FILE=docker-compose.yml:docker-compose.au.yml`. From then on, use a plain `docker compose` without `-f`. When Redis switches to snapshots, it stops normally and writes a final snapshot, which the new container loads, so queues and counters are kept. After that, `redis-data/appendonlydir` is no longer read and can be deleted.

**Older Caddy block.** If your Caddy block is still the plain `reverse_proxy 127.0.0.1:3000`, replace it with the block from [step 4](#4-set-up-the-reverse-proxy) and reload Caddy (`systemctl reload caddy` or `caddy reload`). Its health check on `/internal-api/ready` and `lb_try_duration` hold new requests while the app restarts and pass them to the new container. Without them, clients get `502` during every restart and must retry on their own. The first update to a release with this restart behavior is still installed by the previous updater and image, which wait up to 330 seconds for open streams. From the next update on, the app waits at most 25 seconds.

### Updating an existing database

All 63 original migration files remain unchanged. Existing instances apply two forward migrations: `20261115145000_prisma_compatibility` copies request bodies from every legacy, default, and daily partition into a regular table, preserving their keys, timestamps, owner, grants, and JSON/null values; `20261115145340_request_content_size` adds a nullable measurement column and index. Users, credentials, sessions, API keys, settings, and usage are retained. Older clients can still insert bodies without the new column; the worker measures them later.

The compatibility conversion is one transaction: a failed copy leaves the old table and data intact. It locks request-log writes and needs temporary disk space for a second content table plus indexes and PostgreSQL WAL. Take a backup and measure the upgrade on a restored copy. For large installations, schedule a maintenance window and stop older updaters before replacing the app; those versions may interrupt a long migration at their readiness deadline. The new updater allows a separate 30-minute migration window, then requests recovery while leaving the migration running. Deploy the same new image across replicas and allow migrations to complete before resuming traffic.

The historical custom SQL and this one conversion are preserved for compatibility. Subsequent regular migrations are generated by Prisma without edits. Schema changes at startup use only `prisma migrate deploy`; application queries use the Prisma Client API. No production reset or seed is part of an upgrade.

### A migration failed

The startup wrapper retries connection failures (`P1001`, `P1002`, `P1017`). For `P3009` caused solely by the published `20261115145000_prisma_compatibility` migration, it automatically verifies the checksum, original rolled-back schema, migration history, and database lock before using Prisma's official `migrate resolve --rolled-back` and retrying. This covers an interrupted transactional conversion without manual database edits. Unexpected schemas, other failed migrations, and `P3018` require investigation; the supervisor keeps the web server stopped. Regular Prisma-generated migrations can be partially applied.

1. Stop the app and pause automatic updates. Keep the current image for recovery: an older image may incorrectly assume newer migrations are transactional and automatically resolve their failures.
2. Back up the database, inspect the failed migration and PostgreSQL logs, and fix the cause. Its SQL is in `prisma/migrations/<name>/migration.sql` at the release tag.
3. If you reverted every partial change (or verified the transaction rolled back), mark that migration rolled back and retry. If you deliberately completed every change instead, use `migrate resolve --applied <name>`. Never alter `_prisma_migrations` directly.

```bash
docker compose stop app
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT migration_name, logs FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"'
docker compose run --rm --no-deps --entrypoint node app ./node_modules/prisma/build/index.js migrate resolve --rolled-back <name>
docker compose up -d
```

For an interrupted `20261115145000_prisma_compatibility` conversion, the image includes a verified repair command. Stop every app replica and the updater, take a backup, and ensure the database has space for the copied content, indexes, and WAL. The commands below are for the updater stack with `COMPOSE_FILE` in `.env` (without the updater, leave out `updater`); with an older setup, add the same `-f` options as your deployment. Use the current image:

```bash
docker compose stop updater app
docker compose run --rm --no-deps --entrypoint node app recover-compatibility.mjs
docker compose run --rm --no-deps --entrypoint node app migrate-deploy.mjs
```

Run each command only after the previous one succeeds. The repair accepts only the published compatibility migration's checksum, exactly one failed migration, the original partitioned content table and policy constraint, and no replacement table or later applied migration. It holds Prisma's PostgreSQL advisory lock throughout verification and `migrate resolve`; only that child process skips acquiring the lock again. It refuses an active migration or unexpected database state without changing migration records. It never resets the database, changes migration SQL, or marks a migration applied. Normal startup uses these same checks automatically, once per deployment attempt.

The deployment command streams Prisma output immediately and reports every 30 seconds while it is still running. A large copy may take longer than ten minutes. Leave PostgreSQL running and the updater stopped until it completes successfully. Then start the app, verify readiness, and resume the updater:

```bash
docker compose start app
curl --fail http://127.0.0.1:3000/internal-api/ready
docker compose start updater
```

Use your configured host port if it differs from 3000. If verification refuses recovery, inspect the database using the general procedure above instead of bypassing its checks.

`P3005` means the database is nonempty but has no Prisma migration history. Startup refuses it and never creates an automatic baseline. After a backup, compare the database with the schema at its original release and manually resolve only the migrations it actually contains. This repository keeps a historical migration chain; do not blindly resolve all folders or invent an applied `0_init`. A normal existing LLM Hub database already has its history and needs no adoption step.

## Automatic updates

`docker-compose.au.yml` is an add-on file for `docker-compose.yml`. It adds an updater container and gives the app and the keeper the label `llmhub.updater.target=true`, so both move to every new image. PostgreSQL, Redis, and everything else stay as `docker-compose.yml` defines them.

### Turn it on

Answer yes to **Automatic updates** in `generate-env.sh`. On an existing installation, run it with `--force`; it keeps all values:

```bash
./generate-env.sh --force
docker compose up -d
```

The script downloads `docker-compose.au.yml` and sets `COMPOSE_FILE=docker-compose.yml:docker-compose.au.yml` in `.env`, so a plain `docker compose` uses both files. Switching keeps all data: PostgreSQL, Redis, and the login journal stay as they are. Only the app and keeper containers are recreated.

Automatic updates start switched off. Turn them on in the console: the badge in the top bar (Live, Updating, Reconnecting, Offline) and **Settings → General → Automatic updates** show the updater, the running and the newest image, the free disk space, and the last check. They offer **Check now**, **Update now**, and the **Install updates automatically** switch (needs the `settings:manage` permission). While an updater is connected and updates are off, the console offers to turn them on.

The **Overview** dashboard shows the current phase, the service being replaced, completed services, elapsed time, downloaded bytes and layers, and migration or recovery status. The update panel also shows the last five updates with affected services, phase durations, and failure details. History survives updater restarts and self-updates. While the app restarts, the dashboard marks the last known status until the live connection returns. A lost connection alone does not mean the update succeeded or failed.

### How an update works

The updater runs from the same image (`node updater.mjs`) and keeps the app on the newest image of its tag:

1. Every five minutes, it asks the registry for the newest image of the tag the app runs, and compares it with the running image.
2. When automatic updates are on, or when someone clicks **Update now**, it first removes older, unused images of the app and checks that at least 2 GB are free on the Docker disk. It pulls the new image for the running platform, verifies that its digest matches the check, and checks that at least 512 MB are still free. A moving tag stops the update before any replacement. Before stopping a service, it saves a durable transaction journal. Each replacement uses the verified image ID and retains settings, environment, networks, aliases, and volumes. Running services get a 30-second drain and up to ten minutes to become healthy, separately from migration time. Intentionally stopped services are replaced without starting them.
3. All original containers remain until the whole group succeeds. A failure rolls back switched services in reverse order when the database state permits it. An interrupted updater recovers its journal before accepting more work. Active migrations and uncertain or changed database schemas prevent automatic rollback: the replacement, backups, and journal remain available, and the dashboard asks for recovery. An image that failed is not installed automatically again until a newer one is published; **Update now** retries ordinary failures. Recovery requiring intervention blocks further updates. With less than 2 GB free, automatic updates wait without blacklisting the image.
4. After the group succeeds, it commits the journal, removes backups and unused old images, and replaces its own container. Interrupted cleanup resumes without undoing the committed update. The updater only replaces existing services, so newly introduced services still require a Compose update.

A new container keeps the anonymous volumes of the one it replaces, like `docker compose up` does. So a stack without the `login-journal` volume keeps its login journal across updates. The image also provides an anonymous volume for the root updater's transaction and history files, preserving them during ordinary Compose recreation without requiring a Compose file change. Do not use `--renew-anon-volumes` or delete these volumes during recovery.

The updater service sets `pull_policy: always`. Every `docker compose up` with `docker-compose.au.yml` first pulls the newest image of `LLMHUB_TAG` and recreates the app and the updater if it changed. Without this, a server with an older image of the tag (for example one pulled before the updater existed) would start the updater from an image without `updater.mjs` (`Cannot find module '/app/updater.mjs'`). So this command needs access to the registry.

### Redis switch for older installations

After an update, the updater switches Redis from an append-only file to snapshots once. It only does this when the Redis container runs exactly the command of the compose files from before November 2026 (`redis-server --appendonly yes --requirepass …`), reports healthy, has a writable persistent mount at `/data`, and at least 2 GB are free. It keeps the exact Redis image ID even if its tag has moved. It stops Redis, which writes a final snapshot, and starts it with `--appendonly no --save "60 1" --stop-writes-on-bgsave-error no` and otherwise the same settings. If Redis can't shut down cleanly (for example because the snapshot failed), or the new container doesn't become healthy, it starts the previous container again, which still has its append-only file. It doesn't touch any other Redis or any other container of the stack.

Delete `redis-data/appendonlydir` before you ever start Redis with `--appendonly yes` again. Otherwise Redis loads that old file instead of the snapshot.

### Pinned tags

When `LLMHUB_TAG` is a release tag (`vYYYY.MM.DD.<sha7>` or `vdevYYYY.MM.DD.<sha7>`), a commit tag (`<sha7>`, `dev-<sha7>`), a legacy pinned tag (`dev-YYYY.MM.DD.<sha7>`, `sha-<sha7>`), or a digest, the updater reports the tag as pinned and never replaces the image. Set `LLMHUB_TAG` to `latest` or `dev` to get updates. Back up the database regularly while automatic updates are on, because a new image applies its migrations at start and migrations only go forward.

### Security

The updater gets only what it needs:

- The Docker socket. Pulls and registry lookups go through the Docker daemon.
- `APP_SECRET`, from which it derives the key that signs its messages to the app. It doesn't get the rest of `.env`.
- The default compose network, where it reaches the app at `http://app:3000/internal-api/updater`. It publishes no ports and accepts no connections.
- User `0:0`, because the socket belongs to root on the host, and the image's `node` user can't open it.

Every ten seconds, it sends its status to the app and reads back the switch and any requested check or update. Both directions are signed.

> [!CAUTION]
> Access to the Docker socket is the same as root access on the server. Anyone who controls the updater container or the image it pulls controls the server. That's why the socket lives in a separate container without ports, not in the app, which handles traffic from outside. Only use this file on servers where that is acceptable.

The updater only touches containers of its own compose project that have the label `llmhub.updater.target=true`. Running ones are recreated and checked; stopped ones are recreated without being started. It only pulls public images; registries that need a login are not supported.

These variables configure only the updater. The app doesn't read them:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_SECRET` | from `.env` | Must match the app. The updater derives its signing key from it. |
| `LLMHUB_UPDATER_APP_URL` | `http://app:3000` | Address of the app inside the compose network. |
| `LLMHUB_UPDATER_PROJECT` | detected | Compose project whose containers the updater manages, when it can't inspect its own container. |

### Turn it off

- **Stop automatic installs:** turn off the switch. The updater keeps checking and offers **Update now**.
- **Remove the updater:** run `./generate-env.sh --force`, answer no to **Automatic updates**, and run `docker compose up -d --remove-orphans`. This removes the updater and recreates the app and the keeper without the label.

An older updater refreshes itself after the next app update and prints the logs of the previous updater again, so `docker compose logs updater` still shows that run. `docker compose up -d` refreshes it by hand, together with the app.

## PII redaction model

Fixed patterns find structured values such as email addresses, card numbers, and national IDs. They don't find names or postal addresses in free text. That's why a PII policy can detect with:

- **Patterns** (the default, so nothing changes until you switch),
- a **Redaction model**,
- or **Model and patterns**.

Set it in **Guardrails → PII**, for the global policy and for each override.

- Secrets and credentials always go through the patterns first and never reach the model.
- Matches from the model use the same placeholders and numbering as pattern matches. Mask, block, and restore mode, the request logs, and the placeholder chips work as before.
- When the model fails or takes too long, the policy either falls back to patterns and logs a warning, or blocks the request with `503 pii_detector_unavailable`.

### Run the model next to LLM Hub

`docker-compose.rm.yml` runs [PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer) (MIT license, a 0.6B bidirectional Qwen3 encoder) on the CPU next to the app. It is an add-on file for `docker-compose.yml`, with or without `docker-compose.au.yml`:

```bash
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/docker-compose.rm.yml
```

Append `:docker-compose.rm.yml` to `COMPOSE_FILE` in `.env` (for example `COMPOSE_FILE=docker-compose.yml:docker-compose.au.yml:docker-compose.rm.yml`) and run `docker compose up -d`. `generate-env.sh --force` keeps the entry and updates the file with the others. The file adds three services on a network without internet access. They publish no ports:

- `redactor-fetch` downloads the [GGUF build](https://huggingface.co/perplexity-ai/PII-Tracer-GGUF) at a fixed commit into the `redactor-models` volume on the first start (about 1.2 GB), checks every file against its expected hash, and exits. Later starts only check the files. It is the only redactor service with internet access.
- `redactor-model` runs a fixed version of the `llama.cpp` server image as user `65534` with `--embeddings --pooling none`, which returns one hidden state per token.
- `redactor` runs `node redactor.mjs` from the app image. It tokenizes the text through the model server, applies the classification head, decodes the BIOES tags with the constrained Viterbi decoder from the model card, maps tokens back to character positions, and answers with the [redaction protocol](#redaction-protocol).

The app gets `LLMHUB_REDACTOR_URL=http://redactor:8080` and, at every start, an internal provider with the alias `pii-tracer`. This is also the default redaction model. The app doesn't wait for the redactor: until it is healthy, policies that use the model fall back or block, as configured.

`redactor-fetch` and `redactor` run the app image and have the label `llmhub.updater.target=true`. With `docker-compose.au.yml`, the updater moves them to the new image together with the app: it recreates `redactor` and waits until it is healthy, and recreates the finished `redactor-fetch` without starting it. The next `docker compose up` runs it again as before. If your copy of the file is older, download it again and run `docker compose up -d` once. Otherwise both keep running the old image after an update.

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLMHUB_REDACTOR_REVISION` | fixed commit | Commit of `perplexity-ai/PII-Tracer-GGUF` to download. Other commits are checked against the hashes Hugging Face lists for them. |
| `LLMHUB_REDACTOR_WINDOW` | `2048` | Tokens per model pass (at most 4096). Longer texts are split into overlapping windows. A bigger window needs more memory. |
| `LLMHUB_REDACTOR_CPUS` | `4` | CPU cores and threads for the model server. |
| `REDACTOR_MEMORY_LIMIT` | `4g` | Memory limit of the model server. A 2048-token window used up to 2.8 GB; 4096 needs about 4.4 GB. |

**Speed.** On 4 cores of a shared x86 server, the f16 model took 0.2 to 0.6 seconds for a sentence or a short paragraph, and about 26 seconds for a document of 7,300 characters (2,655 tokens). So expect a few seconds of extra delay per request on a CPU. Text the model has already seen is cached for 10 minutes, so earlier turns of a conversation are not checked again. A request with more than 200,000 characters of new text is treated like a model failure.

For more traffic, run the model on a GPU with [PII-Tracer-vLLM](https://huggingface.co/perplexity-ai/PII-Tracer-vLLM) behind an adapter that speaks the protocol below, and point `LLMHUB_REDACTOR_URL` or an internal provider at it. The model card covers English. It doesn't say how well German works, so test your own samples with the **Test** button in **Guardrails → PII**.

### Redaction protocol

Any service can be the redaction model. Add it as an OpenAI-compatible provider marked as internal (with an API key if it needs one; it is sent as a bearer token) and pick its alias in **Guardrails → PII**. LLM Hub calls it as a system request. These calls are metered as `internal:pii` and are never stored with content. Requests follow the Hugging Face token classification format:

```http
POST <base URL>/v1/token-classification
Content-Type: application/json

{"model": "pii-tracer", "inputs": ["Hi, I'm Daniel Whitfield, you can reach me at daniels@meridiancap.com.", "No PII here."]}
```

```json
[[{"entity_group": "private_person", "score": 0.9999, "start": 8, "end": 24},
  {"entity_group": "private_email", "score": 0.9999, "start": 46, "end": 69}], []]
```

- The answer has one list of matches per input, in the same order. A single string as `inputs` gets a single list.
- `start` and `end` count Unicode code points (like Python string indexes). `end` is not included.
- The label is read from `entity_group`, `entity`, or `label`, without a `B-`, `I-`, `E-`, or `S-` prefix. PII-Tracer labels map like this: `private_person` → `PERSON`, `private_email` → `EMAIL_ADDRESS`, `private_phone` → `PHONE_NUMBER`, `private_address` → `ADDRESS`, `private_url` → `URL`, `private_date` → `DATE_TIME`, `account_number` → `ACCOUNT_NUMBER`, `secret` → `SECRET`, and `other_pii` → `OTHER_PII`. Catalog IDs such as `IBAN_CODE` and the names `person`, `per`, `email`, `phone`, `address`, `street_address`, `date`, and `password` work too. Other labels are ignored.
- `score` (0 to 1) is optional. `word` is ignored.
- LLM Hub sends at most 16 inputs and 16,000 characters per request. It cuts longer texts into pieces of up to 2,000 characters that overlap by 200, and runs at most two requests at a time per app process.

## Local development

Use Node.js 24 or newer and a local PostgreSQL database dedicated to development. Copy `.env.example` to `.env`, set `NODE_ENV=development`, choose a database name such as `llmhub_dev` in `DATABASE_URL`, and generate your own `APP_SECRET` of at least 32 characters. Install dependencies with `npm ci` and apply the existing migrations with `npm run db:migrate`, then start with `npm run dev`. Open `/internal-api/setup` deliberately to create the first operator; login and registration do not redirect there automatically.

For disposable mock product data, run:

```bash
npm run seed-dev -- --reset-local=llmhub_dev
```

This deletes all data in the named database, reapplies every migration, and inserts an example company, departments, projects, and directory people. It creates no login accounts or credentials. The command requires a loopback database named with a `_dev` or `_development` suffix, refuses production and connection overrides, and checks that the confirmation matches the database name. Never use it on a database whose contents you need to retain. Production starts with migrations and an idempotent system catalog; no manual production seed is needed.

Keep route-specific components and hooks in the route's `_components/` directory, using kebab-case filenames. Pages retain routing and composition; server actions use `_action.ts` and call services in `src/lib/<domain>/`. Shared components live in lowercase `src/components/<domain>/` directories once more than one route needs them. The route policy and its allowlist live beside the tests in `src/tests/route-view-policy.ts`.

Start feature work from `origin/development` on `dev/<kebab-topic>`. If the integration branch is absent, arrange it before starting that branch workflow; do not silently substitute `main`.

```bash
git fetch origin
git switch -c dev/my-change origin/development
```

| Branch | Purpose | Published image tags |
| --- | --- | --- |
| `dev/<topic>` | One feature or change; quality checks only | None |
| `development` | Integrate finished features | `vdevYYYY.MM.DD.sha7`, `dev-sha7`, `dev` |
| `main` | Release | `vYYYY.MM.DD.sha7`, `sha7`, `latest` |

`YYYY.MM.DD` is the built commit's committer date; `sha7` is that commit's first seven SHA characters, including the merge commit when CI builds a merge. Rebuilding the same commit keeps the same version. `scripts/build-version.mjs` enforces the format; CI publishes only from the two integration/release branches.

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run i18n:check`, `npm run styles:check`, and `npm run heroui:check` before integration. Database integration tests use `npm run test:integration` against a disposable migrated database.


For future schema changes, use `npx prisma migrate dev --name <change>` against a disposable development database and commit its generated SQL unchanged. `SHADOW_DATABASE_URL` may point to a separate disposable shadow database. Never edit or squash already shipped migrations. See [.ai/playbooks/database-migration.md](.ai/playbooks/database-migration.md).

`DATABASE_URL=<local PostgreSQL URL> npm run test:migrations` tests every historical migration prefix, fresh installations, concurrent boot, custom schemas, and failure recovery. The test role needs permission to create databases and roles; the suite creates and removes its own uniquely named test databases and never resets the database named in the URL.

`npm run test:updater:docker` checks real Docker replacements, group rollback, process crashes, lost daemon responses, low-disk refusal, and volume preservation with disposable labeled fixtures. `node scripts/test-compose-upgrade.mjs <local-image> <expected-build-id>` checks an older Compose layout through a local test registry: `pull` followed by `up -d`, automatic recovery from an interrupted compatibility migration, retained request content and anonymous volumes, and the embedded keeper. Both commands require a local Docker daemon and remove their own test resources afterward.

## License

LLM Hub is released under the [MIT License](LICENSE).

LLM Hub is a personal project. It is not affiliated with, endorsed by, or sponsored by the author's sole proprietorship or any other company.
