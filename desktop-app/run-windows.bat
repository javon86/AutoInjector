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

if not exist "node_modules" (
  echo First run: installing dependencies, this can take a minute...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed - see the error above.
    pause
    exit /b 1
  )
)

echo Starting AutoInjector Desktop...
call npm start
pause
