# Facets, Scoped Filters, Related Items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Items tab to the `page_production` metadata backend so one call returns rows plus facet counts, add an active-filter bar with clickable Type/Year/Collection facets and collection/subject chips, and show IA related items inside an expanded row.

**Architecture:** A new `lib/search.js` owns the `page_production` URL (both backends) and the reshape of rows + facets; `lib/fulltext.js` delegates to it and drops its title round-trip; `lib/related.js` wraps the be-api host. `server.js` keeps the existing cache → `iaFetch` (one retry) → reshape → 502 pattern. The frontend (`public/app.js`, vanilla, no build) gains a `state.filters` object; every filter change resets the Items tab and reloads it under the existing generation guard.

**Tech Stack:** Node 22+ (local dev is Node 24), Express 4, `node:test`, vanilla JS/CSS. Dev-only: `puppeteer-core` driving `/Applications/Google Chrome.app` for headless verification.

**Spec:** `docs/superpowers/specs/2026-09-11-search-facets-related-design.md` (read it first; the "Verified API facts" section is the ground truth for every URL and shape below).

## Global Constraints

- No new runtime dependencies. `puppeteer-core` is `devDependencies` only.
- No build step; `public/` is served as-is.
- Every upstream call goes through `cache.get/set` + `iaFetch` exactly as today. Upstream failure → HTTP 502 `{ error }`.
- `filter_map` key order is fixed: mediatype → year → collection → subject; mediatype values sorted. The URL is the cache key.
- Year: `from === to` → `{ "<y>": "inc" }`; otherwise `gte`/`lte`.
- Facet caps: year top-12-by-count rendered ascending; collection 20. Counts display with a leading `~`.
- `user_query` is required upstream; never send an empty query.
- `lib/snippets.js` stays the only HTML producer; no new `innerHTML` sinks in `app.js`.
- Tests: `npm test` runs `node --test 'test/**/*.test.js'` (glob form — `node --test <dir>` breaks on Node 24). Fixtures are recorded live with `session_context` and `request` stripped (they contain the recording client's IP).
- Work on branch `feat/facets-related`. Commit after every task. Do not push.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## File map

| File | Responsibility |
|---|---|
| `lib/search.js` (new) | `page_production` URL builder (metadata + fts), `filter_map` serialisation, row + facet reshape |
| `lib/fulltext.js` | FTS reshape only; URL via `search.js` |
| `lib/related.js` (new) | be-api related-items URL + reshape |
| `lib/item.js` | adds `collection[]`, `subject[]`; skips `Thumbnail` format |
| `lib/items.js` | **deleted** (with `test/items.test.js`, `test/fixtures/advancedsearch.json`) |
| `server.js` | `/api/items` rewritten, `/api/fulltext` single call, `/api/related/:id` new |
| `public/index.html` | active-filter bar + facet strip replace the mediatype select |
| `public/app.js` | `state.filters`, facet/pill rendering, chips + related in detail, keyboard rows, `returned`-based Load More |
| `public/style.css` | pills, chips, facet rows |
| `scripts/smoke.mjs` | new params + `/api/related` |
| `scripts/verify.mjs` (new) | headless Chrome click-through |
| `README.md`, v1 spec | route table + risk statement |

---

### Task 1: `lib/search.js` — URL builder, filter map, row/facet reshape

**Files:**
- Create: `lib/search.js`
- Create: `test/search.test.js`
- Create: `test/fixtures/pp-metadata.json`, `test/fixtures/pp-metadata-filtered.json`

**Interfaces:**
- Produces:
  - `HITS_PER_PAGE = 20`
  - `buildFilterMap(filters) → object | null` — `filters = { mediatype?: string[], yearFrom?: string|number, yearTo?: string|number, collection?: string, subject?: string }`
  - `buildSearchUrl({ q, page = 1, hitsPerPage = 20, backend = 'metadata' | 'fts', filters = {}, aggregations = [], aggregationsSize = 20 }) → string`
  - `reshapeSearch(json) → { total: number, returned: number, items: Item[], facets: Facets | null }` where `Item = { identifier, title, mediatype, year, downloads, description, collection: string[], subject: string[] }` and `Facets = { mediatype: Bucket[], year: Bucket[], collection: Bucket[] }`, `Bucket = { key, count }`
  - `reshapeFacets(aggs) → Facets | null`
  - `asArray(v) → any[]`, `asString(v) → string | null`

- [ ] **Step 1: Record the two fixtures (live)**

```bash
cd ~/ia-search
UA="ia-search/1.0 (personal tool)"
B="https://archive.org/services/search/beta/page_production/?user_query=apple%20II&page_type=search_results&hits_per_page=3&page=1&aggregations=mediatype,year,collection&aggregations_size=20"
strip() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);delete j.session_context;delete j.request;delete j.caching;process.stdout.write(JSON.stringify(j,null,1))})'; }
curl -s -A "$UA" "$B" | strip > test/fixtures/pp-metadata.json
sleep 2
curl -s -A "$UA" "$B&filter_map=%7B%22mediatype%22%3A%7B%22texts%22%3A%22inc%22%7D%2C%22year%22%3A%7B%221983%22%3A%22gte%22%2C%221985%22%3A%22lte%22%7D%7D" | strip > test/fixtures/pp-metadata-filtered.json
node -e 'for (const f of ["pp-metadata","pp-metadata-filtered"]) { const j=require("./test/fixtures/"+f+".json"); const b=j.response.body; console.log(f, "total", b.hits.total, "returned", b.hits.returned, "aggs", Object.keys(b.aggregations)); }'
```

Expected: both print `returned 3` and `aggs [ 'year', 'date_histogram', 'year_histogram', 'collection', 'mediatype' ]` (order may vary). If either prints an `errors` shape instead, wait 30 s and rerun that curl — the endpoint throttles bursts.

- [ ] **Step 2: Write the failing tests**

Create `test/search.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFilterMap, buildSearchUrl, reshapeSearch, reshapeFacets, HITS_PER_PAGE } from '../lib/search.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pp-metadata.json', import.meta.url)));
const filtered = JSON.parse(readFileSync(new URL('./fixtures/pp-metadata-filtered.json', import.meta.url)));

test('buildFilterMap returns null with no filters', () => {
  assert.equal(buildFilterMap({}), null);
  assert.equal(buildFilterMap({ mediatype: [], yearFrom: '', yearTo: '', collection: '', subject: '' }), null);
});

test('buildFilterMap uses fixed key order and sorted mediatype values', () => {
  const a = buildFilterMap({ subject: 'Apple II', collection: 'byte-magazine', yearTo: 1985, yearFrom: 1983, mediatype: ['texts', 'software'] });
  const b = buildFilterMap({ mediatype: ['software', 'texts'], yearFrom: '1983', yearTo: '1985', collection: 'byte-magazine', subject: 'Apple II' });
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same filters must serialise identically (cache key)');
  assert.deepEqual(Object.keys(a), ['mediatype', 'year', 'collection', 'subject']);
  assert.deepEqual(a.mediatype, { software: 'inc', texts: 'inc' });
  assert.deepEqual(a.year, { 1983: 'gte', 1985: 'lte' });
  assert.deepEqual(a.collection, { 'byte-magazine': 'inc' });
  assert.deepEqual(a.subject, { 'Apple II': 'inc' });
});

test('buildFilterMap encodes a single year as inc and open ranges one-sided', () => {
  assert.deepEqual(buildFilterMap({ yearFrom: 1983, yearTo: '1983' }).year, { 1983: 'inc' });
  assert.deepEqual(buildFilterMap({ yearFrom: 1983 }).year, { 1983: 'gte' });
  assert.deepEqual(buildFilterMap({ yearTo: 1985 }).year, { 1985: 'lte' });
});

test('buildSearchUrl sets verified page_production params for the metadata backend', () => {
  const u = new URL(buildSearchUrl({ q: 'apple II', page: 2, filters: { mediatype: ['texts'] }, aggregations: ['mediatype', 'year', 'collection'] }));
  assert.equal(u.origin + u.pathname, 'https://archive.org/services/search/beta/page_production/');
  assert.equal(u.searchParams.get('service_backend'), null, 'metadata backend is the default: no service_backend param');
  assert.equal(u.searchParams.get('user_query'), 'apple II');
  assert.equal(u.searchParams.get('page_type'), 'search_results');
  assert.equal(u.searchParams.get('hits_per_page'), String(HITS_PER_PAGE));
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('aggregations'), 'mediatype,year,collection');
  assert.equal(u.searchParams.get('aggregations_size'), '20');
  assert.equal(u.searchParams.get('filter_map'), '{"mediatype":{"texts":"inc"}}');
});

test('buildSearchUrl fts backend, no aggregations, no filter_map', () => {
  const u = new URL(buildSearchUrl({ q: 'x', backend: 'fts' }));
  assert.equal(u.searchParams.get('service_backend'), 'fts');
  assert.equal(u.searchParams.get('aggregations'), 'false');
  assert.equal(u.searchParams.get('aggregations_size'), null);
  assert.equal(u.searchParams.get('filter_map'), null);
});

test('reshapeSearch maps fixture rows with array fields normalised', () => {
  const out = reshapeSearch(fixture);
  assert.equal(out.total, fixture.response.body.hits.total);
  assert.equal(out.returned, fixture.response.body.hits.returned);
  assert.equal(out.items.length, fixture.response.body.hits.hits.length);
  for (const it of out.items) {
    assert.ok(it.identifier);
    assert.ok(Array.isArray(it.collection));
    assert.ok(Array.isArray(it.subject));
    assert.ok(it.description === null || typeof it.description === 'string');
  }
});

test('reshapeSearch tolerates a single-string collection and missing fields', () => {
  const out = reshapeSearch({ response: { body: { hits: { total: 1, returned: 1, hits: [
    { fields: { identifier: 'x', collection: 'solo', description: ['a', 'b'] } },
    { fields: {} }, // no identifier → dropped
  ] } } } });
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.items[0].collection, ['solo']);
  assert.deepEqual(out.items[0].subject, []);
  assert.equal(out.items[0].description, 'a b');
  assert.equal(out.items[0].title, null);
  assert.equal(out.items[0].year, null);
  assert.equal(out.items[0].downloads, 0);
  assert.equal(out.facets, null, 'no aggregations → null facets');
});

test('reshapeSearch on an empty body yields zeros', () => {
  assert.deepEqual(reshapeSearch({}), { total: 0, returned: 0, items: [], facets: null });
});

test('reshapeFacets keeps top-12 years by count, rendered ascending, and caps collections at 20', () => {
  const years = Array.from({ length: 25 }, (_, i) => ({ key: 2000 - i, doc_count: 1000 - i * 10 })); // count-ordered like the endpoint
  const colls = Array.from({ length: 30 }, (_, i) => ({ key: `c${i}`, doc_count: 30 - i }));
  const f = reshapeFacets({ mediatype: { buckets: [{ key: 'texts', doc_count: 5 }] }, year: { buckets: years }, collection: { buckets: colls } });
  assert.deepEqual(f.mediatype, [{ key: 'texts', count: 5 }]);
  assert.equal(f.year.length, 12);
  assert.deepEqual(f.year.map((b) => b.key), f.year.map((b) => b.key).sort((a, b) => a - b), 'ascending by year');
  assert.ok(f.year.some((b) => b.key === 2000), 'the top-count year survives the cap');
  assert.ok(!f.year.some((b) => b.key === 1976), 'the 25th year (lowest count) is cut');
  assert.equal(f.collection.length, 20);
  assert.equal(f.collection[0].key, 'c0');
});

test('reshapeFacets from the filtered fixture: each facet ignores its own field\'s filter (post-filter facets)', () => {
  // Verified live 2026-09-11: with mediatype=texts + year 1983–1985 active, the
  // mediatype buckets still list software and the year buckets still list 1982/1986.
  const a = reshapeSearch(fixture).facets;
  const b = reshapeSearch(filtered).facets;
  const has = (list, key) => list.some((x) => x.key === key);
  assert.ok(has(a.mediatype, 'texts') && has(a.mediatype, 'software'));
  assert.ok(has(b.mediatype, 'software'), 'software bucket present even though texts is the active filter');
  assert.ok(b.year.some((y) => y.key < 1983 || y.key > 1985), 'year buckets are not narrowed by the year filter');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test 2>&1 | grep -E "search.test|Cannot find|fail"`
Expected: `Cannot find module '.../lib/search.js'` and a non-zero fail count.

- [ ] **Step 4: Implement `lib/search.js`**

```js
// page_production is the undocumented endpoint behind archive.org's own
// search page. Verified params/shapes are recorded in
// docs/superpowers/specs/2026-09-11-search-facets-related-design.md.
const PP = 'https://archive.org/services/search/beta/page_production/';
const YEAR_FACET_CAP = 12;
const COLLECTION_FACET_CAP = 20;
export const HITS_PER_PAGE = 20;

export const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
export const asString = (v) => (v == null ? null : Array.isArray(v) ? v.join(' ') : String(v));

// Fixed key order (mediatype → year → collection → subject) and sorted
// mediatype values: the serialised URL is the cache key, so equal filter
// sets must produce byte-identical strings.
export function buildFilterMap(filters = {}) {
  const map = {};
  const mts = [...new Set(asArray(filters.mediatype).filter(Boolean))].sort();
  if (mts.length) map.mediatype = Object.fromEntries(mts.map((m) => [m, 'inc']));
  const from = filters.yearFrom ? String(filters.yearFrom) : '';
  const to = filters.yearTo ? String(filters.yearTo) : '';
  if (from && to && from === to) {
    map.year = { [from]: 'inc' }; // gte+lte on one year would collide as a single JSON key
  } else if (from || to) {
    map.year = {};
    if (from) map.year[from] = 'gte';
    if (to) map.year[to] = 'lte';
  }
  if (filters.collection) map.collection = { [filters.collection]: 'inc' };
  if (filters.subject) map.subject = { [filters.subject]: 'inc' };
  return Object.keys(map).length ? map : null;
}

export function buildSearchUrl({ q, page = 1, hitsPerPage = HITS_PER_PAGE, backend = 'metadata', filters = {}, aggregations = [], aggregationsSize = 20 }) {
  const u = new URL(PP);
  if (backend === 'fts') u.searchParams.set('service_backend', 'fts');
  u.searchParams.set('user_query', q);
  u.searchParams.set('page_type', 'search_results');
  u.searchParams.set('hits_per_page', String(hitsPerPage));
  u.searchParams.set('page', String(page));
  if (aggregations.length) {
    u.searchParams.set('aggregations', aggregations.join(','));
    u.searchParams.set('aggregations_size', String(aggregationsSize));
  } else {
    u.searchParams.set('aggregations', 'false');
  }
  const fm = buildFilterMap(filters);
  if (fm) u.searchParams.set('filter_map', JSON.stringify(fm));
  return u.toString();
}

function buckets(agg) {
  return (agg?.buckets ?? []).map((b) => ({ key: b.key, count: b.doc_count }));
}

export function reshapeFacets(aggs) {
  if (!aggs) return null;
  return {
    mediatype: buckets(aggs.mediatype),
    // Endpoint returns years count-ordered: keep the top N, then show them chronologically.
    year: buckets(aggs.year).slice(0, YEAR_FACET_CAP).sort((a, b) => a.key - b.key),
    collection: buckets(aggs.collection).slice(0, COLLECTION_FACET_CAP),
  };
}

export function reshapeSearch(json) {
  const hits = json?.response?.body?.hits ?? { total: 0, returned: 0, hits: [] };
  const items = (hits.hits ?? [])
    .map((h) => {
      const f = h.fields ?? {};
      return {
        identifier: f.identifier ?? null,
        title: asString(f.title),
        mediatype: f.mediatype ?? null,
        year: f.year ?? null,
        downloads: f.downloads ?? 0,
        description: asString(f.description),
        collection: asArray(f.collection),
        subject: asArray(f.subject),
      };
    })
    .filter((it) => it.identifier);
  return {
    total: hits.total ?? 0,
    returned: hits.returned ?? items.length,
    items,
    facets: reshapeFacets(json?.response?.body?.aggregations),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `fail 0`. (The `returned ?? items.length` fallback makes the empty-body test return `returned: 0`.)

- [ ] **Step 6: Commit**

```bash
git add lib/search.js test/search.test.js test/fixtures/pp-metadata.json test/fixtures/pp-metadata-filtered.json
git commit -m "feat: page_production search module with filter_map and facets"
```

---

### Task 2: `/api/items` on the new backend; delete `lib/items.js`

**Files:**
- Modify: `server.js` (the `/api/items` route and imports)
- Delete: `lib/items.js`, `test/items.test.js`, `test/fixtures/advancedsearch.json`
- Modify: `scripts/smoke.mjs` (items check)

**Interfaces:**
- Consumes: `buildSearchUrl`, `reshapeSearch` from Task 1.
- Produces: `GET /api/items?q&page&mediatype=a,b&yearFrom&yearTo&collection&subject` → `{ total, returned, items, facets }`.

- [ ] **Step 1: Rewrite the route**

In `server.js` replace the import line `import { buildItemsUrl, reshapeItems } from './lib/items.js';` with:

```js
import { buildSearchUrl, reshapeSearch } from './lib/search.js';
```

Replace the whole `app.get('/api/items', …)` block with:

```js
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
```

- [ ] **Step 2: Delete the advancedsearch module and its test/fixture**

```bash
git rm -q lib/items.js test/items.test.js test/fixtures/advancedsearch.json
grep -rn "items.js\|advancedsearch" lib server.js test scripts || echo "no stale references"
```

Expected: `no stale references`.

- [ ] **Step 3: Update the smoke check**

In `scripts/smoke.mjs` replace the first entry of `checks` with these two:

```js
  ['/api/items?q=aeron+chair', (d) => d.total > 0 && d.items[0].identifier && d.returned === d.items.length && d.facets && d.facets.mediatype.length > 0],
  ['/api/items?q=apple+II&mediatype=texts&yearFrom=1983&yearTo=1985', (d) => d.items.length > 0 && d.items.every((i) => i.mediatype === 'texts' && i.year >= 1983 && i.year <= 1985) && d.facets.mediatype.some((b) => b.key === 'software')],
```

- [ ] **Step 4: Unit tests + live smoke**

```bash
npm test 2>&1 | tail -8
PORT=3123 node server.js & SRV=$!; sleep 1
node scripts/smoke.mjs http://localhost:3123; kill $SRV
```

Expected: `fail 0`; smoke prints `PASS` for all 6 lines. (The fulltext line still passes here — it is rewritten in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add server.js scripts/smoke.mjs
git commit -m "feat: /api/items on page_production with facets; drop advancedsearch"
```

---

### Task 3: Full-text — single upstream call, fields read directly

**Files:**
- Modify: `lib/fulltext.js` (whole file)
- Modify: `test/fulltext.test.js` (replace the last test)
- Modify: `server.js` (`/api/fulltext` route)

**Interfaces:**
- Consumes: `buildSearchUrl` from Task 1.
- Produces: `buildFtsUrl({ q, page, hitsPerPage }) → string`; `reshapeFts(json) → { total, returned, hits: [{ identifier, title, year, mediatype, snippets: string[] }] }`. `GET /api/fulltext?q&page` returns that object.

- [ ] **Step 1: Replace the title-lookup test**

In `test/fulltext.test.js`, change the import line to:

```js
import { buildFtsUrl, reshapeFts } from '../lib/fulltext.js';
```

Delete the entire `test('title lookup url and merge', …)` block and append:

```js
test('reshapeFts carries title/year/mediatype straight from hit fields and reports returned', () => {
  const out = reshapeFts(fixture);
  assert.equal(out.returned, fixture.response.body.hits.returned);
  assert.equal(typeof out.hits[0].title, 'string');
  assert.ok(['texts', 'audio', 'movies', 'software', 'image'].includes(out.hits[0].mediatype));
  const doctored = { response: { body: { hits: { total: 1, returned: 1, hits: [
    { fields: { identifier: 'x', title: ['Arr Title'], year: 1999, mediatype: 'texts' }, highlight: { text: ['{{{a}}}'] } },
  ] } } } };
  const one = reshapeFts(doctored).hits[0];
  assert.equal(one.title, 'Arr Title', 'array titles collapse to a string');
  assert.equal(one.year, 1999);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "fulltext|fail"`
Expected: failures in `fulltext.test.js` (`returned` undefined / title undefined).

- [ ] **Step 3: Rewrite `lib/fulltext.js`**

```js
import { ftsSnippet } from './snippets.js';
import { buildSearchUrl, asString } from './search.js';

const MAX_SNIPPETS_PER_ITEM = 4;

export function buildFtsUrl({ q, page = 1, hitsPerPage = 20 }) {
  return buildSearchUrl({ q, page, hitsPerPage, backend: 'fts' });
}

// FTS returns one hit per *file*; several files can belong to one item, so
// hits are grouped by identifier and snippets accumulate up to the cap.
// `total` is file-level — never derive page counts from it.
export function reshapeFts(ftsJson) {
  const hitsObj = ftsJson?.response?.body?.hits ?? { total: 0, returned: 0, hits: [] };
  const byId = new Map();
  for (const h of hitsObj.hits ?? []) {
    const f = h.fields ?? {};
    const id = f.identifier;
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, { identifier: id, title: asString(f.title), year: f.year ?? null, mediatype: f.mediatype ?? null, snippets: [] });
    }
    const entry = byId.get(id);
    for (const raw of h.highlight?.text ?? []) {
      if (entry.snippets.length < MAX_SNIPPETS_PER_ITEM) entry.snippets.push(ftsSnippet(raw));
    }
  }
  return {
    total: hitsObj.total ?? 0,
    returned: hitsObj.returned ?? (hitsObj.hits ?? []).length,
    hits: [...byId.values()],
  };
}
```

- [ ] **Step 4: Collapse the route to `proxyRoute`**

In `server.js` change the import to `import { buildFtsUrl, reshapeFts } from './lib/fulltext.js';` and replace the whole `app.get('/api/fulltext', async …)` block with:

```js
app.get('/api/fulltext', proxyRoute(
  (req) => {
    if (!req.query.q) throw new Error('missing q');
    return buildFtsUrl({ q: req.query.q, page: Number(req.query.page) || 1 });
  },
  (raw) => reshapeFts(raw),
));
```

- [ ] **Step 5: Tests + smoke**

Update the fulltext smoke line in `scripts/smoke.mjs` to:

```js
  ['/api/fulltext?q=fusion+anomaly', (d) => d.total > 0 && d.hits[0].snippets[0].includes('<mark>') && typeof d.hits[0].title === 'string' && typeof d.returned === 'number'],
```

```bash
npm test 2>&1 | tail -8
PORT=3123 node server.js & SRV=$!; sleep 1
node scripts/smoke.mjs http://localhost:3123; kill $SRV
```

Expected: `fail 0`; 6/6 `PASS`.

- [ ] **Step 6: Commit**

```bash
git add lib/fulltext.js test/fulltext.test.js server.js scripts/smoke.mjs
git commit -m "feat: fulltext reads titles from hit fields; drop advancedsearch round-trip"
```

---

### Task 4: `lib/related.js` + `/api/related/:id`

**Files:**
- Create: `lib/related.js`, `test/related.test.js`, `test/fixtures/related.json`
- Modify: `server.js` (import + route), `scripts/smoke.mjs`

**Interfaces:**
- Produces: `relatedUrl(id) → string`; `reshapeRelated(json) → { items: [{ identifier, title, mediatype, year, downloads }] }` (≤ 6). `GET /api/related/:id` → that object; `{ items: [] }` for an unknown id (upstream answers 200 with zero hits).

- [ ] **Step 1: Record the fixture (live)**

```bash
curl -s -A "ia-search/1.0 (personal tool)" "https://be-api.us.archive.org/mds/v1/get_related/all/byte-magazine-1982-05-rescan" > test/fixtures/related.json
node -e 'const j=require("./test/fixtures/related.json");console.log("hits",j.hits.hits.length,"first",j.hits.hits[0]._id,Object.keys(j.hits.hits[0]._source).join(","))'
```

Expected: `hits` ≥ 6 and a `_source` key list including `title,mediatype,downloads,collection`. Note whether `year` and/or `date` are present — the reshape handles both being absent.

- [ ] **Step 2: Write the failing tests**

Create `test/related.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relatedUrl, reshapeRelated } from '../lib/related.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/related.json', import.meta.url)));

test('relatedUrl targets be-api and encodes the id', () => {
  assert.equal(relatedUrl('a b/c'), 'https://be-api.us.archive.org/mds/v1/get_related/all/a%20b%2Fc');
});

test('reshapeRelated unwraps one-element arrays and caps at 6', () => {
  const out = reshapeRelated(fixture);
  assert.ok(out.items.length > 0 && out.items.length <= 6);
  for (const it of out.items) {
    assert.equal(typeof it.identifier, 'string');
    assert.ok(it.title === null || typeof it.title === 'string');
    assert.ok(it.mediatype === null || typeof it.mediatype === 'string');
    assert.ok(it.year === null || Number.isInteger(it.year));
    assert.equal(typeof it.downloads, 'number');
  }
});

test('reshapeRelated derives year from year, then date, never publicdate', () => {
  const src = (s) => ({ _id: 'x', _source: s });
  assert.equal(reshapeRelated({ hits: { hits: [src({ year: ['1982'] })] } }).items[0].year, 1982);
  assert.equal(reshapeRelated({ hits: { hits: [src({ date: ['1982-05-01T00:00:00Z'] })] } }).items[0].year, 1982);
  assert.equal(reshapeRelated({ hits: { hits: [src({ publicdate: ['2012-09-22T02:20:27Z'] })] } }).items[0].year, null);
});

test('reshapeRelated returns an empty list for zero hits or garbage', () => {
  assert.deepEqual(reshapeRelated({ hits: { hits: [], total: { value: 0 } } }), { items: [] });
  assert.deepEqual(reshapeRelated({}), { items: [] });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "related|fail"`
Expected: `Cannot find module '.../lib/related.js'`.

- [ ] **Step 4: Implement `lib/related.js`**

```js
// be-api is a third undocumented host (Elasticsearch-shaped). Isolated here so
// a breakage only loses the "Related" section of an expanded row.
const BASE = 'https://be-api.us.archive.org/mds/v1/get_related/all/';
const MAX_RELATED = 6;

const first = (v) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export function relatedUrl(id) {
  return BASE + encodeURIComponent(id);
}

function yearOf(s) {
  const y = Number(first(s.year));
  if (Number.isInteger(y) && y > 0) return y;
  const d = first(s.date); // content date; publicdate is the upload date and would mislead
  const fromDate = d ? Number(String(d).slice(0, 4)) : NaN;
  return Number.isInteger(fromDate) && fromDate > 0 ? fromDate : null;
}

export function reshapeRelated(json) {
  const hits = json?.hits?.hits ?? [];
  const items = hits
    .slice(0, MAX_RELATED)
    .map((h) => {
      const s = h._source ?? {};
      return {
        identifier: h._id ?? null,
        title: first(s.title),
        mediatype: first(s.mediatype),
        year: yearOf(s),
        downloads: Number(first(s.downloads)) || 0,
      };
    })
    .filter((it) => it.identifier);
  return { items };
}
```

- [ ] **Step 5: Route + smoke**

In `server.js` add `import { relatedUrl, reshapeRelated } from './lib/related.js';` after the other lib imports, and add this route directly above the `/api/item/:id` route:

```js
app.get('/api/related/:id', proxyRoute(
  (req) => relatedUrl(req.params.id),
  (raw) => reshapeRelated(raw),
));
```

Append to `checks` in `scripts/smoke.mjs`:

```js
  ['/api/related/byte-magazine-1982-05-rescan', (d) => d.items.length > 0 && d.items[0].identifier],
```

- [ ] **Step 6: Tests + smoke**

```bash
npm test 2>&1 | tail -8
PORT=3123 node server.js & SRV=$!; sleep 1
node scripts/smoke.mjs http://localhost:3123; kill $SRV
```

Expected: `fail 0`; 7/7 `PASS`.

- [ ] **Step 7: Commit**

```bash
git add lib/related.js test/related.test.js test/fixtures/related.json server.js scripts/smoke.mjs
git commit -m "feat: /api/related/:id via be-api related items"
```

---

### Task 5: `lib/item.js` — collection/subject fields, skip Thumbnail format

**Files:**
- Modify: `lib/item.js`
- Modify: `test/item.test.js` (append tests)

**Interfaces:**
- Produces: `reshapeItem` result gains `collection: string[]`, `subject: string[]`. (`/api/item/:id` returns them with no route change.)

- [ ] **Step 1: Append failing tests**

Append to `test/item.test.js`:

```js
test('reshapeItem exposes collection and subject as arrays (fixture subject is a single string)', () => {
  const out = reshapeItem(meta);
  assert.deepEqual(out.collection, meta.metadata.collection);
  assert.equal(typeof meta.metadata.subject, 'string', 'fixture precondition');
  assert.deepEqual(out.subject, [meta.metadata.subject]);
  const empty = reshapeItem({ metadata: { identifier: 'x' }, files: [] });
  assert.deepEqual(empty.collection, []);
  assert.deepEqual(empty.subject, []);
});

test('reshapeItem skips Thumbnail-format files but keeps real content', () => {
  const out = reshapeItem({ metadata: { identifier: 'x' }, files: [
    { name: 'movie.thumbs/frame_000001.jpg', size: '9000', format: 'Thumbnail' },
    { name: 'movie.mp4', size: '100', format: 'h.264' },
    { name: 'catalog.pdf', size: '50', format: 'Text PDF' },
  ] });
  assert.deepEqual(out.files.map((f) => f.name), ['movie.mp4', 'catalog.pdf']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "item.test|fail"`
Expected: two failures (`collection` undefined; thumbnail file present).

- [ ] **Step 3: Implement**

In `lib/item.js`:

```js
import { asArray } from './search.js';

const SKIP_NAME = /(_meta\.xml|_files\.xml|_meta\.sqlite)$/;
// Exact matches for the plumbing formats; Log/Index stay substring matches as before.
const SKIP_FORMAT = /^(Metadata|Thumbnail)$|Log|Index/i;
```

and in the returned object add, after `mediatype`:

```js
    collection: asArray(md.collection),
    subject: asArray(md.subject),
```

- [ ] **Step 4: Run tests**

Run: `npm test 2>&1 | tail -8`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/item.js test/item.test.js
git commit -m "feat: item detail exposes collection/subject; skip thumbnail files"
```

---

### Task 6: Frontend — filter state, active-filter bar, facet strip, `returned`-based Load More

**Files:**
- Modify: `public/index.html` (the `#filters` block)
- Modify: `public/app.js`
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `/api/items` response `{ total, returned, items, facets }`; `/api/fulltext` `{ total, returned, hits }`.
- Produces (used by Task 7): `setFilter(mutate)`, `activateTab(name, { load })`, `state.filters`.

- [ ] **Step 1: Replace the filters block in `public/index.html`**

Replace the whole `<div id="filters" …>…</div>` with:

```html
    <div id="filters" class="pane" data-pane="items">
      <div id="active" hidden></div>
      <div id="facets" hidden>
        <div class="facet-row" data-facet="mediatype"><span class="facet-label">Type</span><div class="chips"></div></div>
        <div class="facet-row" data-facet="year"><span class="facet-label">Year</span><div class="chips"></div>
          <input id="yearFrom" type="number" placeholder="from" min="1000" max="2100" aria-label="Year from">
          <input id="yearTo" type="number" placeholder="to" min="1000" max="2100" aria-label="Year to">
        </div>
        <div class="facet-row" data-facet="collection"><span class="facet-label">Collection</span><div class="chips"></div></div>
      </div>
    </div>
```

- [ ] **Step 2: State + query + filter mutation in `public/app.js`**

At the top, after `const $ = …`, add `const HITS_PER_PAGE = 20;` and add `filters` to `state`:

```js
const state = {
  q: '',
  active: 'items',
  filters: { mediatype: [], yearFrom: '', yearTo: '', collection: '', subject: '' },
  tabs: { /* unchanged */ },
};
```

Replace `itemsQuery` with:

```js
function itemsQuery(page) {
  const f = state.filters;
  const p = new URLSearchParams({ q: state.q, page });
  if (f.mediatype.length) p.set('mediatype', f.mediatype.join(','));
  for (const k of ['yearFrom', 'yearTo', 'collection', 'subject']) if (f[k]) p.set(k, f[k]);
  return `/api/items?${p}`;
}

// Apply a filter mutation, then reset and reload the Items tab. Filters
// persist across searches; only the tab's result state is cleared.
function setFilter(mutate) {
  mutate(state.filters);
  $('#yearFrom').value = state.filters.yearFrom;
  $('#yearTo').value = state.filters.yearTo;
  renderActive();
  resetTabState('items');
  const pane = mainPane('items');
  $('.results', pane).textContent = '';
  setStatus('items', '');
  $('.more', pane).hidden = true; // a stale "Load more" would fetch page 2 onto an emptied list
  if (state.active === 'items') loadTab('items');
}

function clearAllFilters() {
  setFilter((f) => Object.assign(f, { mediatype: [], yearFrom: '', yearTo: '', collection: '', subject: '' }));
}
```

- [ ] **Step 3: Pills, chips, facet strip renderers**

Add after `clearAllFilters`:

```js
function button(className, text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

function renderActive() {
  const box = $('#active');
  box.textContent = '';
  const f = state.filters;
  for (const m of f.mediatype) {
    box.append(button('pill', `✕ ${m}`, () => setFilter((x) => { x.mediatype = x.mediatype.filter((v) => v !== m); })));
  }
  if (f.yearFrom || f.yearTo) {
    const label = f.yearFrom && f.yearTo && f.yearFrom === f.yearTo ? f.yearFrom : `${f.yearFrom || '…'}–${f.yearTo || '…'}`;
    box.append(button('pill', `✕ ${label}`, () => setFilter((x) => { x.yearFrom = ''; x.yearTo = ''; })));
  }
  if (f.collection) box.append(button('pill', `✕ in: ${f.collection}`, () => setFilter((x) => { x.collection = ''; })));
  if (f.subject) box.append(button('pill', `✕ # ${f.subject}`, () => setFilter((x) => { x.subject = ''; })));
  if (box.children.length >= 2) box.append(button('pill clear', 'Clear all', clearAllFilters));
  box.hidden = box.children.length === 0;
}

