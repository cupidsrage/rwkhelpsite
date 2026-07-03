# The Lore Keeper — Local RWK Oracle

Answers RWK questions by reasoning over a full local mirror of jimcav.com.
No dependencies — just Node 18+.

## Setup (one time)

1. Put your Anthropic API key in `config.json` ("anthropicApiKey"),
   or set the ANTHROPIC_API_KEY environment variable instead.
2. Build the local knowledge base (crawls jimcav.com politely, ~1 req/sec):

       node crawl.js

   This writes `data/pages.json` — the full text of every page on the site.
   Re-run it whenever you want to pick up site updates.

## Run

       node server.js

Open http://localhost:7777 and ask away.

## How it answers (two-stage)

1. **Router** (cheap Haiku call): Claude reads the full site map — every
   page title, URL, and preview — plus your question, and PICKS the pages
   that contain what you're really asking for. "Best mob for ash" routes
   to the ash yields table even though the page never says "mob" or "best".
2. **Answerer**: Claude gets the FULL TEXT of those pages (tables intact,
   up to retrieval.maxPagesPerQuestion pages / maxContextChars budget),
   plus BM25 keyword chunks from other pages as backup. It compares the
   numbers, does the math, and gives a direct recommendation, separating
   what the site states from what it deduced. Sources listed at the end,
   and the pages it consulted are shown under each answer.

Conversation history is kept (config: historyTurns), so follow-ups work.
If the router call ever fails, it falls back to BM25-only retrieval.

## Tuning (config.json)

- model — the answering model; routerModel — the page-picking model
  (Haiku default: fast/cheap, only needs to choose URLs)
- maxTokens — answer length cap
- retrieval.maxPagesPerQuestion — how many full pages per question
- retrieval.maxCharsPerPage / maxContextChars — context size budget
- retrieval.topK — backup BM25 chunks added alongside full pages
- retrieval.maxChunksPerPage — forces diversity across pages
- crawl.delayMs / maxPages — crawler politeness and safety cap

## Notes

- The mirror is for your personal use; jimcav.com content is copyrighted,
  so don't republish it. The app paraphrases and links back to the site.
- If an answer seems to miss something, check the chunk count at /status
  and consider raising topK, or use the site's own terms in your question
  (relic names, /commands) — BM25 is keyword based, so vocabulary helps.


## Free-for-you public mode (BYOK)

If you deploy WITHOUT setting ANTHROPIC_API_KEY, the site runs in
bring-your-own-key mode: each visitor clicks "API key" and pastes their
own Anthropic key, which is stored only in THEIR browser and used only
for THEIR questions. Your bill: $0. Their bill: fractions of a cent per
question (Haiku router + Sonnet answers).

You can also mix modes: set ANTHROPIC_API_KEY + ACCESS_PASSWORD so
trusted friends use your key with the password, while everyone else
supplies their own key (BYOK requests skip the password and rate limit
since they spend their own money).

Attribution: keep the header link to jimcav.com and the per-answer source
links intact — the oracle is a front-end that points people to his site,
and crediting it clearly is both right and what his terms are about.

## Deploying on Railway

1. Crawl locally first and COMMIT the mirror so the deploy doesn't
   depend on crawling at boot:

       node crawl.js
       git init && git add . && git commit -m "rwk oracle"

   (Make sure config.json has "anthropicApiKey": "sk-ant-REPLACE_ME" —
   never commit a real key. Alternatively set AUTO_CRAWL=1 on Railway
   and skip committing data/pages.json.)

2. Push to GitHub, then in Railway: New Project -> Deploy from GitHub repo.
   Railway auto-detects the Node app via package.json (npm start).

3. Set these Variables in the Railway service:

       ANTHROPIC_API_KEY = sk-ant-...        (required)
       ACCESS_PASSWORD   = something-secret  (STRONGLY recommended — this
                                              gates /ask so strangers can't
                                              spend your API credits)
       RATE_LIMIT        = 20                (optional, questions/10min/IP)
       AUTO_CRAWL        = 1                 (only if you didn't commit data/)

4. Railway assigns the port via the PORT env var automatically. Generate
   a domain under Settings -> Networking and you're live.

Updating the mirror later: re-run `node crawl.js` locally, commit the new
data/pages.json, push — Railway redeploys.

Note: keep the deployment private (password on). The mirror is jimcav.com's
copyrighted content for your personal use — don't turn it into a public
republication of the site.
