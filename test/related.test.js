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
