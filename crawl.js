// crawl.js — mirrors jimcav.com text into data/pages.json
// Usage: node crawl.js
// Zero dependencies (Node 18+). Polite: sequential requests with a delay.

const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const START = config.crawl.startUrl;
const HOSTS = new Set(config.crawl.allowedHosts);
const DELAY_MS = config.crawl.delayMs;
const MAX_PAGES = config.crawl.maxPages;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!HOSTS.has(u.hostname)) return null;
    u.hash = '';
    u.search = '';
    // skip binary assets
    if (/\.(jpe?g|png|gif|pdf|zip|ico|css|js|xls|xlsx|doc|docx|mp3|wav)$/i.test(u.pathname)) return null;
    // canonicalize host to bare domain so www/non-www dedupe
    u.hostname = 'www.jimcav.com';
    u.protocol = 'https:';
    return u.toString();
  } catch { return null; }
}

function extractLinks(html, baseUrl) {
  const links = [];
  // <a href>, plus <frame src>/<iframe src> (old framesets) and <area href> (image maps)
  const re = /<(?:a|area)\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))|<i?frame\b[^>]*src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[2] ?? m[3] ?? m[4] ?? m[6] ?? m[7] ?? m[8];
    const url = normalizeUrl(href, baseUrl);
    if (url) links.push(url);
  }
  return links;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', copy: '\u00a9' };
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function htmlToText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|head)\b[\s\S]*?<\/\1>/gi, ' ');
  // tables: keep cell separation readable
  s = s.replace(/<\/(td|th)>/gi, ' | ');
  s = s.replace(/<\/(tr|p|div|li|h[1-6]|br|table)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, '\n\n## ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function extractTitle(html, url) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return url;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (personal RWK study tool; respects robots)' },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/html') && !ct.includes('text/plain')) throw new Error(`skipped content-type ${ct}`);
  return await res.text();
}

(async () => {
  const seeds = [START, ...(config.crawl.seedUrls || [])]
    .map(u => normalizeUrl(u, START)).filter(Boolean);
  const queue = [...new Set(seeds)];
  const seen = new Set(queue);
  const pages = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    process.stdout.write(`[${pages.length + 1}] ${url} ... `);
    try {
      const html = await fetchPage(url);
      const text = htmlToText(html);
      const title = extractTitle(html, url);
      if (text.length > 100) {
        pages.push({ url, title, text });
        console.log(`ok (${text.length} chars)`);
      } else {
        console.log('skipped (too short)');
      }
      for (const link of extractLinks(html, url)) {
        if (!seen.has(link)) { seen.add(link); queue.push(link); }
      }
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  const outPath = path.join(__dirname, 'data', 'pages.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ crawledAt: new Date().toISOString(), pages }, null, 1));
  const totalChars = pages.reduce((a, p) => a + p.text.length, 0);
  console.log(`\nDone. ${pages.length} pages, ${(totalChars / 1000).toFixed(0)}k chars -> ${outPath}`);
  console.log('Now run: node server.js');
})();
