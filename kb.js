// kb.js — inspect the local mirror
// Usage:
//   node kb.js list                 list all crawled pages
//   node kb.js find <term>          search page text for a term, show hits
//   node kb.js show <url-or-part>   print the extracted text of a page

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data', 'pages.json');
if (!fs.existsSync(dataPath)) { console.error('No knowledge base. Run: node crawl.js'); process.exit(1); }
const { pages, crawledAt } = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(' ');

if (cmd === 'list' || !cmd) {
  console.log(`${pages.length} pages (crawled ${crawledAt})\n`);
  for (const p of pages) console.log(`${String(p.text.length).padStart(7)}  ${p.title}  ->  ${p.url}`);
} else if (cmd === 'find') {
  if (!arg) { console.error('usage: node kb.js find <term>'); process.exit(1); }
  const needle = arg.toLowerCase();
  let hits = 0;
  for (const p of pages) {
    const lower = p.text.toLowerCase();
    let idx = lower.indexOf(needle);
    if (idx === -1) continue;
    console.log(`\n=== ${p.title} (${p.url}) ===`);
    let shown = 0;
    while (idx !== -1 && shown < 3) {
      const ctx = p.text.slice(Math.max(0, idx - 80), idx + needle.length + 120).replace(/\n/g, ' ');
      console.log('  ...' + ctx + '...');
      idx = lower.indexOf(needle, idx + 1);
      shown++; hits++;
    }
  }
  if (!hits) console.log(`No hits for "${arg}" — that content may not be in the mirror. Re-run: node crawl.js`);
} else if (cmd === 'show') {
  if (!arg) { console.error('usage: node kb.js show <url-or-part>'); process.exit(1); }
  const p = pages.find(p => p.url === arg) || pages.find(p => p.url.includes(arg) || p.title.toLowerCase().includes(arg.toLowerCase()));
  if (!p) { console.error('page not found'); process.exit(1); }
  console.log(`=== ${p.title} (${p.url}) ===\n`);
  console.log(p.text);
} else {
  console.error('commands: list | find <term> | show <url-or-part>');
}
