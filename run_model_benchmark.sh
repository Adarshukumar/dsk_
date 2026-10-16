#!/usr/bin/env bash
# Create an isolated Python sandbox, install the pinned runtime dependency, and
# run the complete live llmchat benchmark. Forward any arguments to the Python
# runner, for example: ./run_model_benchmark.sh --concurrency 1 --timeout 75
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${BENCHMARK_VENV:-$ROOT/.venv}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Creating isolated benchmark environment: $VENV"
  "$PYTHON_BIN" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$ROOT/requirements.txt"
exec "$VENV/bin/python" "$ROOT/benchmark_models.py" "$@"
