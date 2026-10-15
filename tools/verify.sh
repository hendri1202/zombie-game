#!/usr/bin/env bash
# Build, serve dist/ locally, run the headless smoke test, then stop the server.
#
# Kept as one script because a separately started server does not survive across
# sessions here, and a stale server silently makes the smoke test load a blank
# page ("Failed to connect").
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4173}"
export GAME_URL="http://127.0.0.1:${PORT}/"

echo "== build =="
npm run build

echo "== serve dist/ on ${GAME_URL} =="
PORT="${PORT}" node tools/static-server.mjs &
SERVER_PID=$!
cleanup() {
  kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/"; then
    echo "server ready"
    break
  fi
  sleep 0.25
done

if ! curl -sf -o /dev/null "http://127.0.0.1:${PORT}/"; then
  echo "server never became ready" >&2
  exit 1
fi

echo "== smoke test =="
node tools/smoke.mjs
