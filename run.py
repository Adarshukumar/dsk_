#!/usr/bin/env python3
"""
One-file cross-platform launcher for IG-Agent v10 (Gemma-4 brain: DMs, social life, human pacing).

Usage:
    python run.py

1. If run outside the repo, clones Adarshukumar/dsk_ (branch arena/d05a574d-dsk).
2. Ensures curl_cffi is installed.
3. Copies ig-agent-chat.js to clipboard (if supported) and prints the 1-line
   Instagram DevTools Console loader.
4. Starts server.py and keeps it running continuously.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time

REPO_URL = "https://github.com/Adarshukumar/dsk_.git"
BRANCH = "arena/d05a574d-dsk"
ONE_LINER = (
    "(()=>{const w=new WebSocket('ws://localhost:8787/ws');"
    "w.onopen=()=>w.send('{\"id\":\"b\",\"type\":\"bot\"}');"
    "w.onmessage=e=>{eval(JSON.parse(e.data).code);w.close()}})()"
)


def ensure_repo() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(here, "server.py")):
        return here
    target = os.path.join(os.getcwd(), "dsk_")
    if not os.path.exists(os.path.join(target, "server.py")):
        print(f"[git] Cloning {REPO_URL} (branch {BRANCH})...")
        subprocess.check_call(["git", "clone", "-b", BRANCH, REPO_URL, target])
    return target


def ensure_deps(repo_dir: str) -> str:
    try:
        import curl_cffi  # noqa: F401
        return sys.executable
    except ImportError:
        pass
    req = os.path.join(repo_dir, "requirements.txt")
    print("[deps] Installing curl_cffi...")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", req])
    if r.returncode == 0:
        return sys.executable
    venv_dir = os.path.join(repo_dir, ".venv")
    venv_py = os.path.join(
        venv_dir, "Scripts" if os.name == "nt" else "bin",
        "python.exe" if os.name == "nt" else "python",
    )
    if not os.path.exists(venv_py):
        subprocess.check_call([sys.executable, "-m", "venv", venv_dir])
    subprocess.check_call([venv_py, "-m", "pip", "install", "-q", "-r", req])
    return venv_py


def try_copy_clipboard(js_path: str) -> bool:
    if not os.path.exists(js_path):
        return False
    with open(js_path, "rb") as f:
        data = f.read()
    for cmd in (["clip"], ["pbcopy"], ["xclip", "-selection", "clipboard"]):
        try:
            p = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            p.communicate(data, timeout=3)
            if p.returncode == 0:
                return True
        except Exception:
            continue
    return False


def main() -> None:
    repo_dir = ensure_repo()
    os.chdir(repo_dir)
    py = ensure_deps(repo_dir)
    copied = try_copy_clipboard(os.path.join(repo_dir, "ig-agent-chat.js"))

    print("=" * 70)
    print("  IG-Agent v10 RESILIENT BRAIN — Ready & Active")
    print("  Default targets (auto-started live): adarshu.io, deeps20_")
    print("=" * 70)
    if copied:
        print("  [clipboard] ig-agent-chat.js is copied to your clipboard!")
        print("              Just press Ctrl+V + Enter in Instagram DevTools Console.")
    print("\n  Or paste this 1-line loader into Instagram DevTools Console:")
    print(f"  {ONE_LINER}\n")
    print("  Batch target commands in Console:")
    print('    IGAgent.addTargets("user1, user2, user3")  <- add a group at once')
    print('    IGAgent.targets("user1, user2, user3")     <- set target group at once')
    print("    IGAgent.allTargets()                       <- reply to everyone in DMs")
    print("\n  v10 social brain (off until you ask for it):")
    print("    IGAgent.Social.enable()                    <- turn it on (dry-run first)")
    print("    IGAgent.Social.watch('deeps20_', 'adarshu.io')")
    print("    IGAgent.Social.plan()                      <- what would the brain do?")
    print("    IGAgent.Social.dryRun(false)               <- only when you trust it")
    print("    IGAgent.note('chai, code aur thodi si shanti')  <- put a NOTE up")
    print("=" * 70)

    while True:
        try:
            subprocess.call([py, os.path.join(repo_dir, "server.py")] + sys.argv[1:])
        except KeyboardInterrupt:
            print("\n[bridge] Stopped by user.")
            break
        print("[bridge] Restarting server.py in 2s (Ctrl+C to quit)...")
        try:
            time.sleep(2)
        except KeyboardInterrupt:
            break


if __name__ == "__main__":
    main()
