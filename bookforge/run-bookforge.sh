#!/usr/bin/env sh
# Bookforge launcher for macOS/Linux.
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  echo "Bookforge needs Python 3.10 or newer." >&2
  exit 1
fi
if ! "$PY" -c 'import jsonschema' 2>/dev/null; then
  echo "Installing required package jsonschema..."
  "$PY" -m pip install --user -r requirements.txt
fi
exec "$PY" -m bookforge "$@"
