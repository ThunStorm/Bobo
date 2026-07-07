@echo off
setlocal
cd /d "%~dp0"
node server.js
if errorlevel 1 (
  echo.
  echo Bobo failed to start. Please make sure Node.js 18+ is installed.
)
pause
