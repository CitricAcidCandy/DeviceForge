@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.18 or newer is required.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\backend-console.mjs" %*
set "DEVICEFORGE_START_EXIT=%ERRORLEVEL%"
if not "%DEVICEFORGE_START_EXIT%"=="0" pause
endlocal & exit /b %DEVICEFORGE_START_EXIT%
