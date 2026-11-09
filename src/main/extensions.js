'use strict';
// ExtensionManager — loads unpacked Chrome extensions into the default
// session (MV2 + MV3 service-worker subset supported by Electron), tracks
// state, and supports install-from-zip (crx zip or plain zip of an ext dir).

const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');
const { execFileSync } = require('child_process');

class ExtensionManager {
  constructor(store) {
    this.store = store;
    this.dir = path.join(app.getPath('userData'), 'extensions');
    fs.mkdirSync(this.dir, { recursive: true });
    this.loaded = new Map(); // id -> extension record
  }
  async loadAll(ses) {
    const want = this.store.get('extensions.enabled', {});
    for (const d of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, d);
      if (!fs.statSync(full).isDirectory()) continue;
      const manifest = path.join(full, 'manifest.json');
      if (!fs.existsSync(manifest)) continue;
      if (want[d] === false) continue;
      try {
        const ext = await ses.loadExtension(full, { allowFileAccess: true });
        this.loaded.set(d, ext);
      } catch (e) { console.error('[ext] load', d, e.message); }
    }
    return this.list();
  }
  list() {
    const want = this.store.get('extensions.enabled', {});
    const out = [];
    for (const d of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, d);
      const mf = path.join(full, 'manifest.json');
      if (!fs.existsSync(mf)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
        const ext = this.loaded.get(d);
        out.push({
          id: ext ? ext.id : d, dir: d, name: m.name, version: m.version,
          manifestVersion: m.manifest_version, enabled: want[d] !== false,
          loaded: !!ext, description: m.description || ''
        });
      } catch (e) {}
    }
    return out;
  }
  async installZip(zipPath) {
    // unzip into extensions dir; expects a folder containing manifest.json
    const tmp = path.join(this.dir, '.tmp-' + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
      execFileSync('tar', ['-xf', zipPath, '-C', tmp]);
    } catch (e) {
      // fallback: powershell Expand-Archive
      execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`]);
    }
    let root = tmp;
    // find dir containing manifest.json (zip may wrap a top folder)
    const find = dir => {
      for (const e of fs.readdirSync(dir)) {
        const f = path.join(dir, e);
        if (e === 'manifest.json') return dir;
        if (fs.statSync(f).isDirectory()) { const r = find(f); if (r) return r; }
      }
      return null;
    };
    const found = find(tmp);
    if (!found) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('manifest.json not found in archive'); }
    const m = JSON.parse(fs.readFileSync(path.join(found, 'manifest.json'), 'utf8'));
    const dest = path.join(this.dir, (m.name || 'ext').replace(/[^\w\-. ]+/g, '_'));
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(found, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    return dest;
  }
  async setEnabled(ses, dir, on) {
    const want = this.store.get('extensions.enabled', {});
    want[dir] = on;
    this.store.set('extensions.enabled', want);
    if (on && !this.loaded.has(dir)) {
      const ext = await ses.loadExtension(path.join(this.dir, dir), { allowFileAccess: true });
      this.loaded.set(dir, ext);
    } else if (!on && this.loaded.has(dir)) {
      await ses.removeExtension(this.loaded.get(dir).id);
      this.loaded.delete(dir);
    }
  }
  async remove(ses, dir) {
    if (this.loaded.has(dir)) { await ses.removeExtension(this.loaded.get(dir).id); this.loaded.delete(dir); }
    fs.rmSync(path.join(this.dir, dir), { recursive: true, force: true });
    const want = this.store.get('extensions.enabled', {});
    delete want[dir]; this.store.set('extensions.enabled', want);
  }
}

module.exports = { ExtensionManager };
