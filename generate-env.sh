#!/bin/sh
set -eu

APP_URL="${1:-}"

fail() {
  echo "[llmhub] $*" >&2
  exit 1
}

case "$APP_URL" in
  "" | http://* | https://*) ;;
  *) fail "The app URL must start with http:// or https:// (got: $APP_URL)" ;;
esac

[ -e .env ] && fail ".env already exists. Move it away first; regenerating would replace its secrets."

secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

POSTGRES_USER=llmhub
POSTGRES_DB=llmhub
POSTGRES_PASSWORD="$(secret 24)"
REDIS_PASSWORD="$(secret 24)"

umask 077
cat > .env <<ENV
NEXT_PUBLIC_APP_URL=${APP_URL:-http://localhost:3000}
APP_SECRET=$(secret 32)
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_DB=${POSTGRES_DB}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
ENV

if [ -n "$APP_URL" ]; then
  echo "[llmhub] Wrote .env for ${APP_URL}. Start with: docker compose up -d"
else
  cat >> .env <<ENV
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5433/${POSTGRES_DB}
REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6379
S3_ACCESS_KEY_ID=llmhub
S3_SECRET_ACCESS_KEY=$(secret 20)
ENV
  echo "[llmhub] Wrote .env for local development. Start with: docker compose -f docker-compose.dev.yml up -d postgres redis rustfs"
fi
