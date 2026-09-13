import { test } from 'node:test';
import assert from 'node:assert/strict';
import { iaFetch } from '../lib/ia.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = { ok: false, status: 503, json: async () => ({}) };

test('returns parsed json and sends User-Agent', async () => {
  let seenHeaders;
  const fetchImpl = async (url, opts) => { seenHeaders = opts.headers; return ok({ a: 1 }); };
  const result = await iaFetch('https://x.test/', { fetchImpl });
  assert.deepEqual(result, { a: 1 });
  assert.equal(seenHeaders['User-Agent'], 'wayfinder/1.0 (+https://github.com/jwharasyn/wayfinder)');
});

test('retries once on failure then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls === 1 ? fail : ok({ b: 2 }));
  assert.deepEqual(await iaFetch('https://x.test/', { fetchImpl }), { b: 2 });
  assert.equal(calls, 2);
});

test('throws after two failures with status in message', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return fail; };
  await assert.rejects(() => iaFetch('https://x.test/', { fetchImpl }), /503/);
  assert.equal(calls, 2);
});

test('retries on thrown network error', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    if (++calls === 1) throw new Error('socket hang up');
    return ok({ c: 3 });
  };
  assert.deepEqual(await iaFetch('https://x.test/', { fetchImpl }), { c: 3 });
});

test('network failures carry the cause code and host in the message', async () => {
  const fetchImpl = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
  await assert.rejects(() => iaFetch('https://x.test/p', { fetchImpl }), /^Error: fetch failed \(ECONNRESET\) from x\.test$/);
  const timeout = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  await assert.rejects(() => iaFetch('https://x.test/p', { fetchImpl: timeout }), /\(TimeoutError\) from x\.test/);
});
