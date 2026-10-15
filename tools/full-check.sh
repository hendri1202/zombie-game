#!/usr/bin/env bash
# Full verification: static checks, then every browser harness against one server.
#
# One server for all three harnesses keeps the memory footprint to a single
# browser at a time, which matters on a capped-memory host.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4173}"
export GAME_URL="http://127.0.0.1:${PORT}/"

echo "=== asset format policy ==="
# agents.md: glTF is the only runtime model format. A stray FBX in the shipped
# assets, or a FBX path in source, fails the run.
# `|| true` on both probes: under `set -e` a grep or find that matches nothing
# returns 1, and assigning that into a variable kills the script silently.
fbx_files=$(find public -iname '*.fbx' 2>/dev/null | head -20 || true)
if [ -n "$fbx_files" ]; then
  echo "FAIL: FBX files shipped in public/:"
  echo "$fbx_files"
  exit 1
fi
fbx_refs=$(grep -rnE "['\"\x60][^'\"\x60]*\.fbx['\"\x60]" src/ 2>/dev/null | head -20 || true)
if [ -n "$fbx_refs" ]; then
  echo "FAIL: FBX paths referenced in src/:"
  echo "$fbx_refs"
  exit 1
fi
echo "PASS: no FBX shipped and none referenced in source"

echo "=== typecheck ==="
npm run typecheck

echo "=== unit tests ==="
npm run test

echo "=== build ==="
npm run build

echo "=== serve dist/ on ${GAME_URL} ==="
PORT="${PORT}" node tools/static-server.mjs &
SERVER_PID=$!
cleanup() {
  kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/"; then break; fi
  sleep 0.25
done
if ! curl -sf -o /dev/null "http://127.0.0.1:${PORT}/"; then
  echo "server never became ready" >&2
  exit 1
fi

echo "=== animation: clip binding and stride match ==="
node tools/diag-animation.mjs

echo "=== visual: reviewable frames + frame statistics ==="
node tools/diag-visual.mjs

echo "=== end to end: 37 checks ==="
node tools/smoke.mjs

echo
echo "All verification stages completed."
