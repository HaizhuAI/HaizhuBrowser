'use strict';
// MCP server — exposes the browser as a Model Context Protocol server so
// external agents (Claude Desktop, Codex, Cursor, custom bots) can drive
// navigation, packet capture, cookie/DOM automation, sniffing and profiles.
//
// Transports:
//   POST /mcp   — Streamable-HTTP style JSON-RPC (single or batch messages)
//   GET  /mcp   — SSE listen stream (server-initiated notifications, keep-alive)
//   POST /rpc   — same handler; used by the bundled stdio bridge
//
// Auth: `Authorization: Bearer <token>` header or `?token=` query param.
// Bound to 127.0.0.1 only — never exposed on the network.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL_VERSION = '2025-06-18';

// Zero-dependency stdio bridge. Written to <userData>/mcp-stdio.js so MCP
// clients configured with `"command":"node"` can pipe straight into the
// running browser. Framing: newline-delimited JSON-RPC (MCP stdio spec).
const STDIO_BRIDGE = `'use strict';
// Haizhu Browser MCP stdio bridge — pipes stdin JSON-RPC into the running
// browser's HTTP endpoint. Env: HZ_MCP_PORT, HZ_MCP_TOKEN (required).
const http = require('http');
const port = parseInt(process.env.HZ_MCP_PORT || '8765', 10);
const token = process.env.HZ_MCP_TOKEN || '';
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  const body = Buffer.from(line, 'utf8');
  const req = http.request({
    host: '127.0.0.1', port, path: '/mcp', method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      'authorization': 'Bearer ' + token,
      'accept': 'application/json'
    }
  }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const out = Buffer.concat(chunks).toString('utf8').trim();
      if (out) process.stdout.write(out + '\\n');
    });
  });
  req.on('error', e => {
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) {}
    if (msg && msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        error: { code: -32000, message: 'haizhu browser unreachable: ' + e.message } }) + '\\n');
    }
  });
  req.end(body);
});
`;

