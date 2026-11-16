#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "[AtsuSync] Working directory: $PWD"

if [ ! -d ".git" ]; then
  echo "[AtsuSync] Not a git checkout. Download the latest ZIP from https://github.com/Oazzies/AtsuSync and run ./setup.sh."
  exit 1
fi

echo "[AtsuSync] Pulling latest changes..."
git pull --ff-only origin master

echo "[AtsuSync] Installing dependencies..."
npm install --no-audit --no-fund

echo "[AtsuSync] Building extension..."
npm run build

if [ "$(uname -s)" = "Linux" ]; then
  ./scripts/register-protocol.sh
fi

echo ""
echo "[AtsuSync] Update complete!"
echo "[AtsuSync] Reload the extension in chrome://extensions and restart the server if it was running."
