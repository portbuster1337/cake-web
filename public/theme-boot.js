/* Paints the saved theme's background before the app loads (no flash). */
(function () {
  var bg = { 0: '#EDEDFA', 1: '#1B284A' };
  var t = null;
  try { t = localStorage.getItem('cw-theme'); } catch (e) { /* storage disabled */ }
  var light = t === null ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) : t === '0';
  var c = t === null ? (light ? bg[0] : bg[1]) : (bg[t] || (Number(t) >= 112 ? '#000000' : '#131314'));
  document.documentElement.style.setProperty('--surface', c);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
})();
