'use strict';
/* panel.js — docked dev panel: capture, resources, cookies, userscripts,
   extensions, proxy, fingerprint, AI agent. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const activeTab = async () => (await hz.tabs.list()).find(t => t.id === hzActiveId) || (await hz.tabs.state());
let hzActiveId = null;

// i18n + theme
let STR = {};
const tr = k => STR[k] || k;
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = tr(el.dataset.i18nTitle); });
}
hz.app.i18n().then(p => { STR = p.strings; applyI18n(); });
hz.app.onI18n(p => { STR = p.strings; applyI18n(); });
hz.app.theme().then(th => document.documentElement.dataset.theme = th.effective);
hz.app.onTheme(th => document.documentElement.dataset.theme = th.effective);

// ---------- page switching ----------
$('#pClose').onclick = () => hz.panel.toggle();
document.querySelectorAll('#ptabs .pt').forEach(el => {
  el.onclick = () => {
    document.querySelectorAll('#ptabs .pt').forEach(x => x.classList.toggle('active', x === el));
    document.querySelectorAll('.page').forEach(x => x.classList.toggle('active', x.id === 'p-' + el.dataset.p));
    refreshPage(el.dataset.p);
  };
});
function refreshPage(p) {
  ({ net: loadCapture, res: loadRes, ck: loadCk, us: loadUs, ext: loadExt, px: loadPx, fp: loadFp, ai: loadAi })[p]?.();
}

// ---------- capture ----------
let capTimer = null;
async function loadCapture() {
  const on = await hz.capture.list().then(() => true).catch(() => false);
  renderCap();
  clearInterval(capTimer);
  capTimer = setInterval(renderCap, 1500);
}
async function renderCap() {
  const list = await hz.capture.list();
  const f = $('#capFilter').value.toLowerCase();
  const rows = list.filter(e => !f || (e.url + e.type + e.method).toLowerCase().includes(f)).slice(-300).reverse();
  $('#capRows').innerHTML = rows.map(e => `
    <tr class="req-row" data-id="${esc(e.id)}">
      <td class="mono">${esc(e.method)}</td>
      <td title="${esc(e.url)}">${esc(e.url.slice(0, 120))}</td>
      <td>${e.failed ? '<span class="err">ERR</span>' : esc(e.status ?? '·')}</td>
      <td>${esc(e.type)}</td>
      <td>${e.encodedSize ? (e.encodedSize / 1024).toFixed(1) + 'k' : ''}</td>
      <td>${e.time ? Math.round(e.time) : ''}</td>
    </tr>`).join('');
}
$('#capToggle').onclick = async () => {
  const on = await hz.capture.toggle();
  $('#capToggle').textContent = on ? 'Stop capture' : 'Start capture';
  $('#capToggle').classList.toggle('active', on);
};
$('#capClear').onclick = () => { hz.capture.clear(); renderCap(); };
$('#capHar').onclick = async () => {
  const har = await hz.capture.har();
  if (!har) return;
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'capture-' + Date.now() + '.har'; a.click();
};
$('#capRows').addEventListener('click', async e => {
  const tr = e.target.closest('.req-row'); if (!tr) return;
  const list = await hz.capture.list();
  const r = list.find(x => x.id === tr.dataset.id); if (!r) return;
  let body = await hz.capture.body(r.id);
  if (body && body.length > 20000) body = body.slice(0, 20000) + '\n...[truncated]';
  $('#capDump').textContent =
    `${r.method} ${r.url}\nStatus: ${r.status} ${r.statusText || ''}  ${r.protocol || ''}\nRemote: ${r.remote || ''}\n\n` +
    `== Request headers ==\n${Object.entries(r.requestHeaders || {}).map(([k, v]) => k + ': ' + v).join('\n')}\n` +
    (r.postData ? `\n== Post data ==\n${r.postData.slice(0, 4000)}\n` : '') +
    `\n== Response headers ==\n${Object.entries(r.responseHeaders || {}).map(([k, v]) => k + ': ' + v).join('\n')}\n` +
    (body ? `\n== Response body ==\n${tryDecode(body)}` : '');
  $('#capDetail').classList.remove('hidden');
});
function tryDecode(b) {
  // body may come back base64-encoded when binary
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(b) && b.length > 200) {
    try { const d = atob(b); if (/^[\x20-\x7e\s]+$/.test(d.slice(0, 200))) return d; } catch (e) {}
  }
  return b;
}

// ---------- resources ----------
async function loadRes() { renderRes(); renderJobs(); }
async function renderRes() {
  const t = await activeTab();
  const list = await hz.sniff.list(t ? t.id : null);
  $('#resRows').innerHTML = list.map(r => `
    <tr><td><span class="badge b">${esc(r.type)}</span></td>
    <td title="${esc(r.url)}" class="mono">${esc(r.url.slice(0, 110))}</td>
    <td>${r.size ? (r.size / 1048576).toFixed(1) + 'M' : ''}</td>
    <td><button data-dl="${esc(r.url)}">Grab</button> <button data-open="${esc(r.url)}">Open</button></td></tr>`).join('');
}
$('#resRefresh').onclick = renderRes;
$('#resRows').addEventListener('click', e => {
  const dl = e.target.closest('[data-dl]');
  if (dl) { hz.sniff.download(dl.dataset.dl, 'video').then(renderJobs); return; }
  const op = e.target.closest('[data-open]');
  if (op) hz.sniff.open(op.dataset.open);
});
async function renderJobs() {
  const jobs = await hz.sniff.jobs();
  $('#dlJobs').innerHTML = jobs.map(j =>
    `<div class="row"><span class="badge ${j.status === 'done' ? 'g' : j.status === 'error' ? 'r' : 'y'}">${esc(j.status)}</span>
     <span class="mono" title="${esc(j.file || j.url)}">${esc((j.name || '').slice(0, 60))}</span>
     <span class="dim">${j.done || 0}/${j.total || '?'} segs</span>
     ${j.error ? `<span class="err">${esc(j.error)}</span>` : ''}${j.file ? `<span class="dim">${esc(j.file)}</span>` : ''}</div>`).join('')
    || '<div class="dim">no downloads</div>';
}

// ---------- cookies ----------
async function loadCk() {
  const t = await activeTab();
  $('#ckScope').textContent = t ? new URL(t.url || 'http://x').hostname : '';
  const cks = await hz.ck.list(t && t.url && /^https?:/.test(t.url) ? { url: t.url } : {});
  $('#ckRows').innerHTML = cks.map(c => `
    <tr><td class="mono">${esc(c.name)}</td><td title="${esc(c.value)}">${esc(c.value.slice(0, 40))}</td>
    <td>${esc(c.domain)}</td><td>${c.expirationDate ? new Date(c.expirationDate * 1000).toISOString().slice(0, 10) : 'session'}</td>
    <td>${[c.httpOnly && 'http', c.secure && 'sec', c.sameSite].filter(Boolean).join(' ')}</td>
    <td><button data-del="${esc(c.name)}|${esc(c.domain)}">x</button></td></tr>`).join('');
}
$('#ckRefresh').onclick = loadCk;
$('#ckClear').onclick = () => hz.ck.clear().then(loadCk);
$('#ckRows').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  const t = await activeTab();
  const [name] = b.dataset.del.split('|');
  if (t) await hz.ck.del(t.url, name);
  loadCk();
});

// ---------- userscripts ----------
let usEditing = null;
async function loadUs() {
  const list = await hz.us.list();
  $('#usList').innerHTML = list.map(s => `
    <div class="row" style="border-bottom:1px solid var(--border);padding:6px 0">
      <label><input type="checkbox" data-tog="${esc(s.id)}" ${s.enabled ? 'checked' : ''}></label>
      <div style="flex:1"><b>${esc(s.name)}</b> <span class="dim">v${esc(s.version)}</span>
      <div class="dim">${esc(s.desc || '')}</div><div class="dim mono">${esc(s.match.slice(0, 3).join('  '))}</div></div>
      <button data-edit="${esc(s.id)}">Edit</button>
      <button data-del="${esc(s.id)}">Del</button>
    </div>`).join('') || '<div class="dim">No scripts. Install from Greasyfork or write your own.</div>';
}
$('#usInstall').onclick = async () => {
  try { await hz.us.installUrl($('#usUrl').value); $('#usUrl').value = ''; loadUs(); }
  catch (e) { alert('install failed: ' + e.message); }
};
$('#usNew').onclick = () => {
  usEditing = null;
  $('#usCode').value = `// ==UserScript==\n// @name         New Script\n// @namespace    haizhu\n// @version      0.1\n// @match        *://*/*\n// @grant        none\n// @run-at       document-idle\n// ==/UserScript==\n\n(function(){\n  'use strict';\n  // your code\n})();`;
  $('#usEditor').classList.remove('hidden');
};
$('#usList').addEventListener('click', async e => {
  const tog = e.target.closest('[data-tog]');
  if (tog) { await hz.us.toggle(tog.dataset.tog, tog.checked); return; }
  const del = e.target.closest('[data-del]');
  if (del) { if (confirm('Delete script?')) await hz.us.remove(del.dataset.del); loadUs(); return; }
  const ed = e.target.closest('[data-edit]');
  if (ed) {
    const s = await hz.us.get(ed.dataset.edit);
    usEditing = s.id;
    $('#usCode').value = s.code;
    $('#usEditor').classList.remove('hidden');
  }
});
$('#usSave').onclick = async () => {
  const code = $('#usCode').value;
  if (usEditing) await hz.us.save(usEditing, code);
  else await hz.us.create(code);
  $('#usEditor').classList.add('hidden'); loadUs();
};
$('#usCancel').onclick = () => $('#usEditor').classList.add('hidden');
hz.us.onInstalled(() => loadUs());

