@echo off
REM Bookforge launcher for Windows: checks Python, installs the one dependency, starts the workspace.
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
    set "PY=py -3"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Python 3.10 or newer is required. Install it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
        pause
        exit /b 1
    )
    set "PY=python"
)

%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"
if errorlevel 1 (
    echo Bookforge needs Python 3.10 or newer.
    pause
    exit /b 1
)

%PY% -c "import jsonschema" >nul 2>nul
if errorlevel 1 (
    echo Installing required package jsonschema...
    %PY% -m pip install --user -r requirements.txt
    if errorlevel 1 (
        echo Could not install jsonschema. Check your internet connection and try again.
        pause
        exit /b 1
    )
)

echo Starting Bookforge. Keep this window open while you work; close it to stop.
%PY% -m bookforge %*
if errorlevel 1 pause
endlocal
