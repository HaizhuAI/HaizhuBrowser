'use strict';
// ProfileManager — commercial-grade isolated browsing environments
// (比特浏览器 / ADS-style). Each profile is a self-contained identity:
//   - own session partition  -> cookies/storage/cache fully isolated
//   - own fingerprint seed   -> stable coherent persona across launches
//   - own proxy binding      -> independent egress per environment
//   - own UA + UA-CH headers -> rewritten at wire level per session
//
// Profile object:
//   { id, name, os, seed, proxyId, group, color, note, createdAt, lastUsed,
//     pinned, incognito }
//
// Sessions are bound at creation time via bindSession(ses, profile):
//   proxy applied, session->profile map recorded for header rewriting.

const crypto = require('crypto');

class ProfileManager {
  constructor(store, proxy, fingerprint) {
    this.store = store;
    this.proxy = proxy;
    this.fingerprint = fingerprint;
    this.sessions = new Map(); // ses -> profile
  }

  get profiles() { return this.store.get('profiles', []); }
  get(id) { return this.profiles.find((p) => p.id === id) || null; }

  create(input = {}) {
    const p = {
      id: 'prof-' + crypto.randomBytes(6).toString('hex'),
      name: String(input.name || '').trim().slice(0, 60) || 'Env ' + (this.profiles.length + 1),
      os: ['windows', 'macos', 'macos_arm', 'linux', 'android'].includes(input.os) ? input.os : 'auto',
      seed: String(input.seed || crypto.randomBytes(16).toString('hex')),
      proxyId: input.proxyId || null,
      group: String(input.group || 'default').slice(0, 40),
      color: input.color || pickColor(this.profiles.length),
      note: String(input.note || '').slice(0, 200),
      createdAt: Date.now(),
      lastUsed: 0,
      uaOverride: input.ua ? String(input.ua).slice(0, 500) : null,
    };
    const list = this.profiles;
    list.push(p);
    this.store.set('profiles', list);
    return p;
  }

  update(id, patch = {}) {
    const list = this.profiles;
    const p = list.find((x) => x.id === id);
    if (!p) return null;
    for (const k of ['name', 'os', 'proxyId', 'group', 'color', 'note', 'uaOverride']) {
      if (patch[k] !== undefined) p[k] = patch[k];
    }
    this.store.set('profiles', list);
    // re-apply proxy to live sessions bound to this profile
    for (const [ses, prof] of this.sessions) {
      if (prof.id === id) this.proxy.apply(ses, this.proxyById(p.proxyId)).catch(() => {});
    }
    return p;
  }

  async remove(id) {
    this.store.set('profiles', this.profiles.filter((p) => p.id !== id));
    // drop bound sessions' storage
    for (const [ses, prof] of this.sessions) {
      if (prof.id === id) { this.sessions.delete(ses); try { await ses.clearStorageData(); } catch (e) {} }
    }
    return true;
  }

  duplicate(id) {
    const src = this.get(id);
    if (!src) return null;
    return this.create({
      name: src.name + ' copy', os: src.os, proxyId: src.proxyId,
      group: src.group, note: src.note,
    });
  }

  // fresh fingerprint seed (rotate identity, keep proxy/name)
  reseed(id) {
    const list = this.profiles;
    const p = list.find((x) => x.id === id);
    if (!p) return null;
    p.seed = crypto.randomBytes(16).toString('hex');
    this.store.set('profiles', list);
    return p;
  }

  partitionFor(profile) { return 'persist:' + profile.id; }

  proxyById(id) {
    if (!id || id === 'direct') return { id: 'direct', mode: 'direct' };
    return this.proxy.profiles.find((x) => x.id === id) || { id: 'direct', mode: 'direct' };
  }

  // Called for every session created for a profile tab.
  async bindSession(ses, profile) {
    this.sessions.set(ses, profile);
    const px = this.proxyById(profile.proxyId);
    try { await this.proxy.apply(ses, px); } catch (e) {}
    // session-level UA + Accept-Language
    try {
      const langs = this.langsFor(profile);
      ses.setUserAgent(profile.uaOverride || this.fingerprint && this.uaFor(profile), langs.join(','));
    } catch (e) {}
    ses.on && ses.on('destroyed', () => this.sessions.delete(ses));
  }

  // Deterministic persona per profile (cached; reseed/uaOverride change re-keys).
  personaFor(profile) {
    if (!this._pc) this._pc = new Map();
    const key = profile.id + ':' + profile.seed + ':' + (profile.os || 'auto');
    let p = this._pc.get(key);
    if (!p) { p = require('./fingerprint').buildPersona(profile.seed, profile.os); this._pc.set(key, p); }
    return p;
  }
  uaFor(profile) { return this.personaFor(profile).userAgent; }
  langsFor(profile) { return this.personaFor(profile).languages; }

  profileForSession(ses) { return this.sessions.get(ses) || null; }

  // Wire-level UA-CH header rewrite — registered as a webhub beforeSendHeaders
  // subscriber. Only requests on profile-bound sessions are touched.
  headerRewrite(details, ses) {
    const prof = this.profileForSession(ses);
    if (!prof) return undefined;
    const persona = this.personaFor(prof);
    const ch = require('./fingerprint').clientHintHeaders(persona.clientHints);
    const h = { ...(details.requestHeaders || {}) };
    h['User-Agent'] = prof.uaOverride || persona.userAgent;
    h['Accept-Language'] = persona.languages.join(',');
    for (const [k, v] of Object.entries(ch)) h[k] = v;
    return { requestHeaders: h };
  }
}

function pickColor(n) {
  const C = ['#4f8ef7', '#34c07c', '#f5a623', '#e86aa0', '#9b72f0', '#44c2d6', '#e76f51', '#8ac926'];
  return C[n % C.length];
}

module.exports = { ProfileManager };
