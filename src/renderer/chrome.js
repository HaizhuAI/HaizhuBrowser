'use strict';
/* chrome.js — tab strip, omnibox, toolbar wiring. Talks to main via window.hz. */
const $ = s => document.querySelector(s);
const tabstrip = $('#tabstrip'), omni = $('#omni');
let tabs = [], activeId = null;
let STR = {};
const tr = k => STR[k] || k;
function applyI18n() {
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = tr(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = tr(el.dataset.i18nPh); });
}
function applyTheme(th) { document.documentElement.dataset.theme = th.effective || th; }

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
      ${t.incognito ? `<span class="inc">${esc(tr('tab.incognito'))}</span>` : ''}
      ${t.profile ? `<span class="env-ind" style="background:${esc(t.profile.color || '#4f8ef7')}" title="${esc(t.profile.name)}"></span>` : ''}
      <span class="t">${esc(t.title || t.url || tr('tab.newtab'))}</span>
      ${t.capture ? `<span class="cap-ind" title="${esc(tr('tab.capturing'))}"></span>` : ''}
      <span class="x" data-x="${t.id}">${X_SVG}</span>
    </div>`).join('');

  const active = tabs.find(t => t.id === activeId);
  if (active && document.activeElement !== omni) omni.value = isNtp(active.url) ? '' : active.url;

  const sec = $('#omni-sec');
  if (active) {
    $('#bBack').disabled = !active.canBack;
    $('#bFwd').disabled = !active.canFwd;
    const u = active.url || '';
    if (/^https:/i.test(u)) { sec.innerHTML = LOCK_SVG; sec.className = ''; sec.title = tr('omni.secure'); }
    else if (/^http:/i.test(u)) { sec.innerHTML = WARN_SVG; sec.className = 'warn-c'; sec.title = tr('omni.insecure'); }
    else { sec.innerHTML = INFO_SVG; sec.className = ''; sec.title = u.startsWith('file:') ? tr('omni.local') : tr('omni.internal'); }
  }
  updateStar();
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
// window controls — real min/max/close + maximize/restore icon sync.
// Titlebar empty area double-click toggles maximize (Chrome behavior).
const MAX_SVG = '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const RESTORE_SVG = '<svg viewBox="0 0 12 12" width="12" height="12"><rect x="1.6" y="3.6" width="6.8" height="6.8" rx="1" fill="none" stroke="currentColor" stroke-width="1"/><path d="M3.8 3.4V2.4a.8.8 0 0 1 .8-.8h5.2a.8.8 0 0 1 .8.8v5.2a.8.8 0 0 1-.8.8H8.8" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const syncMaxIcon = st => {
  const b = $('#wMax');
  b.innerHTML = st && st.max ? RESTORE_SVG : MAX_SVG;
  b.title = tr(st && st.max ? 'tb.restore' : 'tb.max');
};
$('#wMin').onclick = () => hz.app.winctl('min');
$('#wMax').onclick = async () => syncMaxIcon(await hz.app.winctl('max'));
$('#wClose').onclick = () => hz.app.winctl('close');
hz.app.winstate().then(syncMaxIcon);
if (hz.app.onWinState) hz.app.onWinState(syncMaxIcon);
// dblclick on any non-interactive titlebar area toggles maximize — single
// delegated listener so bubbled events can't double-toggle.
$('#tabrow').addEventListener('dblclick', e => {
  if (e.target.closest('button, input, .tab, a')) return;
  hz.app.winctl('max');
});
// titlebar drag: manual implementation (app-region doesn't work in WebContentsView)
$('#chrome').addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  if (e.target.closest('button, input, .tab, a, [contenteditable]')) return;
  hz.app.dragbegin(e.clientX, e.clientY, e.screenY || 0);
  const move = ev => hz.app.dragmove(ev.clientX, ev.clientY, ev.screenY || 0);
  const up = () => {
    hz.app.dragend();
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
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
    case 'bmbar': toggleBmBar(); break;
    case 'bmadd': $('#omni-star').click(); break;
    case 'settings': hz.tabs.open('settings'); break;
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
  else if (e.ctrlKey && e.key === 'd') { e.preventDefault(); $('#omni-star').click(); }
  else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleBmBar(); }
});

// live updates from main
hz.tabs.onUpdated((id, t) => { const i = tabs.findIndex(x => x.id === id); if (i >= 0) tabs[i] = t; render(); });
hz.tabs.onAdded(t => { refresh(); });
hz.tabs.onClosed(id => { refresh(); });
hz.tabs.onActivated((id, t) => { activeId = id; const i = tabs.findIndex(x => x.id === id); if (i >= 0) tabs[i] = t; render(); });
if (hz.panel.onState) hz.panel.onState(open => $('#bPanel').classList.toggle('active', !!open));

// ---- bookmarks bar ----
let bms = [];
const bmrow = $('#bmrow');
const STAR_OFF = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const STAR_ON = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
// inline icon set — no network favicon guessing; clean glyphs per site type
const BM_ICONS = {
  image: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M4.5 18l4.5-4.5 3 3 3.5-3.5 4 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  relay: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12l-3-3M20 15H8l3 3"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4z"/><circle cx="9" cy="10.5" r="1" fill="currentColor"/><circle cx="13" cy="10.5" r="1" fill="currentColor"/><circle cx="17" cy="10.5" r="1" fill="currentColor"/></svg>',
  compass: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2.2 4.8-4.8 2.2 2.2-4.8z" stroke-linejoin="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z"/></svg>'
};
const bmIcon = b => b.fav ? `<img src="${esc(b.fav)}">` : `<span class="bm-ic">${BM_ICONS[b.icon] || BM_ICONS.globe}</span>`;

function renderBm() {
  bmrow.innerHTML = bms.map(b => `
    <button class="bm-btn" data-id="${esc(b.id)}" title="${esc(b.url)}">
      ${bmIcon(b)}
      <span class="t">${esc(b.title)}</span>
    </button>`).join('');
}
// img error events don't bubble — catch in capture phase and swap for globe icon
bmrow.addEventListener('error', e => {
  if (e.target.tagName === 'IMG') e.target.outerHTML = `<span class="bm-ic">${BM_ICONS.globe}</span>`;
}, true);
bmrow.addEventListener('click', e => {
  const b = e.target.closest('.bm-btn');
  if (!b) return;
  const bm = bms.find(x => x.id === b.dataset.id);
  if (bm) hz.tabs.navigate(bm.url);
});
bmrow.addEventListener('auxclick', e => {
  const b = e.target.closest('.bm-btn');
  if (b && e.button === 1) {
    const bm = bms.find(x => x.id === b.dataset.id);
    if (bm) hz.tabs.open(bm.url);
  }
});
bmrow.addEventListener('contextmenu', e => {
  const b = e.target.closest('.bm-btn');
  if (b) { e.preventDefault(); hz.bm.menu(b.dataset.id); }
});

async function toggleBmBar() {
  const on = await hz.bm.togglebar();
  bmrow.classList.toggle('off', !on);
}
function updateStar() {
  const active = tabs.find(t => t.id === activeId);
  const u = active && active.url || '';
  const marked = !!u && !isNtp(u) && bms.some(b => b.url === u);
  $('#omni-star').classList.toggle('on', marked);
  $('#omni-star').innerHTML = marked ? STAR_ON : STAR_OFF;
}
$('#omni-star').onclick = async () => {
  const active = tabs.find(t => t.id === activeId);
  if (!active || !active.url || isNtp(active.url)) return;
  const ex = bms.find(b => b.url === active.url);
  if (ex) bms = await hz.bm.del(ex.id);
  else bms = await hz.bm.add({ title: active.title || active.url, url: active.url, fav: active.fav || '' });
  renderBm(); updateStar();
};
hz.bm.list().then(l => { bms = l; renderBm(); updateStar(); });
if (hz.bm.onChange) hz.bm.onChange(l => { bms = l; renderBm(); updateStar(); });
if (hz.app.onBmBar) hz.app.onBmBar(on => bmrow.classList.toggle('off', !on));
hz.bm.barstate && hz.bm.barstate().then(on => bmrow.classList.toggle('off', !on));

// i18n + theme bootstrap and live updates
hz.app.i18n().then(p => { STR = p.strings; applyI18n(); render(); });
hz.app.onI18n(p => { STR = p.strings; applyI18n(); render(); });
hz.app.theme().then(applyTheme);
hz.app.onTheme(applyTheme);

refresh();
