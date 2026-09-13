import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFtsUrl, reshapeFts } from '../lib/fulltext.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/fts.json', import.meta.url)));

test('buildFtsUrl uses verified page_production params', () => {
  const u = new URL(buildFtsUrl({ q: 'fusion anomaly', page: 3 }));
  assert.equal(u.origin + u.pathname, 'https://archive.org/services/search/beta/page_production/');
  assert.equal(u.searchParams.get('service_backend'), 'fts');
  assert.equal(u.searchParams.get('user_query'), 'fusion anomaly');
  assert.equal(u.searchParams.get('page_type'), 'search_results');
  assert.equal(u.searchParams.get('page'), '3');
  assert.equal(u.searchParams.get('aggregations'), 'false');
});

test('reshapeFts groups per-file hits by identifier with marked snippets', () => {
  const out = reshapeFts(fixture);
  assert.ok(out.total > 0);
  const ids = out.hits.map((h) => h.identifier);
  assert.equal(new Set(ids).size, ids.length, 'identifiers must be unique');
  assert.ok(out.hits[0].snippets.length >= 1);
  assert.ok(out.hits[0].snippets[0].includes('<mark>'));
  assert.ok(!out.hits[0].snippets[0].includes('{{{'));
});

test('reshapeFts collapses multiple file hits into one hit per identifier', () => {
  // Real FTS returns one hit per *file*; several files can belong to one item.
  const doctored = { response: { body: { hits: { total: 3, hits: [
    { fields: { identifier: 'same', filename: 'a.txt' }, highlight: { text: ['{{{a}}}'] } },
    { fields: { identifier: 'other' }, highlight: { text: ['{{{c}}}'] } },
    { fields: { identifier: 'same', filename: 'b.txt' }, highlight: { text: ['{{{b}}}'] } },
  ] } } } };
  const out = reshapeFts(doctored);
  assert.equal(out.hits.length, 2, 'three file hits must collapse to two items');
  assert.deepEqual(out.hits.map((h) => h.identifier), ['same', 'other'], 'first-seen order preserved');
  assert.deepEqual(out.hits[0].snippets, ['<mark>a</mark>', '<mark>b</mark>'],
    'snippets from both files must accumulate on the one item');
});

test('reshapeFts caps snippets at 4 per identifier', () => {
  const many = { response: { body: { hits: { total: 1, hits: [
    { fields: { identifier: 'x' }, highlight: { text: ['{{{1}}}', '{{{2}}}', '{{{3}}}', '{{{4}}}', '{{{5}}}', '{{{6}}}'] } },
  ] } } } };
  assert.equal(reshapeFts(many).hits[0].snippets.length, 4, 'cap applies within a single hit');

  // The cap is per identifier, so it must also hold across several file hits.
  const spread = { response: { body: { hits: { total: 3, hits: [
    { fields: { identifier: 'x' }, highlight: { text: ['{{{1}}}', '{{{2}}}'] } },
    { fields: { identifier: 'x' }, highlight: { text: ['{{{3}}}', '{{{4}}}'] } },
    { fields: { identifier: 'x' }, highlight: { text: ['{{{5}}}', '{{{6}}}'] } },
  ] } } } };
  const out = reshapeFts(spread);
  assert.equal(out.hits.length, 1);
  assert.deepEqual(out.hits[0].snippets,
    ['<mark>1</mark>', '<mark>2</mark>', '<mark>3</mark>', '<mark>4</mark>'],
    'cap applies across accumulated file hits, keeping the first four');
});

test('reshapeFts escapes html in snippet text', () => {
  const doctored = { response: { body: { hits: { total: 1, hits: [
    { hit_type: 'text', fields: { identifier: 'x' }, highlight: { text: ['{{{a}}} <script>evil</script>'] } },
  ] } } } };
  const out = reshapeFts(doctored);
  assert.equal(out.hits[0].snippets[0], '<mark>a</mark> &lt;script&gt;evil&lt;/script&gt;');
});

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
