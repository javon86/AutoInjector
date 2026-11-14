// lab.js — starts the 🧪 Money lab window (lab.html) once the page has loaded (money-lab-ui.js does the work).
(function () {
  'use strict';
  try { if (window.MoneyLabUi && window.api) window.MoneyLabUi.start(document, window.api); } catch (e) { const m = document.getElementById('lab-msg'); if (m) m.textContent = `The lab window couldn't start: ${e && e.message}`; }
})();
