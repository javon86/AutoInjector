// attach-common.js — shared by the attach-*.html fixtures (test/e2e/file-attach.e2e.js): a Claude-like composer
// (div[data-cds="Editor"]) and a file chip shown next to it when the page takes a file. window.__attach.got lists what
// arrived ({ name, size, type, via }); window.__attach.wrong counts clicks on things that must never be clicked.
(function () {
  const A = window.__attach = { got: [], wrong: 0, clicks: [] };
  const box = document.createElement('div'); box.className = 'composer-card';
  box.innerHTML = '<div class="chips"></div><div data-cds="Editor" contenteditable="true" aria-label="Write your prompt to Claude" style="min-height:40px;border:1px solid #888;padding:6px"></div><div class="row"></div>';
  document.body.appendChild(box);
  A.card = box; A.row = box.querySelector('.row'); A.editor = box.querySelector('[data-cds="Editor"]');
  A.take = (files, via) => {
    for (const f of Array.from(files || [])) {
      A.got.push({ name: f.name, size: f.size, type: f.type, via });
      const chip = document.createElement('div'); chip.setAttribute('data-testid', 'file-thumbnail'); chip.textContent = '🖼';
      box.querySelector('.chips').appendChild(chip);
    }
  };
  A.decoy = (label) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', label); b.textContent = '•'; b.onclick = () => { A.wrong++; }; A.row.appendChild(b); return b; };
})();
