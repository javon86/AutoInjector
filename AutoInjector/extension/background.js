// background.js v1.6.5 — MV3 service worker (module)
const VERSION = "1.6.6";

const DEFAULT_CFG = { wsHost:"127.0.0.1", wsPort:8765, httpHost:"127.0.0.1", httpPort:17890 };
let CFG = { ...DEFAULT_CFG };
const RELAY_WS   = () => `ws://${CFG.wsHost}:${CFG.wsPort}`;
const RELAY_HTTP = () => `http://${CFG.httpHost}:${CFG.httpPort}`;

let ws = null, wsReady = false;
let queue = Promise.resolve();
let currentPhase = "idle";

async function loadCfg(){ const { cfg } = await chrome.storage.local.get("cfg"); if (cfg) Object.assign(CFG, cfg); }
async function saveCfg(){ await chrome.storage.local.set({ cfg: CFG }); }

function postToPopup(ev){ chrome.runtime.sendMessage({ type:"POPUP_EVENT", ...ev }).catch(()=>{}); }
function setPhase(phase){ currentPhase = phase; postToPopup({ type:"PHASE", phase }); }

// --- WS Bridge with backoff ---
let reconnectTimer=null, backoff=800;
function connectWS(){
  if (ws && (ws.readyState===WebSocket.OPEN || ws.readyState===WebSocket.CONNECTING)) return;
  try { ws = new WebSocket(RELAY_WS()); } catch(e){ postToPopup({type:"WS_LOG",level:"error",msg:String(e)}); return scheduleReconnect(); }
  ws.onopen = () => { wsReady=true; backoff=800; postToPopup({type:"WS_STATUS", ok:true, url: RELAY_WS()}); ws.send(JSON.stringify({type:"HELLO",from:"extension",version:VERSION})); publishTabStatus(); };
  ws.onclose = () => { wsReady=false; postToPopup({type:"WS_STATUS", ok:false}); publishTabStatus(); scheduleReconnect(); };
  ws.onerror = () => { postToPopup({type:"WS_LOG",level:"error",msg:"WS error"}); };
  ws.onmessage = (ev) => { let m; try{ m=JSON.parse(ev.data);}catch{return;} if(m.type==="REQUEST"){ queue = queue.then(()=>handleRequest(m)).catch(err=>postToPopup({type:"JOB_ERROR",id:m.id,error:String(err)})); } };
}
function scheduleReconnect(){ if (reconnectTimer) return; reconnectTimer = setTimeout(()=>{ reconnectTimer=null; backoff=Math.min(backoff*2,10000); connectWS(); }, backoff); }

// --- Tabs & helpers ---
async function publishTabStatus(){
  try{
    const tabs = await listChatTabs();
    const hasTab = tabs.length>0;
    let contentOk = false;
    if (hasTab){
      const t = tabs[0];
      const ping = await pingContent(t.id);
      contentOk = !!(ping && ping.ok);
    }
    postToPopup({ type:"TAB_STATUS", hasTab, contentOk });
  } catch(e){
    postToPopup({ type:"TAB_STATUS", hasTab:false, contentOk:false, error:String(e) });
  }
}

async function listChatTabs(){
  const urls = ["*://chat.openai.com/*","*://chatgpt.com/*"]; const tabs=[];
  for (const url of urls){ const q = await chrome.tabs.query({ url }); tabs.push(...q); }
  return tabs.sort((a,b)=>Number(b.active)-Number(a.active));
}
async function ensureChatTab(tabId){
  // NOP to wake worker reliably
  await chrome.runtime.getPlatformInfo(()=>{});
  if (tabId){ try { return await chrome.tabs.get(tabId); } catch {} }
  const tabs = await listChatTabs(); if (tabs.length) return tabs[0];
  return await chrome.tabs.create({ url:"https://chat.openai.com/" });
}

// --- Background <-> Content ---
function pingContent(tabId){
  return new Promise((res)=>{
    chrome.tabs.sendMessage(tabId,{type:"PING_CONTENT"},(r)=>{
      if(chrome.runtime.lastError) return res({ok:false,error:chrome.runtime.lastError.message});
      res(r?.ok ? r : {ok:false,error:"NO_PONG"});
    });
  });
}

async function reinjectContent(tabId){
  // fallback: programmatic executeScript to ensure content.js present
  try{
    await chrome.scripting.executeScript({ target:{ tabId }, files:["content.js"] });
    return true;
  }catch(e){
    postToPopup({ type:"WS_LOG", level:"error", msg:`executeScript failed: ${e}` });
    return false;
  }
}

function injectAndWait(tabId, request, replyTimeout){
  return new Promise(res=>{
    let done=false; const t=setTimeout(()=>{ if(done) return; done=true; res({ok:false,error:"TIMEOUT_REPLY"}); }, Math.max(10000,(replyTimeout||180)*1000));
    chrome.tabs.sendMessage(tabId,{type:"INJECT_AND_WAIT",request,replyTimeout},(r)=>{
      if(done) return; clearTimeout(t);
      if(chrome.runtime.lastError) return res({ok:false,error:chrome.runtime.lastError.message});
      if(!r) return res({ok:false,error:"NO_RESPONSE"});
      res(r);
    });
  });
}

