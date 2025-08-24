Write-Host "== API Bridge Server Starter (v1.6) =="
$py = (Get-Command py -ErrorAction SilentlyContinue)
if (-not $py) { Write-Host "Python launcher not found. Install Python 3.12."; exit 1 }
Write-Host "Installing deps (aiohttp, websockets) ..."
py -3.12 -m pip install -r requirements.txt
Write-Host "Starting server..."
py -3.12 fake_api_server.py