function compact(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function chip(key, count, selected, onClick) {
  const b = button('chip' + (selected ? ' selected' : ''), `${key} ~${compact(count)}`, onClick);
  b.dataset.key = String(key);
  return b;
}

function renderFacets(facets) {
  const strip = $('#facets');
  if (!facets) { strip.hidden = true; return; }
  const f = state.filters;
  const fill = (name, chips) => {
    const box = $(`.facet-row[data-facet="${name}"] .chips`);
    box.textContent = '';
    for (const c of chips) box.append(c);
  };
  fill('mediatype', facets.mediatype.map((b) => chip(b.key, b.count, f.mediatype.includes(b.key), () => setFilter((x) => {
    x.mediatype = x.mediatype.includes(b.key) ? x.mediatype.filter((v) => v !== b.key) : [...x.mediatype, b.key];
  }))));
  fill('year', facets.year.map((b) => {
    const y = String(b.key);
    const selected = f.yearFrom === y && f.yearTo === y;
    return chip(y, b.count, selected, () => setFilter((x) => {
      if (selected) { x.yearFrom = ''; x.yearTo = ''; } else { x.yearFrom = y; x.yearTo = y; }
    }));
  }));
  fill('collection', facets.collection.map((b) => chip(b.key, b.count, f.collection === b.key, () => setFilter((x) => {
    x.collection = x.collection === b.key ? '' : b.key;
  }))));
  strip.hidden = false;
}
```

- [ ] **Step 4: Wire renderers and Load More**

In `renderers.items`, replace the two lines starting `const t = state.tabs.items;` with:

```js
    if (!append) renderFacets(data.facets); // counts follow the endpoint's post-filter behaviour
    $('.more', pane).hidden = data.returned < HITS_PER_PAGE || data.items.length === 0;
```

In `renderers.fulltext`, replace the two lines starting `const t = state.tabs.fulltext;` with:

```js
    $('.more', pane).hidden = data.returned < HITS_PER_PAGE || data.hits.length === 0;
```

Replace the `for (const el of ['#mediatype', '#yearFrom', '#yearTo'] …)` block with:

```js
for (const el of ['#yearFrom', '#yearTo'].map((s) => $(s))) {
  el.onchange = () => setFilter((f) => { f.yearFrom = $('#yearFrom').value; f.yearTo = $('#yearTo').value; });
}
```

Replace the tab-click loop with an `activateTab` helper (Task 7 calls it with `load: false`):

```js
function activateTab(name, { load = true } = {}) {
  state.active = name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
  if (load) loadTab(name);
}
for (const btn of document.querySelectorAll('.tab')) btn.onclick = () => activateTab(btn.dataset.tab);
```

- [ ] **Step 5: Styles**

In `public/style.css` replace the two `#filters` rules with:

```css
#filters { padding: 8px 0 4px; }
#active { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.pill { font-size: 13px; padding: 4px 10px; border-radius: 999px; background: var(--accent); color: #fff; border-color: var(--accent); }
.pill.clear { background: none; color: var(--muted); border-color: var(--line); }
.facet-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.facet-label { flex: none; width: 76px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; min-width: 0; flex: 1; }
.chips::-webkit-scrollbar { display: none; }
.chip { flex: none; font-size: 13px; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
.chip.selected { background: var(--ink); color: #fff; border-color: var(--ink); }
.facet-row input { flex: none; width: 64px; padding: 4px 6px; font-size: 13px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); }
```

- [ ] **Step 6: Manual check in a browser**

```bash
PORT=3123 node server.js
```

Open http://localhost:3123, search `apple II`: three facet rows appear with `~` counts; click `texts` → pill `✕ texts` appears, rows all say texts, the Type row still shows `software`; click a year chip → pill shows that year; two pills → `Clear all` appears; Load More visible on page 1. Switch to Full-text, search, confirm Load More appears and each row has a title. Stop the server. (Task 8 automates this; do the eyeball pass anyway — CSS is not unit-tested.)

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: facet strip, active-filter pills, returned-based load more"
```

---

### Task 7: Frontend — expanded-row chips, related items, keyboard-accessible rows

**Files:**
- Modify: `public/app.js` (`makeRow`, `renderDetail`, new `renderRelated`)
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `setFilter`, `activateTab` (Task 6); `/api/item/:id` `collection[]`/`subject[]` (Task 5); `/api/related/:id` (Task 4); `button()` helper (Task 6).

- [ ] **Step 1: Keyboard access in `makeRow`**

Inside `if (expandable) {` before `let loading = false;` add:

```js
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    };
```

- [ ] **Step 2: Fetch related after the detail renders**

Still in `makeRow`, the `row.onclick` handler: after the `if (state.active === 'fulltext') { … }` block (inside the handler, after `loading = false` has run in `finally`), append:

```js
      const relBox = $('.related', detail);
      try {
        const rel = await api(`/api/related/${encodeURIComponent(identifier)}`);
        renderRelated(relBox, rel);
      } catch (err) {
        relBox.textContent = `Couldn't load related items: ${err.message}`; // append-only: the detail above stays
      }
```

- [ ] **Step 3: Chips row and related placeholder in `renderDetail`**

Replace `renderDetail` with:

```js
function scopeChip(text, mutate) {
  return button('chip scope', text, () => {
    activateTab('items', { load: false }); // setFilter does the (single) reload
    setFilter(mutate);
  });
}

function renderDetail(detail, item) {
  detail.textContent = '';
  if (item.description) {
    const p = document.createElement('p');
    p.textContent = item.description;
    detail.append(p);
  }
  const chips = document.createElement('div');
  chips.className = 'chips-row';
  for (const c of item.collection) chips.append(scopeChip(`in: ${c}`, (f) => { f.collection = c; }));
  for (const s of item.subject.slice(0, 10)) chips.append(scopeChip(`# ${s}`, (f) => { f.subject = s; }));
  if (chips.children.length) detail.append(chips);
  const iframe = document.createElement('iframe');
  iframe.src = item.embedUrl;
  iframe.loading = 'lazy';
  iframe.allowFullscreen = true;
  detail.append(iframe);
  const ul = document.createElement('ul');
  ul.className = 'files';
  for (const f of item.files) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = f.url;
    a.textContent = f.name;
    li.append(a, ` — ${f.format ?? ''} ${humanSize(f.size)}`);
    ul.append(li);
  }
  detail.append(ul);
  const related = document.createElement('div');
  related.className = 'related';
  related.textContent = 'Loading related…';
  detail.append(related);
  const link = document.createElement('a');
  link.href = item.detailsUrl;
  link.textContent = 'on archive.org →';
  detail.append(link);
}