// ---------- extensions ----------
async function loadExt() {
  const list = await hz.ext.list();
  $('#extList').innerHTML = list.map(x => `
    <div class="row" style="border-bottom:1px solid var(--border);padding:6px 0">
      <label><input type="checkbox" data-tog="${esc(x.dir)}" ${x.enabled ? 'checked' : ''}></label>
      <div style="flex:1"><b>${esc(x.name)}</b> <span class="dim">v${esc(x.version)} MV${x.manifestVersion}</span>
      <div class="dim">${esc(x.description || '')}</div>
      ${x.loaded ? '<span class="badge g">loaded</span>' : '<span class="badge y">not loaded</span>'}</div>
      <button data-del="${esc(x.dir)}">Remove</button>
    </div>`).join('') || '<div class="dim">No extensions. Install unpacked extensions packaged as .zip/.crx.</div>';
}
$('#extInstall').onclick = () => hz.ext.install().then(loadExt);
$('#extList').addEventListener('click', async e => {
  const tog = e.target.closest('[data-tog]');
  if (tog) { await hz.ext.toggle(tog.dataset.tog, tog.checked); loadExt(); return; }
  const del = e.target.closest('[data-del]');
  if (del) { await hz.ext.remove(del.dataset.del); loadExt(); }
});

// ---------- proxy ----------
async function loadPx() {
  const { profiles, active } = await hz.proxy.list();
  const all = [{ id: 'direct', name: 'Direct (no proxy)', mode: 'direct' }, { id: 'system', name: 'System proxy', mode: 'system' }, ...profiles];
  $('#pxActive').innerHTML = all.map(p => `<option value="${esc(p.id)}" ${p.id === active ? 'selected' : ''}>${esc(p.name || p.id)} ${p.mode !== 'direct' && p.mode !== 'system' ? '(' + esc(p.mode + ' ' + (p.host || '') + ':' + (p.port || '')) + ')' : ''}</option>`).join('');
  $('#pxList').innerHTML = profiles.map(p => `
    <div class="row"><span class="badge b">${esc(p.mode)}</span>
    <span style="flex:1">${esc(p.name)} — ${esc(p.host || '')}:${esc(p.port || '')}${p.pacUrl ? ' ' + esc(p.pacUrl) : ''}</span>
    <button data-del="${esc(p.id)}">Del</button></div>`).join('') || '<div class="dim">no custom profiles</div>';
}
$('#pxApply').onclick = () => hz.proxy.set($('#pxActive').value).then(() => alert('proxy applied'));
$('#pxAdd').onclick = async () => {
  await hz.proxy.add({
    name: $('#pxName').value || $('#pxHost').value + ':' + $('#pxPort').value,
    mode: $('#pxMode').value, host: $('#pxHost').value, port: +$('#pxPort').value || 0,
    user: $('#pxUser').value, pass: $('#pxPass').value,
    pacUrl: $('#pxPac').value, bypass: $('#pxBypass').value || '<local>'
  });
  loadPx();
};
$('#pxList').addEventListener('click', e => {
  const d = e.target.closest('[data-del]');
  if (d) hz.proxy.remove(d.dataset.del).then(loadPx);
});

