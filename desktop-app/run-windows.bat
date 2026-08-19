@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or isn't on your PATH.
  echo Install it from https://nodejs.org/ ^(pick the LTS version, default options are fine^),
  echo then double-click this file again.
  pause
  exit /b 1
)

rem Make sure every declared dependency is actually present (a partial or
rem interrupted install leaves node_modules in place but incomplete). The
rem preflight installs only what's missing and reports clearly if it can't.
call node scripts\ensure-deps.js
if errorlevel 1 (
  echo.
  echo Could not finish installing dependencies - see the message above.
  pause
  exit /b 1
)

echo Starting AutoInjector Desktop...
call npm start
pause
