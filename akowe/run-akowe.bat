@echo off
REM ==========================================================================
REM  Akowe launcher for Windows (plain ASCII here; the app shows its name as "Akowe" with a dot under the o). Double-click this file.
REM  1. finds Python 3.10+ (explains how to install it if missing)
REM  2. makes a private Python environment in %LOCALAPPDATA%\Akowe\venv
REM  3. installs what Akowe needs (only the first time, quietly)
REM  4. starts Akowe on a free port and opens your browser
REM  The window stays open; close it to stop Akowe.
REM  OPTIONAL: AutoInjector (desktop-app\run-windows.bat) starts Akowe by itself and shows it in its
REM  "Akowe" tab. Use this file only to run Akowe on its own (if AutoInjector already runs it, this opens it).
REM ==========================================================================
setlocal EnableExtensions
title Akowe
cd /d "%~dp0"

echo.
echo   Akowe is starting...
echo.

REM ---- 1. find Python ------------------------------------------------------
set "PY="
where py >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
    where python >nul 2>nul
    if not errorlevel 1 (
        python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
        if not errorlevel 1 set "PY=python"
    )
)
if not defined PY goto :nopython

REM ---- 2. private environment ---------------------------------------------
set "BFROOT=%LOCALAPPDATA%"
if "%LOCALAPPDATA%"=="" set "BFROOT=%USERPROFILE%"
set "BFHOME=%BFROOT%\Akowe"
REM Akowe was called BookForge before 2026-10-25: its folder (venv, books data) moves over once.
REM If it cannot be moved (a file in use), the old folder keeps being used and Akowe copies the data itself.
if not exist "%BFHOME%" if exist "%BFROOT%\Bookforge" (
    move "%BFROOT%\Bookforge" "%BFHOME%" >nul 2>nul
    if exist "%BFHOME%" (
        echo   Akowe was called BookForge before: your data folder moved to %BFHOME%
    ) else (
        set "BFHOME=%BFROOT%\Bookforge"
    )
)
set "VENV=%BFHOME%\venv"
set "VPY=%VENV%\Scripts\python.exe"
if not exist "%BFHOME%" mkdir "%BFHOME%" >nul 2>nul
if not exist "%VPY%" (
    echo   First start: preparing Akowe's own Python environment. This takes a minute...
    %PY% -m venv "%VENV%" >nul 2>nul
)
if not exist "%VPY%" (
    echo   Could not make a private environment; using your normal Python instead.
    for /f "delims=" %%P in ('%PY% -c "import sys; print(sys.executable)"') do set "VPY=%%P"
)

REM ---- 3. install what Akowe needs (only when missing) -----------------
"%VPY%" -c "import jsonschema" >nul 2>nul
if errorlevel 1 (
    echo   Installing what Akowe needs ^(needs the internet once^)...
    "%VPY%" -m pip install --quiet --disable-pip-version-check -r requirements.txt
    if errorlevel 1 goto :noinstall
)

REM ---- 4. start (the program picks a free port and opens the browser) ------
echo   Akowe is running. Your browser opens by itself.
echo   Keep this window open while you work. Close it to stop Akowe.
echo.
"%VPY%" -m akowe %*
if errorlevel 1 goto :crashed
endlocal
exit /b 0

:nopython
echo   ------------------------------------------------------------------
echo   Akowe needs Python 3.10 or newer, and it was not found.
echo.
echo   How to fix it:
echo     1. Your browser now opens https://www.python.org/downloads/
echo     2. Download and run the installer.
echo     3. IMPORTANT: tick "Add python.exe to PATH" on the first screen.
echo     4. When it is done, double-click run-akowe.bat again.
echo   ------------------------------------------------------------------
start "" "https://www.python.org/downloads/"
pause
exit /b 1

:noinstall
echo   ------------------------------------------------------------------
echo   Akowe could not install the one package it needs (jsonschema).
echo   Check that this computer is connected to the internet, then
echo   double-click run-akowe.bat again.
echo   ------------------------------------------------------------------
pause
exit /b 1

:crashed
echo.
echo   ------------------------------------------------------------------
echo   Akowe stopped because of a problem (see the messages above).
echo   Try double-clicking run-akowe.bat again. If it keeps happening,
echo   send a photo of this window to whoever gave you Akowe.
echo   ------------------------------------------------------------------
pause
exit /b 1
