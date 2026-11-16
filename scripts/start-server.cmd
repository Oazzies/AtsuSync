@echo off
title AtsuSync Server
cd /d "%~dp0.."
echo [AtsuSync] Working directory: %CD%

:start
set ATSUSYNC_WRAPPER=1
if exist ".atsusync-restart" del /q ".atsusync-restart" >nul 2>&1

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
if exist ".atsusync-restart" (
  del /q ".atsusync-restart" >nul 2>&1
  echo.
  echo [AtsuSync] Restarting server after update...
  timeout /t 1 /nobreak >nul
  goto :start
)
if errorlevel 1 goto :err
exit /b 0

:err
echo.
echo [AtsuSync] Server stopped or exited with an error.
pause
exit /b 1
