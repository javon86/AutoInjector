@echo off
REM Creates a "BookForge" shortcut on your Desktop that starts run-bookforge.bat.
setlocal
cd /d "%~dp0"
set "TARGET=%~dp0run-bookforge.bat"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'BookForge.lnk')); $s.TargetPath=$env:TARGET; $s.WorkingDirectory=(Split-Path $env:TARGET); $s.Description='Start BookForge'; $s.IconLocation='%SystemRoot%\System32\imageres.dll,112'; $s.Save()"
if errorlevel 1 (
    echo Could not create the shortcut. You can still double-click run-bookforge.bat.
) else (
    echo A "BookForge" shortcut is now on your Desktop. Double-click it to start BookForge.
)
pause
endlocal
