// TempMail — disposable mailbox providers for dev/agent sign-up flows.
// Providers are plain-HTTP adapters; each returns normalized shapes:
//   account: { id, provider, address, password?, token?, type?, createdAt }
//   inbox item: { id, from, fromName, subject, date, isNew }
//   message: { id, subject, from, fromName, date, text, html }

const crypto = require('crypto');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' };

function randUser(len = 10) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(crypto.randomBytes(len)).map(b => abc[b % abc.length]).join('');
}

async function jreq(method, url, body, headers = {}) {
  const opt = { method, headers: { ...UA, Accept: 'application/json', ...headers } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let last;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, opt);
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
    if (r.ok) return j;
    last = new Error(`${r.status} ${url}`); last.body = j;
    if (r.status !== 429) throw last;
    await new Promise(res => setTimeout(res, 1200 * (i + 1))); // mail.tm rate-limits bursts
  }
  throw last;
}
const J = {
  get: (u, h) => jreq('GET', u, undefined, h),
  post: (u, b, h) => jreq('POST', u, b, h),
  del: (u, h) => jreq('DELETE', u, undefined, h)
};

// ---------------------------------------------------------------- emailnator
// Real @gmail.com / googlemail.com pool. Endpoints reverse-engineered from the
// site's Next.js bundle: POST /api/generate-email {ids:[type]}, POST
// /api/message-list {email,limit}, GET /api/message/{id}, POST
// /api/extend-email {email}, POST /api/delete-message/{id}. No auth required.
const EN_TYPES = { gmail: 8, domain: 1, plus: 2, dot: 3 }; // googleMail / domain / +Gmail / dotGmail
const emailnator = {
  id: 'emailnator', label: 'Emailnator (real Gmail)', kinds: Object.keys(EN_TYPES), defaultKind: 'gmail',
  async generate(a) {
    const ids = (a.kind || 'gmail').split(',').map(k => EN_TYPES[k.trim()]).filter(Boolean);
    const r = await J.post('https://www.emailnator.com/api/generate-email', { ids: ids.length ? ids : [8] });
    if (!r.email) throw new Error('emailnator: ' + JSON.stringify(r).slice(0, 200));
    return { address: r.email, type: r.email_type_id };
  },
  async inbox(acc) {
    const r = await J.post('https://www.emailnator.com/api/message-list', { email: acc.address, limit: 50 });
    const list = r.messages || r.mail_list || [];
    return list.map(m => ({
      id: String(m.messageID || m.id || m.mail_id || ''),
      from: m.from || m.from_mail || '', fromName: m.from_name || '',
      subject: m.subject || '', date: m.time || m.date || m.created_at || '',
      isNew: !!m.is_new
    }));
  },
  async read(acc, msgId) {
    const r = await J.get(`https://www.emailnator.com/api/message/${encodeURIComponent(msgId)}`);
    const m = r.message || r; // real shape: {id,from,subject,date:unix,content:html}
    const body = m.content || m.html || m.HTML || '';
    return {
      id: String(m.id || msgId), subject: m.subject || '', from: m.from || '', fromName: m.from_name || '',
      date: typeof m.date === 'number' ? new Date(m.date * 1000).toISOString() : (m.date || m.time || ''),
      text: m.text || m.body || stripHtml(body), html: body, attachments: m.attachments || []
    };
  },
  async deleteMessage(acc, msgId) { await jreq('POST', `https://www.emailnator.com/api/delete-message/${encodeURIComponent(msgId)}`, {}, {}); return true; },
  async extend(acc) { await J.post('https://www.emailnator.com/api/extend-email', { email: acc.address }); return true; }
};

