// background.js — MV3 service worker (module) v2.3.0
const DEFAULT_CFG = { wsHost: "127.0.0.1", wsPort: 8765, httpHost: "127.0.0.1", httpPort: 17890 };
let CFG = { ...DEFAULT_CFG };
let WS = null, reconnectTimer = null, backoffMs = 1000;

const SITE_PATTERNS = {
  chatgpt: ["*://chat.openai.com/*", "*://chatgpt.com/*"],
  claude: ["*://claude.ai/*"],
  gemini: ["*://gemini.google.com/*"]
};
const SITE_LABELS = { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini" };
const SITE_HOME = { chatgpt: "https://chatgpt.com", claude: "https://claude.ai/new", gemini: "https://gemini.google.com/app" };

const STATE = {
  wsConnected:false, lastWsError:null, lastPing:null, lastRequestId:null,
  hasTab:false, contentOk:false, targetTabId:null, wsHintHasWss:false, wsHintUrls:[],
  targetTabIds: { chatgpt:null, claude:null, gemini:null },
  roundtable: { running:false, stopRequested:false, topic:"", participants:[], starter:null, rounds:0, timeoutMs:240000, transcript:[] }
};
const PORTS = new Set();
const HTTP_URL = () => `http://${CFG.httpHost}:${CFG.httpPort}`;
const WS_URL = () => `ws://${CFG.wsHost}:${CFG.wsPort}`;
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));
const logln = (s) => { for (const p of PORTS) { try { p.postMessage({ type:"WS_LOG", line:s }); } catch {} } };
const publish = (m) => { for (const p of PORTS) { try { p.postMessage(m); } catch {} } };

// Tabs (single-site, legacy ChatGPT-only helpers)
async function listChatTabs(){ return chrome.tabs.query({ url: SITE_PATTERNS.chatgpt }); }
async function preferredChatTab(){ const t=await listChatTabs(); if(!t?.length) return null; if(STATE.targetTabId){ const hit=t.find(x=>x.id===STATE.targetTabId); if(hit) return hit; } return t.find(x=>x.active)||t[0]; }

// Tabs (multi-site)
async function listSiteTabs(site){ const patterns = SITE_PATTERNS[site]; if(!patterns) return []; return chrome.tabs.query({ url: patterns }); }
async function ensureSiteTab(site){
  const tabs = await listSiteTabs(site);
  const preferred = STATE.targetTabIds[site];
  if (preferred) { const hit = tabs.find(t=>t.id===preferred); if (hit) return hit; }
  if (tabs.length) return tabs.find(t=>t.active) || tabs[0];
  const created = await chrome.tabs.create({ url: SITE_HOME[site] });
  await sleep(2500);
  return created;
}

async function forceInjectContent(tabId){ try{ await chrome.scripting.executeScript({ target:{tabId}, files:["selectors.js","content.js"] }); logln(`Forced content injection on tab ${tabId}`);}catch(e){ logln(`Force inject failed on tab ${tabId}: ${e}`);} }
async function pingContent(tabId,{forceIfMissing=true}={}){ return new Promise((resolve)=>{ try{ chrome.tabs.sendMessage(tabId,{type:"PING_CONTENT"}, async (resp)=>{ const ok=!!(resp&&resp.ok); if(!ok&&forceIfMissing){ await forceInjectContent(tabId); chrome.tabs.sendMessage(tabId,{type:"PING_CONTENT"},(r2)=>resolve(!!(r2&&r2.ok))); } else resolve(ok); }); } catch (e) {
    logln("pingContent unexpected error: " + String(e));
    resolve(false);
  } }); }
