\
param([string]$Python="python")
$ErrorActionPreference="Stop"
Set-Location -Path $PSScriptRoot
if (-not (Test-Path ".venv")) { Write-Host "[setup] Creating venv..."; & $Python -m venv .venv }
$venvPython = Join-Path ".venv" "Scripts/python.exe"
Write-Host "[setup] Upgrading pip..."; & $venvPython -m pip install --upgrade pip
Write-Host "[setup] Installing requirements..."; & $venvPython -m pip install -r requirements.txt
Write-Host "[run] Starting server on http://127.0.0.1:17890  and  ws://127.0.0.1:8765"; & $venvPython .\fake_api_server.py
