'use strict';
// AdBlock — EasyList-compatible filter engine (subset): ||domain^ anchors,
// |url anchors, substring contains, @@ exceptions, and $third-party/script/
// image/xmlhttprequest modifiers. Lists fetched & cached locally.

const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');

const DEFAULT_LISTS = [
  { name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt' },
  { name: 'EasyPrivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { name: 'EasyList China', url: 'https://easylist-downloads.adblockplus.org/easylistchina.txt' }
];

const RES_TYPES = { script: 'script', image: 'image', stylesheet: 'stylesheet', xmlhttprequest: 'xhr', 'subdocument': 'subFrame', media: 'media', font: 'font', 'other': 'other', websocket: 'ws', 'third-party': '3p' };

class AdBlock {
  constructor(store) {
    this.store = store;
    this.dir = path.join(app.getPath('userData'), 'adblock');
    fs.mkdirSync(this.dir, { recursive: true });
    this.rules = [];       // {re, exception, types:Set, domains:Set|null}
    this.enabled = store.get('adblock.enabled', true);
    this.blockedCount = 0;
  }
  async ensureLists() {
    for (const l of DEFAULT_LISTS) {
      const f = path.join(this.dir, l.name.replace(/\W+/g, '_') + '.txt');
      if (!fs.existsSync(f) || Date.now() - fs.statSync(f).mtimeMs > 7 * 86400e3) {
        try {
          const r = await net.fetch(l.url);
          if (r.ok) fs.writeFileSync(f, await r.text());
        } catch (e) { console.error('[adblock] fetch', l.name, e.message); }
      }
    }
    this.compile();
  }
  compile() {
    this.rules = [];
    for (const f of fs.readdirSync(this.dir).filter(x => x.endsWith('.txt'))) {
      const text = fs.readFileSync(path.join(this.dir, f), 'utf8');
      for (const line of text.split('\n')) this.addRule(line.trim());
    }
    console.log('[adblock] rules:', this.rules.length);
  }
  addRule(line) {
    if (!line || line.startsWith('!') || line.startsWith('[') || line.includes('##') || line.includes('#@#')) return;
    let exception = false;
    if (line.startsWith('@@')) { exception = true; line = line.slice(2); }
    let types = null, domains = null;
    const di = line.indexOf('$');
    if (di >= 0) {
      const opts = line.slice(di + 1).split(',');
      line = line.slice(0, di);
      types = new Set();
      for (const o of opts) {
        const [k, v] = o.split('=');
        if (k === 'domain') domains = new Set(v.split('|').map(d => d.toLowerCase()));
        else if (RES_TYPES[k]) types.add(RES_TYPES[k]);
      }
      if (!types.size) types = null;
    }
    let re;
    try {
      if (line.startsWith('||')) {
        const host = line.slice(2).replace(/\^.*$/, '');
        re = new RegExp('^[a-z]+://([^/]*\\.)?' + host.replace(/[.+?${}()|[\]\\|^]/g, '\\$&').replace(/\*/g, '.*') + '(\\/|\\?|:|$)', 'i');
      } else if (line.startsWith('|')) {
        re = new RegExp('^' + line.slice(1).replace(/[.+?${}()|[\]\\|]/g, '\\$&').replace(/\*/g, '.*').replace(/\^$/, '($|\\?|/)'), 'i');
      } else if (line.endsWith('|')) {
        re = new RegExp(line.slice(0, -1).replace(/[.+?${}()|[\]\\|]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
      } else {
        re = new RegExp(line.replace(/[.+?${}()|[\]\\|]/g, '\\$&').replace(/\*/g, '.*').replace(/\^/g, '[^\\w\\d\\-_.%]'), 'i');
      }
    } catch (e) { return; }
    this.rules.push({ re, exception, types, domains });
  }
  test(url, resourceType, pageHost) {
    if (!this.enabled) return false;
    let blocked = false;
    const rt = RES_TYPES[resourceType] || resourceType;
    for (const r of this.rules) {
      if (r.types && !r.types.has(rt)) continue;
      if (r.domains) {
        if (!pageHost || ![...r.domains].some(d => pageHost === d || pageHost.endsWith('.' + d))) continue;
      }
      if (!r.re.test(url)) continue;
      if (r.exception) return false;
      blocked = true;
    }
    if (blocked) this.blockedCount++;
    return blocked;
  }
  attach(hub) {
    hub.on('before', d => {
      if (!/^https?:/i.test(d.url)) return;
      let host = null;
      try { host = d.referrer ? new URL(d.referrer).hostname : null; } catch (e) {}
      const hit = this.test(d.url, d.resourceType, host);
      if (process.env.HZ_DEBUG && hit) console.error('[ab] BLOCK', d.resourceType, d.url.slice(0, 80));
      return hit ? { cancel: true } : undefined;
    });
  }
  setEnabled(on) { this.enabled = on; this.store.set('adblock.enabled', on); }
}

module.exports = { AdBlock };
