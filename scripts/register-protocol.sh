#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/start-server.sh"
chmod +x "$START_SCRIPT"

if [ "$(uname -s)" != "Linux" ]; then
  echo "Protocol auto-registration is only supported on Windows and Linux."
  echo "Start the server manually with: $START_SCRIPT"
  exit 0
fi

APP_DIR="$HOME/.local/share/applications"
mkdir -p "$APP_DIR"
DESKTOP_FILE="$APP_DIR/atsusync.desktop"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=AtsuSync Server
Exec=x-terminal-emulator -e "$START_SCRIPT"
Type=Application
Terminal=false
MimeType=x-scheme-handler/atsusync;
NoDisplay=true
EOF

if command -v xdg-mime >/dev/null 2>&1; then
  xdg-mime default atsusync.desktop x-scheme-handler/atsusync
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "Registered atsusync:// protocol handler -> $START_SCRIPT"
