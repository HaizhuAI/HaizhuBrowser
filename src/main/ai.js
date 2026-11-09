'use strict';
// AIModule — built-in DuckDuckGo AI (duck.ai) chat plus user-imported
// OpenAI-compatible endpoints. The agent loop exposes browser-control tools:
// cookies read/write, network-capture query, DOM/JS execution, navigation,
// resource list — enabling capture analysis and page automation from chat.

const { net, session } = require('electron');
const https = require('https');

const DUCK_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', label: 'Llama 3.1 70B' },
  { id: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
  { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', label: 'Mixtral 8x7B' },
  { id: 'o3-mini', label: 'o3-mini' }
];

// Minimal https POST helper that returns full body (net.fetch already exists;
// use it for uniformity + proxy awareness via default session).
async function httpPost(url, headers, body) {
  const res = await net.fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return res;
}

class DuckAI {
  constructor() { this.vqd = null; this.xfe = null; }
  async handshake() {
    const res = await net.fetch('https://duckduckgo.com/duckchat/v1/status', {
      headers: {
        'accept': '*/*', 'cache-control': 'no-store', 'x-vqd-accept': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'referer': 'https://duckduckgo.com/'
      }
    });
    this.vqd = res.headers.get('x-vqd-4') || res.headers.get('x-vqd-hash-1');
    this.xfe = res.headers.get('x-fe-version');
    if (!this.vqd) throw new Error('duck.ai handshake failed (no vqd)');
  }
  async chat(messages, model, onDelta) {
    if (!this.vqd) await this.handshake();
    const body = {
      model: model || 'gpt-4o-mini',
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    };
    const attempt = async () => {
      const res = await net.fetch('https://duckduckgo.com/duckchat/v1/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'accept': 'text/event-stream',
          'x-vqd-4': this.vqd, 'cache-control': 'no-store',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'referer': 'https://duckduckgo.com/', 'origin': 'https://duckduckgo.com'
        },
        body: JSON.stringify(body)
      });
      const next = res.headers.get('x-vqd-4');
      if (next) this.vqd = next;
      return res;
    };
    let res = await attempt();
    if (res.status === 429 || res.status === 418) { this.vqd = null; await this.handshake(); res = await attempt(); }
    if (!res.ok) throw new Error('duck.ai HTTP ' + res.status);
    const text = await res.text();
    let full = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') break;
      try {
        const j = JSON.parse(d);
        if (j.message) { full += j.message; onDelta && onDelta(j.message); }
      } catch (e) {}
    }
    return full;
  }
}

class OpenAICompat {
  constructor(endpoint) {
    this.base = endpoint.base.replace(/\/+$/, '');
    this.key = endpoint.key;
    this.model = endpoint.model;
    this.name = endpoint.name || this.base;
  }
  async chat(messages, model, onDelta) {
    const res = await net.fetch(this.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + this.key },
      body: JSON.stringify({ model: model || this.model, messages, stream: false })
    });
    if (!res.ok) throw new Error(this.name + ' HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
    onDelta && onDelta(t);
    return t;
  }
  async models() {
    try {
      const r = await net.fetch(this.base + '/models', { headers: { 'authorization': 'Bearer ' + this.key } });
      const j = await r.json();
      return (j.data || []).map(m => m.id);
    } catch (e) { return [this.model]; }
  }
}

// ---------- agent tool definitions ----------
const TOOLS = [
  { name: 'navigate', desc: 'Open a URL in the current tab', params: { url: 'string' } },
  { name: 'new_tab', desc: 'Open URL in a new tab', params: { url: 'string', active: 'boolean?' } },
  { name: 'get_url', desc: 'Current tab URL and title', params: {} },
  { name: 'list_cookies', desc: 'List cookies for a URL/domain (name,value,domain,path,expires,httpOnly,secure)', params: { url: 'string' } },
  { name: 'set_cookie', desc: 'Set a cookie', params: { url: 'string', name: 'string', value: 'string', domain: 'string?', path: 'string?', secure: 'boolean?', httpOnly: 'boolean?' } },
  { name: 'delete_cookie', desc: 'Delete a cookie', params: { url: 'string', name: 'string' } },
  { name: 'network_log', desc: 'Recent captured requests for current tab (method,url,status,type,size,time). Requires capture ON.', params: { filter: 'string?' } },
  { name: 'request_body', desc: 'Response body of a captured request by id', params: { id: 'string' } },
  { name: 'start_capture', desc: 'Start packet capture on current tab', params: {} },
  { name: 'stop_capture', desc: 'Stop packet capture', params: {} },
  { name: 'resources', desc: 'Sniffed media resources (m3u8/mp4/...)', params: {} },
  { name: 'run_js', desc: 'Execute JavaScript in the page and return the result (automation: click, fill, extract...)', params: { code: 'string' } },
  { name: 'page_text', desc: 'Visible text of the page (truncated)', params: {} },
  { name: 'page_html', desc: 'Page HTML (truncated)', params: {} },
  { name: 'dom_query', desc: 'Query elements by CSS selector; returns tag/text/attrs', params: { selector: 'string', limit: 'number?' } },
  { name: 'click', desc: 'Click first element matching selector', params: { selector: 'string' } },
  { name: 'fill', desc: 'Set value of input matching selector', params: { selector: 'string', value: 'string' } },
  { name: 'wait', desc: 'Sleep ms', params: { ms: 'number' } },
  { name: 'screenshot', desc: 'Capture current tab screenshot (base64 png)', params: {} },
  { name: 'list_scripts', desc: 'Installed userscripts matching current URL', params: {} },
  { name: 'history', desc: 'Recent history entries', params: { limit: 'number?' } },
  { name: 'storage_get', desc: 'localStorage keys for current origin', params: {} }
];

