#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <image> <expected-build-id>" >&2
  exit 2
fi

image="$1"
expected_build="$2"
name="llmhub-smoke-${GITHUB_RUN_ID:-local}-$$"
app="${name}-app"
db="${name}-db"
ready_attempts=90
base=""

cleanup() {
  local status=$?
  if [ "${status}" -ne 0 ]; then
    echo "::group::app logs"
    docker logs "${app}" 2>&1 | tail -n 200 || true
    echo "::endgroup::"
  fi
  docker rm -f "${app}" "${db}" >/dev/null 2>&1 || true
  docker network rm "${name}" >/dev/null 2>&1 || true
  exit "${status}"
}
trap cleanup EXIT

wait_ready() {
  base="http://$(docker port "${app}" 3000/tcp | head -n 1)"
  for attempt in $(seq 1 "${ready_attempts}"); do
    if [ "$(docker inspect --format '{{.State.Running}}' "${app}")" != "true" ]; then
      echo "container stopped before it became ready" >&2
      return 1
    fi
    if curl -fsS --max-time 5 "${base}/internal-api/ready" >/dev/null 2>&1; then
      echo "ready after ${attempt} attempts"
      return 0
    fi
    sleep 2
  done
  echo "not ready after $((ready_attempts * 2)) seconds" >&2
  return 1
}

expect_json() {
  local path="$1"
  local filter="$2"
  local body
  body="$(curl -fsS --max-time 10 "${base}${path}")"
  if ! jq -e "${filter}" <<<"${body}" >/dev/null; then
    echo "${path} returned ${body}" >&2
    return 1
  fi
  echo "${path} ok"
}

expect_page() {
  local path="$1"
  local status
  status="$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "${base}${path}")"
  if [ "${status}" != "200" ]; then
    echo "${path} answered ${status}" >&2
    return 1
  fi
  echo "${path} ok"
}

docker network create "${name}" >/dev/null
docker run -d --quiet --name "${db}" --network "${name}" \
  -e POSTGRES_USER=llmhub \
  -e POSTGRES_PASSWORD=llmhub \
  -e POSTGRES_DB=llmhub \
  postgres:18-alpine >/dev/null
docker run -d --quiet --name "${app}" --network "${name}" -p 127.0.0.1::3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://llmhub:llmhub@${db}:5432/llmhub" \
  -e APP_SECRET="$(openssl rand -hex 32)" \
  "${image}" >/dev/null

wait_ready
expect_json /internal-api/ready '.status == "ready"'
expect_json /internal-api/health '.status == "ok"'
expect_json /internal-api/version ".version == \"${expected_build}\""
expect_page /internal-api/setup

docker restart "${app}" >/dev/null
wait_ready
expect_json /internal-api/ready '.status == "ready"'
expect_json /internal-api/version ".version == \"${expected_build}\""
