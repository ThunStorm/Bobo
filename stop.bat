@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://localhost:4177/api/shutdown' | Out-Null; Write-Host 'Bobo shutdown requested.' } catch { Write-Host 'Bobo is not running on http://localhost:4177 or refused shutdown.' }"
pause