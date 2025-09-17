\
// popup.js
const led = (id, state) => {
  const el = document.getElementById(id);
  el.style.background = state === "green" ? "#29c447" : state === "amber" ? "#f5c542" : "#444";
};
const log = (msg) => {
  const el = document.getElementById("log");
  const ts = new Date().toLocaleTimeString();
  el.textContent += `[${ts}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
};

const port = chrome.runtime.connect();
port.onMessage.addListener((m) => {
  if (m.type === "INIT") log("Popup connected");
  if (m.type === "WS_STATUS") led("led-ws", m.ok ? "green" : "amber");
  if (m.type === "TAB_STATUS") {
    led("led-tab", m.hasTab ? "green" : "amber");
    led("led-content", m.contentOk ? "green" : "amber");
  }
  if (m.type === "WS_LOG") log(m.line);
  if (m.type === "JOB_OK") log(`Job ${m.id} ok (${m.chars} chars)`);
  if (m.type === "JOB_ERROR") log(`Job ${m.id} error: ${m.error}`);
});

async function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function refreshTabs() {
  const res = await send({ type:"LIST_TABS" });
  const sel = document.getElementById("tabs");
  sel.innerHTML = "";
  if (res?.ok) {
    res.tabs.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id; opt.textContent = `${t.id} - ${t.title || t.url}`;
      sel.appendChild(opt);
    });
    log(`Tabs: ${res.tabs.length} found`);
  } else {
    log("LIST_TABS failed");
  }
}

document.getElementById("btn-preflight").onclick = async () => {
  const r = await send("PREFLIGHT");
  log("Preflight: " + JSON.stringify(r));
};
document.getElementById("btn-selftest").onclick = async () => {
  const r = await send("SELFTEST");
  log("Selftest: " + JSON.stringify(r));
};
document.getElementById("btn-dryrun").onclick = async () => {
  const r = await send("DRYRUN");
  log("Dry-Run: " + JSON.stringify(r));
};
document.getElementById("btn-retry").onclick = async () => {
  await send("RETRY");
  log("Retry WS connect");
};
document.getElementById("btn-health").onclick = async () => {
  const cfg = await send({ type:"GET_STATUS" });
  const http = cfg?.cfg ? `http://${cfg.cfg.httpHost}:${cfg.cfg.httpPort}/health` : "http://127.0.0.1:17890/health";
  try {
    const resp = await fetch(http);
    const json = await resp.json();
    log("/health: " + JSON.stringify(json));
  } catch (e) { log("/health error: " + e); }
};
document.getElementById("btn-open-health").onclick = async () => {
  const cfg = await send({ type:"GET_STATUS" });
  const http = cfg?.cfg ? `http://${cfg.cfg.httpHost}:${cfg.cfg.httpPort}/health` : "http://127.0.0.1:17890/health";
  window.open(http, "_blank");
};

document.getElementById("btn-refresh").onclick = refreshTabs;
document.getElementById("btn-activate").onclick = async () => {
  await send({ type:"ACTIVATE_TAB" });
  log("Activate tab requested");
};
document.getElementById("btn-live").onclick = async () => {
  const prompt = document.getElementById("prompt").value;
  const r = await send({ type:"LIVE", prompt });
  log("Live: " + JSON.stringify(r));
};

document.getElementById("btn-save").onclick = async () => {
  const cfg = {
    wsHost: document.getElementById("wsHost").value || "127.0.0.1",
    wsPort: Number(document.getElementById("wsPort").value || 8765),
    httpHost: document.getElementById("httpHost").value || "127.0.0.1",
    httpPort: Number(document.getElementById("httpPort").value || 17890),
  };
  const r = await send({ type:"SET_CFG", cfg });
  log("Save Config");
  const deviates = cfg.wsHost !== "127.0.0.1" || cfg.wsPort !== 8765 || cfg.httpHost !== "127.0.0.1" || cfg.httpPort !== 17890;
  document.getElementById("guard").textContent = deviates ? "Using custom endpoints." : "Using defaults.";
};

(async () => {
  const s = await send({ type:"GET_STATUS" });
  if (s?.cfg) {
    document.getElementById("wsHost").value = s.cfg.wsHost;
    document.getElementById("wsPort").value = s.cfg.wsPort;
    document.getElementById("httpHost").value = s.cfg.httpHost;
    document.getElementById("httpPort").value = s.cfg.httpPort;
    document.getElementById("guard").textContent =
      (s.cfg.wsHost==="127.0.0.1" && s.cfg.wsPort===8765 && s.cfg.httpHost==="127.0.0.1" && s.cfg.httpPort===17890)
      ? "Using defaults." : "Using custom endpoints.";
  }
  refreshTabs();
})();
