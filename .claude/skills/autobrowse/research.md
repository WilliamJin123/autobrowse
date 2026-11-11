# Research: read, search, Google, Perplexity

No explore session. Cheapest first.

```sh
autobrowse read <url> --max 4000     # a page as plain text: jina, then a plain fetch
autobrowse search <words…> -n 5      # exa, then brave, then duckduckgo: the first with a key
autobrowse doctor                    # which backends and tokens answer right now
```

`--via a,b` sets the backend order for one call. `--json` for machine use.

Google's own page: the AI Overview and its sources, every organic result, ads,
People also ask. A browser leg, paced like a person and capped per day. Run it
on the Mac; Google bot-checks the box.

```sh
autobrowse site call web GET "/google?q=<url-encoded>&n=10"   # gl=us, hl=en narrow it
```

Perplexity: an answer with citations. Its API with a key, else the signed-in
page (free plan, paced).

```sh
autobrowse site call perplexity POST /chat/completions \
  --body '{"messages":[{"role":"user","content":"…"}]}'
```

ChatGPT and Gemini: their pages, signed out, as browser legs. ChatGPT searches
the web and gives sources; Gemini (Flash-Lite) gives text only.

```sh
autobrowse site call chatgpt GET "/ask?q=<url-encoded>"   # search=false: no web search
autobrowse site call gemini GET "/ask?q=<url-encoded>"
```

Open sites: a host's own public API, no key, whole records. Each is a site:
`autobrowse site status <site>` lists its routes.

- Papers: `arxiv`, `openalex`, `pubmed`, `dblp`, `openreview`; facts: `wikipedia`, `wikidata`.
- Community: `stackoverflow`, `hackernews`, `lobsters`, `devto`, `bluesky`, `substack`, `medium`.
- News and markets: `bbc`, `bloomberg` (headlines), `reuters` (headlines by Google News), `yahoo-finance` (prices, tickers).
- Launches and jobs: `producthunt` (newest launches), `indeed`, `upwork` (search, one job).
- Papers by citation: `google-scholar` (search, author pages).
- Images and buying: `pinterest` (pin search, a user, a board's pins), `fb-public GET /marketplace` (first 15 listings near a city).
- Video words: `youtube GET /web/videos/<id>/transcript` (any public video).
- `indeed`, `upwork`, `google-scholar`, `pinterest` and the Marketplace read in a browser: paced, capped, slower.

```sh
autobrowse site call hackernews GET "/search?q=playwright&sort=date"
autobrowse site call stackoverflow GET "/questions/11227809"   # with answers and comments
```

Which one:

- Papers, a forum thread, a public profile: the open site, before `search` or `read`.

- A known URL: `read`.
- Many candidates: `search`, then `read` the few that matter.
- What Google itself shows (Overview, ads, rank): `/google`. Slow and capped;
  don't loop it.
- A synthesized answer with sources: Perplexity. Check its citations with `read`.
- A page behind a login, or blank without scripts: explore.md.

The same calls over HTTP or Restate: the `web` site, `GET /search?q=…`,
`GET /read?url=…`, `GET /google?q=…` (site-apis.md).
