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
