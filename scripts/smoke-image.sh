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
keeper="${name}-keeper"
ready_attempts=90
keeper_attempts=30
base=""
app_secret="$(openssl rand -hex 32)"

cleanup() {
  local status=$?
  if [ "${status}" -ne 0 ]; then
    echo "::group::app logs"
    docker logs "${app}" 2>&1 | tail -n 200 || true
    echo "::endgroup::"
    echo "::group::keeper logs"
    docker logs "${keeper}" 2>&1 | tail -n 100 || true
    echo "::endgroup::"
  fi
  docker rm -f -v "${app}" "${keeper}" "${db}" >/dev/null 2>&1 || true
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

wait_keeper() {
  for attempt in $(seq 1 "${keeper_attempts}"); do
    if [ "$(docker inspect --format '{{.State.Running}}' "${keeper}")" != "true" ]; then
      echo "keeper stopped before it became healthy" >&2
      return 1
    fi
    if docker exec "${keeper}" node keeper/keeper.mjs --healthcheck; then
      if docker logs "${keeper}" 2>&1 | grep -q '"event":"keeper.step_failed"'; then
        echo "a keeper step failed" >&2
        return 1
      fi
      if ! docker logs "${keeper}" 2>&1 | grep -q '"event":"keeper.started".*"journal":true'; then
        echo "the keeper cannot write its login journal" >&2
        return 1
      fi
      echo "keeper healthy after ${attempt} attempts"
      return 0
    fi
    sleep 2
  done
  echo "keeper not healthy after $((keeper_attempts * 2)) seconds" >&2
  return 1
}

expect_embedded_keeper() {
  local logs
  for attempt in $(seq 1 "${keeper_attempts}"); do
    logs="$(docker logs "${app}" 2>&1)"
    if grep -q '"event":"keeper.started".*"journal":true' <<<"${logs}"; then
      if grep -q '"event":"keeper.step_failed"' <<<"${logs}"; then
        echo "a step of the embedded keeper failed" >&2
        return 1
      fi
      echo "embedded keeper started after ${attempt} attempts"
      return 0
    fi
    sleep 2
  done
  echo "the embedded keeper did not start with a writable login journal" >&2
  return 1
}

expect_clean_stop() {
  docker stop --time 60 "${app}" >/dev/null
  local code logs
  code="$(docker inspect --format '{{.State.ExitCode}}' "${app}")"
  if [ "${code}" != "143" ] && [ "${code}" != "0" ]; then
    echo "the app stopped with exit code ${code} instead of draining" >&2
    return 1
  fi
  logs="$(docker logs "${app}" 2>&1)"
  for event in start.stopping server.drained keeper.stopped; do
    if ! grep -q "\"event\":\"${event}\"" <<<"${logs}"; then
      echo "the app stopped without ${event}" >&2
      return 1
    fi
  done
  echo "app drained and stopped with exit code ${code}"
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
  -e APP_SECRET="${app_secret}" \
  "${image}" >/dev/null

wait_ready
expect_json /internal-api/ready '.status == "ready"'
expect_json /internal-api/health '.status == "ok"'
expect_json /internal-api/version ".version == \"${expected_build}\""
expect_page /internal-api/setup
expect_embedded_keeper

expect_clean_stop
docker start "${app}" >/dev/null
wait_ready
expect_json /internal-api/ready '.status == "ready"'
expect_json /internal-api/version ".version == \"${expected_build}\""

docker run -d --quiet --name "${keeper}" --network "${name}" -v /login-journal \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://llmhub:llmhub@${db}:5432/llmhub" \
  -e APP_SECRET="${app_secret}" \
  "${image}" node --liftoff-only --wasm-lazy-compilation keeper/keeper.mjs >/dev/null
wait_keeper
