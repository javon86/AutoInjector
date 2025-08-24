// popup.js v1.6.6
const $ = (s) => document.querySelector(s);
function led(el, state){ el.classList.remove("green","red","amb"); el.classList.add(state); }
function logln(o){ const el=$("#log"); const t = typeof o === "string" ? o : JSON.stringify(o, null, 2); el.textContent += (t + "\n"); el.scrollTop = el.scrollHeight; }

function guardrails(cfg){
  const warns = [];
  if ((cfg.wsHost||"127.0.0.1")!=="127.0.0.1" || Number(cfg.wsPort)!==8765) warns.push("Non-default WS host/port");
  if ((cfg.httpHost||"127.0.0.1")!=="127.0.0.1" || Number(cfg.httpPort)!==17890) warns.push("Non-default HTTP host/port");
  $("#guard").textContent = warns.join(" • ");
}

async function refresh(){
  chrome.runtime.sendMessage({ type:"GET_STATUS" }, (resp) => {
    if (!resp?.ok) return;
    led($("#led-relay"), resp.ws ? "green":"red");
    $("#phase").textContent = resp.phase || "idle";
    const sel = $("#tabs"); sel.innerHTML = "";
    (resp.tabs||[]).forEach(t => { const opt=document.createElement("option"); opt.value=t.id; opt.textContent=`${t.id}: ${t.title||t.url}`; sel.appendChild(opt); });
    const view = document.querySelector('#view'); if (view) { const t = (resp.tabs||[])[0]; view.textContent = t ? (t.title || t.url || '') : '(no ChatGPT tab)'; }
    const cfg = resp.CFG||{};
    $("#wsHost").value = cfg.wsHost || "127.0.0.1"; $("#wsPort").value = cfg.wsPort || 8765;
    $("#httpHost").value = cfg.httpHost || "127.0.0.1"; $("#httpPort").value = cfg.httpPort || 17890;
    guardrails(cfg);
  });
}

$("#btn-preflight").onclick = () => chrome.runtime.sendMessage({ type:"PREFLIGHT" }, (r)=>{ logln(r); });
$("#btn-retry").onclick = () => chrome.runtime.sendMessage({ type:"RETRY_WS" }, () => refresh());
$("#btn-health").onclick = () => chrome.runtime.sendMessage({ type:"CHECK_RELAY" }, (r)=>{ logln(r); });
$("#btn-open-health").onclick = () => chrome.runtime.sendMessage({ type:"OPEN_HEALTH" }, ()=>{});
$("#btn-selftest").onclick = () => chrome.runtime.sendMessage({ type:"SELFTEST" }, (r)=>{ logln(r); });
$("#btn-dryrun").onclick = () => chrome.runtime.sendMessage({ type:"DRYRUN" }, (r)=>{ logln(r); });
$("#btn-live").onclick = () => { const tabId = Number($("#tabs").value||0)||undefined; const prompt=$("#prompt").value; chrome.runtime.sendMessage({ type:"LIVE", tabId, prompt }, (r)=>{ logln(r); }); };
$("#btn-refresh").onclick = () => chrome.runtime.sendMessage({ type:"LIST_TABS" }, ()=>{ refresh(); });
$("#btn-activate").onclick = () => { const tabId = Number($("#tabs").value||0)||undefined; chrome.runtime.sendMessage({ type:"ACTIVATE_TAB", tabId }, (r)=>{ logln(r); }); };
$("#btn-save").onclick = () => { const CFG = { wsHost:$("#wsHost").value||"127.0.0.1", wsPort:Number($("#wsPort").value||8765), httpHost:$("#httpHost").value||"127.0.0.1", httpPort:Number($("#httpPort").value||17890) }; chrome.runtime.sendMessage({ type:"SET_CFG", CFG }, (r)=>{ logln(r); refresh(); }); };
chrome.runtime.onMessage.addListener((m)=>{ if(m?.type==="WS_STATUS"){ led($("#led-relay"), m.ok ? "green":"red"); } if(m?.type==="PHASE"){ $("#phase").textContent=m.phase||"idle"; } if(m?.type==="JOB_ERROR"){ logln(m); } if(m?.type==="WS_LOG"){ logln(m); } });
refresh();


chrome.runtime.onMessage.addListener((m)=>{
  if (m?.type === "TAB_STATUS"){
    const tabLed = document.querySelector("#led-tab");
    const contentLed = document.querySelector("#led-content");
    if (tabLed) led(tabLed, m.hasTab ? "green" : "red");
    if (contentLed) led(contentLed, m.contentOk ? "green" : (m.hasTab ? "amb" : "red"));
  }
});
