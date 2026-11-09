'use strict';
/* chrome.js — tab strip, omnibox, toolbar wiring. Talks to main via window.hz. */
const $ = s => document.querySelector(s);
const tabstrip = $('#tabstrip'), omni = $('#omnibox');
let tabs = [], activeId = null, menuEl = null;

function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function render() {
  tabstrip.innerHTML = tabs.map(t => `
    <div class="tab ${t.id === activeId ? 'active' : ''}" data-id="${t.id}" title="${esc(t.url)}">
      ${t.loading ? '<span class="dot"></span>' : (t.fav ? `<img src="${esc(t.fav)}" width="14" height="14" style="flex:none;border-radius:3px">` : '')}
      ${t.incognito ? '<span class="inc">INCOG</span>' : ''}
      <span class="t">${esc(t.title || t.url || 'New Tab')}</span>
      <span class="x" data-x="${t.id}">&#10005;</span>
    </div>`).join('');
  const active = tabs.find(t => t.id === activeId);
  if (active && document.activeElement !== omni) omni.value = active.url === 'about:blank' ? '' : active.url;
}

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

$('#bNew').onclick = () => hz.tabs.open('about:blank');
$('#bInc').onclick = () => hz.tabs.open('about:blank', { incognito: true, partition: 'incognito:' + Date.now() });
$('#bBack').onclick = () => hz.tabs.back();
$('#bFwd').onclick = () => hz.tabs.fwd();
$('#bReload').onclick = () => hz.tabs.reload();
$('#bPanel').onclick = () => hz.panel.toggle();
$('#bDevtools').onclick = () => hz.tabs.devtools();
$('#bCap').onclick = async () => {
  const on = await hz.capture.toggle();
  $('#bCap').classList.toggle('active', on);
};

omni.addEventListener('keydown', e => {
  if (e.key === 'Enter') { hz.tabs.navigate(omni.value); omni.blur(); }
  if (e.key === 'Escape') omni.blur();
});
omni.addEventListener('focus', () => omni.select());

// main-menu popup
const MENU = [
  ['New tab', 'Ctrl+T', () => hz.tabs.open('about:blank')],
  ['New anonymous tab', 'Ctrl+Shift+N', () => hz.tabs.open('about:blank', { incognito: true, partition: 'incognito:' + Date.now() })],
  ['—'],
  ['Dev panel', 'F12', () => hz.panel.toggle()],
  ['Page DevTools', 'Ctrl+Shift+I', () => hz.tabs.devtools()],
  ['Toggle capture', '', async () => $('#bCap').classList.toggle('active', await hz.capture.toggle())],
  ['View source', 'Ctrl+U', () => hz.page.viewSource()],
  ['—'],
  ['Zoom in', 'Ctrl+=', () => hz.page.zoom(0.1)],
  ['Zoom out', 'Ctrl+-', () => hz.page.zoom(-0.1)],
  ['Print', 'Ctrl+P', () => hz.page.print()],
  ['—'],
  ['Clear browsing data (this session)', '', () => hz.ck.clear()]
];
$('#bMenu').onclick = e => {
  if (menuEl) { menuEl.remove(); menuEl = null; return; }
  menuEl = document.createElement('div');
  menuEl.className = 'menu-pop';
  menuEl.style.right = '8px'; menuEl.style.top = '46px';
  menuEl.innerHTML = MENU.map((m, i) => m[0] === '—'
    ? '<div style="border-top:1px solid var(--border);margin:4px 0"></div>'
    : `<div class="mi" data-i="${i}"><span>${esc(m[0])}</span><span class="kbd">${esc(m[1] || '')}</span></div>`).join('');
  menuEl.onclick = ev => {
    const mi = ev.target.closest('.mi');
    if (mi) { MENU[+mi.dataset.i][2](); menuEl.remove(); menuEl = null; }
  };
  document.body.appendChild(menuEl);
  const el = menuEl;
  setTimeout(() => document.addEventListener('click', function h(ev) {
    if (!el.contains(ev.target)) { el.remove(); if (menuEl === el) menuEl = null; document.removeEventListener('click', h); }
  }), 0);
};

// keyboard
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 't') hz.tabs.open('about:blank');
  else if (e.ctrlKey && e.key === 'l') omni.focus();
  else if (e.ctrlKey && e.key === 'w') activeId && hz.tabs.close(activeId);
  else if (e.key === 'F12') hz.panel.toggle();
  else if (e.ctrlKey && e.shiftKey && e.key === 'N') hz.tabs.open('about:blank', { incognito: true, partition: 'incognito:' + Date.now() });
  else if (e.ctrlKey && e.key === 'Tab') {
    const i = tabs.findIndex(t => t.id === activeId);
    if (i >= 0 && tabs.length > 1) hz.tabs.activate(tabs[(i + 1) % tabs.length].id);
  }
});

// live updates from main
hz.tabs.onUpdated((id, t) => { const i = tabs.findIndex(x => x.id === id); if (i >= 0) tabs[i] = t; render(); });
hz.tabs.onAdded(t => { refresh(); });
hz.tabs.onClosed(id => { refresh(); });
hz.tabs.onActivated((id, t) => { activeId = id; const i = tabs.findIndex(x => x.id === id); if (i >= 0) tabs[i] = t; render(); });
hz.us.onInstalled(name => { /* toast in panel context; keep silent here */ });

$('#wMin').onclick = () => hz.app.winctrl('min');
$('#wMax').onclick = () => hz.app.winctrl('max');
$('#wClose').onclick = () => hz.app.winctrl('close');

refresh();
