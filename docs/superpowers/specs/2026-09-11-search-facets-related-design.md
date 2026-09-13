# IA Search — Facets, scoped filters, related items

**Date:** 2026-09-11
**Status:** Approved design, pre-implementation
**Builds on:** `2026-08-31-ia-search-design.md` (v1, live at https://ia-search-production.up.railway.app/)

## Purpose

Make the Items tab a real search tool instead of a flat list: facet counts
you can click, a scoped-filter bar that collection and subject chips feed
into, and IA's own related-items recommendations inside an expanded row.
Along the way, drop the Full-text title round-trip and fix Load More.

## Decisions already made

- **Items tab moves to `page_production` (metadata backend).** One upstream
  call returns rows, facet buckets and filters. The Items tab leaves
  `advancedsearch.php`, the only documented endpoint, and joins Full-text on
  the undocumented beta one. Risk statement for the app is now: all three
  tabs sit on undocumented endpoints; each is isolated in its own module so
  breakage stays per-tab.
- **Active-filter bar, not query rewriting.** Clicking a facet or a chip
  sets a filter shown as a removable pill under the tabs. The query text is
  never touched.
- **Facet strip above results**, three compact groups under the tab bar.
  No sidebar; the single-column 860px layout stays.
- **Not in this round:** Wayback expansion (CDX / sparkline / URL mode),
  subject or creator facets, browsing a collection with no query, reviews,
  views, TV news.

## Verified API facts (live, 2026-09-11)

`GET https://archive.org/services/search/beta/page_production/`

- Required: `user_query` (non-empty; `*` is rejected), `page_type=search_results`.
- `service_backend` absent → metadata (items); `=fts` → full-text (already in use).
- `hits_per_page`, `page` (1-based). Response `response.body.hits.{total,returned,hits[]}`;
  each hit has `fields` with identifier, title, description (truncated to
  1000 by the endpoint), subject[], creator[], collection[], year,
  mediatype, downloads, item_size, files_count.
- `aggregations=mediatype,year,collection` (comma list; `true` is parsed
  as a field named "1" and errors). `aggregations_size=N`. Buckets under
  `response.body.aggregations.<field>.buckets[{key,doc_count}]`, ordered
  by count. Collection returns at most 20 buckets regardless of size
  requested; year returned 25 when asked for 25.
- Counts are approximate (`doc_count_error_upper_bound` non-zero; the
  `texts` bucket read 8,533 while the filtered total was 8,980).
- `filter_map` is a JSON object: `{"mediatype":{"texts":"inc","software":"inc"},"year":{"1983":"gte","1985":"lte"},"collection":{"byte-magazine":"inc"},"subject":{"Apple II software":"inc"}}`.
  Multiple `inc` on one field is OR (verified: texts+software total equals
  the sum). `gte`/`lte` on year verified. A single year uses
  `{"year":{"1983":"inc"}}` (verified: 1,173 matches, equal to the facet
  bucket) because `gte` and `lte` on the same year would collide as one
  JSON key.
- Facets are post-filtered per field: each aggregation applies every
  active filter **except its own field's**. With `mediatype=texts` and
  year 1983–1985 active, the mediatype buckets still list `software`
  (1,507) and the year buckets still list 1982 and 1986, while collection
  buckets narrow to both filters. This is the standard faceting UX
  (siblings stay clickable) and needs no client work.
- Totals agree with advancedsearch within ~2% (27,577 vs 27,104 for `apple II`).

`GET https://be-api.us.archive.org/mds/v1/get_related/all/<identifier>`

- Elasticsearch-shaped: `hits.hits[]._source` with title[], mediatype[],
  downloads[], collection[], publicdate[], description[] (arrays of one),
  `_id` is the identifier. Returns `hits.total.value=0` for unknown ids
  (no error).

`GET https://archive.org/metadata/<id>` already used; `metadata.collection`
and `metadata.subject` are arrays (or a single string on some items).

Rate limits: a burst of ~20 requests in a few seconds from one IP tripped
429s on `archive.org/wayback/available` and `web.archive.org/save`, and
blanked CDX. `page_production`, `metadata`, and `be-api` did not throttle
at 1 request / 2 s. The existing URL-keyed 10-minute cache is the
mitigation; nothing new.

## Server

### `lib/search.js` (new, replaces `lib/items.js`)

```
buildSearchUrl({ q, page = 1, hitsPerPage = 20, backend = 'metadata',
                 filters = {}, aggregations = [] , aggregationsSize = 20 })
```

- `filters`: `{ mediatype: string[], yearFrom, yearTo, collection, subject }`.
  Builds `filter_map` with **fixed key order** mediatype → year →
  collection → subject and mediatype values sorted, so the same filter
  set always yields the same URL (the URL is the cache key).
- Omits `filter_map` entirely when no filter is set; omits `aggregations`
  when the list is empty and sends `aggregations=false` (what fulltext does
  today).

```
reshapeSearch(json) → { total, returned, items[], facets }
```

- `items[]`: identifier, title, mediatype, year, downloads, description,
  collection[], subject[]. Multi-value fields normalised to arrays;
  description normalised to a string.
- `facets`: `{ mediatype: [{key,count}], year: [{key,count}], collection: [{key,count}] }`.
  Year buckets **sorted ascending by key and capped at 12** (the endpoint
  returns them count-ordered). Collection capped at 20. Absent
  aggregations → `facets: null`.
- `returned` is `hits.returned`; the client hides Load More when
  `returned < hitsPerPage`.

### `lib/fulltext.js` (shrinks)

- `buildFtsUrl` delegates to `buildSearchUrl({ backend: 'fts' })`.
- `reshapeFts` reads `fields.title`, `fields.year`, `fields.mediatype`
  directly and returns `{ total, returned, hits }`. `buildTitleLookupUrl`
  and `mergeTitles` are deleted, along with their tests.

### `lib/related.js` (new)

- `relatedUrl(id)` → the be-api URL.
- `reshapeRelated(json)` → `{ items: [{ identifier, title, mediatype, year, downloads }] }`,
  at most 6, first-of-array unwrapping, `year` from `year` or the first
  four characters of `date`, else null. Never `publicdate`: that is the
  upload date, not the content year.

### `lib/item.js`

- Adds `collection: string[]` and `subject: string[]` to the reshaped item
  (string → one-element array; absent → `[]`). Also adds `|Thumbnail` to
  `SKIP_FORMAT` and anchors it (follow-up #2; touched file, one line).

### Routes (`server.js`)

| Route | Upstream | Change |
|---|---|---|
| `GET /api/items?q&page&mediatype=a,b&yearFrom&yearTo&collection&subject` | page_production (metadata) | rewritten; returns `{ total, returned, items, facets }`; always requests the three aggregations |
| `GET /api/fulltext?q&page` | page_production (fts) | single upstream call; returns `{ total, returned, hits }` |
| `GET /api/related/:id` | be-api | new; `proxyRoute`; `{ items: [] }` for unknown id |
| `/api/inside`, `/api/web`, `/api/item/:id` | unchanged | `/api/item` gains collection/subject fields |

Cache, one retry, 502 on double failure: unchanged for all routes.

## Frontend

### State

```
state.filters = { mediatype: [], yearFrom: '', yearTo: '', collection: '', subject: '' }
```

Every filter change: `resetTabState('items')`, clear the pane, hide Load
More, reload if Items is the active tab. Same generation guard as today.
Filters persist across queries (a new search keeps the active pills);
"Clear all" pill removes everything.

### Layout under the tab bar (Items tab only, hidden with no query)

1. **Active-filter bar** `#active`: one pill per set filter
   (`✕ texts`, `✕ 1983–1985`, `✕ byte-magazine`, `✕ subject: Apple II`),
   plus "Clear all" when two or more are set. Hidden when none.
2. **Facet strip** `#facets`: three rows, each a label and a horizontally
   scrolling row of chips: `texts ~8.5k`.
   - **Type**: multi-select toggle. Selected chips render filled.
   - **Year**: single value; clicking sets yearFrom = yearTo = key (sent
     upstream as `inc`). Top 12 by count, rendered chronologically.
     The existing year from/to inputs stay beside the row for ranges.
   - **Collection**: single-select; clicking replaces.
   - Counts formatted compactly (`1.2k`) with a leading `~`.
3. The mediatype `<select>` is removed.

The strip re-renders from each Items response, so chip counts follow the
post-filter behaviour of the endpoint.

### Expanded row

After the description, before the iframe:

- **Chips row**: collection chips (`in: byte-magazine`) and subject chips
  (`# Apple II`), from `/api/item`. Click → set the filter, activate the
  Items tab, reload. Subject strings are split on ';' (IA often stores one
  joined string), trimmed, de-duplicated, empty values dropped; subject chips
  capped at 10.

After the file list, before the "on archive.org" link:

- **Related** heading and up to 6 rows built with `makeRow({ expandable: true })`,
  fetched from `/api/related/:id` after the item detail rendered. Failure
  or empty → one muted line ("No related items" / "Couldn't load related
  items"), appended, never clearing what's above. Related rows expand
  inline like any other row (their detail sits inside the parent detail;
  clicks do not bubble to the parent row because `.detail` is a sibling of
  `.row`, not a child).

### Rows

- Expandable rows get `tabindex="0"`, `role="button"`, and toggle on Enter
  and Space (follow-up #3).

### Load More

- Items and Full-text: `more.hidden = data.returned < HITS_PER_PAGE || rows.length === 0`.
  The `total`-based check is gone (fulltext `total` is file-level and was
  never a page count).

## Error handling

- Items upstream failure: existing per-tab status + Retry. Strip and bar
  keep their last state.
- `facets: null`: strip hidden, rows render.
- Related failure: inline line inside the detail only.
- Item detail failure: unchanged (collapse and re-expand retries).

## Testing

node:test, fixtures captured live into `test/fixtures/`:

- `pp-metadata.json` (apple II, 2 hits, 3 aggregations), `pp-metadata-filtered.json`
  (mediatype texts + year range), `related.json`. The existing
  `metadata.json` (string `subject`, array `collection`) covers the item
  normalisation cases. The existing `fts.json` already carries
  title/year/mediatype fields and stays as is; `advancedsearch.json` is
  deleted with `lib/items.js`.
- `search.test.js`: filter_map key order and value sorting produce a
  stable URL; no filters → no `filter_map`; aggregations list vs `false`;
  reshape items (array/string normalisation); year buckets ascending and
  capped at 12; collection capped at 20; missing aggregations → null;
  `returned` passthrough.
- `fulltext.test.js`: fields read directly; title lookup tests removed.
- `related.test.js`: unwrap arrays, cap 6, empty for `total.value=0`.
- `item.test.js`: collection/subject normalisation; `.thumbs` jpg skipped.
- `scripts/smoke.mjs`: items with `mediatype=texts&yearFrom=1983&yearTo=1985`
  asserts `facets.mediatype.length > 0` and every item year in range;
  `/api/related/byte-magazine-1982-05-rescan` returns ≥ 1; fulltext hits
  carry titles.
- Headless puppeteer (`scripts/verify.mjs` pattern from v1): search,
  click the `texts` chip → a pill appears and all visible rows say texts;
  expand a row, click a collection chip → collection pill appears and the
  list reloads; Full-text Load More hides on a short last page.

## Collateral

- README route table and params.
- v1 spec: endpoint table row for `/api/items`, and the "What it is not"
  risk statement (three undocumented tabs).
- `package.json` unchanged (no new deps).

## Open follow-ups after this round

- Wayback: expand Web-tab rows (sparkline, latest snapshot, limited CDX)
  or URL mode. Verified endpoints and the CDX scoping constraint are in
  the 2026-09-11 session notes; needs its own spec.
- Unauthenticated public proxy (v1 follow-up #5) still open.
