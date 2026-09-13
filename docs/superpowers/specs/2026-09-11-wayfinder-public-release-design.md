# Wayfinder — public release (rename, demo mode, public repo, Reddit)

**Date:** 2026-09-11
**Status:** Approved design, pre-implementation
**Builds on:** `2026-09-11-search-facets-related-design.md` (round 2, live on Railway)

## Purpose

Share the app on Reddit (r/DataHoarder, r/SideProject) as **Wayfinder** so
readers can both run it themselves and try a live demo, without the demo
traffic hurting John's own instance or archive.org.

## Decisions already made

- Name: **Wayfinder**, tagline "search the Internet Archive". "IA Search"
  survives only as descriptive wording.
- Public repo: **fresh `jwharasyn/wayfinder`** from a squashed snapshot of
  the current tree (one "initial public release" commit). The private
  `ia-search` repo is archived after cutover. No history rewrite.
- Demo: **second Railway service from the same repo with `DEMO_MODE=1`**.
  App-level per-client rate limit + global upstream budget + banner. No
  Cloudflare, no auth.
- Railway: John has CLI access; the agent creates a new Railway project
  `wayfinder` with two services (`wayfinder`, `wayfinder-demo`) from the
  new repo, generates domains, verifies both. The old `IA Search` project
  stays until John deletes it.
- Publishing moments that require John's explicit go: pushing the public
  repo (first time it is public) and posting to Reddit (John posts).
- Demo domain: **`ia-search.quest`** (registered at Porkbun; ALIAS at the apex
  to the Railway target). The personal instance stays on its Railway hostname.
- Out of scope: Docker/compose, animated GIF, Cloudflare, accounts/auth,
  r/selfhosted.
- Item descriptions (uploader HTML) are rendered via a DOMParser allowlist
  rebuild in `public/app.js` (`renderDescription`): the app's second deliberate
  markup consumer beside `lib/snippets.js`; `innerHTML` remains banned as a sink.

## 1. Rename

| Where | Now | Becomes |
|---|---|---|
| `package.json` `name` | `ia-search` | `wayfinder` |
| `public/index.html` `<title>` / `<h1>` | IA Search | `Wayfinder` + `<p class="tagline">search the Internet Archive</p>` |
| `server.js` listen log | `ia-search listening` | `wayfinder listening` |
| `lib/ia.js` `UA` | `ia-search/1.0 (personal tool)` | `wayfinder/1.0 (+https://github.com/jwharasyn/wayfinder)` |
| `scripts/*.mjs` comments, README | ia-search | wayfinder |
| Page footer (new) | — | `Not affiliated with the Internet Archive. · Source` (link to repo) |

The `archive.org` wording in status messages stays (it names the upstream,
not the app).

## 2. Demo mode

Enabled by env `DEMO_MODE=1`. Everything below is a no-op without it.

### `lib/ratelimit.js` (new)

```
createBucket({ capacity, refillPerMinute, now = Date.now }) → { take(n = 1) → boolean }
createLimiter({ perClient: { capacity, refillPerMinute }, global: { capacity, refillPerMinute }, now, maxClients = 5000 })
  → { client(ip) → bucket, global → bucket }
```

- Token buckets. `take()` refills lazily from elapsed time, returns `false`
  when empty. Per-client buckets live in a `Map` keyed by IP; when the map
  exceeds `maxClients`, the oldest-inserted entry is evicted (same FIFO
  discipline as `lib/cache.js`).
- Defaults (env-overridable, all integers):
  - `DEMO_CLIENT_PER_MINUTE` = 30 (capacity and refill)
  - `DEMO_GLOBAL_PER_MINUTE` = 120 upstream fetches (capacity and refill)

### Wiring in `server.js`

- `const demo = process.env.DEMO_MODE === '1'`.
- `if (demo) app.set('trust proxy', true)` — Railway terminates TLS and
  forwards; `req.ip` is then the real client.
- Middleware on `/api/*` (before the routes) when `demo`: if
  `!limiter.client(req.ip).take()` → `429 { error: 'Slow down — the demo allows about 30 searches a minute.' }`.
- Global budget is charged **only on cache misses**: `proxyRoute` and the
  two hand-rolled routes (`/api/inside`, `/api/item/:id`) call a shared
  `fetchCached(url)` helper (extracted in this round) which, in demo mode,
  does `if (!limiter.global.take()) throw new DemoBusy()` before `iaFetch`.
  `DemoBusy` maps to `503 { error: 'The demo is busy right now — run your own copy: https://github.com/jwharasyn/wayfinder' }`.
  Non-demo mode: `fetchCached` is cache → `iaFetch` → cache, exactly the
  current inline pattern.
- Cache TTL: `CACHE_TTL_MS` env if set; else 30 min in demo, 10 min otherwise.
- `GET /api/config` → `{ demo: boolean, repo: 'https://github.com/jwharasyn/wayfinder' }`. Not rate-limited.

### Frontend

- On load, `fetch('/api/config')`; if `demo`, unhide `<div id="demo-banner">`:
  "Live demo — rate-limited and shared. For real use, run your own copy: `<a>`".
- `api()` in `app.js` already throws `body.error`; `loadTab`'s catch changes
  to show the server's message verbatim when the HTTP status is 429 or 503
  (`err.status`), and keeps the current `archive.org didn't respond: …`
  wording for everything else. Retry button stays.

