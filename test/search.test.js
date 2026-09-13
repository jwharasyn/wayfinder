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
