#!/usr/bin/env bash
# ==============================================================================
#  IG-Agent v7 — Clone & Run (GLM-4.7-Flash + Gemma-4 Brain) (Linux / macOS / Git Bash / WSL)
#  Default active targets: adarshu.io, deeps20_
# ==============================================================================
set -e

REPO_URL="https://github.com/Adarshukumar/dsk_.git"
BRANCH="arena/d05a574d-dsk"

echo "======================================================================"
echo "  IG-Agent v7 — Auto Clone, Setup and Start"
echo "  Default active targets: adarshu.io, deeps20_"
echo "======================================================================"

# 1. Clone or enter repo
if [ ! -f "server.py" ]; then
  if [ -f "dsk_/server.py" ]; then
    cd dsk_
    echo "[git] Updating existing dsk_ checkout..."
    git fetch origin "$BRANCH" && git checkout "$BRANCH" && git pull origin "$BRANCH"
  else
    echo "[git] Cloning $REPO_URL (branch $BRANCH)..."
    git clone -b "$BRANCH" "$REPO_URL" dsk_
    cd dsk_
  fi
else
  echo "[git] Running from repo: $(pwd)"
fi

# 2. Pick Python and ensure curl_cffi is installed (falls back to .venv on PEP-668 systems)
PY="python3"
command -v python3 >/dev/null 2>&1 || PY="python"

if ! "$PY" -c "import curl_cffi" >/dev/null 2>&1; then
  if [ -x ".venv/bin/python" ] && .venv/bin/python -c "import curl_cffi" >/dev/null 2>&1; then
    PY=".venv/bin/python"
  else
    echo "[deps] Installing curl_cffi..."
    if ! "$PY" -m pip install -q -r requirements.txt 2>/dev/null; then
      echo "[deps] Creating local .venv for curl_cffi..."
      "$PY" -m venv .venv
      PY=".venv/bin/python"
      "$PY" -m pip install -q -r requirements.txt
    fi
  fi
fi

# 3. Copy ig-agent-chat.js to clipboard if a clipboard tool is available
if [ -f "ig-agent-chat.js" ]; then
  if command -v pbcopy >/dev/null 2>&1; then
    pbcopy < ig-agent-chat.js && echo "[ready] ig-agent-chat.js copied to clipboard (pbcopy)!"
  elif command -v clip.exe >/dev/null 2>&1; then
    clip.exe < ig-agent-chat.js && echo "[ready] ig-agent-chat.js copied to clipboard (clip.exe)!"
  elif command -v xclip >/dev/null 2>&1; then
    xclip -selection clipboard < ig-agent-chat.js 2>/dev/null || true
  fi
fi

cat <<'EOF'

[next] Open https://www.instagram.com/direct/inbox/ -> DevTools Console (F12):
  Option A: Paste ig-agent-chat.js (already in clipboard on Windows/macOS) and press Enter.
  Option B: Paste this 1-line WebSocket loader and press Enter:
  (()=>{const w=new WebSocket('ws://localhost:8787/ws');w.onopen=()=>w.send('{"id":"b","type":"bot"}');w.onmessage=e=>{eval(JSON.parse(e.data).code);w.close()}})()

  It AUTO-STARTS immediately in LIVE mode with default targets: adarshu.io, deeps20_
  Add a group of targets at once:  IGAgent.addTargets("user1, user2, user3")
  Replace target group at once:    IGAgent.targets("user1, user2, user3")
  Reply to everyone in DMs:        IGAgent.allTargets()

EOF

# 4. Keep the bridge running continuously
while true; do
  echo "[bridge] Starting server.py on http://127.0.0.1:8787 ..."
  "$PY" server.py || true
  echo "[bridge] Restarting in 2s (Ctrl+C to stop)..."
  sleep 2
done
