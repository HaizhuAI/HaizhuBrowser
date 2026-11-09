'use strict';
// ProxyManager — per-session proxy profiles (system/direct/http/socks/pac,
// per-scheme rules, bypass lists). Chromium resolves proxy per session
// (partition), so anonymous/identity profiles can each carry their own egress.

class ProxyManager {
  constructor(store) {
    this.store = store;
  }
  get profiles() { return this.store.get('proxyProfiles', []); }
  get activeId() { return this.store.get('activeProxy', 'direct'); }
  active() { return this.profiles.find(p => p.id === this.activeId) || { id: 'direct', mode: 'direct' }; }
  addProfile(p) {
    p.id = p.id || 'p' + Date.now().toString(36);
    const list = this.profiles; list.push(p);
    this.store.set('proxyProfiles', list);
    return p;
  }
  updateProfile(id, patch) {
    const list = this.profiles;
    const p = list.find(x => x.id === id);
    if (p) Object.assign(p, patch);
    this.store.set('proxyProfiles', list);
  }
  removeProfile(id) {
    this.store.set('proxyProfiles', this.profiles.filter(p => p.id !== id));
    if (this.activeId === id) this.setActive('direct');
  }
  setActive(id) { this.store.set('activeProxy', id); }

  // Build Electron proxyConfig for a session
  configFor(profile) {
    const p = profile || this.active();
    switch (p.mode) {
      case 'http': case 'https': case 'socks5': case 'socks4': {
        const scheme = p.mode === 'socks4' ? 'socks4' : p.mode === 'socks5' ? 'socks5' : p.mode;
        const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass || '')}@` : '';
        // Chromium takes auth via separate login event; host-only rules here.
        const rule = `${scheme}://${p.host}:${p.port}`;
        return {
          proxyRules: p.allSchemes === false
            ? [p.http && `http=${scheme}://${p.http}`, p.https && `https=${scheme}://${p.https}`, p.ftp && `ftp=${scheme}://${p.ftp}`].filter(Boolean).join(';')
            : rule,
          proxyBypassRules: p.bypass || '<local>'
        };
      }
      case 'pac': return { proxyRules: '', pacScript: p.pacUrl || p.pacScript, proxyBypassRules: p.bypass || '' };
      case 'system': return { mode: 'system' };
      default: return { mode: 'direct' };
    }
  }
  async apply(ses, profile) {
    const cfg = this.configFor(profile);
    await ses.setProxy(cfg.mode === 'system' ? { mode: 'system' } : cfg.mode === 'direct' ? { mode: 'direct' } : {
      proxyRules: cfg.proxyRules, pacScript: cfg.pacScript, proxyBypassRules: cfg.proxyBypassRules
    });
    return cfg;
  }
  // credentials: Electron fires 'login' — main.js wires this to supply user/pass
  credentials(profile) {
    return profile && profile.user ? { username: profile.user, password: profile.pass || '' } : null;
  }
}

module.exports = { ProxyManager };
