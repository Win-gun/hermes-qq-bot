#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Requires an Apple Silicon Mac." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit((major>22||major===22&&minor>=12)&&major<26?0:1)'; then
  echo "Requires host Node.js >=22.12 and <26." >&2
  exit 1
fi
for tool in npm docker hermes; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Requires external $tool installation." >&2
    exit 1
  fi
done

npm ci --omit=dev
npm run web:start