// ---------------------------------------------------------------- mail.tm
// Official open REST API (hydra). Account + JWT, receive-only.
const mailtm = {
  id: 'mailtm', label: 'mail.tm', kinds: ['random'], defaultKind: 'random',
  _domain: null,
  async domain() {
    if (!this._domain) {
      const dom = await J.get('https://api.mail.tm/domains');
      const list = dom['hydra:member'] || (Array.isArray(dom) ? dom : []);
      this._domain = list.find(d => d.isActive)?.domain;
    }
    return this._domain;
  },
  async generate(a) {
    const domain = await this.domain();
    if (!domain) throw new Error('mail.tm: no active domain');
    const address = (a.username || randUser(12)) + '@' + domain;
    const password = 'hz-' + randUser(14);
    await J.post('https://api.mail.tm/accounts', { address, password });
    const t = await J.post('https://api.mail.tm/token', { address, password });
    if (!t.token) throw new Error('mail.tm: no token');
    return { address, password, token: t.token };
  },
  async inbox(acc) {
    const r = await J.get('https://api.mail.tm/messages?page=1', { Authorization: 'Bearer ' + acc.token });
    const list = r['hydra:member'] || (Array.isArray(r) ? r : []);
    return list.map(m => ({
      id: m.id, from: m.from?.address || '', fromName: m.from?.name || '',
      subject: m.subject || '', date: m.createdAt || '', isNew: !m.seen,
      intro: m.intro || ''
    }));
  },
  async read(acc, msgId) {
    const m = await J.get('https://api.mail.tm/messages/' + encodeURIComponent(msgId), { Authorization: 'Bearer ' + acc.token });
    return {
      id: m.id, subject: m.subject || '', from: m.from?.address || '', fromName: m.from?.name || '',
      date: m.createdAt || '', text: m.text || '', html: Array.isArray(m.html) ? m.html.join('\n') : (m.html || ''),
      attachments: (m.attachments || []).map(x => ({ filename: x.filename, url: x.downloadUrl, size: x.size }))
    };
  },
  async deleteMessage(acc, msgId) { await J.del('https://api.mail.tm/messages/' + encodeURIComponent(msgId), { Authorization: 'Bearer ' + acc.token }); return true; }
};

// ---------------------------------------------------------------- tempmail.plus
// Open JSON API, instant delivery inside its own domains, supports send+delete.
const TMP_DOMAINS = ['mailto.plus', 'fexbox.org', 'fexpost.com', 'fextemp.com', 'merepost.com', 'rover.info', 'any.pink', 'chitthi.in', 'inpwa.com', 'intopwa.com', 'tofimail.com', 'mailbox.in.ua'];
const tempmailplus = {
  id: 'tempmailplus', label: 'TempMail+ (instant)', kinds: TMP_DOMAINS, defaultKind: 'mailto.plus',
  async generate(a) {
    const dom = a.kind && TMP_DOMAINS.includes(a.kind) ? a.kind : TMP_DOMAINS[Math.floor(Math.random() * TMP_DOMAINS.length)];
    return { address: (a.username || randUser(12)) + '@' + dom, type: dom };
  },
  async inbox(acc) {
    const r = await J.get(`https://tempmail.plus/api/mails?email=${encodeURIComponent(acc.address)}&limit=50&epin=`);
    return (r.mail_list || []).map(m => ({
      id: String(m.mail_id), from: m.from_mail || '', fromName: m.from_name || '',
      subject: m.subject || '', date: m.time || '', isNew: !!m.is_new
    }));
  },
  async read(acc, msgId) {
    const m = await J.get(`https://tempmail.plus/api/mails/${encodeURIComponent(msgId)}?email=${encodeURIComponent(acc.address)}&epin=`);
    return {
      id: String(m.mail_id || msgId), subject: m.subject || '', from: m.from_mail || m.from || '',
      fromName: m.from_name || '', date: m.date || '', text: m.text || '', html: m.html || '',
      attachments: (m.attachments || []).map(x => ({ filename: x.name, url: 'https://tempmail.plus' + (x.download_url || ''), size: x.size }))
    };
  },
  async deleteMessage(acc, msgId) {
    await J.del(`https://tempmail.plus/api/mails/${encodeURIComponent(msgId)}?email=${encodeURIComponent(acc.address)}&epin=`); return true;
  }
};

const PROVIDERS = { emailnator, mailtm, tempmailplus };