async function wsHealth(tabId){ return new Promise((resolve)=>{ try{ chrome.tabs.sendMessage(tabId,{type:"WS_HEALTH"},(resp)=>resolve(resp||{ok:false})); }catch{ resolve({ok:false}); } }); }
async function injectAndWait(tabId,messages,timeoutMs=180000){ return new Promise((resolve)=>{ try{ chrome.tabs.sendMessage(tabId,{type:"INJECT_AND_WAIT",messages,timeoutMs},(resp)=>resolve(resp||{ok:false,error:"no response from content script"})); }catch(e){ resolve({ok:false,error:String(e)}); } }); }
async function ensureChatTab(){ const tab=await preferredChatTab(); if(tab) return tab; const created=await chrome.tabs.create({ url:"https://chat.openai.com" }); await sleep(2000); return created; }
async function publishTabStatus(){ try{ const tabs=await listChatTabs(); STATE.hasTab=tabs.length>0; let contentOk=false; let wsHint={ok:false,hasWss:false,urls:[]}; const tab=await preferredChatTab(); if(tab){ contentOk=await pingContent(tab.id); wsHint=await wsHealth(tab.id); } STATE.contentOk=contentOk; STATE.wsHintHasWss=!!wsHint?.hasWss; STATE.wsHintUrls=Array.isArray(wsHint?.urls)?wsHint.urls:[]; publish({ type:"TAB_STATUS", hasTab:STATE.hasTab, contentOk:STATE.contentOk, targetTabId:STATE.targetTabId, wsHintHasWss:STATE.wsHintHasWss, wsHintUrls:STATE.wsHintUrls }); }catch(e){ publish({ type:"TAB_STATUS", hasTab:false, contentOk:false, error:String(e) }); } }

// WS
function resetBackoff(){ backoffMs=1000; }
function scheduleReconnect(){ if(reconnectTimer) return; const delay=Math.min(backoffMs,10000); reconnectTimer=setTimeout(()=>{ reconnectTimer=null; backoffMs=Math.min(backoffMs*2,10000); connectWS(); }, delay); logln(`WS reconnect in ${delay}ms`); }
function connectWS(force=false){ if(WS && STATE.wsConnected && !force) return; try{ WS && WS.close(); }catch{}; try{ WS=new WebSocket(WS_URL()); }catch(e){ STATE.lastWsError=String(e); logln("WS ctor error: "+e); publish({type:"WS_STATUS",ok:false,error:STATE.lastWsError}); scheduleReconnect(); return; } WS.onopen=()=>{ STATE.wsConnected=true; STATE.lastWsError=null; resetBackoff(); logln("WS connected"); publish({type:"WS_STATUS",ok:true}); }; WS.onclose=(ev)=>{ STATE.wsConnected=false; logln("WS closed ("+ev.code+")"); publish({type:"WS_STATUS",ok:false,code:ev.code}); scheduleReconnect(); }; WS.onerror=()=>{ STATE.lastWsError="WebSocket error"; logln("WS onerror"); }; WS.onmessage=async (evt)=>{ try{ const msg=JSON.parse(evt.data); if(msg.type==="PING"){ STATE.lastPing=Date.now(); WS.send(JSON.stringify({type:"PONG"})); return; } if(msg.type==="REQUEST"){ const requestId=msg.id; STATE.lastRequestId=requestId; publish({ type:"WS_LOG", line:`REQUEST ${requestId} received` }); try{ const tab=await ensureChatTab(); const result=await injectAndWait(tab.id, msg.messages||[], msg.timeoutMs??180000); if(result.ok){ WS.send(JSON.stringify({type:"RESPONSE", id:requestId, ok:true, text:result.text||"" })); publish({ type:"JOB_OK", id:requestId, chars:(result.text||"").length }); } else { WS.send(JSON.stringify({type:"ERROR", id:requestId, error:result.error||"unknown"})); publish({ type:"JOB_ERROR", id:requestId, error:result.error||"unknown" }); } }catch(e){ WS.send(JSON.stringify({type:"ERROR", id:requestId, error:String(e)})); publish({ type:"JOB_ERROR", id:requestId, error:String(e) }); } } }catch(e){ logln("WS parse error: "+e); } }; }

// Roundtable orchestration — round-robins a topic across ChatGPT/Claude/Gemini tabs,
// copy/pasting each reply into the next participant's input, and keeps one local transcript.
function roundtableSnapshot(){ return { ...STATE.roundtable, transcript: STATE.roundtable.transcript.slice() }; }
async function persistRoundtable(){ await chrome.storage.local.set({ ROUNDTABLE: roundtableSnapshot() }); }

function buildRoundtableMessages(rt, currentSite){
  const participantLabels = rt.participants.map(p => SITE_LABELS[p]).join(", ");
  const sys = `You're one voice (${SITE_LABELS[currentSite]}) in a live roundtable discussion between ${participantLabels} on this topic: "${rt.topic}". Read the conversation so far and reply in your own voice, building on points already made where useful. Keep it conversational and reasonably concise.`;
  const messages = [{ role:"system", content: sys }];
  if (!rt.transcript.length) {
    messages.push({ role:"user", content: rt.topic });
  } else {
    for (const turn of rt.transcript) messages.push({ role: turn.label, content: turn.text });
  }
  return messages;
}

