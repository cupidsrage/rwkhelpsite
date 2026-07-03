// server.js — local RWK oracle, two-stage agentic retrieval
// Stage 1: Claude reads the site map + your question and PICKS which pages it needs.
// Stage 2: Claude answers from the FULL TEXT of those pages (tables intact),
//          with BM25 keyword chunks added as a backup layer.
// Usage: node server.js   (then open http://localhost:7777)
// Zero dependencies (Node 18+).

const fs = require('fs');
const path = require('path');
const http = require('http');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const SERVER_API_KEY = (process.env.ANTHROPIC_API_KEY || config.anthropicApiKey || '').trim();
const HAS_SERVER_KEY = SERVER_API_KEY && !SERVER_API_KEY.startsWith('sk-ant-REPLACE');
const PORT = process.env.PORT || config.port;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || config.accessPassword || '';
if (!HAS_SERVER_KEY) {
  console.log('No server API key set — running in BYOK-only mode (users must provide their own key).');
}

const dataPath = path.join(__dirname, 'data', 'pages.json');
if (!fs.existsSync(dataPath)) {
  if (process.env.AUTO_CRAWL === '1') {
    console.log('No knowledge base found — AUTO_CRAWL=1, crawling jimcav.com now (takes a few minutes)...');
    require('child_process').execFileSync('node', [path.join(__dirname, 'crawl.js')], { stdio: 'inherit' });
  } else {
    console.error('No knowledge base found. Run: node crawl.js (or set AUTO_CRAWL=1)');
    process.exit(1);
  }
}
const { pages, crawledAt } = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const pageByUrl = new Map(pages.map(p => [p.url, p]));

// ---------- site map (what the router stage sees) ----------
const siteMap = pages.map(p => {
  const preview = p.text.slice(0, 400).replace(/\s+/g, ' ').trim();
  return `URL: ${p.url}\nTITLE: ${p.title}\nPREVIEW: ${preview}`;
}).join('\n\n');
const compactMap = pages.map(p => `- ${p.title}: ${p.url}`).join('\n');

// ---------- BM25 backup index ----------
const CHUNK_SIZE = 1600, CHUNK_OVERLAP = 250;
function chunkPage(page) {
  const chunks = [];
  for (let i = 0; i < page.text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
    const body = page.text.slice(i, i + CHUNK_SIZE);
    if (body.trim().length < 80) continue;
    chunks.push({ url: page.url, title: page.title, body });
    if (i + CHUNK_SIZE >= page.text.length) break;
  }
  return chunks;
}
const allChunks = pages.flatMap(chunkPage);

const STOP = new Set('a an and are as at be but by for from has have how i if in is it its of on or that the this to was what when where which who why will with you your'.split(' '));
const tokenize = s => s.toLowerCase().replace(/[^a-z0-9/']+/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t));

const df = new Map();
const docTokens = allChunks.map(c => {
  const toks = tokenize(c.title + ' ' + c.body);
  for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  return toks;
});
const N = allChunks.length;
const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / Math.max(N, 1);
const K1 = 1.4, B = 0.75;

function bm25Retrieve(question, topK, excludeUrls) {
  const scores = new Float64Array(N);
  for (const q of new Set(tokenize(question))) {
    const dfq = df.get(q);
    if (!dfq) continue;
    const idf = Math.log(1 + (N - dfq + 0.5) / (dfq + 0.5));
    for (let d = 0; d < N; d++) {
      let tf = 0;
      const toks = docTokens[d];
      for (let i = 0; i < toks.length; i++) if (toks[i] === q) tf++;
      if (!tf) continue;
      scores[d] += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * toks.length / avgLen));
    }
  }
  const ranked = [...scores.keys()].sort((a, b) => scores[b] - scores[a]);
  const picked = [], perPage = new Map();
  for (const idx of ranked) {
    if (scores[idx] <= 0) break;
    const c = allChunks[idx];
    if (excludeUrls.has(c.url)) continue;
    const count = perPage.get(c.url) || 0;
    if (count >= config.retrieval.maxChunksPerPage) continue;
    perPage.set(c.url, count + 1);
    picked.push(c);
    if (picked.length >= topK) break;
  }
  return picked;
}

