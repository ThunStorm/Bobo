@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if defined NODE_BINARY (
  "%NODE_BINARY%" scripts\upgrade-data.js --interactive %*
) else (
  node scripts\upgrade-data.js --interactive %*
)
set "upgrade_status=%errorlevel%"
pause
exit /b %upgrade_status%
