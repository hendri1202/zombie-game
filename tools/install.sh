#!/usr/bin/env bash
# Installs dependencies one group at a time. This sandbox has a 1 GiB memory
# cgroup, so a single `npm install` of everything has been OOM-killed before;
# splitting the installs keeps peak memory lower and makes a failure identifiable.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_OPTIONS=--max-old-space-size=512

echo "== node $(node -v) npm $(npm -v)"
node -e 'console.log("cgroup limit:", require("fs").readFileSync("/sys/fs/cgroup/memory.max","utf8").trim())' || true

echo "== runtime dependencies"
npm install --no-audit --no-fund --save three

echo "== dev dependencies"
npm install --no-audit --no-fund --save-dev vite typescript vitest @types/three

echo "== installed versions"
npm ls --depth=0
