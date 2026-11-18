// phone-pair.js — the 📱 Phone window on the PC (phone-pair.html): on / off, the QR code to pair a phone, the link,
// the phones that used it, and "Un-pair all phones". Data from phone-main.js through window.api.phoneApp*.
(function (root) {
  'use strict';
  function ago(ms, now) { const m = Math.round((now - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; }

  function render(doc, st, now) {
    const $ = (id) => doc.getElementById(id);
    const s = st || {};
    $('ph-on').checked = !!s.enabled;
    const on = !!(s.enabled && s.running);
    $('ph-state').textContent = !s.enabled ? 'Off — no phone can connect.' : !s.running ? 'Starting…' : s.noWifi ? 'On, but this PC has no Wi-Fi / network address — connect it to your home network.' : `On — phones on this Wi-Fi can connect (port ${s.port}).`;
    $('ph-pair').hidden = !on || !!s.noWifi;
    const link = s.links && s.links[0];
    $('ph-link').value = link ? link.url : '';
    const qr = $('qr');
    qr.textContent = '';
    if (s.qr) {
      const img = doc.createElement('img');
      img.alt = 'QR code to pair your phone';
      img.src = `data:image/svg+xml;base64,${typeof btoa === 'function' ? btoa(s.qr) : Buffer.from(s.qr).toString('base64')}`;
      qr.appendChild(img);
    } else qr.textContent = on ? 'No code — see the link instead' : 'The code appears here';
    const others = (s.links || []).slice(1);
    $('ph-other').textContent = others.length ? `If the phone can't reach it, try: ${others.map((l) => `${l.address} (${l.name})`).join(', ')}` : '';
    const phones = s.phones || [];
    $('ph-phones-box').hidden = !phones.length;
    const ul = $('ph-phones');
    ul.textContent = '';
    for (const p of phones) { const li = doc.createElement('li'); li.textContent = `${p.phone} · ${ago(p.lastSeen, now)}`; ul.appendChild(li); }
  }

  function start(doc, api) {
    const $ = (id) => doc.getElementById(id);
    const say = (w, tone) => { $('msg').textContent = w || ''; $('msg').dataset.tone = tone || 'info'; };
    const refresh = async () => { try { render(doc, await api.phoneAppStatus(), Date.now()); } catch (e) { say(`Couldn't read the phone settings: ${e && e.message}`, 'warn'); } };
    $('ph-on').addEventListener('change', async (e) => {
      say(e.target.checked ? 'Turning it on…' : 'Turning it off…');
      const r = await api.phoneAppSetEnabled(e.target.checked);
      render(doc, r, Date.now());
      say(r && r.ok === false ? (r.words || 'That did not work.') : !e.target.checked ? 'Off.' : r && r.noWifi ? 'On — but connect this PC to your Wi-Fi so the phone can reach it.' : 'On. Scan the code with your phone.', r && (r.ok === false || r.noWifi) ? 'warn' : 'ok');
    });
    $('ph-copy').addEventListener('click', async () => { const v = $('ph-link').value; if (!v) return; try { await root.navigator.clipboard.writeText(v); say('Copied.', 'ok'); } catch (_) { $('ph-link').select(); } });
    $('ph-newkey').addEventListener('click', async () => {
      if (root.confirm && !root.confirm('Un-pair every phone? They will need to scan the new code.')) return;
      const r = await api.phoneAppNewKey();
      render(doc, r, Date.now());
      say(r && r.words, 'ok');
    });
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }

  const out = { render, start };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  if (root) {
    root.PhonePair = out;
    if (root.document && root.api && root.api.phoneAppStatus && !root.__PHONE_PAIR_NO_AUTOSTART) start(root.document, root.api);
  }
})(typeof window !== 'undefined' ? window : null);
