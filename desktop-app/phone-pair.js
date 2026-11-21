// phone-pair.js — the 📱 Phone window on the PC (phone-pair.html): on / off, the QR code to pair a phone, the link,
// the phones that used it, and "Un-pair all phones". Data from phone-main.js through window.api.phoneApp*.
(function (root) {
  'use strict';
  function ago(ms, now) { const m = Math.round((now - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; }

  function setQr(doc, box, svg, alt) {
    if (!box) return;
    box.textContent = '';
    if (!svg) return;
    const img = doc.createElement('img');
    img.alt = alt;
    img.src = `data:image/svg+xml;base64,${typeof btoa === 'function' ? btoa(svg) : Buffer.from(svg).toString('base64')}`;
    box.appendChild(img);
  }

  function render(doc, st, now) {
    const $ = (id) => doc.getElementById(id);
    const s = st || {};
    $('ph-on').checked = !!s.enabled;
    const on = !!(s.enabled && s.running);
    $('ph-state').textContent = !s.enabled ? 'Off — no phone can connect.' : !s.running ? 'Starting…' : s.noWifi ? 'On, but this PC has no Wi-Fi / network address — connect it to your home network.' : `On — phones on this Wi-Fi can connect (port ${s.port}).`;
    $('ph-pair').hidden = !on || !!s.noWifi;
    const link = s.links && s.links[0];
    $('ph-link').value = link ? link.url : '';
    setQr(doc, $('qr'), s.qr, 'QR code to pair your phone');
    if (!s.qr) $('qr').textContent = on ? 'No code — see the link instead' : 'The code appears here';
    const others = (s.links || []).slice(1);
    $('ph-other').textContent = others.length ? `If the phone can't reach it, try: ${others.map((l) => `${l.address} (${l.name})`).join(', ')}` : '';
    // 🌍 from anywhere (Tailscale)
    const any = s.anywhere || {};
    const ts = any.tailscale || {};
    $('ph-anywhere').hidden = !on;
    const ready = !!any.url;
    $('ph-ts-setup').hidden = ready;
    $('ph-ts-ready').hidden = !ready;
    $('ph-ts-state').textContent = ready ? '' : !ts.installed ? 'Tailscale is not installed on this PC yet.' : ts.needsLogin ? 'Tailscale is installed but not signed in — open it and sign in.' : !ts.running ? 'Tailscale is installed but switched off — open it and connect.' : 'Waiting for Tailscale…';
    $('ph-any-link').value = any.url || '';
    setQr(doc, $('qr-any'), any.qr, 'QR code to pair your phone from anywhere');
    $('ph-ts-name').textContent = ts.dnsName || 'your-pc.your-tailnet.ts.net';
    const sec = any.secure || {};
    $('ph-secure').textContent = sec.on ? '🔓 Turn off the secure link' : '🔒 Turn on the secure link';
    $('ph-secure').dataset.on = sec.on ? '1' : '0';
    $('ph-secure').disabled = !ts.installed || !ts.running || !ts.dnsName;
    $('ph-secure-box').hidden = !sec.on;
    $('ph-secure-url').value = sec.url || '';
    setQr(doc, $('qr-secure'), sec.qr, 'QR code for the secure link');
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
    const copy = async (id) => { const v = $(id).value; if (!v) return; try { await root.navigator.clipboard.writeText(v); say('Copied.', 'ok'); } catch (_) { $(id).select(); } };
    $('ph-any-copy').addEventListener('click', () => copy('ph-any-link'));
    $('ph-secure-copy').addEventListener('click', () => copy('ph-secure-url'));
    $('ph-secure').addEventListener('click', async () => {
      const on = $('ph-secure').dataset.on !== '1';
      $('ph-secure').disabled = true;
      say(on ? 'Asking Tailscale for the secure link… (up to half a minute)' : 'Turning the secure link off…');
      const r = await api.phoneAppSecure(on);
      render(doc, r, Date.now());
      say(r && r.words, r && r.ok ? 'ok' : 'warn');
      $('ph-secure-link-row').hidden = !(r && r.link);
      $('ph-secure-why').textContent = r && r.link ? 'Open this in your browser, allow it, then press the button again:' : '';
      $('ph-secure-link').value = (r && r.link) || '';
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
