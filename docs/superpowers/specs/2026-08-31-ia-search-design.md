# IA Search — Internet Archive search web app

**Date:** 2026-08-31
**Status:** Approved design, pre-implementation
**Repo:** private `jwharasyn/ia-search`, deployed on Railway (GitHub integration; John links the service)

## Purpose

A personal, fast search front-end for the Internet Archive. One search
field, three modes, inline previews, direct download links. Primarily
used from desktop; responsive so it still works on a phone.

## What it is not (v1)

- No accounts, no auth beyond whatever Railway env gating we add later.
- No search history / saved results / database.
- No full-text search of archived *web pages* (IA has no public index);
  the Web tab is best-effort site-name matching only.
- No build step, no frontend framework.
- (2026-09-11) All three tabs now depend on undocumented endpoints; the
  documented `advancedsearch.php` is no longer used. Each is isolated in its
  own `lib/` module so breakage stays per-tab.

## Architecture

Single Node service on Railway:

- **Server** (`server.js`, minimal Express): serves the
  static frontend and exposes ~5 proxy routes to archive.org. The proxy
  exists because two of the IA endpoints are undocumented and may not
  send CORS headers, and it gives one place for caching, retries, and
  response reshaping.
- **Frontend** (`public/`): single-page vanilla JS + CSS. Desktop-first
  layout, responsive down to phone widths.

`dns.setDefaultResultOrder("ipv4first")` at server startup (Railway
IPv6 → outbound HTTPS hang fix).

## API routes

| Route | Backs onto | Notes |
|---|---|---|
| `GET /api/items?q=&mediatype=&yearFrom=&yearTo=&collection=&subject=&page=` | `page_production` metadata backend (undocumented) — superseded 2026-09-11, see `2026-09-11-search-facets-related-design.md` | Rows + facet counts in one call; `filter_map` scoping. |
| `GET /api/fulltext?q=&page=` | archive.org search "text contents" mode (undocumented page-production endpoint) | Verify the exact endpoint/params against live traffic during implementation — do not trust blog posts. Returns items whose *content* matches, with snippets when the endpoint provides them. |
| `GET /api/inside?id=&q=` | `fulltext/inside.php` on the item's server | Per-item search-inside: matched snippets + page numbers. Used when a full-text result is expanded. |
| `GET /api/web?q=` | `web.archive.org/__wb/search/...` | Undocumented site-name/anchor matching. Best-effort; degrade gracefully if it breaks. |
| `GET /api/item/:id` | `archive.org/metadata/:id` | Documented. Description, file list → direct download URLs (`archive.org/download/{id}/{file}`). |
| `GET /api/related/:id` | `be-api.us.archive.org/mds/v1/get_related/all/:id` | Undocumented. ≤ 6 related items for an expanded row; degrades to one inline line. |

Thumbnails come straight from `archive.org/services/img/{id}` in the
frontend (public, CORS-irrelevant for `<img>`).

**Caching:** in-memory LRU-ish map (query → response, TTL ~10 min,
capped entries). IA is slow; repeat queries should be instant. No
persistence.

**Errors:** IA endpoints time out and rate-limit. Each proxy route:
one retry, then a clean JSON error the frontend renders as a
per-tab message ("archive.org didn't respond — retry"). Never a blank
screen.

## Frontend

- One persistent search field at top. Three tabs: **Items** /
  **Full-text** / **Web**. The query persists across tab switches; a
  tab fetches lazily on first view of the current query.
- **Items tab filters:** mediatype (all / texts / audio / movies /
  software / image) and year range. Nothing else in v1.
- **Result rows:** thumbnail, title, year/mediatype, snippet.
  "Load more" button for paging (advancedsearch supports paging).
- **Expanded result (inline, no new tabs):** description, file list
  with direct download links, and an embedded archive.org viewer
  (`archive.org/embed/{id}` iframe — BookReader/AV player as
  appropriate). On the Full-text tab, expansion also calls
  `/api/inside` and shows matched snippets with page numbers.
- Plain `<a href>` for downloads; browser handles them.

## Testing

- `node:test` suite for the server: response reshaping functions
  (pure), cache behavior, error mapping. IA calls mocked with recorded
  fixtures.
- One live smoke script (`scripts/smoke.mjs`) hitting real IA through
  the running server — run manually, not in CI, since it depends on
  archive.org being up.
- Frontend verified against the deployed IT/Railway instance (no
  localhost testing per John's workflow), headless-checked with
  puppeteer-core + Chrome.app before pushing.

## Risks

- The full-text and web endpoints are undocumented and can change or
  disappear. Isolate each behind its own module so breakage is
  contained to one tab.
- IA rate limits aggressively under load; personal use should stay
  well under, but the retry + cache layers are the mitigation.
