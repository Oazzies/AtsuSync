@echo off
title AtsuSync Server
cd /d "%~dp0.."
echo [AtsuSync] Working directory: %CD%
echo [AtsuSync] Installing dependencies...
call npm install || goto :err
echo [AtsuSync] Building extension...
call npm run build || goto :err
echo [AtsuSync] Starting server...
call npm start
if errorlevel 1 goto :err
exit
:err
echo.
echo [AtsuSync] Server stopped or exited with an error.
pause
