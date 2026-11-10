'use strict';
/* settings.js — haizhu://settings page controller (Edge-style two-column). */
const $ = s => document.querySelector(s);
let STR = {};
const tr = (k, v) => {
  let s = STR[k] || k;
  if (v) for (const kk in v) s = s.replace('{' + kk + '}', v[kk]);
  return s;
};
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
  const nm = tr('app.name');
  $('#appName').textContent = nm;
  $('#aboutName').textContent = nm;
}
function applyTheme(th) { document.documentElement.dataset.theme = th.effective || th; }

// nav switching
document.querySelectorAll('.sitem').forEach(el => {
  el.onclick = () => {
    document.querySelectorAll('.sitem').forEach(x => x.classList.toggle('active', x === el));
    document.querySelectorAll('.sect').forEach(x => x.classList.toggle('active', x.id === 's-' + el.dataset.s));
  };
});

async function boot() {
  const [i18n, theme] = await Promise.all([hzNav.i18n(), hzNav.theme()]);
  STR = i18n.strings; applyI18n(); applyTheme(theme);

  // appearance
  const mode = theme.mode || 'system';
  document.querySelectorAll('#themeSeg .opt').forEach(o => {
    o.classList.toggle('on', o.dataset.v === mode);
    o.onclick = async () => {
      await hzNav.settings.set('theme', o.dataset.v);
      document.querySelectorAll('#themeSeg .opt').forEach(x => x.classList.toggle('on', x === o));
    };
  });
  const wp = await hzNav.settings.get('ntpWallpaper');
  $('#swWp').checked = wp !== false;
  $('#swWp').onchange = e => hzNav.settings.set('ntpWallpaper', e.target.checked);

  // language
  const lang = await hzNav.settings.get('lang');
  $('#selLang').value = lang || 'system';
  $('#selLang').onchange = e => hzNav.settings.set('lang', e.target.value);

  // startup
  const home = await hzNav.settings.get('home');
  $('#inHome').value = home || '';
  $('#inHome').onchange = e => hzNav.settings.set('home', e.target.value.trim() || 'haizhu://newtab');

  // search engine
  const eng = await hzNav.settings.get('searchEngine');
  $('#selEng').value = eng || 'duckduckgo';
  $('#selEng').onchange = e => hzNav.settings.set('searchEngine', e.target.value);

  // privacy
  const ab = await hzNav.ab.state();
  $('#swAb').checked = !!ab.enabled;
  $('#abRules').textContent = tr('set.rules', { n: ab.rules || 0 });
  $('#abBlocked').textContent = tr('set.blocked', { n: ab.blocked || 0 });
  $('#swAb').onchange = e => hzNav.ab.toggle(e.target.checked);
  $('#btnClear').onclick = async e => {
    await hzNav.ck.clear();
    e.target.textContent = tr('set.cleared');
    setTimeout(() => { e.target.textContent = tr('set.clear'); }, 1600);
  };

  // mcp — agent bridge
  async function mcpRefresh() {
    const s = await hzNav.mcp.state();
    $('#swMcp').checked = !!s.enabled;
    $('#inMcpPort').value = s.port || 8765;
    $('#mcpUrl').textContent = s.url || ('http://127.0.0.1:' + (s.port || 8765) + '/mcp');
    $('#mcpState').textContent = s.running ? '● ' + tr('set.mcp.on') : '○ ' + tr('set.mcp.off');
    $('#mcpState').style.color = s.running ? '#3fb950' : 'var(--fg2)';
    $('#mcpToken').textContent = s.token ? (s.token.slice(0, 8) + '…') : '—';
    const cfg = await hzNav.mcp.config();
    if (cfg) { $('#taCfgStdio').value = cfg.stdio; $('#taCfgHttp').value = cfg.http; }
  }
  await mcpRefresh();
  $('#swMcp').onchange = e => hzNav.mcp.set({ enabled: e.target.checked }).then(mcpRefresh);
  $('#inMcpPort').onchange = e => hzNav.mcp.set({ port: parseInt(e.target.value, 10) || 8765 }).then(mcpRefresh);
  $('#btnMcpRegen').onclick = () => hzNav.mcp.regen().then(mcpRefresh);
  const copyBtn = (btn, ta) => {
    $(btn).onclick = async () => {
      await navigator.clipboard.writeText($(ta).value);
      $(btn).textContent = tr('set.mcp.copied');
      setTimeout(() => { $(btn).textContent = tr('set.mcp.copy'); }, 1400);
    };
  };
  copyBtn('#btnCfgStdio', '#taCfgStdio');
  copyBtn('#btnCfgHttp', '#taCfgHttp');

  // about
  $('#aboutVer').textContent = tr('set.version') + ' ' + (await hzNav.version());
}
hzNav.onI18n(p => { STR = p.strings; applyI18n(); });
hzNav.onTheme(applyTheme);
boot();
