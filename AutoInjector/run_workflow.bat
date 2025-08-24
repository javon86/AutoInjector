@echo off
setlocal ENABLEDELAYEDEXPANSION

rem === Paths ===
set "ROOT=%~dp0"
cd /d "%ROOT%"
set "SRV=%ROOT%server"
set "HEALTH=http://127.0.0.1:17890/health"

echo [Workflow] Launching relay in a dedicated window...
start "AutoInjector Relay" cmd /k "cd /d ""%SRV%"" && ( if exist "".venv\Scripts\python.exe"" ( call "".venv\Scripts\activate"" ) ) && python -u fake_api_server.py"

echo [Workflow] Waiting for relay health at %HEALTH% ...
powershell -NoProfile -Command "$u='%HEALTH%'; for($i=0;$i -lt 40;$i++){ try{ $r=Invoke-WebRequest -UseBasicParsing $u -TimeoutSec 2; if($r.StatusCode -eq 200){ Write-Host '[OK] Relay up'; exit 0 } }catch{}; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo [Workflow] ERROR: Relay did not respond on %HEALTH% within timeout.
  echo Press any key to close this window...
  pause >nul
  exit /b 1
)

echo [Workflow] Relay is up. Running quick self-tests...
where curl >nul 2>nul
if errorlevel 1 (
  echo [Workflow] NOTE: curl not found, skipping curl tests.
) else (
  echo [Workflow] /health:
  curl -s "%HEALTH%"
  echo.
  echo [Workflow] _selftest:
  curl -s "http://127.0.0.1:17890/v1/chat/completions" -H "Content-Type: application/json" -d "{\"model\":\"_selftest\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
  echo.
  echo [Workflow] dry_run:
  curl -s "http://127.0.0.1:17890/v1/chat/completions" -H "Content-Type: application/json" -d "{\"model\":\"gpt-4o-mini\",\"dry_run\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"
  echo.
)

echo [Workflow] Opening ChatGPT in your default browser...
start "" "https://chatgpt.com/"
echo.
echo [Workflow] Done. Use the extension popup for Dry-Run or Live Test.
echo This window stays open. Press any key to close...
pause >nul
