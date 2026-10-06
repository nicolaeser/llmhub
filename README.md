# LLM Hub

Self-hosted OpenAI-compatible LLM gateway (`/v1`) with an admin console.

## Run

```bash
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/nicolaeser/llmhub/main/generate-env.sh
sh generate-env.sh https://hub.example.com
docker compose up -d
```

`generate-env.sh` writes `.env` with `NEXT_PUBLIC_APP_URL`, a fresh `APP_SECRET`, the Postgres user and database name (`POSTGRES_USER` and `POSTGRES_DB`, both `llmhub`), and fresh `POSTGRES_PASSWORD` and `REDIS_PASSWORD`; it never overwrites an existing `.env`. Keep `APP_SECRET` stable: it encrypts stored provider keys and signs sessions. The app listens on `127.0.0.1:3000`; put a reverse proxy such as Caddy in front (`reverse_proxy 127.0.0.1:3000`). Postgres and Redis keep their data in `./postgres-data` and `./redis-data` next to the compose file. Migrations run on every container start. Create the owner account at `/internal-api/setup`; every account sets up two-factor authentication at its first sign-in. Self-registration stays off until you enable it in Admin settings.

## Develop

```bash
sh generate-env.sh
docker compose -f docker-compose.dev.yml up -d postgres redis rustfs
npm ci
npx prisma generate
npm run db:migrate
npm run dev
```

Without a URL, `generate-env.sh` writes a local `.env` that also points `DATABASE_URL` at Postgres on `127.0.0.1:5433`, `REDIS_URL` at password-protected Redis on `127.0.0.1:6379` (BullMQ), and carries the S3 keys for RustFS on `127.0.0.1:9000`.

Project documentation lives in [`.ai/`](.ai/SUMMARY.md).
