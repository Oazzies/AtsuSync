#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "=== AtsuSync Setup ==="
echo "Folder: $PWD"
echo ""

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
  NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
  if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
    return 1
  fi
  return 0
}

install_node() {
  local os_name
  os_name="$(uname -s)"

  if [ "$os_name" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      if brew list node >/dev/null 2>&1; then
        brew upgrade node
      else
        brew install node
      fi
      return 0
    fi
    if command -v curl >/dev/null 2>&1; then
      local pkg_name
      pkg_name="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/node-v22\.[0-9]+\.[0-9]+\.pkg$/ { print $2; exit }')"
      if [ -n "$pkg_name" ]; then
        local tmp_pkg
        tmp_pkg="$(mktemp /tmp/node-v22-XXXXXX.pkg)"
        curl -fL "https://nodejs.org/dist/latest-v22.x/$pkg_name" -o "$tmp_pkg"
        sudo installer -pkg "$tmp_pkg" -target /
        rm -f "$tmp_pkg"
        return 0
      fi
    fi
    return 1
  fi

  if [ "$os_name" = "Linux" ]; then
    if command -v apt-get >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
      return 0
    elif command -v dnf >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y nodejs
      return 0
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -Sy --noconfirm nodejs npm
      return 0
    elif command -v zypper >/dev/null 2>&1; then
      sudo zypper install -y nodejs22 || sudo zypper install -y nodejs
      return 0
    fi
  fi

  return 1
}

if ! check_node; then
  FOUND_VER="none"
  if command -v node >/dev/null 2>&1; then
    FOUND_VER="$(node -v)"
  fi
  echo "Node.js >= 22.5.0 is required (found: $FOUND_VER)."
  read -r -p "Install Node.js 22 LTS automatically now? [Y/n] " ans
  if [ -z "$ans" ] || [[ "$ans" =~ ^[Yy] ]]; then
    install_node || true
    hash -r 2>/dev/null || true
  fi
  if ! check_node; then
    echo "Please install Node.js 22+ (LTS recommended) from https://nodejs.org and re-run ./setup.sh."
    exit 1
  fi
fi

NODE_VER="$(node -v | sed 's/^v//')"
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
OS_NAME="$(uname -s)"
if [ "$OS_NAME" = "Linux" ] || [ "$OS_NAME" = "Darwin" ]; then
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
echo "  4. Open https://atsu.moe and click \"Start Server\" in the AtsuSync panel (or run ./scripts/start-server.sh)."
echo ""
