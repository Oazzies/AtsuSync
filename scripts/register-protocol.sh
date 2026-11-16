#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_SCRIPT="$SCRIPT_DIR/start-server.sh"
chmod +x "$START_SCRIPT"

OS_NAME="$(uname -s)"

if [ "$OS_NAME" = "Linux" ]; then
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
  exit 0
fi

if [ "$OS_NAME" = "Darwin" ]; then
  APP_DIR="$HOME/Applications"
  APP_PATH="$APP_DIR/AtsuSync Server.app"
  mkdir -p "$APP_DIR"
  rm -rf "$APP_PATH"

  ESCAPED_SCRIPT="${START_SCRIPT//\'/\'\\\'\'}"
  osacompile -o "$APP_PATH" \
    -e "on run" \
    -e "tell application \"Terminal\"" \
    -e "activate" \
    -e "do script \"'$ESCAPED_SCRIPT'\"" \
    -e "end tell" \
    -e "end run" \
    -e "on open location this_URL" \
    -e "tell application \"Terminal\"" \
    -e "activate" \
    -e "do script \"'$ESCAPED_SCRIPT'\"" \
    -e "end tell" \
    -e "end open location"

  PLIST="$APP_PATH/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleIdentifier" "$PLIST" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string moe.atsu.atsusync" "$PLIST"
  /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string 'AtsuSync Protocol'" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string atsusync" "$PLIST"

  LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [ -x "$LSREGISTER" ]; then
    "$LSREGISTER" -f "$APP_PATH"
  fi

  echo "Registered atsusync:// protocol handler -> $APP_PATH ($START_SCRIPT)"
  exit 0
fi

echo "Protocol auto-registration is not supported on $OS_NAME."
echo "Start the server manually with: $START_SCRIPT"