### Behaviour under a spike

Per-client limits stop one tab from hammering; the global budget keeps the
Railway IP under archive.org's throttle (observed: ~20 requests in a few
seconds from one IP → 429). Cached repeats (30-min TTL) cost nothing.
When the budget is exhausted users get a clear 503 with the self-host link,
not upstream 429s or blank tabs.

## 3. Public README (rewrite)

Sections in order: title + tagline + disclaimer line; hero screenshot; what
it does (Items with facets and filters, Full-text with page matches,
Wayback site search, inline viewer + direct downloads, related items);
**Try it** (demo URL, "rate-limited and shared; self-host for real use");
**Run it** (`npm install`, `npm start`, `PORT`); **Deploy** (one Node ≥22.12
service, `PORT`, optional `DEMO_MODE=1` + the two limit envs +
`CACHE_TTL_MS`); **How it works** (proxy + cache, routes table, the
undocumented-endpoint caveat: page_production, `__wb/search/anchor`,
be-api; each isolated per tab); **Tests** (`npm test`, smoke, verify,
screenshots); **Not affiliated with the Internet Archive**; **License** MIT.

Remove the personal-tool framing, `docs/superpowers` mentions and the
"fixtures recorded on" line.

## 4. Screenshots

`scripts/screenshots.mjs` (puppeteer-core, same spawn/launch/finally shape
as `scripts/verify.mjs`, port 3125, viewport 1280×800, `deviceScaleFactor: 2`),
`npm run screenshots` → `docs/screenshots/{items,expanded,fulltext,web}.png`:

1. `items.png` — query `apple II`, Type `texts` selected (pill + strip visible).
2. `expanded.png` — first row expanded, scrolled so chips, viewer and the
   Related list are in frame.
3. `fulltext.png` — Full-text tab, query `fusion anomaly`, first row expanded
   with page matches.
4. `web.png` — Web tab, query `fusionanomaly`.

Committed PNGs (about 200–400 KB each). README embeds all four.

## 5. Fresh public repo + Railway

1. Export: `git archive HEAD` of the release branch (after all code work
   merged to `main`) into `~/wayfinder`, excluding `.superpowers/`.
   `docs/superpowers/` is included **after a scrub pass** that removes
   session URLs, local home paths, the recorder IP, and `session_context`.
   The scrub is a gate: any hit stops the export.
2. `git init`, single commit `Initial public release`, MIT `LICENSE`
   (copyright John Harasyn).
3. **Ask John**, then `gh repo create jwharasyn/wayfinder --public` and push.
4. Railway (CLI): `railway init --name wayfinder`; `railway add --service wayfinder --repo jwharasyn/wayfinder`;
   `railway add --service wayfinder-demo --repo jwharasyn/wayfinder --variables DEMO_MODE=1`;
   `railway domain` for each; wait for deploys; run `scripts/smoke.mjs`
   against both domains and confirm `/api/config` reports `demo` correctly
   on each. Caveat to verify first: the Railway GitHub app must have access
   to the new repo (if `railway add --repo` fails, John grants access in
   GitHub → Settings → Applications → Railway).
5. README demo link = the `wayfinder-demo` domain.
6. Cutover left to John: delete the `IA Search` Railway project, archive
   `jwharasyn/ia-search`, update bookmarks. `~/ia-search` local checkout is
   replaced by `~/wayfinder` as the working repo (memory updated).

## 6. Reddit drafts

`~/Desktop/wayfinder-reddit.md` (not in the repo), two posts:

- **r/DataHoarder** — title around "I built a faster front-end for
  searching the Internet Archive: full-text search inside books with page
  numbers, facets, direct download links". Body: the three tabs, what the
  official site makes painful, demo + repo links, honest caveats (undocumented
  endpoints, rate-limited demo, may break), disclaimer, "happy to answer
  questions".
- **r/SideProject** — title around "Wayfinder: a vanilla-JS, no-build search
  UI for the Internet Archive". Body: the build story (Express proxy with a
  10-minute cache, three undocumented backends isolated per tab, how the
  facets endpoint was found), demo + repo, screenshots, caveats, disclaimer.
- Both end with a short FAQ (Why a proxy? Why does the demo say busy? Will
  IA mind?) and the note that John is the one posting.

## 7. Testing

- `test/ratelimit.test.js`: bucket takes `capacity` then refuses; refills by
  elapsed time using an injected clock; per-client buckets are isolated;
  `maxClients` eviction; global budget consumed only on cache misses
  (test `fetchCached` with a stub `fetchImpl` and a pre-warmed cache).
- `test/server-demo.test.js`: spin the Express app in-process with
  `DEMO_MODE=1` and small limits, assert 429 after N requests from one
  IP, 503 once the global budget is spent (stub `iaFetch`), `/api/config`
  shape in both modes. (Server needs a small refactor so `app` is exported
  and `listen` only runs when `server.js` is the entry point.)
- Smoke: add `/api/config`. Verify: unchanged. Screenshots: run once.
- Manual: both Railway domains smoke-clean; demo banner visible on the demo
  domain only.

## Rulings to carry

- Limit defaults are guesses anchored on today's throttle observation;
  tune from the demo's logs after the post, not before.
- The recorder IP stays in the private repo's history; it never reaches
  the public repo because the export has no history.
