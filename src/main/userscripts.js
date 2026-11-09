'use strict';
// Userscript engine — Tampermonkey-compatible metadata parsing, @match/@include
// rules, run-at scheduling, and the GM_* API surface bridged to main-process
// privileges (cross-origin XHR, persistent storage, downloads, tabs).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, net } = require('electron');
const { Store } = require('./store');

const GM_API_NAMES = [
  'GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues',
  'GM_addStyle', 'GM_addElement', 'GM_openInTab', 'GM_xmlhttpRequest',
  'GM_download', 'GM_notification', 'GM_setClipboard', 'GM_getResourceText',
  'GM_getResourceURL', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand',
  'GM_cookie', 'GM.webRequest', 'GM_getTab', 'GM_saveTab'
];

function matchPatternToRe(pat) {
  // @match: scheme://host/path — * wildcard, also allow plain glob @include.
  let s = pat.trim();
  if (s === '<all_urls>' || s === '*') return /^https?:\/\/.+/;
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/i.exec(s);
  if (m) {
    const scheme = m[1] === '*' ? 'https?' : m[1].replace(/\./g, '\\.');
    let host = m[2].toLowerCase();
    let hostRe;
    if (host === '*') hostRe = '[^/]+';
    else if (host.startsWith('*.')) hostRe = '([^/]+\\.)?' + host.slice(2).replace(/\./g, '\\.');
    else hostRe = host.replace(/\*/g, '[^/]*').replace(/\./g, '\\.');
    const p = (m[3] || '/').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + scheme + '://' + hostRe + p + '$', 'i');
  }
  // @include glob
  const re = s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + re + '$', 'i');
}

