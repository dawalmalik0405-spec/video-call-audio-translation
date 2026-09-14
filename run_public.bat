@echo off
setlocal enabledelayedexpansion

rem -------------------------------------------------
rem Clean up any existing ngrok processes
rem -------------------------------------------------
ngrok.exe kill >nul 2>&1 || echo No active ngrok tunnels
taskkill /F /IM ngrok.exe >nul 2>&1 || echo No existing ngrok processes found

rem -------------------------------------------------
rem Clean up any stray Node processes (port 8765/9000)
rem -------------------------------------------------
taskkill /F /IM node.exe >nul 2>&1 || echo No existing node processes found

rem -------------------------------------------------
rem 1. Launch Node UI (detached) on port 9000
rem -------------------------------------------------
start "" npm run start

rem -------------------------------------------------
rem Wait for Node UI to listen on port 9000 before starting ngrok
rem -------------------------------------------------
powershell -NoProfile -Command "while(-not (Test-NetConnection -ComputerName localhost -Port 9000 -InformationLevel Quiet)){Start-Sleep -Seconds 1}" >nul 2>&1

rem -------------------------------------------------
rem 2. Start ngrok tunnel for port 9000
rem -------------------------------------------------
start "" /b ngrok.exe http 9000 --log=ngrok_log.txt

rem -------------------------------------------------
rem 3. Fetch public HTTPS URL via ngrok API (with retry loop)
rem -------------------------------------------------
set "NGROK_PUBLIC_URL="
for /f "usebackq tokens=*" %%U in (`powershell -NoProfile -Command "$u=''; for ($i=0; $i -lt 15; $i++) { try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 1; if ($r.tunnels -and $r.tunnels[0].public_url) { $u = $r.tunnels[0].public_url; break } } catch {}; Start-Sleep -Seconds 1 }; Write-Output $u"`) do (
    set "NGROK_PUBLIC_URL=%%U"
)

rem -------------------------------------------------
rem 4. Show URLs
rem -------------------------------------------------
echo.
echo ==============================================
echo  TranslateMeet Public Tunnel Ready!
echo  Public Web UI (HTTPS) : %NGROK_PUBLIC_URL%
echo  Local Node Server     : http://localhost:9000
echo  Local FastAPI Server  : http://localhost:8000
echo ==============================================
echo.

rem -------------------------------------------------
rem 5. Activate virtual environment and launch FastAPI
rem -------------------------------------------------
if exist ".\.venv\Scripts\activate.bat" (
    call .\.venv\Scripts\activate.bat
)

start "" uvicorn translator_fastapi:app --host 0.0.0.0 --port 8000

rem Keep the script alive so you can copy the URLs
pause
