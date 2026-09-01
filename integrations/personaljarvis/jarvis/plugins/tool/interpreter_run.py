"""run-code tool: run a coding/computer task through Open Interpreter, via
AutoInjector's bridge.

This routes code execution through AutoInjector's ``/interpreter/run`` endpoint,
which drives a locally-running Open Interpreter and streams normalized execution
events (message / code / output / done). Keeping it on AutoInjector's bridge
gives the whole merged system ONE code-execution path; PersonalJarvis's own
Critic / Kontrollierer gate still wraps the result as with any tool.

Config (from ExecutionContext.config or environment):
  AUTOINJECTOR_BRIDGE_URL    default http://127.0.0.1:8765
  AUTOINJECTOR_BRIDGE_TOKEN  optional bearer token the bridge requires

Risk tier: ask — it can run code / act on the machine, so confirmation is
required unless the safety layer's whitelist says otherwise.
"""
from __future__ import annotations

import os
from typing import Any

import httpx

from jarvis.core.protocols import ExecutionContext, ToolResult


def _base_and_token(ctx: ExecutionContext) -> tuple[str, str | None]:
    cfg = getattr(ctx, "config", None) or {}
    base = (cfg.get("autoinjector_bridge_url") if isinstance(cfg, dict) else None) \
        or os.environ.get("AUTOINJECTOR_BRIDGE_URL") or "http://127.0.0.1:8765"
    token = (cfg.get("autoinjector_bridge_token") if isinstance(cfg, dict) else None) \
        or os.environ.get("AUTOINJECTOR_BRIDGE_TOKEN") or None
    return base.rstrip("/"), token


class RunCodeTool:
    name = "run-code"
    description = (
        "Run a coding or computer-control task through Open Interpreter (executes "
        "Python/shell locally). Give a natural-language task; returns the "
        "assistant's summary plus the code it ran and the output it produced."
    )
    risk_tier = "ask"
    schema = {
        "type": "object",
        "properties": {
            "task": {"type": "string", "description": "The natural-language coding/computer task to run."},
        },
        "required": ["task"],
    }

    async def execute(self, args: dict[str, Any], ctx: ExecutionContext) -> ToolResult:
        task = str(args.get("task") or "").strip()
        if not task:
            return ToolResult(success=False, output=None, error="task is required")
        base, token = _base_and_token(ctx)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            async with httpx.AsyncClient(timeout=600.0, headers=headers) as client:
                r = await client.post(f"{base}/interpreter/run", json={"task": task})
        except httpx.HTTPError as exc:
            return ToolResult(success=False, output=None,
                              error=f"AutoInjector bridge unreachable at {base}: {exc}")
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code >= 400 or not data.get("ok"):
            return ToolResult(success=False, output=data or None,
                              error=data.get("error") or f"HTTP {r.status_code}")
        out = {
            "message": data.get("message", ""),
            "code": [e for e in data.get("events", []) if e.get("type") == "code"],
            "output": [e for e in data.get("events", []) if e.get("type") == "output"],
        }
        return ToolResult(success=True, output=out)
