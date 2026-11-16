#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "=== AtsuSync Setup ==="
echo "Folder: $PWD"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 22.5.0 is required. Install it from https://nodejs.org and re-run ./setup.sh."
  exit 1
fi

NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "Node.js >= 22.5.0 is required (found v$NODE_VER). Please upgrade Node.js."
  exit 1
fi
echo "[OK] Node.js v$NODE_VER"

echo ""
echo "Installing dependencies..."
npm install

if [ ! -f "extension/dist/manifest.json" ]; then
  echo ""
  echo "Building browser extension..."
  npm run build
fi

chmod +x scripts/start-server.sh scripts/register-protocol.sh scripts/update.sh
if [ "$(uname -s)" = "Linux" ]; then
  echo ""
  echo "Registering atsusync:// protocol handler..."
  ./scripts/register-protocol.sh
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps to load the browser extension:"
echo "  1. Open chrome://extensions (or brave://extensions)"
echo "  2. Enable \"Developer mode\" (top-right toggle)"
echo "  3. Click \"Load unpacked\" and select:"
echo "     $PWD/extension/dist"
echo "  4. Start the server with ./scripts/start-server.sh (or click Start Server on Linux)"
echo ""
