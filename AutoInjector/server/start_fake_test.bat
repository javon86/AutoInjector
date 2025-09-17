@echo off
setlocal
pushd "%~dp0"
set "HTTP=http://127.0.0.1:17890"

echo [test] GET %HTTP%/health
curl -s %HTTP%/health
echo.
echo.

echo [test] POST dry_run to %HTTP%/v1/chat/completions
set "BODY={\"messages\":[{\"role\":\"user\",\"content\":\"dry run check\"}],\"dry_run\":true}"
curl -s -H "Content-Type: application/json" -d "%BODY%" %HTTP%/v1/chat/completions
echo.
echo.
echo Done.
echo Press any key to close...
pause >NUL
popd
endlocal
