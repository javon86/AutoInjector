#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install it from https://nodejs.org/ (pick the LTS version, default options are fine),"
  echo "then double-click this file again."
  read -p "Press Enter to close..."
  exit 1
fi

# Install on first run, and re-install whenever package.json changed since the
# last install (e.g. after pulling an update that added a dependency).
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
  echo "Installing/updating dependencies, this can take a minute..."
  npm install || { echo "npm install failed - see the error above."; read -p "Press Enter to close..."; exit 1; }
fi

echo "Starting AutoInjector Desktop..."
npm start
