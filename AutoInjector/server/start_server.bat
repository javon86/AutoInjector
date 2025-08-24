@echo off
setlocal
echo == API Bridge Server Starter (v1.6) ==
where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher not found. Install Python 3.12.
  pause
  exit /b 1
)
echo Installing deps (aiohttp, websockets) ...
py -3.12 -m pip install -r requirements.txt
echo Starting server...
py -3.12 fake_api_server.py
