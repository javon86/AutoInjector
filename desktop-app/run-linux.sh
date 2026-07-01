#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  echo "Install it from https://nodejs.org/ (pick the LTS version) or your distro's package manager,"
  echo "then run this script again."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "First run: installing dependencies, this can take a minute..."
  npm install || { echo "npm install failed - see the error above."; exit 1; }
fi

echo "Starting AutoInjector Desktop..."
npm start
