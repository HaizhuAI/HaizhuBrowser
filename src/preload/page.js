'use strict';
// Page preload — runs in the isolated world at document-start.
//  1) Injects the --hz-bootstrap source into the MAIN world via a <script>
//     element inserted as the first child of <html> (fires before page code).
//  2) Relays GM_* bridge calls (page -> ipc -> main -> page).
const { ipcRenderer } = require('electron');

// ---- 1. early main-world injection ----
(function injectBootstrap() {
  // TOP FRAME ONLY — inserting/removing a <script> inside a cross-origin
  // iframe (e.g. the Cloudflare challenge widget) is observable via
  // MutationObserver. Subframes get the stealth surface invisibly through
  // CDP Page.addScriptToEvaluateOnNewDocument instead.
  if (window.top !== window) return;
  const arg = process.argv.find(a => a.startsWith('--hz-bootstrap-file='));
  if (!arg) return;
  let src;
  try { src = require('fs').readFileSync(arg.slice('--hz-bootstrap-file='.length), 'utf8'); }
  catch (e) { return; }
  if (!src) return;
  const insert = () => {
    const el = document.createElement('script');
    el.textContent = src + '\n//# sourceURL=haizhu-bootstrap.js';
    (document.documentElement || document).insertBefore(el, (document.documentElement || document).firstChild);
    el.remove();
  };
  if (document.documentElement) insert();
  else {
    const mo = new MutationObserver(() => {
      if (document.documentElement) { insert(); mo.disconnect(); }
    });
    mo.observe(document, { childList: true, subtree: true });
    // safety: also try on next tick
    setTimeout(() => { if (document.documentElement) insert(); }, 0);
  }
})();

// ---- 2. GM relay ----
window.addEventListener('message', ev => {
  const d = ev.data;
  if (!d || !d.__hz_gm || d.dir !== 'req') return;
  ipcRenderer.invoke('gm:op', d.sid, d.op, d.args)
    .then(value => window.postMessage({ __hz_gm: true, dir: 'res', id: d.id, value }, '*'))
    .catch(err => window.postMessage({ __hz_gm: true, dir: 'res', id: d.id, error: String(err && err.message || err) }, '*'));
});
