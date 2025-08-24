/* content.js v1.6.5 — DOM injector & capture */
const CS_VERSION = "1.6.6";
const TRACE = [];

function trace(e){ try{ TRACE.push({ t: Date.now(), e }); if (TRACE.length>50) TRACE.shift(); }catch{} }

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "PING_CONTENT"){ sendResponse({ ok:true, pong:true, version: CS_VERSION }); return; }
  if (msg.type === "INJECT_AND_WAIT"){ handleInjectAndWait(msg.request).then(sendResponse); return true; }
  if (msg.type === "GET_TRACE"){ sendResponse({ ok:true, trace: TRACE.slice(-20) }); return; }
});

function selectInput(){
  const sels = [
    '#prompt-textarea',
    'textarea[data-id="prompt-textarea"]','div[role="textbox"]','div[data-testid="textbox"]',
    'main textarea','main div[role="textbox"]','textarea[placeholder*="Message"]','textarea[placeholder*="Send a message"]',
    'textarea','div[contenteditable="true"]'
  ];
  for (const s of sels){ const el = document.querySelector(s); if (el) { trace({ sel:s, hit:true }); return el; } trace({ sel:s, hit:false }); }
  return null;
}
function setTextToInput(el, text){
  const nativeSetter = el && el.tagName === 'TEXTAREA' ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set : null;

  try{
    if (el.tagName === "TEXTAREA"){ el.focus(); if (nativeSetter) nativeSetter.call(el, text); else el.value = text; el.dispatchEvent(new Event("input",{bubbles:true})); el.selectionStart = el.selectionEnd = el.value.length; trace({ action:"set-textarea" }); return true; }
    if (el.getAttribute("contenteditable")==="true"){ el.focus(); el.textContent = text; el.dispatchEvent(new Event("input",{bubbles:true})); trace({ action:"set-contenteditable" }); return true; }
    el.focus(); el.value = text; el.dispatchEvent(new Event("input",{bubbles:true})); trace({ action:"set-generic" }); return true;
  }catch(e){ trace({ action:"set-failed", e:String(e) }); return false; }
}
function clickSend(){
  const btns = ['button[data-testid="send-button"]','button[aria-label*="Send"]','button:has(svg[aria-label*="Send"])','form button[type="submit"]'];
  for (const s of btns){ const b=document.querySelector(s); if (b){ b.click(); trace({ action:"click-send", selector:s }); return true; } }
  const a = document.activeElement || selectInput(); if (a){ a.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true})); trace({ action:"enter-fallback" }); return true; }
  trace({ action:"send-missing" }); return false;
}
function lastAssistant(){ const nodes = Array.from(document.querySelectorAll('div[data-message-author-role="assistant"],[data-testid="assistant-message"]')); return nodes.at(-1)||null; }
async function waitForAssistantText(timeoutMs=180000){
  const start=Date.now(); let lastText=lastAssistant()?.innerText||"";
  return await new Promise((resolve)=>{
    let stableTimer=null;
    const obs=new MutationObserver(()=>{ const n=lastAssistant(); if(!n) return; const t=n.innerText; if(t!==lastText){ lastText=t; if(stableTimer) clearTimeout(stableTimer); stableTimer=setTimeout(()=>{ obs.disconnect(); resolve({ok:true,text:(n.innerText||"").trim()}); },1000); } });
    obs.observe(document.body,{subtree:true,childList:true,characterData:true});
    const tick=setInterval(()=>{ if(Date.now()-start>timeoutMs){ obs.disconnect(); clearInterval(tick); resolve({ok:false,error:"TIMEOUT_REPLY"}); } },500);
  });
}
async function handleInjectAndWait(req){
  try{
    const userText = (req?.messages||[]).filter(m=>m.role==="user").map(m=>m.content).join("\n").trim() || "(empty)";
    const el = selectInput(); if(!el) return {ok:false,error:"INPUT_NOT_FOUND"};
    if(!setTextToInput(el, userText)) { if (el.getAttribute && el.getAttribute('contenteditable')==='true'){ const ok = await typeChars(el, userText); if(!ok) return {ok:false,error:"INJECT_FAILED"}; } else { return {ok:false,error:"INJECT_FAILED"}; } }
    if(!clickSend()) return {ok:false,error:"SEND_FAILED"};
    return await waitForAssistantText((req?.replyTimeout||180)*1000);
  }catch(e){ return { ok:false, error:String(e) }; }
}


async function typeChars(el, text){
  // Slow fallback: paste characters to contenteditable editors
  try{
    el.focus();
    for (const ch of text){
      const e = new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true });
      el.dispatchEvent(e);
      await new Promise(r=>setTimeout(r, 2));
    }
    return true;
  }catch{ return false; }
}
