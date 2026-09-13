# Wayfinder Public Release — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the app to Wayfinder, add an app-level demo mode (per-client rate limit + global upstream budget + banner), produce a public README with screenshots and an MIT license, publish a fresh public repo with two Railway services (personal + demo), and draft the two Reddit posts.

**Architecture:** `server.js` becomes a thin entry point over a new `lib/app.js` `createApp(options)` factory so demo behaviour is testable in-process with an injected `fetchImpl` and clock. A shared `fetchCached(url)` inside the factory is the only path to archive.org: cache → (demo global budget) → `iaFetch` → cache. Demo mode is a single env flag; without it the app behaves exactly as today. The public repo is a squashed export of the tree (no history), scrubbed by a grep gate before the first commit.

**Tech Stack:** Node ≥22.12, Express 4, `node:test`, vanilla JS/CSS, puppeteer-core (dev), Railway CLI 4.66, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-11-wayfinder-public-release-design.md` (binding; read first).

## Global Constraints

- No new runtime dependencies. No build step.
- Without `DEMO_MODE=1` nothing observable changes except the name, the User-Agent, the footer, and `/api/config`.
- Demo defaults: `DEMO_CLIENT_PER_MINUTE` = 30, `DEMO_GLOBAL_PER_MINUTE` = 120, cache TTL 30 min in demo / 10 min otherwise, `CACHE_TTL_MS` overrides both.
- Global budget is charged **only on cache misses**. `/api/config` is never rate-limited.
- Error copy, verbatim: 429 → `Slow down — the demo allows about 30 searches a minute.`; 503 → `The demo is busy right now — run your own copy: https://github.com/jwharasyn/wayfinder`.
- User-Agent: `wayfinder/1.0 (+https://github.com/jwharasyn/wayfinder)`. Repo URL constant: `https://github.com/jwharasyn/wayfinder`.
- `lib/snippets.js` stays the only HTML producer; no new `innerHTML` in `app.js`.
- Tests: `npm test` = `node --test 'test/**/*.test.js'`.
- Two hard stops that require John's explicit go: pushing the public repo (Task 6 Step 5) and posting to Reddit (John does it; Task 7 only drafts).
- Work on branch `feat/wayfinder-release` in `~/ia-search`. Commit after every task. Push nothing until Task 6.

## File map

| File | Responsibility |
|---|---|
| `lib/ratelimit.js` (new) | token buckets: `createBucket`, `createLimiter` |
| `lib/app.js` (new) | `createApp(options)`: cache, `fetchCached`, demo middleware, routes, static |
| `server.js` | entry point only: dns order + `createApp().listen` |
| `lib/ia.js` | User-Agent rename |
| `public/index.html`, `public/app.js`, `public/style.css` | rename, tagline, footer, demo banner, 429/503 copy |
| `scripts/screenshots.mjs` (new) | four README PNGs into `docs/screenshots/` |
| `README.md`, `LICENSE` (new) | public docs |
| `scripts/smoke.mjs` | `/api/config` check |
| `test/ratelimit.test.js`, `test/app.test.js` (new) | limiter + in-process demo behaviour |
| `~/wayfinder` (new repo) | squashed public export |
| `~/Desktop/wayfinder-reddit.md` | post drafts (outside the repo) |

---

### Task 1: `lib/ratelimit.js` — token buckets

**Files:**
- Create: `lib/ratelimit.js`, `test/ratelimit.test.js`

**Interfaces:**
- Produces: `createBucket({ capacity, refillPerMinute, now = Date.now }) → { take(n = 1): boolean }`; `createLimiter({ perClient: { capacity, refillPerMinute }, global: { capacity, refillPerMinute }, now = Date.now, maxClients = 5000 }) → { global: bucket, client(ip): bucket }`.

- [ ] **Step 1: Write the failing tests**

Create `test/ratelimit.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBucket, createLimiter } from '../lib/ratelimit.js';

function clock(start = 0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('bucket allows `capacity` takes then refuses', () => {
  const b = createBucket({ capacity: 3, refillPerMinute: 3, now: clock() });
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
});

test('bucket refills proportionally to elapsed time and never exceeds capacity', () => {
  const now = clock();
  const b = createBucket({ capacity: 3, refillPerMinute: 3, now });
  b.take(3);
  now.advance(20_000); // 1/3 minute at 3/min → exactly 1 token
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
  now.advance(600_000); // ten minutes → capped at 3, not 30
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false]);
});

test('take(n) is all-or-nothing', () => {
  const b = createBucket({ capacity: 2, refillPerMinute: 2, now: clock() });
  assert.equal(b.take(3), false, 'asking for more than available takes nothing');
  assert.equal(b.take(2), true);
});

test('limiter: per-client buckets are isolated; global is shared', () => {
  const l = createLimiter({ perClient: { capacity: 1, refillPerMinute: 1 }, global: { capacity: 1, refillPerMinute: 1 }, now: clock() });
  assert.equal(l.client('a').take(), true);
  assert.equal(l.client('a').take(), false);
  assert.equal(l.client('b').take(), true, 'b has its own bucket');
  assert.equal(l.global.take(), true);
  assert.equal(l.global.take(), false);
  assert.equal(l.client('a'), l.client('a'), 'same ip → same bucket object');
});

test('limiter: evicts the oldest client past maxClients', () => {
  const l = createLimiter({ perClient: { capacity: 1, refillPerMinute: 1 }, global: { capacity: 9, refillPerMinute: 9 }, now: clock(), maxClients: 2 });
  l.client('a').take();
  l.client('b');
  l.client('c'); // evicts a
  assert.equal(l.client('a').take(), true, 'a came back with a fresh bucket');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/ratelimit.test.js 2>&1 | grep -E "Cannot find|fail"`
