import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../lib/cache.js';

test('get returns what set stored', () => {
  const c = createCache({});
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
});

test('get returns undefined on miss', () => {
  const c = createCache({});
  assert.equal(c.get('nope'), undefined);
});

test('entries expire after ttlMs', async () => {
  const c = createCache({ ttlMs: 10 });
  c.set('a', 1);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.get('a'), undefined);
});

test('oldest entry evicted at max capacity', () => {
  const c = createCache({ max: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
});
