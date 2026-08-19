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

rem Install on first run, and re-install whenever package.json changed since the
rem last install (e.g. after pulling an update that added a dependency).
set "NEED_INSTALL=0"
if not exist "node_modules" set "NEED_INSTALL=1"
if exist "node_modules" (
  for /f %%i in ('powershell -NoProfile -Command "if((Get-Item package.json).LastWriteTime -gt (Get-Item node_modules).LastWriteTime){'1'}else{'0'}" 2^>nul') do set "NEED_INSTALL=%%i"
)
if "%NEED_INSTALL%"=="1" (
  echo Installing/updating dependencies, this can take a minute...
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
