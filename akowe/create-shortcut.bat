@echo off
REM Creates an "Akowe" shortcut on your Desktop that starts run-akowe.bat (its name is written with the
REM dot-below o, U+1ECD, which PowerShell adds as [char]0x1ECD so this file can stay plain ASCII).
setlocal
cd /d "%~dp0"
set "TARGET=%~dp0run-akowe.bat"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d ('Ak'+[char]0x1ECD+'we.lnk'))); $s.TargetPath=$env:TARGET; $s.WorkingDirectory=(Split-Path $env:TARGET); $s.Description='Start Ak'+[char]0x1ECD+'we'; $s.IconLocation='%SystemRoot%\System32\imageres.dll,112'; $s.Save()"
if errorlevel 1 (
    echo Could not create the shortcut. You can still double-click run-akowe.bat.
) else (
    echo A "Akowe" shortcut is now on your Desktop. Double-click it to start Akowe.
)
pause
endlocal
