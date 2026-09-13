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

test('bucket ignores a clock that steps backwards', () => {
  const now = clock(3_600_000);
  const b = createBucket({ capacity: 2, refillPerMinute: 2, now });
  b.take(2);
  now.advance(-3_600_000); // one hour backwards, and it stays back
  assert.equal(b.take(), false, 'no refill on a backwards step');
  now.advance(30_000); // 30 s on from the stepped-back time → exactly 1 token
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
});

test('limiter reports the number of tracked clients', () => {
  const l = createLimiter({ perClient: { capacity: 1, refillPerMinute: 1 }, global: { capacity: 1, refillPerMinute: 1 }, now: clock(), maxClients: 5 });
  assert.equal(l.activeClients(), 0);
  l.client('a'); l.client('b'); l.client('a');
  assert.equal(l.activeClients(), 2);
});