// ---------- fingerprint ----------
async function loadFp() {
  const s = await hz.fp.get();
  $('#fpOn').checked = !!s.enabled;
  $('#fpMode').value = s.mode || 'per-session';
  const p = await hz.fp.persona();
  $('#fpPersona').innerHTML = p ? `<div class="kv">
    <div>User-Agent</div><div class="mono">${esc(p.userAgent)}</div>
    <div>Platform</div><div>${esc(p.platform)} / ${esc(p.hardwareConcurrency)}c / ${p.deviceMemory}GB</div>
    <div>Screen</div><div>${p.screen.width}x${p.screen.height}</div>
    <div>GPU</div><div class="mono">${esc(p.gpu)}</div>
    <div>Languages</div><div>${esc(p.languages.join(', '))}</div>
    <div>TZ offset</div><div>${p.tzOffset} min</div></div>` : '<div class="dim">spoofing disabled — enable to preview persona</div>';
}
$('#fpOn').onchange = () => hz.fp.set({ enabled: $('#fpOn').checked }).then(loadFp);
$('#fpMode').onchange = () => hz.fp.set({ mode: $('#fpMode').value }).then(loadFp);
$('#fpRotate').onclick = () => hz.fp.rotate().then(loadFp);

// ---------- AI ----------
const aiLog = [];
function aiMsg(kind, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + kind;
  d.textContent = text;
  $('#aiMsgs').appendChild(d);
  $('#aiMsgs').scrollTop = 1e9;
  return d;
}
async function loadAi() {
  const provs = await hz.ai.providers();
  $('#aiProv').innerHTML = provs.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  await loadModels();
}
async function loadModels() {
  const id = $('#aiProv').value;
  const models = await hz.ai.models(id).catch(() => []);
  $('#aiModel').innerHTML = (models || []).map(m => `<option value="${esc(m.id || m)}">${esc(m.label || m.id || m)}</option>`).join('');
}
$('#aiProv').onchange = () => { hz.ai.setActive($('#aiProv').value); loadModels(); };
$('#aiCfg').onclick = () => $('#aiCfgBox').classList.toggle('hidden');
$('#epAdd').onclick = async () => {
  await hz.ai.addEndpoint({ name: $('#epName').value || $('#epBase').value, base: $('#epBase').value, key: $('#epKey').value, model: $('#epModel').value });
  $('#aiCfgBox').classList.add('hidden'); loadAi();
};
async function aiSend(agentMode) {
  const text = $('#aiIn').value.trim(); if (!text) return;
  $('#aiIn').value = '';
  aiMsg('user', text);
  const out = aiMsg('ai', '…');
  try {
    if (!agentMode) {
      const reply = await hz.ai.chat([...aiLog, { role: 'user', content: text }], { model: $('#aiModel').value || undefined });
      out.textContent = reply;
      aiLog.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    } else {
      const t = await activeTab();
      const res = await hz.ai.agent(text, t ? t.id : null);
      out.textContent = res.answer || JSON.stringify(res);
      aiLog.push({ role: 'user', content: text }, { role: 'assistant', content: res.answer || '' });
    }
  } catch (e) { out.textContent = 'error: ' + (e.message || e); out.classList.add('tool'); }
}
$('#aiSend').onclick = () => aiSend(false);
$('#aiAgent').onclick = () => aiSend(true);
$('#aiIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(false); } });
hz.ai.onEvent(ev => {
  if (ev.type === 'tool') aiMsg('tool', '▶ ' + ev.data.name + ' ' + JSON.stringify(ev.data.args));
  if (ev.type === 'tool_result') aiMsg('tool', '◀ ' + String(ev.data.result).slice(0, 500));
  if (ev.type === 'error') aiMsg('tool', '✖ ' + ev.data);
});

// active tab tracking
hz.tabs.onActivated((id) => { hzActiveId = id; });
hz.tabs.state().then(s => { if (s) hzActiveId = s.id; });

renderCap();
