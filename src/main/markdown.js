'use strict';
// Markdown extraction — obscura's LP.getMarkdown equivalent.
// Injected script walks the DOM once, emits GitHub-flavored markdown tuned
// for LLM consumption: headings, links, lists, code blocks, tables, quotes.
// Runs in the page context via executeJavaScript.

const EXTRACT_JS = `(function(){
  const DROP = 'script,style,noscript,template,svg,canvas,iframe,video,audio,select,textarea,button,input,[hidden],[aria-hidden="true"]';
  const DROP_LAYOUT = 'nav,footer,header,aside,[role="navigation"],[role="banner"],[role="complementary"],[class*="cookie"],[id*="cookie"],[class*="sidebar"],[id*="sidebar"],[class*="advert"],[class*="social"],[class*="share"],[class*="comment"],[id*="comment"]';
  function vis(el){
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }
  function esc(t){ return t.replace(/\\\\/g,'\\\\\\\\').replace(/\\[/g,'\\\\[').replace(/\\]/g,'\\\\]').replace(/\\*/g,'\\\\*'); }
  function inlineText(node){
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.textContent.replace(/\\s+/g,' '); continue; }
      if (n.nodeType !== 1 || n.matches(DROP) || !vis(n)) continue;
      const tag = n.tagName.toLowerCase();
      const inner = inlineText(n);
      if (tag === 'a') {
        const href = n.getAttribute('href') || '';
        let abs = '';
        try { abs = href && !href.startsWith('javascript:') ? new URL(href, location.href).href : ''; } catch (e) {}
        out += abs && inner.trim() ? '[' + inner.trim() + '](' + abs + ')' : inner;
      }
      else if (tag === 'img') { const alt = n.getAttribute('alt') || ''; const src = n.getAttribute('src') || ''; let u = ''; try { u = new URL(src, location.href).href; } catch (e) {} out += src && !src.startsWith('data:') && u ? '![' + alt + '](' + u + ')' : ''; }
      else if (tag === 'strong' || tag === 'b') out += '**' + inner + '**';
      else if (tag === 'em' || tag === 'i' || tag === 'u') out += '*' + inner + '*';
      else if (tag === 'code' || tag === 'kbd' || tag === 'samp') out += '\`' + inner.replace(/\`/g,'') + '\`';
      else if (tag === 'br') out += '  \\n';
      else if (tag === 'del' || tag === 's' || tag === 'strike') out += '~~' + inner + '~~';
      else out += inner;
    }
    return out;
  }
  function cellsText(el){ return inlineText(el).replace(/\\|/g,'\\\\|').replace(/\\n/g,' ').trim(); }
  function block(node, depth){
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 8) continue;
      if (n.nodeType === 3) { const t = n.textContent.replace(/\\s+/g,' ').trim(); if (t) out += esc(t) + ' '; continue; }
      if (n.nodeType !== 1 || n.matches(DROP + ',' + DROP_LAYOUT) || !vis(n)) continue;
      const tag = n.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const t = inlineText(n).trim(); if (t) out += '\\n\\n' + '#'.repeat(+tag[1]) + ' ' + t + '\\n\\n';
      }
      else if (tag === 'p') { const t = inlineText(n).trim(); if (t) out += '\\n\\n' + t + '\\n\\n'; }
      else if (tag === 'ul' || tag === 'ol') {
        let i = 0;
        for (const li of n.children) {
          if (li.tagName !== 'LI') continue; i++;
          const marker = tag === 'ol' ? i + '. ' : '- ';
          const t = block(li, depth + 1).trim().replace(/\\n+/g,'\\n' + '  '.repeat(depth + 1));
          if (t) out += '  '.repeat(depth) + marker + t + '\\n';
        }
        out += '\\n';
      }
      else if (tag === 'pre') { const t = n.textContent.replace(/\\n+$/,''); out += '\\n\\n\`\`\`\\n' + t + '\\n\`\`\`\\n\\n'; }
      else if (tag === 'blockquote') {
        const t = block(n, depth + 1).trim().split('\\n').map(l => '> ' + l).join('\\n');
        if (t.trim()) out += '\\n\\n' + t + '\\n\\n';
      }
      else if (tag === 'table') {
        const rows = [...n.querySelectorAll('tr')].map(r => [...r.children].filter(c => /^T[DH]$/.test(c.tagName)).map(cellsText));
        if (rows.length) {
          const w = Math.max(...rows.map(r => r.length));
          const norm = rows.map(r => '| ' + Array.from({length: w}, (_, i) => r[i] || '').join(' | ') + ' |');
          norm.splice(1, 0, '| ' + Array(w).fill('---').join(' | ') + ' |');
          out += '\\n\\n' + norm.join('\\n') + '\\n\\n';
        }
      }
      else if (tag === 'hr') out += '\\n\\n---\\n\\n';
      else if (tag === 'details') { const s = n.querySelector('summary'); if (s) out += '\\n\\n**' + inlineText(s).trim() + '**\\n'; out += block(n, depth); }
      else if (tag === 'dl') {
        const kids = [...n.children];
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].tagName === 'DT') out += '\\n**' + inlineText(kids[i]).trim() + '**\\n';
          else if (kids[i].tagName === 'DD') out += inlineText(kids[i]).trim() + '\\n';
        }
        out += '\\n';
      }
      else if (tag === 'figure') { out += block(n, depth); }
      else out += block(n, depth);
    }
    return out;
  }
  const root = document.querySelector('article,main,[role="main"],#content,.content,.post,.article,.entry-content,.markdown-body') || document.body;
  if (!root) return { title: document.title, url: location.href, markdown: '' };
  let md = block(root, 0);
  md = md.replace(/[ \\t]+\\n/g,'\\n').replace(/\\n{3,}/g,'\\n\\n').replace(/^\\s+|\\s+$/g,'');
  return { title: document.title, url: location.href, markdown: md, chars: md.length };
})()`;

async function toMarkdown(wc) {
  return wc.executeJavaScript(EXTRACT_JS, true);
}

module.exports = { toMarkdown, EXTRACT_JS };
