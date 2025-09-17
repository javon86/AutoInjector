@echo off
setlocal ENABLEDELAYEDEXPANSION
REM ===== AutoInjector — Start Local Fake OpenAI Server (Windows .bat) =====
REM Creates venv if missing, installs deps, starts fake_api_server.py.
REM Keeps window open on errors or when the server exits.

pushd "%~dp0"

REM Prefer 'py -3' when available, else fall back to 'python'
where py >NUL 2>&1
if %ERRORLEVEL%==0 (
  set "PY=py -3"
) else (
  set "PY=python"
)

if not exist ".venv" (
  echo [setup] Creating virtual environment .venv ...
  %PY% -m venv .venv
  if %ERRORLEVEL% NEQ 0 (
    echo [error] Failed to create venv.
    goto :PAUSE_END
  )
)

call ".venv\Scripts\activate.bat"
if %ERRORLEVEL% NEQ 0 (
  echo [error] Failed to activate venv.
  goto :PAUSE_END
)

echo [setup] Upgrading pip...
python -m pip install --upgrade pip >NUL

echo [setup] Installing requirements...
python -m pip install -r requirements.txt
if %ERRORLEVEL% NEQ 0 (
  echo [error] pip install failed.
  goto :PAUSE_END
)

REM ---- Bind addresses/ports (match extension defaults) ----
set "HTTP_HOST=127.0.0.1"
set "HTTP_PORT=17890"
set "WS_HOST=127.0.0.1"
set "WS_PORT=8765"

echo [run] Starting server on http://%HTTP_HOST%:%HTTP_PORT%  and  ws://%WS_HOST%:%WS_PORT%
python fake_api_server.py
set "EXITCODE=%ERRORLEVEL%"
echo [exit] Server process ended with code %EXITCODE%

:PAUSE_END
echo.
echo Press any key to close this window...
pause >NUL
popd
endlocal
