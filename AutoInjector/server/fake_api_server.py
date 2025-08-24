#!/usr/bin/env python3
# fake_api_server.py v1.6.5
import asyncio, json, time, uuid
from aiohttp import web
import websockets

HTTP_HOST, HTTP_PORT = "127.0.0.1", 17890
WS_HOST, WS_PORT     = "127.0.0.1", 8765

_ws_client = None
_ws_lock = asyncio.Lock()
PENDING = {}

async def ws_handler(websocket):
    global _ws_client
    async with _ws_lock:
        if _ws_client is None or _ws_client.closed:
            _ws_client = websocket
        else:
            await websocket.close()
            return
    try:
        await websocket.send(json.dumps({"type":"HELLO_ACK","server":"fake_api","version":"1.6.5"}))
        async for raw in websocket:
            try: msg = json.loads(raw)
            except Exception: continue
            t = msg.get("type")
            if t == "PING": continue
            if t == "RESPONSE":
                rid = msg.get("id"); fut = PENDING.pop(rid, None)
                if fut and not fut.done(): fut.set_result(msg)
            elif t == "ERROR":
                rid = msg.get("id"); fut = PENDING.pop(rid, None)
                if fut and not fut.done(): fut.set_exception(RuntimeError(msg.get("error","unknown error")))
    finally:
        async with _ws_lock:
            if _ws_client is websocket: _ws_client = None

def openai_shape(text: str, model="gpt-4o"):
    return {
        "id": f"chatcmpl-fake-{uuid.uuid4()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}],
        "usage": {"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}
    }

async def http_health(_req): return web.json_response({"ok": True, "connected_clients": int(_ws_client is not None and not _ws_client.closed)})
async def http_selftest(_req): return web.json_response({"ok": True})

async def http_chat_completions(request: web.Request):
    try: body = await request.json()
    except Exception: return web.json_response({"error":"Invalid JSON"}, status=400)

    model = body.get("model","gpt-4o")
    messages = body.get("messages", [])
    dry_run = bool(body.get("dry_run", False))
    tab_id  = body.get("tabId")
    timeout_sec = 180

    if model == "_selftest": return web.json_response(openai_shape("[_selftest ok]"))
    if dry_run:
        echo = " | ".join([m.get("content","") for m in messages if isinstance(m, dict)]) or "(no content)"
        return web.json_response(openai_shape(f"[dry_run echo] {echo}", model=model))

    global _ws_client
    if _ws_client is None or _ws_client.closed:
        return web.json_response({"error":"No extension connected"}, status=503)

    rid = f"req-{uuid.uuid4()}"
    payload = {"type":"REQUEST","id":rid,"model":model,"messages":messages,"tabId":tab_id,"replyTimeout":timeout_sec}
    fut = asyncio.get_running_loop().create_future(); PENDING[rid] = fut
    try: await _ws_client.send(json.dumps(payload))
    except Exception as e: PENDING.pop(rid, None); return web.json_response({"error":f"Extension error: {e}"}, status=502)

    try: result = await asyncio.wait_for(fut, timeout=timeout_sec)
    except asyncio.TimeoutError: PENDING.pop(rid, None); return web.json_response({"error":"Timeout waiting for extension"}, status=504)
    except Exception as e: PENDING.pop(rid, None); return web.json_response({"error":f"Extension error: {e}"}, status=502)

    if not result.get("ok"): return web.json_response({"error":f"Extension error: {result.get('error','UNKNOWN')}"}, status=502)
    return web.json_response(openai_shape(result.get("text",""), model=model))

async def main():
    app = web.Application()
    app.add_routes([web.get("/health", http_health), web.get("/_selftest", http_selftest), web.post("/v1/chat/completions", http_chat_completions)])
    runner = web.AppRunner(app); await runner.setup()
    site = web.TCPSite(runner, HTTP_HOST, HTTP_PORT); await site.start()
    print(f"[HTTP] http://{HTTP_HOST}:{HTTP_PORT}")
    async with websockets.serve(lambda ws, path=None: ws_handler(ws), WS_HOST, WS_PORT):
        print(f"[WS]   ws://{WS_HOST}:{WS_PORT}")
        await asyncio.Future()
if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
