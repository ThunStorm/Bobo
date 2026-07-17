@echo off
setlocal
cd /d "%~dp0"
node server.js
if errorlevel 1 (
  echo.
  echo Bobo failed to start. Check the message above.
  echo If "node" is not recognized, please install Node.js 18+.
)
pause
