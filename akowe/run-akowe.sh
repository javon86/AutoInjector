#!/usr/bin/env sh
# Akowe launcher for macOS/Linux: Python 3.10+, a private venv, the one dependency, then start
# (the program picks a free port and opens the browser).
# OPTIONAL: AutoInjector (desktop-app/run-linux.sh / run-mac.command) starts Akowe by itself and shows it in its
# "Akowe" tab. Use this only to run Akowe on its own (if AutoInjector already runs it, this opens it).
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  echo "Akowe needs Python 3.10 or newer: https://www.python.org/downloads/" >&2
  exit 1
fi
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
# Akowe was called BookForge before 2026-10-25: its folder (venv + data) moves over once, before the venv is made
# here (the program copies the data itself when the move is not possible).
if [ ! -e "$DATA/akowe" ] && [ -d "$DATA/bookforge" ]; then
  mv "$DATA/bookforge" "$DATA/akowe" 2>/dev/null && echo "Akowe was called BookForge before: moved $DATA/bookforge to $DATA/akowe"
fi
VENV="$DATA/akowe/venv"
if [ ! -d "$DATA/akowe" ] && [ -d "$DATA/bookforge" ]; then VENV="$DATA/bookforge/venv"; fi
if [ ! -x "$VENV/bin/python" ]; then
  echo "First start: preparing Akowe's own Python environment..."
  "$PY" -m venv "$VENV" 2>/dev/null || true
fi
if [ -x "$VENV/bin/python" ]; then PY="$VENV/bin/python"; fi
if ! "$PY" -c 'import jsonschema' 2>/dev/null; then
  echo "Installing required package jsonschema..."
  "$PY" -m pip install --quiet --disable-pip-version-check -r requirements.txt || \
    "$PY" -m pip install --quiet --user -r requirements.txt
fi
exec "$PY" -m akowe "$@"
