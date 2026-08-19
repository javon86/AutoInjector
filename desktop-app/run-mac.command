#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install it from https://nodejs.org/ (pick the LTS version, default options are fine),"
  echo "then double-click this file again."
  read -p "Press Enter to close..."
  exit 1
fi

# Make sure every declared dependency is actually present (a partial or
# interrupted install leaves node_modules in place but incomplete). The
# preflight installs only what's missing and reports clearly if it can't.
node scripts/ensure-deps.js || { echo "Could not finish installing dependencies - see the message above."; read -p "Press Enter to close..."; exit 1; }

echo "Starting AutoInjector Desktop..."
npm start