function parseMeta(src) {
  const meta = { name: 'Unnamed', namespace: '', version: '0', description: '', author: '',
    match: [], include: [], exclude: [], grant: [], require: [], resource: {},
    'run-at': 'document-idle', noframes: false, connect: [], icon: '', downloadURL: '', updateURL: '' };
  const block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(src);
  if (!block) return null;
  for (const line of block[1].split('\n')) {
    const m = /^\s*\/\/\s*@([A-Za-z_-]+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    switch (key) {
      case 'name': case 'namespace': case 'version': case 'description':
      case 'author': case 'icon': case 'downloadurl': case 'updateurl':
        meta[key === 'downloadurl' ? 'downloadURL' : key === 'updateurl' ? 'updateURL' : key] = val; break;
      case 'match': case 'include': case 'exclude': case 'grant': case 'require': case 'connect':
        meta[key].push(val); break;
      case 'resource': {
        const i = val.indexOf(' '); if (i > 0) meta.resource[val.slice(0, i)] = val.slice(i + 1).trim(); break;
      }
      case 'run-at': meta['run-at'] = val; break;
      case 'noframes': meta.noframes = true; break;
    }
  }
  if (!meta.match.length && !meta.include.length) meta.include.push('*');
  return meta;
}

class UserscriptEngine {
  constructor(store) {
    this.store = store;
    this.dir = path.join(app.getPath('userData'), 'userscripts');
    fs.mkdirSync(this.dir, { recursive: true });
    this.scripts = new Map(); // id -> {meta, code, enabled, file}
    this.values = new Store('gm-values', {}); // persistent GM_setValue store
    this.loadAll();
  }
  id(meta) { return crypto.createHash('md5').update(meta.namespace + '|' + meta.name).digest('hex').slice(0, 16); }
  loadAll() {
    this.scripts.clear();
    for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith('.user.js'))) {
      try {
        const code = fs.readFileSync(path.join(this.dir, f), 'utf8');
        const meta = parseMeta(code);
        if (!meta) continue;
        const id = f.replace(/\.user\.js$/, '');
        const disabled = fs.existsSync(path.join(this.dir, id + '.disabled'));
        this.scripts.set(id, { id, meta, code, enabled: !disabled });
      } catch (e) { console.error('[us] load', f, e.message); }
    }
  }
  install(code, sourceUrl) {
    const meta = parseMeta(code);
    if (!meta) throw new Error('No ==UserScript== metadata block');
    const id = this.id(meta);
    fs.writeFileSync(path.join(this.dir, id + '.user.js'), code, 'utf8');
    const off = path.join(this.dir, id + '.disabled');
    if (fs.existsSync(off)) fs.unlinkSync(off);
    const rec = { id, meta, code, enabled: true, sourceUrl };
    this.scripts.set(id, rec);
    return rec;
  }
  async installFromUrl(url) {
    const res = await net.fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return this.install(await res.text(), url);
  }
  remove(id) {
    for (const ext of ['.user.js', '.disabled']) {
      const f = path.join(this.dir, id + ext);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    this.scripts.delete(id);
    const v = this.values.get('values') || {};
    delete v[id];
    this.values.set('values', v);
  }
  setEnabled(id, on) {
    const s = this.scripts.get(id); if (!s) return;
    const f = path.join(this.dir, id + '.disabled');
    if (on) { if (fs.existsSync(f)) fs.unlinkSync(f); } else fs.writeFileSync(f, '');
    s.enabled = on;
  }
  matchesFor(url, isTopFrame) {
    const out = [];
    for (const s of this.scripts.values()) {
      if (!s.enabled) continue;
      if (isTopFrame === false && s.meta.noframes) continue;
      const pats = [...s.meta.match, ...s.meta.include];
      let ok = false;
      for (const p of pats) { try { if (matchPatternToRe(p).test(url)) { ok = true; break; } } catch (e) {} }
      if (!ok) continue;
      let excl = false;
      for (const p of s.meta.exclude) { try { if (matchPatternToRe(p).test(url)) { excl = true; break; } } catch (e) {} }
      if (!excl) out.push(s);
    }
    return out;
  }
  // GM_* bridge bootstrap injected into the page (isolated bridge world).
  // Real privileges live in the preload; the page talks over postMessage.
  bridgeSource() {
    return `(function(){
'use strict';
if (window.__hz_gm_for) return;
const pending = new Map(); let seq = 0;
const call = (sid, op, args) => new Promise((res, rej) => {
  const id = 'gm' + (++seq);
  pending.set(id, { res, rej });
  window.postMessage({ __hz_gm: true, dir: 'req', sid, id, op, args }, '*');
});
window.addEventListener('message', ev => {
  const d = ev.data;
  if (!d || !d.__hz_gm || d.dir !== 'res') return;
  const p = pending.get(d.id); if (!p) return;
  pending.delete(d.id);
  d.error ? p.rej(new Error(d.error)) : p.res(d.value);
});
window.__hz_gm_for = function(sid){
  const api = {
    GM_info: { script: {}, scriptMetaStr: '', scriptHandler: 'Haizhu', version: '1.0.0' },
    GM_getValue: (k, d) => call(sid, 'getValue', [k, d]),
    GM_setValue: (k, v) => call(sid, 'setValue', [k, v]),
    GM_deleteValue: k => call(sid, 'deleteValue', [k]),
    GM_listValues: () => call(sid, 'listValues', []),
    GM_addStyle: css => call(sid, 'addStyle', [css]),
    GM_addElement: (a, b, c) => call(sid, 'addElement', [a, b, c]),
    GM_openInTab: (url, opts) => call(sid, 'openInTab', [url, opts]),
    GM_xmlhttpRequest: det => {
      const cbs = {};
      for (const k of ['onload','onerror','ontimeout','onprogress','onreadystatechange','onabort','onloadend'])
        if (typeof det[k] === 'function') cbs[k] = det[k];
      return call(sid, 'xhr', [Object.assign({}, det)]).then(r => {
        for (const [k, f] of Object.entries(cbs)) { try { f(r); } catch(e){} }
        return r;
      });
    },
    GM_download: (a, b) => call(sid, 'download', [a, b]),
    GM_notification: (a, b, c, d) => call(sid, 'notification', [a, b, c, d]),
    GM_setClipboard: (v, t) => call(sid, 'setClipboard', [v, t]),
    GM_getResourceText: n => call(sid, 'resourceText', [n]),
    GM_getResourceURL: n => call(sid, 'resourceURL', [n]),
    GM_registerMenuCommand: (n, f) => call(sid, 'regMenu', [n]),
    GM_unregisterMenuCommand: id => call(sid, 'unregMenu', [id]),
    GM_cookie: { list: p => call(sid, 'cookieList', [p || {}]), set: p => call(sid, 'cookieSet', [p]), delete: p => call(sid, 'cookieDel', [p]) },
    GM_getTab: () => call(sid, 'getTab', []),
    GM_saveTab: t => call(sid, 'saveTab', [t])
  };
  api.unsafeWindow = window;
  return api;
};
})();`;
  }
  wrapScript(rec) {
    const grants = new Set(rec.meta.grant.map(g => g.trim()));
    const names = grants.has('none') ? [] : GM_API_NAMES.filter(n => grants.size === 0 || grants.has(n) || grants.has(n.replace('GM_', 'GM.')) || [...grants].some(g => n.startsWith(g.split('.')[0])));
    const header = `/* ==Haizhu injected: ${rec.meta.name} v${rec.meta.version}== */`;
    const metaJson = JSON.stringify(rec.meta);
    return `${header}
(function(){
const __gm = (window.__hz_gm_for ? window.__hz_gm_for(${JSON.stringify(rec.id)}) : {});
const GM_info = { script: ${metaJson}, scriptMetaStr: '', scriptHandler: 'Haizhu', version: '1.0.0' };
const { ${names.filter(n => !n.includes('.') && n !== 'GM_info').join(',') || 'GM_getValue:GM_getValue'} } = __gm;
const unsafeWindow = window;
try {
${rec.code}
} catch (e) { console.error('[userscript ${rec.meta.name}]', e); }
})();`;
  }
  // main-side GM op executor (called from preload bridge via ipc)
  async execOp(scriptId, op, args, ctx) {
    const rec = this.scripts.get(scriptId);
    const vals = () => { const v = this.values.get('values') || {}; return v[scriptId] || (v[scriptId] = {}); };
    switch (op) {
      case 'getValue': { const o = vals(); return args[0] in o ? o[args[0]] : args[1]; }
      case 'setValue': { const v = this.values.get('values') || {}; (v[scriptId] = v[scriptId] || {})[args[0]] = args[1]; this.values.set('values', v); return true; }
      case 'deleteValue': { const o = vals(); delete o[args[0]]; const v = this.values.get('values') || {}; v[scriptId] = o; this.values.set('values', v); return true; }
      case 'listValues': return Object.keys(vals());
      case 'openInTab': ctx.openTab(args[0], !(args[1] && args[1].active === false)); return true;
      case 'setClipboard': { require('electron').clipboard.writeText(String(args[0])); return true; }
      case 'notification': {
        const opts = typeof args[0] === 'object' ? args[0] : { title: args[1] || 'Userscript', text: args[0] };
        new require('electron').Notification({ title: opts.title || 'Userscript', body: opts.text || '' }).show();
        return true;
      }
      case 'download': {
        const opt = typeof args[0] === 'object' ? args[0] : { url: args[0], name: args[1] };
        return ctx.download(opt.url, opt.name);
      }
      case 'xhr': {
        const det = args[0];
        const res = await net.fetch(det.url, {
          method: det.method || 'GET',
          headers: det.headers || {},
          body: det.data || det.body
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const h = {}; res.headers.forEach((v, k) => h[k] = v);
        const resp = {
          status: res.status, statusText: res.statusText, finalUrl: res.url,
          responseHeaders: Object.entries(h).map(([k, v]) => k + ': ' + v).join('\r\n'),
          responseText: buf.toString('utf8'), readyState: 4,
          response: det.responseType === 'arraybuffer' ? Array.from(buf) : buf.toString('utf8')
        };
        resp.events = { onload: resp, onreadystatechange: resp, onloadend: resp };
        return resp;
      }
      case 'cookieList': return ctx.cookies.list(args[0]);
      case 'cookieSet': return ctx.cookies.set(args[0]);
      case 'cookieDel': return ctx.cookies.remove(args[0]);
      case 'resourceText': case 'resourceURL': {
        const u = rec && rec.meta.resource[args[0]];
        if (!u) throw new Error('resource not declared');
        const r = await net.fetch(u);
        const t = await r.text();
        return op === 'resourceText' ? t : u;
      }
      case 'getTab': return {};
      case 'saveTab': { const t = this.values.get('tabs') || {}; t[ctx.tabId] = args[0]; this.values.set('tabs', t); return true; }
      case 'addStyle': return ctx.injectCss(args[0]);
      case 'addElement': return ctx.addElement(args[0], args[1], args[2]);
      default: throw new Error('unsupported op ' + op);
    }
  }
}

module.exports = { UserscriptEngine, parseMeta, matchPatternToRe };