async function runRoundtable(){
  const rt = STATE.roundtable;
  const n = rt.participants.length;
  const startIdx = Math.max(0, rt.participants.indexOf(rt.starter));
  const order = [];
  for (let i=0; i<rt.rounds*n; i++) order.push(rt.participants[(startIdx+i)%n]);

  for (const site of order) {
    if (rt.stopRequested) break;
    publish({ type:"ROUNDTABLE_TURN_START", site });
    const tab = await ensureSiteTab(site);
    if (!tab) { rt.transcript.push({ site, label:SITE_LABELS[site], error:"NO_TAB", ts:Date.now() }); publish({ type:"ROUNDTABLE_ERROR", site, error:"NO_TAB" }); break; }
    const ok = await pingContent(tab.id);
    if (!ok) { rt.transcript.push({ site, label:SITE_LABELS[site], error:"CONTENT_SCRIPT_NOT_READY", ts:Date.now() }); publish({ type:"ROUNDTABLE_ERROR", site, error:"CONTENT_SCRIPT_NOT_READY" }); break; }
    if (rt.stopRequested) break;
    const messages = buildRoundtableMessages(rt, site);
    const res = await injectAndWait(tab.id, messages, rt.timeoutMs);
    if (rt.stopRequested) break;
    if (res.ok) {
      const turn = { site, label:SITE_LABELS[site], text: res.text || "", ts: Date.now() };
      rt.transcript.push(turn);
      await persistRoundtable();
      publish({ type:"ROUNDTABLE_TURN", turn });
    } else {
      rt.transcript.push({ site, label:SITE_LABELS[site], error: res.error||"unknown", ts:Date.now() });
      await persistRoundtable();
      publish({ type:"ROUNDTABLE_ERROR", site, error: res.error||"unknown" });
      break;
    }
  }
  rt.running = false;
  await persistRoundtable();
  publish({ type:"ROUNDTABLE_DONE", stopped: rt.stopRequested });
}

// Popup / roundtable page wiring
chrome.runtime.onConnect.addListener((port)=>{
  PORTS.add(port);
  port.postMessage({type:"INIT"});
  publishTabStatus();
  port.postMessage({type:"WS_STATUS",ok:STATE.wsConnected});
  port.postMessage({type:"ROUNDTABLE_STATE", roundtable: roundtableSnapshot()});
  port.onDisconnect.addListener(()=>{ PORTS.delete(port); });
});

chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{ (async ()=>{ try{
  if(msg==="PREFLIGHT"){ const httpOk=await (async()=>{ try{ const r=await fetch(HTTP_URL()+"/health"); return r.ok; }catch{ return false; } })(); await publishTabStatus(); sendResponse({ok:true, wsOk:STATE.wsConnected, httpOk, hasTab:STATE.hasTab, contentOk:STATE.contentOk}); return; }
  if(msg==="SELFTEST"){ sendResponse({ ok:true, echo:"[_selftest ok]" }); return; }
  if(msg==="DRYRUN"){ try{ const body={ messages:[{role:"user", content:"dry run check"}], dry_run:true }; const resp=await fetch(HTTP_URL()+"/v1/chat/completions", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) }); const json=await resp.json(); sendResponse({ ok:resp.ok, json }); }catch(e){ sendResponse({ ok:false, error:String(e) }); } return; }
  if(msg==="RETRY"){ connectWS(true); sendResponse({ ok:true }); return; }
  if(typeof msg==="object" && msg){
    if(msg.type==="LIST_TABS"){ const tabs=await listChatTabs(); sendResponse({ ok:true, tabs: tabs.map(t=>({ id:t.id, url:t.url, active:t.active, title:t.title })) }); return; }
    if(msg.type==="SET_TARGET_TAB"){ STATE.targetTabId=msg.tabId||null; await chrome.storage.local.set({ TARGET_TAB_ID: STATE.targetTabId }); await publishTabStatus(); sendResponse({ ok:true, targetTabId: STATE.targetTabId }); return; }
    if(msg.type==="ACTIVATE_TAB"){ const tab=await ensureChatTab(); await chrome.tabs.update(tab.id,{active:true}); await publishTabStatus(); sendResponse({ ok:true }); return; }
    if(msg.type==="LIVE"){ const tab=await ensureChatTab(); const messages = msg.messages && Array.isArray(msg.messages) ? msg.messages : [{ role:"user", content: msg.prompt || "Say: hello from AutoInjector" }]; const res=await injectAndWait(tab.id, messages); sendResponse(res); return; }
    if(msg.type==="GET_STATUS"){ await publishTabStatus(); sendResponse({ ok:true, state:{...STATE}, cfg:{...CFG} }); return; }
    if(msg.type==="SET_CFG"){ const next={ ...CFG, ...msg.cfg }; CFG=next; await chrome.storage.local.set({ CFG: next }); connectWS(true); sendResponse({ ok:true, cfg: next }); return; }

    // Roundtable (ChatGPT + Claude + Gemini) endpoints
    if(msg.type==="LIST_AI_TABS"){
      const result = {};
      for (const site of Object.keys(SITE_PATTERNS)) {
        const tabs = await listSiteTabs(site);
        result[site] = tabs.map(t=>({ id:t.id, url:t.url, title:t.title, active:t.active }));
      }
      sendResponse({ ok:true, tabs: result });
      return;
    }
    if(msg.type==="SET_TARGET_TABS"){
      STATE.targetTabIds = { ...STATE.targetTabIds, ...(msg.tabIds||{}) };
      await chrome.storage.local.set({ TARGET_TAB_IDS: STATE.targetTabIds });
      sendResponse({ ok:true, targetTabIds: STATE.targetTabIds });
      return;
    }
    if(msg.type==="OPEN_SITE_TAB"){
      const tab = await ensureSiteTab(msg.site);
      if (tab) await chrome.tabs.update(tab.id, { active:true });
      sendResponse({ ok: !!tab, tabId: tab?.id });
      return;
    }
    if(msg.type==="START_ROUNDTABLE"){
      if (STATE.roundtable.running) { sendResponse({ ok:false, error:"ALREADY_RUNNING" }); return; }
      const participants = Array.isArray(msg.participants) && msg.participants.length >= 2
        ? msg.participants.filter(p => SITE_PATTERNS[p])
        : ["chatgpt","claude","gemini"];
      if (participants.length < 2) { sendResponse({ ok:false, error:"NEED_AT_LEAST_TWO_PARTICIPANTS" }); return; }
      const starter = participants.includes(msg.starter) ? msg.starter : participants[0];
      STATE.roundtable = {
        running:true, stopRequested:false,
        topic: String(msg.topic||"").slice(0,4000),
        participants, starter,
        rounds: Math.max(1, Math.min(20, Number(msg.rounds)||3)),
        timeoutMs: Number(msg.timeoutMs)||240000,
        transcript: []
      };
      await persistRoundtable();
      sendResponse({ ok:true });
      runRoundtable();
      return;
    }
    if(msg.type==="STOP_ROUNDTABLE"){
      STATE.roundtable.stopRequested = true;
      sendResponse({ ok:true });
      return;
    }
    if(msg.type==="GET_ROUNDTABLE"){
      sendResponse({ ok:true, roundtable: roundtableSnapshot() });
      return;
    }
    if(msg.type==="CLEAR_ROUNDTABLE"){
      if (STATE.roundtable.running) { sendResponse({ ok:false, error:"RUNNING" }); return; }
      STATE.roundtable.transcript = [];
      await persistRoundtable();
      sendResponse({ ok:true });
      return;
    }
  }
  sendResponse({ ok:false, error:"UNKNOWN_MESSAGE" });
}catch(e){ sendResponse({ ok:false, error:String(e) }); } })(); return true; });

// Boot & keepalive
async function boot(){
  const store = await chrome.storage.local.get(["CFG","TARGET_TAB_ID","TARGET_TAB_IDS","ROUNDTABLE"]);
  CFG = store.CFG || DEFAULT_CFG;
  STATE.targetTabId = store.TARGET_TAB_ID || null;
  STATE.targetTabIds = store.TARGET_TAB_IDS || { chatgpt:null, claude:null, gemini:null };
  if (store.ROUNDTABLE) {
    STATE.roundtable = { ...store.ROUNDTABLE, running:false, stopRequested:false };
  }
  connectWS(true);
  publishTabStatus();
  logln("background.js initialized v2.3.0");
}
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.alarms.create("keepalive", { periodInMinutes: 0.9 });
chrome.alarms.onAlarm.addListener(async (alarm)=>{ if(alarm.name==="keepalive"){ chrome.runtime.getPlatformInfo(()=>{}); connectWS(); publishTabStatus(); } });