// Related rows are full rows: they expand inline too. Their detail nodes sit
// inside this parent's detail, and .detail is a sibling of .row, so clicks
// never bubble into the parent row's toggle.
function renderRelated(box, rel) {
  box.textContent = '';
  if (!rel.items.length) { box.textContent = 'No related items.'; return; }
  const h = document.createElement('h4');
  h.textContent = 'Related';
  box.append(h);
  for (const it of rel.items) {
    box.append(makeRow({
      identifier: it.identifier,
      title: it.title,
      metaLine: [it.year, it.mediatype, it.downloads ? `${it.downloads} downloads` : null].filter(Boolean).join(' · '),
      expandable: true,
    }));
  }
}
```

- [ ] **Step 4: Styles**

Append to `public/style.css`:

```css
.detail .chips-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.chip.scope { background: var(--bg); }
.detail .related { margin: 12px 0; color: var(--muted); font-size: 14px; }
.detail .related h4 { margin: 0 0 4px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.detail .related .row { padding: 8px 0; }
.detail .related .row img { width: 48px; height: 48px; }
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
```

- [ ] **Step 5: Manual check**

```bash
PORT=3123 node server.js
```

Search `byte magazine`, expand a row: `in: …` and `# …` chips above the viewer, "Related" list under the files with thumbnails. Click a related row → it expands inline under itself, parent stays open. Click an `in:` chip → Items tab shows a `✕ in: …` pill and reloads once (Network tab: one `/api/items` request). Tab to a row, press Enter → it expands. Stop the server.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/style.css
git commit -m "feat: collection/subject chips, related items, keyboard rows in expanded detail"
```

---

### Task 8: Headless Chrome verification script

**Files:**
- Create: `scripts/verify.mjs`
- Modify: `package.json` (devDependency + script)

**Interfaces:**
- Consumes: the running app end-to-end. Exits non-zero on any failed assertion.

- [ ] **Step 1: Add the dev dependency and script**

```bash
npm i -D puppeteer-core
node -e 'const p=require("./package.json");p.scripts.verify="node scripts/verify.mjs";require("fs").writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
git diff --stat package.json package-lock.json
```

Expected: `puppeteer-core` under `devDependencies`, no browser download (puppeteer-core never downloads one).

- [ ] **Step 2: Write `scripts/verify.mjs`**

```js
// Headless click-through against the real app + live IA. Run before pushing UI
// changes (reproduce-before-pushing rule). Requires Google Chrome.app.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const PORT = 3124;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`http://localhost:${PORT}/`);

  // 1. Search → facet strip renders with ~counts.
  await page.type('#q', 'apple II');
  await page.click('#search-form button');
  await page.waitForSelector('.facet-row[data-facet="mediatype"] .chip');
  const firstChip = await page.$eval('.facet-row[data-facet="mediatype"] .chip', (el) => ({ key: el.dataset.key, text: el.textContent }));
  check(firstChip.text.includes('~'), `type chip shows approximate count: "${firstChip.text}"`);

  // 2. Click the Type chip → pill appears, every visible row carries that mediatype, sibling counts remain.
  await page.click('.facet-row[data-facet="mediatype"] .chip');
  await page.waitForSelector('#active .pill');
  await page.waitForFunction((k) => {
    const rows = [...document.querySelectorAll('main .pane[data-pane="items"] .row .meta')];
    return rows.length > 0 && rows.every((m) => m.textContent.includes(k));
  }, {}, firstChip.key);
  const pill = await page.$eval('#active .pill', (el) => el.textContent);
  check(pill.includes(firstChip.key), `active pill "${pill}" names the selected type`);
  const typeChips = await page.$$eval('.facet-row[data-facet="mediatype"] .chip', (els) => els.length);
  check(typeChips >= 2, `type row still lists ${typeChips} types after filtering (post-filter facets)`);
  const selected = await page.$eval('.facet-row[data-facet="mediatype"] .chip.selected', (el) => el.dataset.key);
  check(selected === firstChip.key, 'selected chip is highlighted');

  // 3. Year chip → single-year pill.
  const yearKey = await page.$eval('.facet-row[data-facet="year"] .chip', (el) => el.dataset.key);
  await page.click('.facet-row[data-facet="year"] .chip');
  await page.waitForFunction((y) => [...document.querySelectorAll('#active .pill')].some((p) => p.textContent.includes(y)), {}, yearKey);
  check(await page.$('#active .pill.clear') !== null, 'Clear all appears with two filters');

  // 4. Expand a row → chips + related. (The year click emptied and reloaded the list.)
  await page.waitForSelector('main .pane[data-pane="items"] .row');
  await page.click('main .pane[data-pane="items"] .row');
  await page.waitForSelector('main .pane[data-pane="items"] .detail:not([hidden]) .chips-row .chip.scope');
  await page.waitForFunction(() => {
    const r = document.querySelector('main .pane[data-pane="items"] .detail:not([hidden]) .related');
    return r && !r.textContent.startsWith('Loading');
  });
  const relatedText = await page.$eval('main .pane[data-pane="items"] .detail:not([hidden]) .related', (el) => el.textContent);
  check(relatedText.includes('Related') || relatedText.includes('No related'), `related section settled: "${relatedText.slice(0, 40)}"`);

  // 5. Collection chip → collection pill, Items reload.
  const collChip = await page.$('main .pane[data-pane="items"] .detail:not([hidden]) .chips-row .chip.scope');
  const collText = await collChip.evaluate((el) => el.textContent);
  await collChip.click();
  await page.waitForFunction((t) => [...document.querySelectorAll('#active .pill')].some((p) => p.textContent.includes(t.replace(/^in: |^# /, ''))), {}, collText);
  await page.waitForSelector('main .pane[data-pane="items"] .row');
  check(true, `scope chip "${collText}" became a pill and results reloaded`);

  // 6. Keyboard: focus first row, press Enter → detail opens.
  await page.focus('main .pane[data-pane="items"] .row');
  await page.keyboard.press('Enter');
  await page.waitForSelector('main .pane[data-pane="items"] .detail:not([hidden])');
  check(true, 'Enter on a focused row expands it');

  // 7. Full-text tab renders titles and Load More.
  await page.click('.tab[data-tab="fulltext"]');
  await page.waitForSelector('main .pane[data-pane="fulltext"] .row h3');
  const ftTitle = await page.$eval('main .pane[data-pane="fulltext"] .row h3', (el) => el.textContent);
  check(ftTitle.length > 0, `fulltext row has a title: "${ftTitle.slice(0, 40)}"`);
  const moreHidden = await page.$eval('main .pane[data-pane="fulltext"] .more', (el) => el.hidden);
  check(moreHidden === false, 'fulltext Load More visible on a full first page');
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
```

- [ ] **Step 3: Run it**

Run: `npm run verify`
Expected: every line `PASS`, ending `ALL PASS`, exit 0. If step 2's `waitForFunction` times out, open the page manually and check `.row .meta` text contains the mediatype word (it is built from `[year, mediatype, downloads]` in `renderers.items`).

- [ ] **Step 4: Commit**

```bash
git add scripts/verify.mjs package.json package-lock.json
git commit -m "test: headless Chrome verification of facets, chips, related, keyboard"
```

---

### Task 9: Docs, final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-31-ia-search-design.md` (route table row + "What it is not")

- [ ] **Step 1: README**

Replace the three tab bullets and the test block with:

```markdown
- **Items** — archive.org item search (undocumented `page_production` metadata backend): Type / Year / Collection facet counts, an active-filter bar, collection and subject chips
- **Full-text** — search inside the content of IA's texts (same endpoint, fts backend)
- **Web** — Wayback Machine site-name matching (undocumented `__wb/search/anchor`)

Rows expand inline: description, collection/subject chips, embedded IA viewer,
direct download links, IA's related items (undocumented `be-api` host);
full-text rows also show per-page matches (`fulltext/inside.php`).
```

```markdown
## Test

    npm test                 # unit tests against recorded fixtures
    node scripts/smoke.mjs   # live checks against real IA (server must be running)
    npm run verify           # headless Chrome click-through (needs Google Chrome.app)

All three tabs sit on undocumented backends that can break without notice;
each lives in its own `lib/` module and only takes down its own tab (related
items only its own section). Fixtures in `test/fixtures/` were recorded
2026-08-31 and 2026-09-11.
```

Add a route table under `## Run`:

```markdown
## Routes

| Route | Returns |
|---|---|
| `GET /api/items?q&page&mediatype=a,b&yearFrom&yearTo&collection&subject` | `{ total, returned, items, facets }` |
| `GET /api/fulltext?q&page` | `{ total, returned, hits }` |
| `GET /api/inside?id&q` | `{ matches }` |
| `GET /api/web?q` | `{ sites }` |
| `GET /api/item/:id` | item detail incl. `collection[]`, `subject[]`, `files[]` (404 unknown) |
| `GET /api/related/:id` | `{ items }` (≤ 6; empty for unknown id) |
```

- [ ] **Step 2: v1 spec**

In `docs/superpowers/specs/2026-08-31-ia-search-design.md` replace the `/api/items` table row with:

```markdown
| `GET /api/items?q=&mediatype=&yearFrom=&yearTo=&collection=&subject=&page=` | `page_production` metadata backend (undocumented) — superseded 2026-09-11, see `2026-09-11-search-facets-related-design.md` | Rows + facet counts in one call; `filter_map` scoping. |
```

and add a row after `/api/item/:id`:

```markdown
| `GET /api/related/:id` | `be-api.us.archive.org/mds/v1/get_related/all/:id` | Undocumented. ≤ 6 related items for an expanded row; degrades to one inline line. |
```

Under "What it is not (v1)" replace the `No full-text search of archived *web pages*` bullet's neighbour context by appending this bullet:

```markdown
- (2026-09-11) All three tabs now depend on undocumented endpoints; the
  documented `advancedsearch.php` is no longer used. Each is isolated in its
  own `lib/` module so breakage stays per-tab.
```

- [ ] **Step 3: Full verification**

```bash
npm test 2>&1 | tail -8
PORT=3123 node server.js & SRV=$!; sleep 1
node scripts/smoke.mjs http://localhost:3123; kill $SRV
npm run verify
git status --short
```

Expected: `fail 0`; smoke 7/7 `PASS`; verify `ALL PASS`; only the two doc files modified.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-31-ia-search-design.md
git commit -m "docs: routes, facets, related items; all tabs on undocumented backends"
git log --oneline main..HEAD
```

Expected: nine feature/test/docs commits on top of the spec commit. Do not push; hand back for review.
