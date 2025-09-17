\
import asyncio, json, uuid, time
from aiohttp import web
import websockets

HTTP_HOST="127.0.0.1"; HTTP_PORT=17890
WS_HOST="127.0.0.1"; WS_PORT=8765
PENDING = {}; WS_CLIENT=None

async def health(request): return web.json_response({"ok":True,"ws_connected":WS_CLIENT is not None,"pending":len(PENDING)})
async def completions(request):
    body = await request.json()
    messages = body.get("messages", [])
    dry = body.get("dry_run", False)
    timeout_s = int(body.get("timeout_s", 180))
    if dry:
        text="(dry-run echo)\n" + "\n".join(f"[{m.get('role')}] {m.get('content')}" for m in messages)
        return web.json_response({"id":"chatcmpl-local-"+uuid.uuid4().hex,"object":"chat.completion","created":int(time.time()),"model":body.get("model","local-auto-injector"),"choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}]})
    if WS_CLIENT is None: return web.json_response({"error":"WS_NOT_CONNECTED"}, status=503)
    req_id = uuid.uuid4().hex
    loop = asyncio.get_event_loop()
    fut = loop.create_future()
    PENDING[req_id]=fut
    await WS_CLIENT.send(json.dumps({"type":"REQUEST","id":req_id,"messages":messages,"timeoutMs":timeout_s*1000}))
    try:
        res = await asyncio.wait_for(fut, timeout=timeout_s)
    except asyncio.TimeoutError:
        PENDING.pop(req_id, None)
        return web.json_response({"error":"TIMEOUT"}, status=504)
    if res.get("ok"):
        text = res.get("text","")
        return web.json_response({"id":"chatcmpl-local-"+uuid.uuid4().hex,"object":"chat.completion","created":int(time.time()),"model":body.get("model","local-auto-injector"),"choices":[{"index":0,"message":{"role":"assistant","content":text},"finish_reason":"stop"}]})
    else:
        return web.json_response({"error":res.get("error","unknown")}, status=500)

async def ws_handler(websocket, path):
    global WS_CLIENT
    if WS_CLIENT is not None:
        return
    WS_CLIENT = websocket
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except: continue
            if msg.get("type") in ("RESPONSE","ERROR"):
                req_id = msg.get("id")
                fut = PENDING.pop(req_id, None)
                if fut and not fut.done(): fut.set_result(msg)
    finally:
        WS_CLIENT = None
        for k,fut in list(PENDING.items()):
            if not fut.done(): fut.set_result({"ok":False,"error":"WS_DISCONNECTED"})
            PENDING.pop(k,None)

async def start_ws(): return await websockets.serve(ws_handler, WS_HOST, WS_PORT)

async def main():
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_post("/v1/chat/completions", completions)
    runner = web.AppRunner(app); await runner.setup()
    site = web.TCPSite(runner, HTTP_HOST, HTTP_PORT); await site.start()
    print(f"[http] listening on http://{HTTP_HOST}:{HTTP_PORT}"); print(f"[ws]   listening on  ws://{WS_HOST}:{WS_PORT}")
    ws_srv = await start_ws()
    try:
        while True: await asyncio.sleep(3600)
    finally:
        ws_srv.close(); await ws_srv.wait_closed(); await runner.cleanup()

if __name__=="__main__":
    asyncio.run(main())
