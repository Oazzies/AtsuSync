@echo off
title AtsuSync Update
cd /d "%~dp0.."
echo [AtsuSync] Working directory: %CD%

if not exist ".git" (
  echo [AtsuSync] Not a git checkout. Download the latest ZIP from https://github.com/Oazzies/AtsuSync and run setup.cmd.
  pause
  exit /b 1
)

echo [AtsuSync] Pulling latest changes...
git pull --ff-only origin master || goto :err

echo [AtsuSync] Installing dependencies...
call npm install --no-audit --no-fund || goto :err

echo [AtsuSync] Building extension...
call npm run build || goto :err

echo [AtsuSync] Refreshing protocol handler...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-protocol.ps1" || goto :err

echo.
echo [AtsuSync] Update complete!
echo [AtsuSync] Reload the extension in chrome://extensions (refresh icon) and restart the server if it was running.
pause
exit /b 0

:err
echo.
echo [AtsuSync] Update failed.
pause
exit /b 1
