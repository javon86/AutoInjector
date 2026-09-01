"""council-ask tool: ask AutoInjector's Council of web AIs (ChatGPT, Claude,
Gemini) and read their replies back.

This is the PersonalJarvis → AutoInjector seam. AutoInjector drives the three
web AIs by copy/paste in real browser panes (no API keys for them) and exposes a
local HTTP + SSE service bridge; this tool sends a prompt to one or all of them
and polls the bridge for the fresh replies. A separate `council-debate` shape is
available by passing `mode`.

Config (from ExecutionContext.config or environment):
  AUTOINJECTOR_BRIDGE_URL    default http://127.0.0.1:8765
  AUTOINJECTOR_BRIDGE_TOKEN  optional bearer token the bridge requires

Risk tier: monitor — it sends a prompt to external assistants and reads the
answer; it makes no change to the user's machine.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx

from jarvis.core.protocols import ExecutionContext, ToolResult

_PARTICIPANTS = ("chatgpt", "claude", "gemini")


def _base_and_token(ctx: ExecutionContext) -> tuple[str, str | None]:
    cfg = getattr(ctx, "config", None) or {}
    base = (cfg.get("autoinjector_bridge_url") if isinstance(cfg, dict) else None) \
        or os.environ.get("AUTOINJECTOR_BRIDGE_URL") or "http://127.0.0.1:8765"
    token = (cfg.get("autoinjector_bridge_token") if isinstance(cfg, dict) else None) \
        or os.environ.get("AUTOINJECTOR_BRIDGE_TOKEN") or None
    return base.rstrip("/"), token


class CouncilAskTool:
    name = "council-ask"
    description = (
        "Ask AutoInjector's Council of web AIs (ChatGPT, Claude, Gemini) a "
        "question and get their replies. Use target='all' for every AI, or a "
        "single name to ask just one. Optionally run a structured debate/"
        "brainstorm/rotation via mode+topic. Returns each AI's reply text."
    )
    risk_tier = "monitor"
    schema = {
        "type": "object",
        "properties": {
            "text": {"type": "string", "description": "The prompt/question to send."},
            "target": {"type": "string", "enum": ["all", *_PARTICIPANTS], "default": "all"},
            "mode": {
                "type": "string",
                "description": "Optional Council/roundtable format instead of a plain ask.",
                "enum": ["debate", "brainstorm", "rotation", "free-for-all",
                         "who-wants-to-speak", "devil-angel", "chargeback", "blind-round"],
            },
            "rounds": {"type": "integer", "description": "Rounds for a mode run (chargeback requires it)."},
            "wait_ms": {"type": "integer", "default": 60000, "description": "How long to wait for replies."},
        },
        "required": ["text"],
    }

    async def execute(self, args: dict[str, Any], ctx: ExecutionContext) -> ToolResult:
        text = str(args.get("text") or "").strip()
        if not text:
            return ToolResult(success=False, output=None, error="text is required")
        target = str(args.get("target") or "all").lower()
        mode = args.get("mode")
        wait_ms = int(args.get("wait_ms") or 60000)
        base, token = _base_and_token(ctx)
        headers = {"Authorization": f"Bearer {token}"} if token else {}

        try:
            async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
                # Baseline: the newest response id, so we only collect what comes AFTER we send.
                since = 0
                try:
                    r = await client.get(f"{base}/responses", params={"limit": 1})
                    rows = (r.json() or {}).get("responses") or []
                    since = rows[-1]["id"] if rows else 0
                except Exception:
                    since = 0

                # Who do we expect to answer?
                if mode:
                    st = (await client.get(f"{base}/status")).json()
                    expected = [p["id"] for p in st.get("participants", []) if p.get("enabled")]
                    body = {"mode": mode, "topic": text}
                    if args.get("rounds") is not None:
                        body["rounds"] = int(args["rounds"])
                    start = await client.post(f"{base}/council/start", json=body)
                    if start.status_code >= 400:
                        return ToolResult(success=False, output=None,
                                          error=f"council/start failed: {start.text}")
                elif target == "all":
                    st = (await client.get(f"{base}/status")).json()
                    expected = [p["id"] for p in st.get("participants", []) if p.get("enabled")]
                    await client.post(f"{base}/send", json={"text": text})
                else:
                    if target not in _PARTICIPANTS:
                        return ToolResult(success=False, output=None, error=f"unknown target '{target}'")
                    expected = [target]
                    await client.post(f"{base}/participants/{target}/send", json={"text": text})

                # Poll for the fresh replies from the expected participants.
                deadline = time.monotonic() + wait_ms / 1000.0
                replies: dict[str, dict[str, Any]] = {}
                while time.monotonic() < deadline and len(replies) < len(expected):
                    await asyncio.sleep(1.0)
                    resp = await client.get(f"{base}/responses", params={"since": since})
                    for row in (resp.json() or {}).get("responses", []):
                        if row.get("site") in expected and row["id"] > since and row["site"] not in replies:
                            replies[row["site"]] = {"site": row["site"], "text": row.get("text", ""),
                                                    "rate_limited": bool(row.get("isRateLimited"))}
        except httpx.HTTPError as exc:
            return ToolResult(success=False, output=None,
                              error=f"AutoInjector bridge unreachable at {base}: {exc}")

        out = {
            "replies": [replies[s] for s in expected if s in replies],
            "missing": [s for s in expected if s not in replies],
        }
        ok = bool(out["replies"])
        return ToolResult(success=ok, output=out,
                          error=None if ok else "no replies within wait_ms (are the panes signed in?)")