Expected: `Cannot find module '.../lib/ratelimit.js'`.

- [ ] **Step 3: Implement `lib/ratelimit.js`**

```js
// Token buckets for demo mode. Refill is lazy (computed from elapsed time on
// each take) so there are no timers to leak. The clock is injectable for tests.
export function createBucket({ capacity, refillPerMinute, now = Date.now }) {
  let tokens = capacity;
  let last = now();
  return {
    take(n = 1) {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 60_000) * refillPerMinute);
      last = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
  };
}

// One shared `global` bucket plus a per-client bucket keyed by IP. The client
// map is bounded FIFO (oldest inserted evicted first), like lib/cache.js.
export function createLimiter({ perClient, global, now = Date.now, maxClients = 5000 }) {
  const clients = new Map();
  return {
    global: createBucket({ ...global, now }),
    client(ip) {
      let bucket = clients.get(ip);
      if (!bucket) {
        if (clients.size >= maxClients) clients.delete(clients.keys().next().value);
        bucket = createBucket({ ...perClient, now });
        clients.set(ip, bucket);
      }
      return bucket;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | tail -6`
Expected: `fail 0` (51 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/ratelimit.js test/ratelimit.test.js
git commit -m "feat: token-bucket rate limiter for demo mode"
```

---

### Task 2: `lib/app.js` factory with demo mode; `server.js` as entry point

**Files:**
- Create: `lib/app.js`, `test/app.test.js`
- Modify: `server.js` (whole file)

**Interfaces:**
- Consumes: `createLimiter` (Task 1); every `lib/*` route module unchanged.
- Produces: `createApp({ demo, cacheTtlMs, clientPerMinute, globalPerMinute, fetchImpl, now }) → express app`; `REPO_URL`; `GET /api/config → { demo, repo }`; 429/503 JSON errors in demo mode.

- [ ] **Step 1: Write the failing tests**

Create `test/app.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, REPO_URL } from '../lib/app.js';

const jsonResponse = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function withServer(app, fn) {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => srv.close(r)); }
}

test('/api/config reports the demo flag and repo url', async () => {
  await withServer(createApp({ demo: false }), async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), { demo: false, repo: REPO_URL });
  });
  await withServer(createApp({ demo: true }), async (base) => {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).demo, true);
  });
});

test('demo: per-client 429 after the client budget; config is exempt', async () => {
  const app = createApp({ demo: true, clientPerMinute: 2, globalPerMinute: 100, fetchImpl: jsonResponse([]) });
  await withServer(app, async (base) => {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${base}/api/web?q=x${i}`)).status);
    assert.deepEqual(codes, [200, 200, 429]);
    const body = await (await fetch(`${base}/api/web?q=x9`)).json();
    assert.equal(body.error, 'Slow down — the demo allows about 30 searches a minute.');
    assert.equal((await fetch(`${base}/api/config`)).status, 200);
  });
});

test('demo: global budget is charged only on cache misses → 503 with the self-host link', async () => {
  let upstream = 0;
  const fetchImpl = async () => { upstream++; return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const app = createApp({ demo: true, clientPerMinute: 100, globalPerMinute: 1, fetchImpl });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/web?q=same`)).status, 200);
    assert.equal((await fetch(`${base}/api/web?q=same`)).status, 200, 'cache hit costs no budget');
    const r = await fetch(`${base}/api/web?q=other`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, `The demo is busy right now — run your own copy: ${REPO_URL}`);
    assert.equal(upstream, 1, 'exactly one upstream fetch happened');
  });
});

test('non-demo: no limits; upstream failure → 502 with the upstream message', async () => {
  const app = createApp({ demo: false, fetchImpl: async () => new Response('nope', { status: 500 }) });
  await withServer(app, async (base) => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/api/web?q=x`);
      assert.equal(r.status, 502);
      assert.match((await r.json()).error, /upstream 500/);
    }
  });
});

test('missing q still fails fast without touching upstream', async () => {
  let upstream = 0;
  const app = createApp({ demo: true, fetchImpl: async () => { upstream++; return new Response('[]', { status: 200 }); } });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/items`)).status, 502);
    assert.equal(upstream, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/app.test.js 2>&1 | grep -E "Cannot find|fail"`
Expected: `Cannot find module '.../lib/app.js'`.

- [ ] **Step 3: Create `lib/app.js`**

```js
import path from 'node:path';
import express from 'express';
import { createCache } from './cache.js';
import { iaFetch } from './ia.js';
import { createLimiter } from './ratelimit.js';
import { buildSearchUrl, reshapeSearch } from './search.js';
import { buildFtsUrl, reshapeFts } from './fulltext.js';
import { insideUrl, reshapeInside } from './inside.js';
import { buildWebUrl, reshapeWeb } from './web.js';
import { reshapeItem } from './item.js';
import { relatedUrl, reshapeRelated } from './related.js';

export const REPO_URL = 'https://github.com/jwharasyn/wayfinder';
const SLOW_DOWN = 'Slow down — the demo allows about 30 searches a minute.';
const DEMO_BUSY = `The demo is busy right now — run your own copy: ${REPO_URL}`;

class DemoBusy extends Error {
  constructor() { super(DEMO_BUSY); this.status = 503; }
}

const envInt = (name, fallback) => Number(process.env[name]) || fallback;

// The whole HTTP app. Options exist so tests can run it in-process with a
// stub upstream and a fake clock; production reads everything from env.
export function createApp({
  demo = process.env.DEMO_MODE === '1',
  cacheTtlMs = envInt('CACHE_TTL_MS', demo ? 1_800_000 : 600_000),
  clientPerMinute = envInt('DEMO_CLIENT_PER_MINUTE', 30),
  globalPerMinute = envInt('DEMO_GLOBAL_PER_MINUTE', 120),
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const app = express();
  const cache = createCache({ ttlMs: cacheTtlMs });
  const limiter = demo
    ? createLimiter({
        perClient: { capacity: clientPerMinute, refillPerMinute: clientPerMinute },
        global: { capacity: globalPerMinute, refillPerMinute: globalPerMinute },
        now,
      })
    : null;

  // The only path to archive.org: cache → (demo global budget) → upstream → cache.
  // The budget is charged on misses only, so cached repeats are free in a spike.
  async function fetchCached(url) {
    const hit = cache.get(url);
    if (hit) return hit;
    if (limiter && !limiter.global.take()) throw new DemoBusy();
    const raw = await iaFetch(url, { fetchImpl });
    cache.set(url, raw);
    return raw;
  }

  // 502 for anything upstream-shaped; DemoBusy carries its own 503.
  const fail = (res, err) => res.status(err.status ?? 502).json({ error: String(err.message ?? err) });

  function proxyRoute(buildUrl, reshape) {
    return async (req, res) => {
      try {
        const raw = await fetchCached(buildUrl(req));
        res.json(await reshape(raw, req));
      } catch (err) {
        fail(res, err);
      }
    };
  }

  if (demo) {
    app.set('trust proxy', true); // Railway fronts the app; req.ip must be the real client
    app.use('/api', (req, res, next) => {
      if (req.path === '/config') return next();
      if (!limiter.client(req.ip).take()) return res.status(429).json({ error: SLOW_DOWN });
      next();
    });
  }

  app.get('/api/config', (req, res) => res.json({ demo, repo: REPO_URL }));

  app.get('/api/items', proxyRoute(
    (req) => {
      if (!req.query.q) throw new Error('missing q');
      return buildSearchUrl({
        q: req.query.q,
        page: Number(req.query.page) || 1,
        filters: {
          mediatype: String(req.query.mediatype || '').split(',').filter(Boolean),
          yearFrom: req.query.yearFrom || '',
          yearTo: req.query.yearTo || '',
          collection: req.query.collection || '',
          subject: req.query.subject || '',
        },
        aggregations: ['mediatype', 'year', 'collection'],
      });
    },
    (raw) => reshapeSearch(raw),
  ));

  app.get('/api/fulltext', proxyRoute(
    (req) => {
      if (!req.query.q) throw new Error('missing q');
      return buildFtsUrl({ q: req.query.q, page: Number(req.query.page) || 1 });
    },
    (raw) => reshapeFts(raw),
  ));

  app.get('/api/inside', async (req, res) => {
    try {
      const { id, q } = req.query;
      if (!id || !q) throw new Error('missing id or q');
      const meta = await fetchCached(`https://archive.org/metadata/${encodeURIComponent(id)}`);
      const url = insideUrl(meta, q);
      if (!url) return res.json({ matches: [] }); // item has no search-inside index
      res.json(reshapeInside(await fetchCached(url)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/web', proxyRoute(
    (req) => {
      if (!req.query.q) throw new Error('missing q');
      return buildWebUrl(req.query.q);
    },
    (raw) => reshapeWeb(raw),
  ));

  app.get('/api/related/:id', proxyRoute(
    (req) => relatedUrl(req.params.id),
    (raw) => reshapeRelated(raw),
  ));

  // Not proxyRoute: archive.org answers `{}` with HTTP 200 for an unknown identifier,
  // which must surface as a 404 rather than an item with null fields.
  app.get('/api/item/:id', async (req, res) => {
    try {
      const item = reshapeItem(await fetchCached(`https://archive.org/metadata/${encodeURIComponent(req.params.id)}`));
      if (!item.identifier) return res.status(404).json({ error: 'item not found' });
      res.json(item);
    } catch (err) {
      fail(res, err);
    }
  });

  // Anchored to this module, not process.cwd() — the server must work started from any directory.
  app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
  return app;
}
```

- [ ] **Step 4: Replace `server.js`**

```js
import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { createApp } from './lib/app.js';

const port = process.env.PORT || 3000;
createApp().listen(port, () => console.log(`wayfinder listening on :${port}`));
```

- [ ] **Step 5: Tests + live smoke in both modes**

```bash
npm test 2>&1 | tail -6
PORT=3123 node server.js & SRV=$!; sleep 1; node scripts/smoke.mjs http://localhost:3123; curl -s localhost:3123/api/config; echo; kill $SRV
DEMO_MODE=1 PORT=3123 node server.js & SRV=$!; sleep 1; node scripts/smoke.mjs http://localhost:3123; curl -s localhost:3123/api/config; echo; kill $SRV
```

Expected: `fail 0` (56 tests); smoke 7/7 PASS both times; config prints `{"demo":false,…}` then `{"demo":true,…}`.

- [ ] **Step 6: Commit**

```bash
git add lib/app.js test/app.test.js server.js
git commit -m "feat: app factory with demo mode (per-client limit, global upstream budget, /api/config)"
```

---

### Task 3: Rename to Wayfinder; banner, footer, 429/503 copy

**Files:**
- Modify: `package.json` (`name`), `lib/ia.js` (UA), `public/index.html`, `public/app.js`, `public/style.css`, `scripts/smoke.mjs`

**Interfaces:**
- Consumes: `GET /api/config` (Task 2); `err.status` on 429/503.

- [ ] **Step 1: Name + User-Agent**

`package.json`: `"name": "wayfinder"`.
`lib/ia.js` line 1: `const UA = 'wayfinder/1.0 (+https://github.com/jwharasyn/wayfinder)';`
`test/ia.test.js` line 13 pins the old UA; change it to:

```js
  assert.equal(seenHeaders['User-Agent'], 'wayfinder/1.0 (+https://github.com/jwharasyn/wayfinder)');
```

- [ ] **Step 2: `public/index.html`**

Replace lines 6 and 11 and add the banner and footer:

```html
  <title>Wayfinder</title>
```

```html
  <header>
    <div id="demo-banner" hidden>Live demo — rate-limited and shared. For real use, run your own copy: <a href="https://github.com/jwharasyn/wayfinder">github.com/jwharasyn/wayfinder</a></div>
    <h1>Wayfinder <span class="tagline">search the Internet Archive</span></h1>
```

After `</main>` add:

```html
  <footer>Not affiliated with the Internet Archive. · <a href="https://github.com/jwharasyn/wayfinder">Source</a></footer>
```

- [ ] **Step 3: `public/app.js`**

Replace `api()` with:

```js
async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status; // 429/503 carry demo-mode copy the UI shows verbatim
    throw err;
  }
  return body;
}
```

In `loadTab`'s catch, replace the `setStatus(name, \`archive.org didn't respond: …\`, true);` line with:

```js
    const demoLimited = err.status === 429 || err.status === 503;
    setStatus(name, demoLimited ? err.message : `archive.org didn't respond: ${err.message}`, true);
```

Append at the end of the file:

```js
// Demo deployments announce themselves; a failed config fetch just means no banner.
fetch('/api/config').then((r) => r.json()).then((c) => { if (c.demo) $('#demo-banner').hidden = false; }).catch(() => {});
```

- [ ] **Step 4: `public/style.css`**

Append:

```css
.tagline { font-size: 14px; font-weight: 400; color: var(--muted); margin-left: 8px; }
#demo-banner { background: #fff4e5; border: 1px solid #f0d9b5; border-radius: 8px; padding: 8px 12px; font-size: 14px; margin-bottom: 12px; }
footer { max-width: 860px; margin: 0 auto; padding: 24px 16px 40px; color: var(--muted); font-size: 13px; }
```

- [ ] **Step 5: Smoke gains config**

Append to `checks` in `scripts/smoke.mjs`:

```js
  ['/api/config', (d) => typeof d.demo === 'boolean' && d.repo === 'https://github.com/jwharasyn/wayfinder'],
```

- [ ] **Step 6: Verify**

```bash
grep -rn "ia-search" server.js lib public scripts package.json test; echo "(expect no output above)"
npm test 2>&1 | tail -6
PORT=3123 node server.js & SRV=$!; sleep 1; node scripts/smoke.mjs http://localhost:3123; kill $SRV
npm run verify
```

Then eyeball: `DEMO_MODE=1 DEMO_CLIENT_PER_MINUTE=3 PORT=3123 node server.js`, open http://localhost:3123 — banner visible, title reads "Wayfinder search the Internet Archive", footer present; search four times quickly → the fourth shows "Slow down — the demo allows about 30 searches a minute." with Retry. Without `DEMO_MODE`, no banner. Kill the server.

Expected: no `ia-search` hits; `fail 0`; smoke 8/8; verify ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json lib/ia.js public/index.html public/app.js public/style.css scripts/smoke.mjs test
git commit -m "feat: rename to Wayfinder; demo banner, footer, rate-limit copy"
```

---

### Task 4: `scripts/screenshots.mjs` and the four README PNGs

**Files:**
- Create: `scripts/screenshots.mjs`, `docs/screenshots/{items,expanded,fulltext,web}.png`
- Modify: `package.json` (script)

- [ ] **Step 1: Add the script entry**

`package.json` scripts: `"screenshots": "node scripts/screenshots.mjs"`.

- [ ] **Step 2: Write `scripts/screenshots.mjs`**

```js
// Captures the README screenshots against the real app + live archive.org.
// Requires Google Chrome.app. Output: docs/screenshots/*.png (1280×800 @2x).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const PORT = 3125;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const ITEMS = 'main .pane[data-pane="items"]';
const FULLTEXT = 'main .pane[data-pane="fulltext"]';
mkdirSync(OUT, { recursive: true });

const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));

let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(45_000);
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}${name}.png` });
    console.log(`wrote docs/screenshots/${name}.png`);
  };
  const search = async (q) => {
    await page.$eval('#q', (el) => { el.value = ''; });
    await page.type('#q', q);
    await page.click('#search-form button');
  };
  const imagesSettled = (scope) => page.waitForFunction((sel) => {
    const imgs = [...document.querySelectorAll(`${sel} .row img`)].slice(0, 5);
    return imgs.length > 0 && imgs.every((i) => i.complete);
  }, {}, scope);

  await page.goto(`http://localhost:${PORT}/`);

  // 1. Items with the texts facet selected.
  await search('apple II');
  await page.waitForSelector('.facet-row[data-facet="mediatype"] .chip');
  const texts = await page.$('.facet-row[data-facet="mediatype"] .chip[data-key="texts"]');
  await (texts ?? (await page.$('.facet-row[data-facet="mediatype"] .chip'))).click();
  await page.waitForSelector('#active .pill');
  await page.waitForSelector(`${ITEMS} .row`);
  await imagesSettled(ITEMS);
  await shot('items');

  // 2. First row expanded: chips, viewer, related.
  await page.click(`${ITEMS} .row`);
  await page.waitForSelector(`${ITEMS} .detail:not([hidden]) .chips-row`);
  await page.waitForFunction(() => {
    const r = document.querySelector('main .pane[data-pane="items"] .detail:not([hidden]) .related');
    return r && (r.querySelector('h4') || r.textContent.startsWith('No related'));
  });
  await page.$eval(`${ITEMS} .detail:not([hidden])`, (el) => el.scrollIntoView({ block: 'start' }));
  await shot('expanded');

  // 3. Full-text with per-page matches.
  await page.click('.tab[data-tab="fulltext"]');
  await search('fusion anomaly');
  await page.waitForSelector(`${FULLTEXT} .row`);
  await page.click(`${FULLTEXT} .row`);
  await page.waitForSelector(`${FULLTEXT} .detail:not([hidden]) .inside-match`);
  await page.$eval(`${FULLTEXT} .detail:not([hidden]) .inside-match`, (el) => el.scrollIntoView({ block: 'center' }));
  await shot('fulltext');

  // 4. Web tab.
  await page.click('.tab[data-tab="web"]');
  await search('fusionanomaly');
  await page.waitForSelector('main .pane[data-pane="web"] .row');
  await shot('web');
} finally {
  try { if (browser) await browser.close(); } finally { server.kill(); }
}
```

- [ ] **Step 3: Run it and look at the output**

```bash
npm run screenshots
ls -la docs/screenshots
```

Expected: four `wrote …` lines, four PNGs each roughly 150–600 KB. Open each (`open docs/screenshots/items.png` etc.) and confirm: items shows the strip with counts and a `✕ texts` pill; expanded shows chips, the viewer and a Related list; fulltext shows highlighted page matches; web shows site rows. If a capture is visually wrong (blank area, loading text), fix the wait in the script and rerun; do not commit a bad image.

- [ ] **Step 4: Commit**

```bash
git add scripts/screenshots.mjs package.json docs/screenshots
git commit -m "docs: README screenshots + capture script"
```

---

### Task 5: Public README and MIT license

**Files:**
- Modify: `README.md` (whole file)
- Create: `LICENSE`

- [ ] **Step 1: `LICENSE`**

Standard MIT text with `Copyright (c) 2026 John Harasyn`.

- [ ] **Step 2: Rewrite `README.md`**

```markdown
# Wayfinder

**Search the Internet Archive without fighting the site.** Full-text search
inside books and documents with page numbers, facet counts you can click,
direct download links, an inline viewer, and Wayback site search — one
query, three tabs.

*Not affiliated with the Internet Archive.*

![Items tab with facets](docs/screenshots/items.png)

## What it does

- **Items** — archive.org item search with Type / Year / Collection facet
  counts, an active-filter bar, and year-range inputs. Click a collection or
  subject chip in any expanded row to scope the search.
- **Full-text** — search *inside* the text of IA's books and documents;
  expand a hit to see matching snippets with page numbers.
- **Web** — Wayback Machine site-name matching with capture counts and
  first/last-seen years.
- **Expanded rows** — description, collection and subject chips, the
  embedded IA viewer (BookReader / player), direct download links for every
  file, and IA's own related items (which expand too).
- Keyboard-friendly rows, no accounts, no tracking, no build step.

![Expanded row](docs/screenshots/expanded.png)
![Full-text matches](docs/screenshots/fulltext.png)
![Web tab](docs/screenshots/web.png)

## Try it

Live demo: **DEMO_URL** — rate-limited and shared, so please self-host for
real use. If it says it's busy, that's the demo protecting archive.org.

## Run it

    npm install
    npm start          # http://localhost:3000, or $PORT

Needs Node 22.12 or newer. Nothing else: a single Express process that
proxies archive.org and serves `public/`.

## Deploy

One Node service. Set `PORT` if your platform doesn't. Optional env:

| Env | Default | Meaning |
|---|---|---|
| `DEMO_MODE=1` | off | public-demo mode: per-client rate limit, global upstream budget, banner |
| `DEMO_CLIENT_PER_MINUTE` | 30 | requests per client IP per minute (demo mode) |
| `DEMO_GLOBAL_PER_MINUTE` | 120 | archive.org fetches per minute for the whole instance (demo mode) |
| `CACHE_TTL_MS` | 600000 (1800000 in demo) | response cache lifetime |

It runs on Railway with the GitHub integration; `railway.json` skips
docs-only deploys.

## How it works

The server is a thin proxy with a 10-minute in-memory cache: it exists so
the browser never talks to undocumented endpoints directly, and so repeat
queries are instant. Every upstream call retries once, then fails with a
clean per-tab error.

| Route | Backs onto | Returns |
|---|---|---|
| `GET /api/items?q&page&mediatype=a,b&yearFrom&yearTo&collection&subject` | `page_production` metadata backend | `{ total, returned, items, facets }` |
| `GET /api/fulltext?q&page` | `page_production` fts backend | `{ total, returned, hits }` |
| `GET /api/inside?id&q` | `fulltext/inside.php` on the item's server | `{ matches }` with page numbers |
| `GET /api/web?q` | `web.archive.org/__wb/search/anchor` | `{ sites }` |
| `GET /api/item/:id` | `archive.org/metadata/:id` | item detail incl. `collection[]`, `subject[]`, `files[]` (404 unknown) |
| `GET /api/related/:id` | `be-api.us.archive.org/mds/v1/get_related` | `{ items }` (≤ 6) |
| `GET /api/config` | — | `{ demo, repo }` |

**Caveat:** `page_production`, the Wayback anchor search and `be-api` are
undocumented endpoints that archive.org's own site uses. They can change or
disappear without notice. Each lives in its own `lib/` module and only takes
down its own tab (related items only their own section). Facet counts are
approximate by design of the upstream.

Be a good citizen: the User-Agent identifies this project, the cache keeps
repeat traffic off archive.org, and demo mode caps what one instance can
send. Please keep it that way if you fork.

## Tests

    npm test                 # unit tests against recorded fixtures
    node scripts/smoke.mjs   # live checks against archive.org (server must be running)
    npm run verify           # headless Chrome click-through (needs Google Chrome.app)
    npm run screenshots      # regenerate docs/screenshots/*.png

## License

MIT — see `LICENSE`.
```

`DEMO_URL` is filled in by Task 6 Step 8 once the demo domain exists; leaving the literal token here until then is deliberate so Task 6's grep finds it.

- [ ] **Step 3: Verify and commit**

```bash
grep -c "ia-search\|Personal Internet Archive" README.md; echo "(expect 0)"
git add README.md LICENSE
git commit -m "docs: public README and MIT license"
```

---

### Task 6: Merge, export the public repo, publish, create Railway services

**Files:**
- `~/ia-search` (merge to main, push private), `~/wayfinder` (new), Railway project `wayfinder`.

Two hard stops in this task. Do not skip them.

- [ ] **Step 1: Merge the release branch and push the private repo**

```bash
cd ~/ia-search && git checkout main && git merge --ff-only feat/wayfinder-release && npm test 2>&1 | tail -3 && git push origin main && git branch -d feat/wayfinder-release
```

Expected: `fail 0`; push succeeds (the old `IA Search` Railway project redeploys with the rename; harmless).

- [ ] **Step 2: Export the tree (no history) and scrub**

```bash
rm -rf ~/wayfinder && mkdir ~/wayfinder && git -C ~/ia-search archive main | tar -x -C ~/wayfinder
cd ~/wayfinder
grep -rn "<session-URL, home-path, recorder-IP, personal-domain patterns>" . --exclude-dir=node_modules && { echo "SCRUB FAILED — stop"; exit 1; } || echo "scrub clean"
ls -a   # expect no .superpowers, no node_modules, no .git
```

If the scrub reports hits, remove the offending lines by hand, rerun the grep, and only continue on `scrub clean`.

- [ ] **Step 3: Initialise the public repo**

```bash
cd ~/wayfinder && git init -b main && npm install --silent && npm test 2>&1 | tail -3 && git add -A && git commit -q -m "Initial public release" && git log --oneline
```

Expected: `fail 0`; exactly one commit.

- [ ] **Step 4: HARD STOP — ask John**

Report: the scrub result, `git -C ~/wayfinder ls-files | wc -l`, and ask: "Ready to create public repo jwharasyn/wayfinder and push. Go?" Do nothing further until the answer is yes.

- [ ] **Step 5: Create and push the public repo**

```bash
cd ~/wayfinder && gh repo create jwharasyn/wayfinder --public --source=. --push --description "Search the Internet Archive: full-text with page numbers, facets, direct downloads, Wayback"
gh repo view jwharasyn/wayfinder --json url,visibility
```

- [ ] **Step 6: Railway project and services**

```bash
cd ~/wayfinder
railway init --name wayfinder --json
railway add --service wayfinder --repo jwharasyn/wayfinder --json
railway add --service wayfinder-demo --repo jwharasyn/wayfinder --variables DEMO_MODE=1 --json
railway domain --service wayfinder --json
railway domain --service wayfinder-demo --json
railway status
```

If `railway add --repo` fails with a permissions/not-found error, the Railway GitHub app lacks access to the new repo: report it and ask John to grant access (GitHub → Settings → Applications → Railway → Repository access), then rerun the two `add` commands.

- [ ] **Step 7: Wait for both deploys and smoke them**

```bash
for d in <wayfinder-domain> <demo-domain>; do
  for i in $(seq 1 40); do curl -s -m 15 "https://$d/api/config" | grep -q '"demo"' && break; sleep 15; done
  echo "== $d"; curl -s "https://$d/api/config"; echo; node ~/wayfinder/scripts/smoke.mjs "https://$d"
done
```

Expected: personal domain reports `"demo":false`, demo domain `"demo":true`; smoke 8/8 on both. Then hit the demo domain's `/api/web?q=x1` … `x35` in a loop and confirm a 429 appears (per-client limit works through Railway's proxy, proving `trust proxy` sees real client IPs — if every request 429s immediately or never does, report it).

- [ ] **Step 7b: Custom domain `ia-search.quest` on the demo service (Porkbun DNS)**

John registers `ia-search.quest` at Porkbun (never Network Solutions). Then:

```bash
cd ~/wayfinder && railway domain ia-search.quest --service wayfinder-demo
```

It prints the DNS record Railway wants. Apex on Porkbun: add an **ALIAS** record (host blank, answer = the `*.up.railway.app` target Railway printed, TTL 600) — Porkbun supports ALIAS at the apex; a plain CNAME at the apex is not allowed. If Railway instead prints a CNAME for `www` or a subdomain, add that CNAME. Remove any Porkbun parking/forwarding records on the apex first. Poll until it resolves and TLS is issued:

```bash
for i in $(seq 1 40); do curl -s -m 15 -o /dev/null -w "%{http_code}\n" https://ia-search.quest/api/config | grep -q 200 && break; sleep 30; done
curl -s https://ia-search.quest/api/config; echo
node ~/wayfinder/scripts/smoke.mjs https://ia-search.quest
```

Expected: `{"demo":true,…}` and smoke 8/8. Railway's certificate issuance can take a few minutes after DNS resolves; a 525/526 in that window is normal.

- [ ] **Step 8: Fill the demo URL and push**

```bash
cd ~/wayfinder && sed -i '' "s|DEMO_URL|https://ia-search.quest|" README.md && grep -n "Try it" -A3 README.md && git commit -qam "docs: demo link" && git push
```

Also apply the same README change to `~/ia-search` (`git commit -am "docs: demo link" && git push origin main`) so the two trees stay identical until John archives ia-search.

- [ ] **Step 9: Report for cutover (John's steps)**

List: both domains; the `IA Search` Railway project can be deleted; `jwharasyn/ia-search` can be archived on GitHub; `~/wayfinder` is now the working checkout. Record all of this in the project memory (`project_ia_search.md` → repo map and status).

---

### Task 7: Reddit drafts

**Files:**
- Create: `~/Desktop/wayfinder-reddit.md` (outside the repo)

- [ ] **Step 1: Write the file**

Replace `<demo>` with `ia-search.quest` (the custom demo domain from Task 6 Step 7b).

```markdown
# Wayfinder — Reddit drafts (John posts; do not post from an automation)

## r/DataHoarder

**Title:** I got tired of fighting archive.org's search, so I built a small front-end for it: full-text hits with page numbers, facets, direct downloads

**Body:**

First post here, and the first time I've shared code publicly, so go easy but be honest.

I use the Internet Archive a lot, and the search UI has been a constant low-grade pain: full-text results without page numbers, facets that reload the whole page, download links buried a few clicks down. I built Wayfinder to fix those things for myself. It's a small utility, not a platform. I've been using it daily for a while now and it's earned its keep, so I figured it was worth putting out there.

What it does:
- **Full-text search inside books and documents.** Expand a hit and you get the matching snippets with page numbers, plus the BookReader right there.
- **Facets that behave.** Type, Year and Collection counts you can click to filter and click again to clear. They collapse on a phone so the results stay on top.
- **Direct download links** for every file in an item, largest first, plus the embedded viewer or player.
- **Collection and subject chips** on every item to pivot the search.
- **Wayback site search** with capture counts and first/last-seen years, and IA's own related items inline.

Try it: https://<demo> (shared and rate-limited; if it says it's busy, that's it protecting archive.org)
Code: https://github.com/jwharasyn/wayfinder — MIT, one Node process, `npm install && npm start`, no build step, no accounts, no tracking. Self-hosting is the intended way to use it.

The honest part: it leans on three endpoints archive.org uses for its own site but doesn't document. Any of them could change. Each one lives in its own module, so if one breaks it takes out one tab, not the app. Facet counts are approximate because the upstream's are. Not affiliated with the Internet Archive.

It didn't take an enormous amount of effort, but I think it's good code and I'd like to know if you disagree. Screenshots in the README.

## r/SideProject

**Title:** Wayfinder: a small, no-build search UI for the Internet Archive I made for myself and decided to share

**Body:**

First time sharing code publicly. This is a small utility, built out of my own annoyance with archive.org's search, that turned out useful enough to put in front of other people.

The whole thing is one Express process that proxies archive.org with a short cache, and one vanilla JS file for the UI. No framework, no bundler. The part I enjoyed most was finding that the search service behind archive.org's own results page returns rows and facet counts in one call, and takes a filter map for scoping. That gave me real facets with no extra round-trips.

A few other things I'm quietly pleased with: rows expand inline and nested "related items" expand too without any event-bubbling mess; there's a demo mode with a token-bucket limiter so a traffic spike can't get the demo's IP throttled by archive.org; and a headless-Chrome script clicks through the whole app against the live site before anything gets pushed.

Demo: https://<demo> (shared and rate-limited) · Code: https://github.com/jwharasyn/wayfinder (MIT)

Caveats: it uses three undocumented upstream endpoints, each isolated to its own tab, and it's not affiliated with the Internet Archive. I'd genuinely like feedback on the code. I think it's solid, and this is the first time anyone outside my house has looked at it.

## FAQ to keep handy for comments

- **Why a proxy?** The endpoints don't send CORS headers, and a proxy gives one place for caching, retries and rate limiting.
- **Why does the demo say busy?** A global budget caps upstream fetches per minute so archive.org never sees a spike from one IP. Self-hosting has no such cap.
- **Will IA mind?** The User-Agent identifies the project with the repo URL, traffic is cached, and demo mode caps it. If IA asks for changes I'll make them.
- **Docker?** Not yet; it's `npm start` with `PORT`. PRs welcome.
```

- [ ] **Step 2: Report**

Tell John the file path, and that both drafts carry the demo and repo links, the caveats and the disclaimer. John posts.