// ---------- Anthropic API ----------
async function callClaude(apiKey, model, maxTokens, system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// ---------- Stage 1: page selection (the "reasoning about what you want" step) ----------
const ROUTER_SYSTEM = `You are a retrieval router for a Q&A system over Jimcav's RWK Help Site (a Race War Kingdoms fan guide). Given a player's question and the site map below, decide which pages most likely contain the facts needed to answer — including pages needed for indirect/deductive answers (e.g. a "best X for Y" question needs the data table page for Y plus any mechanics pages that affect the comparison).

Think about what the player is really asking, translated into game mechanics. "Best mob for ash" — ash comes from destroying drops (1 drop = 1 ash), so it needs the drop rates page (kills per drop by critter) plus the ash page. "Is it worth X" needs the numbers behind X. Prefer data/table pages (drop rates, ash yields, crafting tables, stat boosts) whenever the question implies comparison, optimization, or "best/fastest/most".

Respond with ONLY a JSON array of page URLs from the site map, most important first, maximum ${'{MAX}'} entries. No other text, no markdown fences.

SITE MAP:
`;

function parseUrlArray(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) return arr.filter(u => typeof u === 'string');
  } catch {}
  // fallback: scrape URLs out of whatever came back
  return [...cleaned.matchAll(/https?:\/\/[^\s"',\]]+/g)].map(m => m[0].replace(/[.,)>]+$/, ''));
}

async function selectPages(apiKey, question, history) {
  const recentContext = history.slice(-4).map(m => `${m.role}: ${m.content.slice(0, 300)}`).join('\n');
  const system = ROUTER_SYSTEM.replace('{MAX}', String(config.retrieval.maxPagesPerQuestion)) + siteMap;
  const user = (recentContext ? `Recent conversation (for context):\n${recentContext}\n\n` : '') + `Question: ${question}`;
  const raw = await callClaude(apiKey, config.routerModel, 400, system, [{ role: 'user', content: user }]);
  const urls = parseUrlArray(raw)
    .map(u => u.replace(/^http:/, 'https:').replace('://jimcav.com', '://www.jimcav.com'))
    .filter(u => pageByUrl.has(u));
  return [...new Set(urls)].slice(0, config.retrieval.maxPagesPerQuestion);
}

// ---------- Stage 2: answer from full pages ----------
const ANSWER_SYSTEM = `You are the Lore Keeper, an expert oracle for the browser game Race War Kingdoms (RWK). Your ONLY knowledge source is Jimcav's RWK Help Site (jimcav.com); the relevant pages are provided in full in each message, plus backup excerpts.

How to answer:
1. Ground every answer in the provided material. Never use outside knowledge about RWK.
2. ANSWER THE REAL QUESTION. If the player asks for the "best" or "most efficient" option, find the relevant data (tables included), compare the numbers, and give a direct recommendation with the figures that justify it. Do the arithmetic. Deduce freely from stated facts and show the short chain of reasoning. Translate the player's terms into game mechanics first (e.g. if ash comes from destroying drops, "best mob for ash" means "highest drop-rate mob" — answer THAT).
3. IF THE NEEDED FACTS ARE MISSING from the provided material but another page in the site map below likely has them, DO NOT apologize or give a partial answer. Instead reply with ONLY this, nothing else:
MORE_PAGES: <url1>, <url2>
You will then be re-asked with those pages included. Only if no site-map page could plausibly hold the data should you say the site doesn't cover it.
4. Distinguish what the site states directly from what you deduced.
5. Paraphrase in your own words; individual data values (numbers, names, yields) may be used freely, but do not reproduce prose passages. Any direct quote must be under 15 words, at most one per answer.
6. Format game commands like /skills in backticks and bold item/NPC names. End with "Sources:" listing the page URLs you actually used.
7. A light old-keeper flavor is welcome in a phrase, but clarity, correctness and directness come first. Lead with the answer.

SITE MAP (for MORE_PAGES requests):
${compactMap}`;

async function answer(apiKey, question, history, fullPages, backupChunks) {
  const pageBlocks = fullPages.map(p =>
    `<page title="${p.title}" url="${p.url}">\n${p.body}\n</page>`).join('\n\n');
  const chunkBlocks = backupChunks.map((c, i) =>
    `<excerpt index="${i + 1}" page="${c.title}" url="${c.url}">\n${c.body}\n</excerpt>`).join('\n\n');
  const content =
    `<full_pages>\n${pageBlocks || '(none selected)'}\n</full_pages>\n\n` +
    `<backup_excerpts>\n${chunkBlocks || '(none)'}\n</backup_excerpts>\n\n` +
    `Question: ${question}`;
  const messages = [...history, { role: 'user', content }];
  return callClaude(apiKey, config.model, config.maxTokens, ANSWER_SYSTEM, messages);
}

function budgetPages(urls) {
  const out = [];
  let total = 0;
  for (const url of urls) {
    const p = pageByUrl.get(url);
    if (!p) continue;
    let body = p.text;
    if (body.length > config.retrieval.maxCharsPerPage) body = body.slice(0, config.retrieval.maxCharsPerPage) + '\n[...page truncated...]';
    if (total + body.length > config.retrieval.maxContextChars) break;
    total += body.length;
    out.push({ url: p.url, title: p.title, body });
  }
  return out;
}

// ---------- HTTP server ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

// simple per-IP rate limit (sliding window)
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 20); // questions per 10 min per IP
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    return;
  }
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pages: pages.length, chunks: allChunks.length, crawledAt, model: config.model, routerModel: config.routerModel }));
    return;
  }
  if (req.method === 'POST' && req.url === '/ask') {
    try {
      // BYOK: a user-supplied Anthropic key takes priority and costs the host nothing
      const userKey = (req.headers['x-user-api-key'] || '').trim();
      const usingByok = userKey.startsWith('sk-ant-');
      const apiKey = usingByok ? userKey : (HAS_SERVER_KEY ? SERVER_API_KEY : null);
      if (!apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_key', message: 'This oracle runs on your own Anthropic API key. Click "API key" below to add one.' }));
        return;
      }
      // password + rate limit only protect the HOST's key; BYOK users spend their own
      if (!usingByok) {
        if (ACCESS_PASSWORD && req.headers['x-access-key'] !== ACCESS_PASSWORD) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
        if (rateLimited(ip)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'rate limit reached — wait a few minutes' }));
          return;
        }
      }
      const { question, history = [] } = JSON.parse(await readBody(req));
      if (!question || typeof question !== 'string') throw new Error('missing question');
      const trimmedHistory = history.slice(-config.historyTurns * 2);

      // Stage 1: Claude picks pages from the site map
      let selectedUrls = [];
      try { selectedUrls = await selectPages(apiKey, question, trimmedHistory); }
      catch (e) { console.error('router failed, falling back to BM25 only:', e.message); }
      const fullPages = budgetPages(selectedUrls);

      // Backup: BM25 chunks from pages NOT already included in full
      const included = new Set(fullPages.map(p => p.url));
      const backup = bm25Retrieve(question, config.retrieval.topK, included);

      console.log(`Q: ${question}`);
      console.log(`  pages: ${fullPages.map(p => p.title).join(' | ') || '(none)'} + ${backup.length} backup chunks`);

      let text = await answer(apiKey, question, trimmedHistory, fullPages, backup);

      // Self-correction: the answerer can request missing pages once
      const moreMatch = text.match(/^\s*MORE_PAGES:\s*(.+)$/im);
      if (moreMatch) {
        const extraUrls = moreMatch[1].split(/[,\s]+/)
          .map(u => u.trim().replace(/^http:/, 'https:').replace('://jimcav.com', '://www.jimcav.com'))
          .filter(u => pageByUrl.has(u));
        console.log(`  answerer requested: ${extraUrls.join(', ') || '(none valid)'}`);
        const combined = [...new Set([...extraUrls, ...fullPages.map(p => p.url)])];
        const retryPages = budgetPages(combined);
        fullPages.length = 0; fullPages.push(...retryPages);
        const included2 = new Set(retryPages.map(p => p.url));
        const backup2 = bm25Retrieve(question, config.retrieval.topK, included2);
        text = await answer(apiKey, question, trimmedHistory, retryPages, backup2);
        // if it STILL asks for pages, fall through with a plain miss message
        if (/^\s*MORE_PAGES:/im.test(text)) {
          text = "The archives I gathered don't contain the data needed for this one, even after a second look. Try `node kb.js find <term>` to check whether the page is in your mirror — if it's missing, re-run `node crawl.js`.";
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        answer: text,
        consulted: fullPages.map(p => ({ title: p.title, url: p.url }))
      }));
    } catch (err) {
      console.error('ask error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  console.log(`Lore Keeper knowledge base: ${pages.length} pages / ${allChunks.length} chunks (crawled ${crawledAt})`);
  console.log(`Router: ${config.routerModel}  Answerer: ${config.model}`);
  console.log(`Password gate: ${ACCESS_PASSWORD ? 'ON' : 'OFF (set ACCESS_PASSWORD for public deploys!)'}  Rate limit: ${RATE_LIMIT}/10min/IP`);
  console.log(`Listening on port ${PORT}`);
});
