'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Store {
  constructor(name, defaults = {}) {
    this.file = path.join(app.getPath('userData'), 'config', name + '.json');
    this.defaults = defaults;
    this.data = this._load();
  }
  _load() {
    try {
      return Object.assign({}, this.defaults, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {
      return Object.assign({}, this.defaults);
    }
  }
  get(key, fallback) {
    if (key === undefined) return this.data;
    return key in this.data ? this.data[key] : (fallback !== undefined ? fallback : this.defaults[key]);
  }
  set(key, val) {
    this.data[key] = val;
    this._save();
    return val;
  }
  merge(obj) {
    Object.assign(this.data, obj);
    this._save();
  }
  unset(key) {
    delete this.data[key];
    this._save();
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) { console.error('[store] save fail', e); }
  }
}

module.exports = { Store };