// --- Retry policy ---
async function runWithRetries(tabId, msg, budget=2){
  // Try once; if INPUT_NOT_FOUND → reinject + retry; if TIMEOUT_REPLY → one retry
  let lastErr=null;
  for (let i=0;i<=budget;i++){
    const r = await injectAndWait(tabId, msg, msg.replyTimeout||180);
    if (r.ok) return r;
    lastErr = r.error||"UNKNOWN";
    if (lastErr==="INPUT_NOT_FOUND"){
      await reinjectContent(tabId);
      await new Promise(r=>setTimeout(r,400));
      continue;
    }
    if (lastErr==="TIMEOUT_REPLY"){
      await new Promise(r=>setTimeout(r,800));
      continue;
    }
    break;
  }
  return { ok:false, error:lastErr||"FAILED" };
}

// --- Core job handler ---
async function handleRequest(msg){
  setPhase("preparing");
  const tab = await ensureChatTab(msg.tabId);
  await chrome.tabs.update(tab.id,{active:true});
  setPhase("handshake");
  let pong = await pingContent(tab.id);
  await publishTabStatus();
  if(!pong?.ok){
    await reinjectContent(tab.id);
    pong = await pingContent(tab.id);
  }
  setPhase("injecting");
  const result = await runWithRetries(tab.id, msg, 2);
  setPhase("done");
  if (wsReady){
    ws.send(JSON.stringify(result.ok ? {type:"RESPONSE",id:msg.id,ok:true,text:result.text} : {type:"RESPONSE",id:msg.id,ok:false,error:result.error||"UNKNOWN"}));
  }
}

// --- Preflight (popup) ---
async function preflight(){
  const out = { ws:false, http:false, tabs:0, convo:false, content:false, warnings:[] };
  out.ws = wsReady;
  try{ const r = await fetch(`${RELAY_HTTP()}/health`); const j = await r.json(); out.http = !!j?.ok; }catch{ out.http=false; }
  const tabs = await listChatTabs(); out.tabs = tabs.length;
  if (tabs.length){
    const t = tabs[0];
    out.convo = /\/c\//.test(t.url||"");
    const ping = await pingContent(t.id);
    if (!ping?.ok){
      await reinjectContent(t.id);
      const ping2 = await pingContent(t.id);
      out.content = !!ping2?.ok;
    } else out.content = true;
  }
  // Guardrails
  if (String(CFG.wsHost) !== "127.0.0.1" || CFG.wsPort !== 8765) out.warnings.push("Non-default WS host/port");
  if (String(CFG.httpHost) !== "127.0.0.1" || CFG.httpPort !== 17890) out.warnings.push("Non-default HTTP host/port");
  if (!out.convo) out.warnings.push("Open a conversation (/c/...)");
  return out;
}

// --- Popup RPC ---
chrome.runtime.onMessage.addListener((m,_s,send)=>{ (async()=>{
  if(m?.type==="GET_STATUS"){ const tabs = await listChatTabs(); return send({ok:true,ws:wsReady,phase:currentPhase,tabs,CFG,VERSION}); }
  if(m?.type==="RETRY_WS"){ try{ ws&&ws.close(); }catch{} connectWS(); return send({ok:true}); }
  if(m?.type==="LIST_TABS"){ const tabs = await listChatTabs(); await publishTabStatus(); return send({ok:true,tabs}); }
  if(m?.type==="ACTIVATE_TAB"){ const t = await ensureChatTab(m.tabId); await chrome.tabs.update(t.id,{active:true}); return send({ok:true,tabId:t.id}); }
  if(m?.type==="SET_CFG"){ Object.assign(CFG, m.CFG||{}); await saveCfg(); try{ws&&ws.close();}catch{} return send({ok:true,CFG}); }
  if(m?.type==="OPEN_HEALTH"){ await chrome.tabs.create({url:`${RELAY_HTTP()}/health`}); return send({ok:true}); }
  if(m?.type==="CHECK_RELAY"){ try{ const r=await fetch(`${RELAY_HTTP()}/health`); const j=await r.json().catch(()=>({ok:false})); return send({ok:true,health:j,status:r.status}); }catch(e){ return send({ok:false,error:String(e)}); } }
  if(m?.type==="SELFTEST"){ try{ const r=await fetch(`${RELAY_HTTP()}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"_selftest",messages:[{role:"user",content:"ping"}]})}); return send({ok:true,resp:await r.json(),status:r.status}); }catch(e){ return send({ok:false,error:String(e)}); } }
  if(m?.type==="DRYRUN"){ try{ const r=await fetch(`${RELAY_HTTP()}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"gpt-4o",dry_run:true,messages:[{role:"user",content:"Hello"}]})}); return send({ok:true,resp:await r.json(),status:r.status}); }catch(e){ return send({ok:false,error:String(e)}); } }
  if(m?.type==="LIVE"){ try{ const tabId = m.tabId || (await ensureChatTab())?.id; const r=await fetch(`${RELAY_HTTP()}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"gpt-4o",messages:[{role:"user",content:m.prompt||"Say: hello from AutoInjector"}],tabId})}); return send({ok:true,resp:await r.json(),status:r.status}); }catch(e){ return send({ok:false,error:String(e)}); } }
  if(m?.type==="PREFLIGHT"){ const pf = await preflight(); return send({ ok:true, pf }); }
})()); return true; });

(async function init(){ await loadCfg(); connectWS(); postToPopup({type:"INIT",version:VERSION}); })();