// Tool catalogue. Per-tab tools are delegated to ai.runTool(); browser-level
// tools are implemented here against the shared ctx.
const SCHEMAS = [
  { name: 'list_tabs', desc: 'List open tabs (id,title,url,active,incognito,profile)', inputSchema: { type: 'object', properties: {} } },
  { name: 'new_tab', desc: 'Open a URL in a new tab', inputSchema: { type: 'object', properties: { url: { type: 'string' }, active: { type: 'boolean' }, incognito: { type: 'boolean' }, profileId: { type: 'string', description: 'launch inside this fingerprint profile/environment' } }, required: ['url'] } },
  { name: 'close_tab', desc: 'Close a tab by id (defaults to active tab)', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'activate_tab', desc: 'Bring a tab to front', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } }, required: ['tabId'] } },
  { name: 'navigate', desc: 'Navigate a tab to a URL (defaults to active tab)', inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId: { type: 'number' } }, required: ['url'] } },
  { name: 'get_url', desc: 'Current URL and title of a tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'page_text', desc: 'Visible text of the page (truncated)', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'page_html', desc: 'Page HTML (truncated)', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'dom_query', desc: 'Query elements by CSS selector → tag/text/attrs', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, limit: { type: 'number' }, tabId: { type: 'number' } }, required: ['selector'] } },
  { name: 'click', desc: 'Click first element matching CSS selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector'] } },
  { name: 'fill', desc: 'Set value of input matching CSS selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' }, tabId: { type: 'number' } }, required: ['selector', 'value'] } },
  { name: 'run_js', desc: 'Execute JavaScript in the page, return result (automation/extraction)', inputSchema: { type: 'object', properties: { code: { type: 'string' }, tabId: { type: 'number' } }, required: ['code'] } },
  { name: 'wait', desc: 'Sleep ms (max 10000)', inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } },
  { name: 'screenshot', desc: 'Capture tab screenshot → PNG image content', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'start_capture', desc: 'Start packet capture (CDP Network domain) on a tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'stop_capture', desc: 'Stop packet capture on a tab', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'network_log', desc: 'Captured requests for a tab (method,url,status,type,size,time). Requires capture ON.', inputSchema: { type: 'object', properties: { filter: { type: 'string' }, tabId: { type: 'number' } } } },
  { name: 'request_body', desc: 'Response body of a captured request by id', inputSchema: { type: 'object', properties: { id: { type: 'string' }, tabId: { type: 'number' } }, required: ['id'] } },
  { name: 'har_export', desc: 'Full HAR 1.2 document of captured traffic', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'resources', desc: 'Sniffed media resources on a tab (m3u8/mpd/mp4/flv/mp3...)', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'download_resource', desc: 'Download a sniffed resource / HLS stream to disk', inputSchema: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' } }, required: ['url'] } },
  { name: 'list_cookies', desc: 'Cookies of the tab session (or for a URL/domain)', inputSchema: { type: 'object', properties: { url: { type: 'string' }, domain: { type: 'string' }, tabId: { type: 'number' } } } },
  { name: 'set_cookie', desc: 'Set a cookie on the tab session (url defaults to current page)', inputSchema: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' }, domain: { type: 'string' }, path: { type: 'string' }, secure: { type: 'boolean' }, httpOnly: { type: 'boolean' }, tabId: { type: 'number' } }, required: ['name', 'value'] } },
  { name: 'delete_cookie', desc: 'Delete a cookie (url defaults to current page)', inputSchema: { type: 'object', properties: { url: { type: 'string' }, name: { type: 'string' }, tabId: { type: 'number' } }, required: ['name'] } },
  { name: 'storage_get', desc: 'localStorage keys for the current origin', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'list_profiles', desc: 'List fingerprint environments (isolated partitions + personas + bound proxies)', inputSchema: { type: 'object', properties: {} } },
  { name: 'launch_profile', desc: 'Open a tab inside a fingerprint environment', inputSchema: { type: 'object', properties: { profileId: { type: 'string' }, url: { type: 'string' } }, required: ['profileId'] } },
  { name: 'profile_persona', desc: 'Resolved fingerprint persona of an environment (GPU/UA-CH/timezone/...)', inputSchema: { type: 'object', properties: { profileId: { type: 'string' } }, required: ['profileId'] } },
  { name: 'proxy_list', desc: 'List proxy profiles and the active one', inputSchema: { type: 'object', properties: {} } },
  { name: 'proxy_set', desc: 'Activate a proxy profile by id ("direct" for none)', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'adblock_state', desc: 'Adblock state: enabled / rule count / blocked count', inputSchema: { type: 'object', properties: {} } },
  { name: 'adblock_toggle', desc: 'Enable or disable adblock', inputSchema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } },
  { name: 'list_scripts', desc: 'Installed userscripts matching the tab URL', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'bookmarks', desc: 'List bookmarks', inputSchema: { type: 'object', properties: {} } },
  { name: 'history', desc: 'Recent history entries', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'ai_chat', desc: 'Ask the built-in AI (Duck.ai or configured endpoint). messages=[{role,content}]', inputSchema: { type: 'object', properties: { messages: { type: 'array', items: { type: 'object' } }, provider: { type: 'string' }, model: { type: 'string' } }, required: ['messages'] } },
  { name: 'stealth_audit', desc: 'Anti-bot surface selftest — webdriver/chrome/plugins/UA-CH/permissions/WebGL etc → per-check pass/FAIL', inputSchema: { type: 'object', properties: { tabId: { type: 'number' } } } },
  { name: 'human_click', desc: 'Click at page coords with trusted human-like bezier trajectory + jitter timing', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, tabId: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'human_type', desc: 'Type text into the focused element with per-key human delays (trusted events)', inputSchema: { type: 'object', properties: { text: { type: 'string' }, tabId: { type: 'number' } }, required: ['text'] } },
  { name: 'solve_turnstile', desc: 'Best-effort Cloudflare Turnstile/managed-challenge pass — locates the challenge iframe, human-clicks the checkbox zone, polls for token/cf_clearance', inputSchema: { type: 'object', properties: { tabId: { type: 'number' }, timeout: { type: 'number' } } } }
];

class McpServer {
  constructor(store, ctx) {
    this.store = store;
    this.ctx = ctx; // {tabs, ai, captures, sniffer, m3u8, proxy, profiles, adblock, scripts, history, bookmarks, userData}
    this.server = null;
    this.sseClients = new Set();
    this.lastRequest = 0;
  }
  get enabled() { return !!this.store.get('mcp.enabled', false); }
  get port() { return parseInt(this.store.get('mcp.port', 8765), 10) || 8765; }
  get token() {
    let t = this.store.get('mcp.token');
    if (!t) { t = crypto.randomBytes(18).toString('hex'); this.store.set('mcp.token', t); }
    return t;
  }
  get running() { return !!this.server; }
  state() {
    return {
      enabled: this.enabled, running: this.running, port: this.port,
      token: this.token, url: 'http://127.0.0.1:' + this.port + '/mcp',
      lastRequest: this.lastRequest, lastError: this.lastError || null,
      tools: SCHEMAS.length
    };
  }
  clientConfig(bridgePath) {
    const tok = this.token, port = this.port;
    return {
      stdio: JSON.stringify({ mcpServers: { haizhu: {
        command: 'node', args: [bridgePath],
        env: { HZ_MCP_PORT: String(port), HZ_MCP_TOKEN: tok }
      } } }, null, 2),
      http: JSON.stringify({ mcpServers: { haizhu: {
        type: 'http', url: 'http://127.0.0.1:' + port + '/mcp',
        headers: { Authorization: 'Bearer ' + tok }
      } } }, null, 2)
    };
  }
  installBridge() {
    const p = path.join(this.ctx.userData, 'mcp-stdio.js');
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== STDIO_BRIDGE) fs.writeFileSync(p, STDIO_BRIDGE);
    return p;
  }

  applyConfig({ enabled, port }) {
    if (port !== undefined) { const p = parseInt(port, 10); if (p > 0 && p < 65536) this.store.set('mcp.port', p); }
    if (enabled !== undefined) this.store.set('mcp.enabled', !!enabled);
    this.enabled ? this.start() : this.stop();
    return this.state();
  }
  regenToken() { this.store.set('mcp.token', crypto.randomBytes(18).toString('hex')); return this.token; }

  start() {
    if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('error', e => { this.lastError = e.message; console.error('[mcp]', e.message); this.server = null; });
    this.server.listen(this.port, '127.0.0.1', () => console.log('[mcp] listening on 127.0.0.1:' + this.port));
  }
  stop() {
    if (!this.server) return;
    for (const s of this.sseClients) { try { s.end(); } catch (e) {} }
    this.sseClients.clear();
    this.server.close(); this.server = null;
  }

  authed(reqUrl, headers) {
    const u = new URL(reqUrl, 'http://x');
    const tok = u.searchParams.get('token');
    const auth = headers['authorization'] || '';
    return tok === this.token || auth === 'Bearer ' + this.token;
  }

  async handle(req, res) {
    const u = new URL(req.url, 'http://x');
    if (!this.authed(req.url, req.headers)) { res.writeHead(401).end('unauthorized'); return; }
    this.lastRequest = Date.now();
    if (req.method === 'GET' && (u.pathname === '/mcp' || u.pathname === '/')) {
      // SSE listen stream — kept open; nothing is pushed today but clients
      // that require the stream get a valid one instead of an error.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': haizhu-mcp\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST' || (u.pathname !== '/mcp' && u.pathname !== '/rpc' && u.pathname !== '/')) {
      res.writeHead(404).end('not found'); return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); return; }
      const isBatch = Array.isArray(msg);
      const list = isBatch ? msg : [msg];
      const replies = [];
      for (const m of list) {
        const r = await this.dispatch(m);
        if (r !== undefined) replies.push(r);
      }
      if (!replies.length) { res.writeHead(202).end(); return; } // notifications only
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL_VERSION });
      res.end(JSON.stringify(isBatch ? replies : replies[0]));
    });
  }

  async dispatch(m) {
    if (!m || typeof m !== 'object') return undefined;
    const id = m.id;
    const ok = result => id === undefined ? undefined : { jsonrpc: '2.0', id, result };
    const err = (code, message) => id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code, message } };
    switch (m.method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'haizhu-browser', title: 'Haizhu Browser 海柱浏览器', version: this.ctx.version || '0' },
          instructions: 'Drive Haizhu Browser: navigation, tabs, JS automation, DOM query/click/fill, packet capture + HAR, media sniffing/download, cookies, storage, history, fingerprint environments, proxies, adblock, userscripts, built-in AI. Optional tabId on page tools; defaults to the active tab.'
        });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: SCHEMAS.map(s => ({ name: s.name, description: s.desc, inputSchema: s.inputSchema })) });
      case 'resources/list': return ok({ resources: [] });
      case 'prompts/list': return ok({ prompts: [] });
      case 'tools/call': {
        const p = m.params || {};
        try {
          const r = await this.callTool(p.name, p.arguments || {});
          return ok(r);
        } catch (e) {
          return ok({ content: [{ type: 'text', text: 'error: ' + (e && e.message || String(e)) }], isError: true });
        }
      }
      default:
        if (m.method && m.method.startsWith('notifications/')) return undefined;
        return err(-32601, 'method not found: ' + m.method);
    }
  }

  tab(args) {
    const t = args && args.tabId !== undefined ? this.ctx.tabs.tabs.get(args.tabId) : this.ctx.tabs.active;
    if (!t) throw new Error('no such tab');
    return t;
  }

  async callTool(name, args) {
    const c = this.ctx;
    const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });
    const BROWSER = { // tools that need no tab
      list_tabs: () => c.tabs.list(),
      close_tab: () => { const id = args.tabId || c.tabs.activeId; if (!c.tabs.tabs.get(id)) throw new Error('no such tab'); c.tabs.closeTab(id); return 'closed'; },
      activate_tab: () => { if (!c.tabs.tabs.get(args.tabId)) throw new Error('no such tab'); c.tabs.activate(args.tabId); return 'activated'; },
      har_export: async () => c.captures.get(this.tab(args).wc).har(),
      download_resource: () => c.m3u8.download(args.url, args.name),
      list_profiles: () => c.profiles.profiles.map(p => ({
        id: p.id, name: p.name, os: p.os, seed: p.seed, color: p.color,
        proxy: (c.profiles.proxyById(p.proxyId) || {}).name || p.proxyId || 'direct',
        open: [...c.tabs.tabs.values()].some(t => t.profile && t.profile.id === p.id)
      })),
      launch_profile: (a) => { const t = c.tabs.openTab(a.url || 'about:blank', true, { profileId: a.profileId }); return { tabId: t.id }; },
      profile_persona: () => { const p = c.profiles.get(args.profileId); if (!p) throw new Error('profile not found'); return c.profiles.personaFor(p); },
      proxy_list: () => ({ profiles: c.proxy.profiles, active: c.proxy.activeId }),
      proxy_set: async () => { c.proxy.setActive(args.id === 'direct' ? 'direct' : args.id); await c.applyNetworkStack(); return { active: c.proxy.activeId }; },
      adblock_state: () => ({ enabled: c.adblock.enabled, rules: c.adblock.rules.length, blocked: c.adblock.blockedCount }),
      adblock_toggle: () => { c.adblock.setEnabled(!!args.on); return { enabled: c.adblock.enabled }; },
      bookmarks: () => c.bookmarks ? c.bookmarks() : [],
      history: () => c.history(args.limit || 50),
      ai_chat: async () => c.ai.chat(args.messages, { provider: args.provider, model: args.model })
    };
    if (BROWSER[name]) return text(await BROWSER[name](args));
    const tab = this.tab(args);
    if (name === 'new_tab') {
      const t = c.tabs.openTab(args.url, args.active !== false, { incognito: !!args.incognito, profileId: args.profileId });
      return text({ tabId: t.id, url: args.url });
    }
    if (name === 'navigate') { // search-engine normalization like the omnibox
      const t = this.tab(args);
      const u = c.tabs.normalizeUrl(args.url);
      t.wc.loadURL(u);
      return text('navigated ' + u);
    }
    if (name === 'stealth_audit') return text(await c.stealth.audit(tab));
    if (name === 'human_click') return text(await c.stealth.humanClick(tab.wc, args.x, args.y));
    if (name === 'human_type') return text(await c.stealth.humanType(tab.wc, args.text));
    if (name === 'solve_turnstile') return text(await c.stealth.solveTurnstile(tab, args.timeout || 15000));
    if (name === 'screenshot') {
      const img = await tab.wc.capturePage();
      return { content: [
        { type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: `screenshot ${img.getSize().width}x${img.getSize().height}` }
      ] };
    }
    // cookie ops: Electron needs a url — default to the tab's current URL
    if ((name === 'set_cookie' || name === 'delete_cookie') && !args.url) args.url = tab.wc.getURL();
    const out = await c.ai.runTool(name, args, tab);
    if (typeof out === 'string' && out.startsWith('unknown tool'))
      return { content: [{ type: 'text', text: out }], isError: true };
    return text(out === undefined ? 'ok' : out);
  }
}

module.exports = { McpServer, PROTOCOL_VERSION };
