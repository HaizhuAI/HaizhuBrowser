'use strict';
// i18n — locale resolution + dictionary loading for all UI surfaces.
// Active locale: settings.lang ('system' => app.getLocale() best-match).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SUPPORTED = ['en', 'zh-CN', 'zh-TW', 'ja'];
const dicts = {};

function load(lang) {
  if (dicts[lang]) return dicts[lang];
  try {
    dicts[lang] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n', lang + '.json'), 'utf8'));
  } catch (e) { dicts[lang] = lang === 'en' ? {} : load('en'); }
  return dicts[lang];
}

function resolveLocale(raw) {
  const l = String(raw || '').toLowerCase();
  if (l.startsWith('zh')) {
    return /tw|hk|mo|hant/.test(l) ? 'zh-TW' : 'zh-CN';
  }
  if (l.startsWith('ja')) return 'ja';
  return 'en';
}

class I18n {
  constructor(store) {
    this.store = store;
    this.lang = this.resolve();
    this.dict = Object.assign({}, load('en'), load(this.lang));
  }
  resolve() {
    const pref = this.store.get('lang', 'system');
    return pref === 'system' ? resolveLocale(app.getLocale()) : pref;
  }
  reload() {
    this.lang = this.resolve();
    this.dict = Object.assign({}, load('en'), load(this.lang));
    return this.lang;
  }
  t(key, vars) {
    let s = this.dict[key] || load('en')[key] || key;
    if (vars) for (const k in vars) s = s.replace('{' + k + '}', vars[k]);
    return s;
  }
  payload() { return { lang: this.lang, supported: SUPPORTED, strings: this.dict }; }
}

module.exports = { I18n, SUPPORTED };