const AGENT_SYSTEM = `You are Haizhu Agent, an AI operator embedded in a developer browser.
You can inspect and control the browser via tools. Reply with tool calls ONLY as JSON lines, one per line:
{"tool": "<name>", "args": {...}}
When you need no more tools, answer normally in the user's language.
Analyze cookies/network captures/DOM and automate pages when asked. Be terse and technical.`;

class AIModule {
  constructor(store, ctx) {
    this.store = store;
    this.ctx = ctx; // {getActiveTab, openTab, captures, sniffer, scripts, history}
    this.duck = new DuckAI();
  }
  get endpoints() { return this.store.get('ai.endpoints', []); }
  get activeId() { return this.store.get('ai.active', 'duck'); }
  providers() {
    const list = [{ id: 'duck', name: 'Duck.ai (built-in)', models: DUCK_MODELS }];
    for (const e of this.endpoints) list.push({ id: 'ep:' + e.id, name: e.name, models: null, model: e.model });
    return list;
  }
  addEndpoint(e) {
    e.id = 'e' + Date.now().toString(36);
    const list = this.endpoints; list.push(e);
    this.store.set('ai.endpoints', list);
    return e;
  }
  removeEndpoint(id) { this.store.set('ai.endpoints', this.endpoints.filter(e => e.id !== id)); }
  setActive(id) { this.store.set('ai.active', id); }

  async chat(messages, opts = {}, onDelta) {
    const id = opts.provider || this.activeId;
    if (id === 'duck') return this.duck.chat(messages, opts.model, onDelta);
    const eid = id.slice(3);
    const ep = this.endpoints.find(e => e.id === eid);
    if (!ep) throw new Error('endpoint not found');
    return new OpenAICompat(ep).chat(messages, opts.model || ep.model, onDelta);
  }