// ---------------------------------------------------------------- helpers
function stripHtml(h) {
  return String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

// Extract verification codes + confirm links from a message body
function extractOtp(msg) {
  const text = msg.text || stripHtml(msg.html);
  const raw = (msg.text || '') + ' ' + (msg.html || '');
  let otp = null;
  const labeled = text.match(/(?:code|otp|passcode|verification|verify|pin|token|确认码|验证码|校验码)[^\d]{0,25}?(\d{4,8})/i)
    || text.match(/(\d{4,8})[^\d]{0,25}(?:code|verification|is your)/i);
  if (labeled) otp = labeled[1];
  if (!otp) { const m = text.match(/\b(\d{6})\b/) || text.match(/\b(\d{4,8})\b/); if (m) otp = m[1]; }
  const links = [...new Set((raw.match(/https?:\/\/[^\s"'<>)]+/g) || [])
    .filter(u => /verify|confirm|activate|token|valid|magic|signin|sign-in|login|auth|reset|approval|complete/i.test(u))
    .map(u => u.replace(/[.,;)>\]]+$/, '')))].slice(0, 10);
  return { otp, links, text: text.slice(0, 4000) };
}

class TempMail {
  constructor(store) {
    this.store = store;
    this.waiters = new Map(); // accountId -> interval handle
  }
  get accounts() { return this.store.get('tempmail.accounts', []); }
  save(list) { this.store.set('tempmail.accounts', list); }

  providerOf(acc) {
    const p = PROVIDERS[acc.provider];
    if (!p) throw new Error('unknown provider ' + acc.provider);
    return p;
  }
  find(ref) { // ref = account id or raw address
    const a = this.accounts.find(x => x.id === ref || x.address === ref);
    if (!a) throw new Error('no such account: ' + ref);
    return a;
  }
  providers() {
    return Object.values(PROVIDERS).map(p => ({ id: p.id, label: p.label, kinds: p.kinds.slice(0, 20), defaultKind: p.defaultKind }));
  }
  async generate(opts = {}) {
    const p = PROVIDERS[opts.provider || 'emailnator'];
    if (!p) throw new Error('unknown provider ' + opts.provider);
    const r = await p.generate(opts);
    const acc = {
      id: crypto.randomBytes(6).toString('hex'), provider: p.id, address: r.address,
      password: r.password || null, token: r.token || null, type: r.type || opts.kind || null,
      note: opts.note || '', createdAt: Date.now()
    };
    const l = this.accounts; l.unshift(acc); this.save(l);
    return acc;
  }
  remove(id) { this.save(this.accounts.filter(a => a.id !== id)); return true; }
  async inbox(ref) { const a = this.find(ref); return { account: a.address, messages: await this.providerOf(a).inbox(a) }; }
  async read(ref, msgId) { const a = this.find(ref); return { account: a.address, message: await this.providerOf(a).read(a, msgId) }; }
  async readExtract(ref, msgId) {
    const { message } = await this.read(ref, msgId);
    return { account: this.find(ref).address, message: { id: message.id, subject: message.subject, from: message.from, date: message.date }, ...extractOtp(message) };
  }
  async deleteMessage(ref, msgId) { const a = this.find(ref); return this.providerOf(a).deleteMessage(a, msgId); }
  async extend(ref) { const a = this.find(ref); const p = this.providerOf(a); return p.extend ? p.extend(a) : 'unsupported'; }
  async send(fromRef, to, subject, text) {
    const a = this.find(fromRef); const p = this.providerOf(a);
    if (p.id !== 'tempmailplus') throw new Error('send only supported for tempmailplus');
    const body = new URLSearchParams({ email: a.address, to, subject, content_type: 'text/plain', text });
    const r = await fetch('https://tempmail.plus/api/mails', { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    return r.json();
  }
  // Poll until a matching message lands; return it with OTP/links extracted.
  async waitForMail(ref, opts = {}) {
    const a = this.find(ref);
    const p = this.providerOf(a);
    const timeout = Math.min(opts.timeout || 120000, 300000);
    const pollMs = Math.max(opts.poll || 4000, 2000);
    const match = opts.match ? new RegExp(opts.match, 'i') : null;
    const since = opts.since || Date.now();
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeout) {
      try {
        const list = await p.inbox(a);
        const hit = list.find(m => (!match || match.test(m.subject + ' ' + m.from)) && (!opts.unseenOnly || m.isNew !== false));
        if (hit) {
          const message = await p.read(a, hit.id);
          return { account: a.address, waitedMs: Date.now() - t0, message: { id: message.id, subject: message.subject, from: message.from, date: message.date }, ...extractOtp(message) };
        }
      } catch (e) { lastErr = e.message; }
      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error('timeout waiting for mail' + (lastErr ? ' (last error: ' + lastErr + ')' : ''));
  }
}

module.exports = { TempMail, PROVIDERS, extractOtp };
