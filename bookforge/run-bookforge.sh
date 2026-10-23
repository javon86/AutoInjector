#!/usr/bin/env sh
# Bookforge launcher for macOS/Linux: Python 3.10+, a private venv, the one dependency, then start
# (the program picks a free port and opens the browser).
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  echo "Bookforge needs Python 3.10 or newer: https://www.python.org/downloads/" >&2
  exit 1
fi
VENV="${XDG_DATA_HOME:-$HOME/.local/share}/bookforge/venv"
if [ ! -x "$VENV/bin/python" ]; then
  echo "First start: preparing Bookforge's own Python environment..."
  "$PY" -m venv "$VENV" 2>/dev/null || true
fi
if [ -x "$VENV/bin/python" ]; then PY="$VENV/bin/python"; fi
if ! "$PY" -c 'import jsonschema' 2>/dev/null; then
  echo "Installing required package jsonschema..."
  "$PY" -m pip install --quiet --disable-pip-version-check -r requirements.txt || \
    "$PY" -m pip install --quiet --user -r requirements.txt
fi
exec "$PY" -m bookforge "$@"
