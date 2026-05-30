@echo off
setlocal enabledelayedexpansion

rem -------------------------------------------------
rem Clean up any existing ngrok processes (free tier limit of 3 sessions)
rem -------------------------------------------------
ngrok.exe kill >nul 2>&1 || echo No active ngrok tunnels
taskkill /F /IM ngrok.exe >nul 2>&1 || echo No existing ngrok processes found

rem -------------------------------------------------
rem Clean up any stray Node processes (port 8765 may be left bound)
rem -------------------------------------------------
taskkill /F /IM node.exe >nul 2>&1 || echo No existing node processes found

rem -------------------------------------------------
rem 1️⃣ Launch Node UI (detached) on port 9000
rem -------------------------------------------------
start "" npm run start

rem -------------------------------------------------
rem Wait for Node UI to listen on port 9000 before starting ngrok
rem -------------------------------------------------
powershell -NoProfile -Command "while(-not (Test-NetConnection -ComputerName localhost -Port 9000 -InformationLevel Quiet)){Start-Sleep -Seconds 1}" >nul 2>&1

rem -------------------------------------------------
rem 2️⃣ Start a single ngrok tunnel for the UI (port 9000) and capture its URL
rem -------------------------------------------------
rem Start ngrok in background, logging output to a temporary file
start "" /b cmd /c "ngrok.exe http 9000 ^> ngrok_log.txt 2^>^&1"

rem -------------------------------------------------
rem Wait up to 15 seconds for the forwarding line to appear
rem -------------------------------------------------
set "NGROK_PUBLIC_URL="
for /L %%i in (1,1,15) do (
    for /f "tokens=2" %%A in ('type ngrok_log.txt ^| findstr "https://"') do (
        set "NGROK_PUBLIC_URL=%%A"
    )
    if defined NGROK_PUBLIC_URL goto :goturl
    timeout /t 1 >nul
)

:goturl
rem -------------------------------------------------
rem 3️⃣ Derive the WebSocket URL for FastAPI (same host, ws://)
rem -------------------------------------------------
set "NGROK_WS_URL=%NGROK_PUBLIC_URL:http://=ws://%"
set "NGROK_WS_URL=%NGROK_WS_URL:https://=ws://%"

rem -------------------------------------------------
rem Show the URLs so you can copy them
rem -------------------------------------------------
echo.
echo ==============================
echo ngrok tunnel is ready:
echo UI (HTTPS)   : %NGROK_PUBLIC_URL%
echo WS (FastAPI) : %NGROK_WS_URL%
echo ==============================
echo.

rem -------------------------------------------------
rem 4️⃣ Activate the virtual‑env
rem -------------------------------------------------
call .\.venv\Scripts\Activate.ps1

rem -------------------------------------------------
rem 5️⃣ Launch FastAPI (detached)
rem -------------------------------------------------
start "" uvicorn translator_fastapi:app --host 0.0.0.0 --port 8000

rem Keep the script alive so you can see the URLs
pause
