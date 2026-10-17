@echo off
setlocal EnableDelayedExpansion
title IG-Agent v5 — Clone and Run (Gemma-4 + Aduu)

echo ======================================================================
echo   IG-Agent v5 — Auto Clone, Setup and Start
echo   Default active targets: adarshu.io, deeps20_
echo ======================================================================

:: 1. If not already inside the repo, clone or update it
if not exist "server.py" (
    if exist "dsk_\server.py" (
        cd /d "dsk_"
        echo [git] Updating existing dsk_ checkout...
        git fetch origin arena/d05a574d-dsk
        git checkout arena/d05a574d-dsk
        git pull origin arena/d05a574d-dsk
    ) else (
        echo [git] Cloning Adarshukumar/dsk_ ^(branch arena/d05a574d-dsk^)...
        git clone -b arena/d05a574d-dsk https://github.com/Adarshukumar/dsk_.git dsk_
        if errorlevel 1 (
            echo [err] git clone failed. Make sure git is installed and internet is connected.
            pause
            exit /b 1
        )
        cd /d "dsk_"
    )
) else (
    echo [git] Already inside repo folder: %CD%
)

:: 2. Ensure curl_cffi is installed
echo [deps] Checking Python + curl_cffi...
python -c "import curl_cffi" >nul 2>&1
if errorlevel 1 (
    echo [deps] Installing curl_cffi...
    python -m pip install -r requirements.txt
)

:: 3. Copy ig-agent-chat.js to clipboard automatically so Ctrl+V in Instagram Console starts it
if exist "ig-agent-chat.js" (
    clip < "ig-agent-chat.js" >nul 2>&1
    echo.
    echo [ready] ig-agent-chat.js is COPIED to your clipboard!
    echo         1. Open https://www.instagram.com/direct/inbox/ in Chrome/Edge
    echo         2. Open DevTools Console ^(F12 or Ctrl+Shift+J^)
    echo         3. Press Ctrl+V and Enter — it AUTO-STARTS LIVE with adarshu.io and deeps20_!
    echo.
    echo         Or paste this tiny 1-line loader in the Instagram Console:
    echo         ^(()=>^{const w=new WebSocket^('ws://localhost:8787/ws'^);w.onopen=^()=>w.send^('{"id":"b","type":"bot"}'^);w.onmessage=e=^>^{eval^(JSON.parse^(e.data^).code^);w.close^(^)^}^}^)^(^)
    echo.
)

:: 4. Start the bridge (auto-restarts if it ever exits unexpectedly)
:loop
echo [bridge] Starting server.py on http://127.0.0.1:8787 ...
python server.py
echo [bridge] Bridge exited — restarting in 2 seconds ^(press Ctrl+C twice to quit^)...
timeout /t 2 >nul
goto loop