  async runTool(name, args, tab) {
    const c = this.ctx;
    const wc = tab && tab.view.webContents;
    switch (name) {
      case 'navigate': wc.loadURL(args.url); return 'navigated';
      case 'new_tab': c.openTab(args.url, args.active !== false); return 'opened';
      case 'get_url': return { url: wc.getURL(), title: wc.getTitle() };
      case 'list_cookies': return (await c.cookies(wc.session).list(args)) .slice(0, 300);
      case 'set_cookie': await c.cookies(wc.session).set(args); return 'ok';
      case 'delete_cookie': await c.cookies(wc.session).remove(args.url, args.name); return 'ok';
      case 'network_log': {
        const cap = c.captures.get(wc);
        let list = cap.list();
        if (args.filter) { const f = args.filter.toLowerCase(); list = list.filter(e => (e.url + e.type + e.method).toLowerCase().includes(f)); }
        return list.slice(-200).map(e => ({ id: e.id, m: e.method, url: e.url.slice(0, 300), status: e.status, type: e.type, size: e.encodedSize, time: Math.round(e.time) }));
      }
      case 'request_body': {
        const cap = c.captures.get(wc);
        const b = await cap.body(args.id);
        return b ? b.toString('utf8').slice(0, 20000) : '(no body)';
      }
      case 'start_capture': await c.captures.get(wc).start(); return 'capturing';
      case 'stop_capture': await c.captures.get(wc).stop(); return 'stopped';
      case 'resources': return c.sniffer.list(wc.id).slice(0, 100);
      case 'run_js': {
        const r = await wc.executeJavaScript(`(function(){ ${args.code} })()`, true);
        return r === undefined ? '(undefined)' : JSON.stringify(r).slice(0, 20000);
      }
      case 'page_text': return (await wc.executeJavaScript('document.body ? document.body.innerText.slice(0,15000) : ""', true)) || '';
      case 'page_html': return (await wc.executeJavaScript('document.documentElement ? document.documentElement.outerHTML.slice(0,20000) : ""', true)) || '';
      case 'dom_query': return await wc.executeJavaScript(`Array.from(document.querySelectorAll(${JSON.stringify(args.selector)})).slice(0,${args.limit || 20}).map(e=>({tag:e.tagName,text:(e.innerText||'').slice(0,120),href:e.href||null,id:e.id||null,cls:e.className||null}))`, true);
      case 'click': return await wc.executeJavaScript(`(function(){const e=document.querySelector(${JSON.stringify(args.selector)});if(!e)return 'not found';e.scrollIntoView({block:'center'});e.click();return 'clicked'})()`, true);
      case 'fill': return await wc.executeJavaScript(`(function(){const e=document.querySelector(${JSON.stringify(args.selector)});if(!e)return 'not found';e.value=${JSON.stringify(args.value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'filled'})()`, true);
      case 'wait': await new Promise(r => setTimeout(r, Math.min(args.ms || 1000, 10000))); return 'waited';
      case 'screenshot': { const img = await wc.capturePage(); return img.toDataURL().slice(0, 100) + '... [screenshot ' + img.getSize().width + 'x' + img.getSize().height + ']'; }
      case 'list_scripts': return c.scripts.matchesFor(wc.getURL(), true).map(s => s.meta.name + ' v' + s.meta.version);
      case 'history': return c.history(args.limit || 50);
      case 'storage_get': return await wc.executeJavaScript('Object.entries(localStorage).map(([k,v])=>({k,v:v.slice(0,200)}))', true);
      default: return 'unknown tool ' + name;
    }
  }

  toolSpec() {
    return TOOLS.map(t => `- ${t.name}(${Object.entries(t.params).map(([k, v]) => k + ':' + v.replace('?', '')).join(', ')}) — ${t.desc}`).join('\n');
  }

  // agent loop: iteratively let the model call tools
  async agent(userMsg, tab, onEvent, opts = {}) {
    const sys = AGENT_SYSTEM + '\n\nTOOLS:\n' + this.toolSpec();
    const messages = [{ role: 'system', content: sys }, { role: 'user', content: userMsg }];
    const toolRe = /\{"tool":\s*"([^"]+)",\s*"args":\s*(\{[^}]*\}|\{\})\}/g;
    const maxIter = 8;
    for (let i = 0; i < maxIter; i++) {
      let reply = '';
      try { reply = await this.chat(messages, opts, d => onEvent('delta', d)); }
      catch (e) { onEvent('error', e.message); return { error: e.message, messages }; }
      const calls = [];
      let m; toolRe.lastIndex = 0;
      while ((m = toolRe.exec(reply))) {
        try { calls.push({ name: m[1], args: JSON.parse(m[2]) }); } catch (e) {}
      }
      if (!calls.length) { onEvent('final', reply); return { answer: reply, messages }; }
      messages.push({ role: 'assistant', content: reply });
      const results = [];
      for (const c of calls) {
        onEvent('tool', c);
        let out;
        try { out = await this.runTool(c.name, c.args, tab); }
        catch (e) { out = 'tool error: ' + e.message; }
        results.push({ tool: c.name, result: typeof out === 'string' ? out.slice(0, 8000) : JSON.stringify(out).slice(0, 8000) });
        onEvent('tool_result', results[results.length - 1]);
      }
      messages.push({ role: 'user', content: 'TOOL RESULTS:\n' + results.map(r => r.tool + ' => ' + r.result).join('\n---\n') });
    }
    const last = await this.chat(messages, opts, d => onEvent('delta', d));
    onEvent('final', last);
    return { answer: last, messages };
  }
}

// cookie helper bound to a session
function cookieApi(ses) {
  return {
    list: async (f) => {
      const filter = {};
      if (f && f.url) filter.url = f.url;
      if (f && f.domain) filter.domain = f.domain;
      if (f && f.name) filter.name = f.name;
      const c = await ses.cookies.get(Object.keys(filter).length ? filter : {});
      return c;
    },
    set: (c) => ses.cookies.set({ url: c.url, name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, expirationDate: c.expirationDate }),
    remove: (url, name) => ses.cookies.remove(url, name)
  };
}

module.exports = { AIModule, cookieApi, DUCK_MODELS, OpenAICompat };
