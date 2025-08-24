# AutoInjector
AutoInjector.zip contains a complete Chrome/Edge MV3 extension and a local Python-based fake API server. Together, they automate ChatGPT’s web interface and provide an OpenAI-compatible API endpoint without using paid APIs.

Contents

extension/

manifest.json: MV3 manifest with proper permissions and host settings.

background.js: Service worker handling WebSocket bridge and popup commands.

content.js: Injects user prompt, submits to ChatGPT, and captures assistant replies.

selectors.js: Centralized DOM selectors for ChatGPT input, send button, and assistant messages.

popup.html / popup.js: Control panel for Preflight → Self-Test → Dry-Run → Refresh Tabs → Activate Tab → Live Test, with LEDs and logs.

icons/: Valid PNG placeholders (16, 32, 48, 128 px).

server/

requirements.txt: aiohttp + websockets dependencies.

fake_api_server.py: Provides /v1/chat/completions endpoint and WebSocket relay to extension. Returns OpenAI-style JSON.

start_server.ps1: One-click script to create venv, install dependencies, and launch server.

README.txt: Minimal runbook detailing install steps and test sequence.

Features

Injects prompts into ChatGPT web UI automatically.

Captures assistant replies with robust DOM monitoring.

Local HTTP API (http://127.0.0.1:17890/v1/chat/completions) and WS bridge (ws://127.0.0.1:8765).

Popup HMI for full test/control workflow.

Hardening for DOM drift, service worker sleep, and reconnections.

End-to-end OpenAI-shaped response without using paid APIs.
