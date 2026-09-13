import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, REPO_URL } from '../lib/app.js';

const jsonResponse = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function withServer(app, fn) {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => srv.close(r)); }
}

test('/api/config reports the demo flag and repo url', async () => {
  await withServer(createApp({ demo: false }), async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), { demo: false, repo: REPO_URL });
  });
  await withServer(createApp({ demo: true }), async (base) => {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).demo, true);
  });
});

test('demo: per-client 429 after the client budget; config is exempt', async () => {
  const app = createApp({ demo: true, clientPerMinute: 2, globalPerMinute: 100, fetchImpl: jsonResponse([]) });
  await withServer(app, async (base) => {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${base}/api/web?q=x${i}`)).status);
    assert.deepEqual(codes, [200, 200, 429]);
    const body = await (await fetch(`${base}/api/web?q=x9`)).json();
    assert.equal(body.error, 'Slow down — the demo allows about 30 searches a minute.');
    assert.equal((await fetch(`${base}/api/config`)).status, 200);
  });
});

test('demo: global budget is charged only on cache misses → 503 with the self-host link', async () => {
  let upstream = 0;
  const fetchImpl = async () => { upstream++; return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const app = createApp({ demo: true, clientPerMinute: 100, globalPerMinute: 1, fetchImpl });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/web?q=same`)).status, 200);
    assert.equal((await fetch(`${base}/api/web?q=same`)).status, 200, 'cache hit costs no budget');
    const r = await fetch(`${base}/api/web?q=other`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, `The demo is busy right now — run your own copy: ${REPO_URL}`);
    assert.equal(upstream, 1, 'exactly one upstream fetch happened');
  });
});

test('non-demo: no limits; upstream failure → 502 with the upstream message', async () => {
  const app = createApp({ demo: false, fetchImpl: async () => new Response('nope', { status: 500 }) });
  await withServer(app, async (base) => {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/api/web?q=x`);
      assert.equal(r.status, 502);
      assert.match((await r.json()).error, /upstream 500/);
    }
  });
});

test('missing q still fails fast without touching upstream', async () => {
  let upstream = 0;
  const app = createApp({ demo: true, fetchImpl: async () => { upstream++; return new Response('[]', { status: 200 }); } });
  await withServer(app, async (base) => {
    assert.equal((await fetch(`${base}/api/items`)).status, 502);
    assert.equal(upstream, 0);
  });
});

test('demo: stats line aggregates requests, upstream, cache hits, 429s, 503s; counters reset', async () => {
  const lines = [];
  const app = createApp({ demo: true, clientPerMinute: 3, globalPerMinute: 1, statsIntervalMs: 0, log: (l) => lines.push(l), fetchImpl: jsonResponse([]) });
  await withServer(app, async (base) => {
    await fetch(`${base}/api/web?q=a`); // miss → upstream
    await fetch(`${base}/api/web?q=a`); // hit
    await fetch(`${base}/api/web?q=b`); // miss → global budget spent → 503
    await fetch(`${base}/api/web?q=c`); // 4th request → 429
    await fetch(`${base}/api/config`);  // never counted
    app.locals.flushStats();
    assert.deepEqual(lines, ['demo stats: requests=4 upstream=1 cache_hits=1 limited_429=1 busy_503=1 active_clients=1']);
    app.locals.flushStats();
    assert.equal(lines[1], 'demo stats: requests=0 upstream=0 cache_hits=0 limited_429=0 busy_503=0 active_clients=1', 'counters reset; client map persists');
  });
});

test('non-demo: flushStats logs nothing', async () => {
  const lines = [];
  const app = createApp({ demo: false, log: (l) => lines.push(l), fetchImpl: jsonResponse([]) });
  await withServer(app, async (base) => { await fetch(`${base}/api/web?q=a`); app.locals.flushStats(); });
  assert.deepEqual(lines, []);
});

test('DEMO_STATS_INTERVAL_MS=0 or a non-numeric value disables the stats interval', () => {
  const saved = process.env.DEMO_STATS_INTERVAL_MS;
  try {
    process.env.DEMO_STATS_INTERVAL_MS = '0';
    assert.equal(createApp({ demo: true, log: () => {} }).locals.statsIntervalMs, 0);
    process.env.DEMO_STATS_INTERVAL_MS = 'abc';
    assert.equal(createApp({ demo: true, log: () => {} }).locals.statsIntervalMs, 0, 'garbage means off, not the default');
  } finally {
    if (saved === undefined) delete process.env.DEMO_STATS_INTERVAL_MS;
    else process.env.DEMO_STATS_INTERVAL_MS = saved;
  }
});

test('DEMO_STATS_INTERVAL_MS unset falls back to five minutes', () => {
  const saved = process.env.DEMO_STATS_INTERVAL_MS;
  try {
    delete process.env.DEMO_STATS_INTERVAL_MS;
    assert.equal(createApp({ demo: true, log: () => {} }).locals.statsIntervalMs, 300_000);
  } finally {
    if (saved !== undefined) process.env.DEMO_STATS_INTERVAL_MS = saved;
  }
});
