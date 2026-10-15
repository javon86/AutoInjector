@echo off
REM ==========================================================================
REM  BookForge launcher for Windows. Double-click this file.
REM  1. finds Python 3.10+ (explains how to install it if missing)
REM  2. makes a private Python environment in %LOCALAPPDATA%\Bookforge\venv
REM  3. installs what BookForge needs (only the first time, quietly)
REM  4. starts BookForge on a free port and opens your browser
REM  The window stays open; close it to stop BookForge.
REM ==========================================================================
setlocal EnableExtensions
title BookForge
cd /d "%~dp0"

echo.
echo   BookForge is starting...
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
set "BFHOME=%LOCALAPPDATA%\Bookforge"
if "%LOCALAPPDATA%"=="" set "BFHOME=%USERPROFILE%\Bookforge"
set "VENV=%BFHOME%\venv"
set "VPY=%VENV%\Scripts\python.exe"
if not exist "%BFHOME%" mkdir "%BFHOME%" >nul 2>nul
if not exist "%VPY%" (
    echo   First start: preparing BookForge's own Python environment. This takes a minute...
    %PY% -m venv "%VENV%" >nul 2>nul
)
if not exist "%VPY%" (
    echo   Could not make a private environment; using your normal Python instead.
    for /f "delims=" %%P in ('%PY% -c "import sys; print(sys.executable)"') do set "VPY=%%P"
)

REM ---- 3. install what BookForge needs (only when missing) -----------------
"%VPY%" -c "import jsonschema" >nul 2>nul
if errorlevel 1 (
    echo   Installing what BookForge needs ^(needs the internet once^)...
    "%VPY%" -m pip install --quiet --disable-pip-version-check -r requirements.txt
    if errorlevel 1 goto :noinstall
)

REM ---- 4. start (the program picks a free port and opens the browser) ------
echo   BookForge is running. Your browser opens by itself.
echo   Keep this window open while you work. Close it to stop BookForge.
echo.
"%VPY%" -m bookforge %*
if errorlevel 1 goto :crashed
endlocal
exit /b 0

:nopython
echo   ------------------------------------------------------------------
echo   BookForge needs Python 3.10 or newer, and it was not found.
echo.
echo   How to fix it:
echo     1. Your browser now opens https://www.python.org/downloads/
echo     2. Download and run the installer.
echo     3. IMPORTANT: tick "Add python.exe to PATH" on the first screen.
echo     4. When it is done, double-click run-bookforge.bat again.
echo   ------------------------------------------------------------------
start "" "https://www.python.org/downloads/"
pause
exit /b 1

:noinstall
echo   ------------------------------------------------------------------
echo   BookForge could not install the one package it needs (jsonschema).
echo   Check that this computer is connected to the internet, then
echo   double-click run-bookforge.bat again.
echo   ------------------------------------------------------------------
pause
exit /b 1

:crashed
echo.
echo   ------------------------------------------------------------------
echo   BookForge stopped because of a problem (see the messages above).
echo   Try double-clicking run-bookforge.bat again. If it keeps happening,
echo   send a photo of this window to whoever gave you BookForge.
echo   ------------------------------------------------------------------
pause
exit /b 1
