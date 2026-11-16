#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "[AtsuSync] Working directory: $PWD"

while true; do
  export ATSUSYNC_WRAPPER=1
  rm -f ".atsusync-restart"

  if [ ! -d "node_modules" ]; then
    echo "[AtsuSync] Installing dependencies..."
    npm install
  fi

  if [ ! -f "extension/dist/manifest.json" ]; then
    echo "[AtsuSync] Building extension..."
    npm run build
  fi

  echo "[AtsuSync] Starting server..."
  npm start || exit $?

  if [ -f ".atsusync-restart" ]; then
    rm -f ".atsusync-restart"
    echo ""
    echo "[AtsuSync] Restarting server after update..."
    sleep 1
    continue
  fi
  break
done
