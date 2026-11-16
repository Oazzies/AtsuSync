#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "[AtsuSync] Working directory: $PWD"

if [ ! -d "node_modules" ]; then
  echo "[AtsuSync] Installing dependencies..."
  npm install
fi

if [ ! -f "extension/dist/manifest.json" ]; then
  echo "[AtsuSync] Building extension..."
  npm run build
fi

echo "[AtsuSync] Starting server..."
exec npm start
