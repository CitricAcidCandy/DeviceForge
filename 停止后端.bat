@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.18 or newer is required.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\backend-console.mjs" --stop
set "DEVICEFORGE_STOP_EXIT=%ERRORLEVEL%"
pause
endlocal & exit /b %DEVICEFORGE_STOP_EXIT%
