'use strict';
/* chrome.js — tab strip, omnibox, toolbar wiring. Talks to main via window.hz. */
const $ = s => document.querySelector(s);
const tabstrip = $('#tabstrip'), omni = $('#omni');
let tabs = [], activeId = null;

function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

const X_SVG = '<svg viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.2"/></svg>';
const LOCK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
const WARN_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4M12 17.2h.01"/></svg>';
const INFO_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.8h.01"/></svg>';
const PAGE_SVG = '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M15 2v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const isNtp = u => !u || u === 'about:blank' || /^haizhu:\/\//.test(u);

function faviconHtml(t) {
  if (t.loading) return '<span class="spin"></span>';
  if (t.fav) return `<img src="${esc(t.fav)}" onerror="this.outerHTML=window.__pageSvg()">`;
  return PAGE_SVG;
}

function render() {
  tabstrip.innerHTML = tabs.map(t => `
    <div class="tab ${t.id === activeId ? 'active' : ''}" data-id="${t.id}" title="${esc(t.url)}">
      <span class="fav">${faviconHtml(t)}</span>
      ${t.incognito ? '<span class="inc">INCOG</span>' : ''}
      <span class="t">${esc(t.title || t.url || 'New Tab')}</span>
      ${t.capture ? '<span class="cap-ind" title="Capturing"></span>' : ''}
      <span class="x" data-x="${t.id}">${X_SVG}</span>
    </div>`).join('');

  const active = tabs.find(t => t.id === activeId);
  if (active && document.activeElement !== omni) omni.value = isNtp(active.url) ? '' : active.url;

  const sec = $('#omni-sec');
  if (active) {
    $('#bBack').disabled = !active.canBack;
    $('#bFwd').disabled = !active.canFwd;
    const u = active.url || '';
    if (/^https:/i.test(u)) { sec.innerHTML = LOCK_SVG; sec.className = ''; sec.title = 'Connection is secure'; }
    else if (/^http:/i.test(u)) { sec.innerHTML = WARN_SVG; sec.className = 'warn-c'; sec.title = 'Not secure (HTTP)'; }
    else { sec.innerHTML = INFO_SVG; sec.className = ''; sec.title = u.startsWith('file:') ? 'Local file' : 'Internal page'; }
  }
}
window.__pageSvg = () => PAGE_SVG;

async function refresh() {
  tabs = await hz.tabs.list();
  const st = await hz.tabs.state();
  if (st) activeId = st.id;
  render();
}

tabstrip.addEventListener('click', e => {
  const x = e.target.closest('[data-x]');
  if (x) { hz.tabs.close(+x.dataset.x); return; }
  const t = e.target.closest('.tab');
  if (t) hz.tabs.activate(+t.dataset.id);
});
tabstrip.addEventListener('auxclick', e => {
  const t = e.target.closest('.tab');
  if (t && e.button === 1) hz.tabs.close(+t.dataset.id);
});
$('#dragspace').addEventListener('dblclick', () => hz.tabs.open('newtab'));
$('#tabrow').addEventListener('dblclick', e => {
  if (e.target.id === 'tabrow' || e.target.id === 'tabstrip') hz.tabs.open('newtab');
});

const openIncognito = () => hz.tabs.open('newtab', { incognito: true, partition: 'incognito:' + Date.now() });
$('#bNew').onclick = () => hz.tabs.open('newtab');
$('#bInc').onclick = openIncognito;
$('#bBack').onclick = () => hz.tabs.back();
$('#bFwd').onclick = () => hz.tabs.fwd();
$('#bReload').onclick = () => hz.tabs.reload();
$('#omni-go').onclick = () => { hz.tabs.navigate(omni.value); omni.blur(); };
$('#bPanel').onclick = () => hz.panel.toggle();
$('#bDevtools').onclick = () => hz.tabs.devtools();
$('#bCap').onclick = async () => {
  const on = await hz.capture.toggle();
  $('#bCap').classList.toggle('rec', !!on);
  $('#bCap').classList.toggle('active', !!on);
};

omni.addEventListener('keydown', e => {
  if (e.key === 'Enter') { hz.tabs.navigate(omni.value); omni.blur(); }
  if (e.key === 'Escape') omni.blur();
});
omni.addEventListener('focus', () => omni.select());

// main menu — native popup (an HTML menu would be clipped by the 82px view)
$('#bMenu').onclick = () => hz.ui.menu();
if (hz.ui.onMenuCmd) hz.ui.onMenuCmd(id => {
  switch (id) {
    case 'newtab': hz.tabs.open('newtab'); break;
    case 'incognito': openIncognito(); break;
    case 'panel': hz.panel.toggle(); break;
    case 'devtools': hz.tabs.devtools(); break;
    case 'capture': $('#bCap').click(); break;
    case 'viewsource': hz.page.viewSource(); break;
    case 'zoomin': hz.page.zoom(0.1); break;
    case 'zoomout': hz.page.zoom(-0.1); break;
    case 'zoomreset': hz.page.zoom('reset'); break;
    case 'print': hz.page.print(); break;
    case 'clearcookies': hz.ck.clear(); break;
    case 'opendownloads': hz.app.opendownloads(); break;
  }
});

// keyboard
document.addEventListener('keydown', e => {
  if (e.ctrlKey && !e.shiftKey && e.key === 't') { e.preventDefault(); hz.tabs.open('newtab'); }
  else if (e.ctrlKey && !e.shiftKey && e.key === 'l') { e.preventDefault(); omni.focus(); }
  else if (e.ctrlKey && !e.shiftKey && e.key === 'w') { e.preventDefault(); activeId && hz.tabs.close(activeId); }
  else if (e.key === 'F12') { e.preventDefault(); hz.panel.toggle(); }
  else if (e.ctrlKey && e.shiftKey && e.key === 'N') { e.preventDefault(); openIncognito(); }
  else if (e.ctrlKey && e.shiftKey && e.key === 'I') { e.preventDefault(); hz.tabs.devtools(); }
  else if (e.ctrlKey && !e.shiftKey && e.key === 'u') { e.preventDefault(); hz.page.viewSource(); }
  else if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    const i = tabs.findIndex(t => t.id === activeId);
    if (i >= 0 && tabs.length > 1) hz.tabs.activate(tabs[(i + 1) % tabs.length].id);
  }
});

// live updates from main
hz.tabs.onUpdated((id, t) => { const i = tabs.findIndex(x => x.id === id); if (i >= 0) tabs[i] = t; render(); });
hz.tabs.onAdded(t => { refresh(); });
hz.tabs.onClosed(id => { refresh(); });
hz.tabs.onActivated((id, t) => { activeId = id; const i = tabs.findIndex(x => x.id === id); if (i >= 0) tabs[i] = t; render(); });
if (hz.panel.onState) hz.panel.onState(open => $('#bPanel').classList.toggle('active', !!open));

$('#wMin').onclick = () => hz.app.winctrl('min');
$('#wMax').onclick = () => hz.app.winctrl('max');
$('#wClose').onclick = () => hz.app.winctrl('close');

refresh();
