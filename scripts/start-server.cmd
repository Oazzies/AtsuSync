@echo off
title AtsuSync Server
cd /d "%~dp0.."
echo [AtsuSync] Working directory: %CD%

if not exist "node_modules" (
  echo [AtsuSync] Installing dependencies...
  call npm install || goto :err
)

if not exist "extension\dist\manifest.json" (
  echo [AtsuSync] Building extension...
  call npm run build || goto :err
)

echo [AtsuSync] Starting server...
call npm start
if errorlevel 1 goto :err
exit /b 0

:err
echo.
echo [AtsuSync] Server stopped or exited with an error.
pause
exit /b 1
