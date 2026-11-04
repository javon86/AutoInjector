@echo off
rem Copies the AutoInjector custom Claude Code skills into .claude\skills.
rem Double-click this file, or run it from a Command Prompt. Safe to run again (it overwrites).
setlocal
set "SRC=%~dp0"
set "DEST=%~dp0..\.claude\skills"

if not exist "%DEST%" mkdir "%DEST%"
if errorlevel 1 (
  echo ERROR: could not create "%DEST%".
  pause
  exit /b 1
)

set FAILED=0
for %%S in (autoinjector-pane-repair autoinjector-relay-debug autoinjector-verify-change alfred-add-tool autoinjector-media-diagnostics autoinjector-electron-review) do (
  if not exist "%SRC%%%S\SKILL.md" (
    echo MISSING: %%S\SKILL.md
    set FAILED=1
  ) else (
    if not exist "%DEST%\%%S" mkdir "%DEST%\%%S"
    copy /Y "%SRC%%%S\SKILL.md" "%DEST%\%%S\SKILL.md" >nul
    if errorlevel 1 (
      echo FAILED:  %%S
      set FAILED=1
    ) else (
      echo ok       %%S
    )
  )
)

if exist "%DEST%\x" del "%DEST%\x" >nul 2>&1

echo.
if "%FAILED%"=="1" (
  echo Some skills were not installed. See the lines above.
) else (
  echo All 6 custom skills installed to "%DEST%".
  echo Restart Claude Code in this project to load them.
)
pause
endlocal
