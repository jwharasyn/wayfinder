import path from 'node:path';
import express from 'express';
import { createCache } from './cache.js';
import { iaFetch } from './ia.js';
import { createLimiter } from './ratelimit.js';
import { buildSearchUrl, reshapeSearch } from './search.js';
import { buildFtsUrl, reshapeFts } from './fulltext.js';
import { insideUrl, reshapeInside } from './inside.js';
import { buildWebUrl, reshapeWeb } from './web.js';
import { reshapeItem } from './item.js';
import { relatedUrl, reshapeRelated } from './related.js';

export const REPO_URL = 'https://github.com/jwharasyn/wayfinder';
const SLOW_DOWN = 'Slow down — the demo allows about 30 searches a minute.';
const DEMO_BUSY = `The demo is busy right now — run your own copy: ${REPO_URL}`;

class DemoBusy extends Error {
  constructor() { super(DEMO_BUSY); this.status = 503; }
}

const envInt = (name, fallback) => Number(process.env[name]) || fallback;

// Unlike envInt, an explicit "0" here means "off", not "use the default".
const parseInterval = (raw, fallback) => (raw === undefined || raw === '' ? fallback : Math.max(0, Number(raw) || 0));

// The whole HTTP app. Options exist so tests can run it in-process with a
// stub upstream and a fake clock; production reads everything from env.
export function createApp({
  demo = process.env.DEMO_MODE === '1',
  cacheTtlMs = envInt('CACHE_TTL_MS', demo ? 1_800_000 : 600_000),
  clientPerMinute = envInt('DEMO_CLIENT_PER_MINUTE', 30),
  globalPerMinute = envInt('DEMO_GLOBAL_PER_MINUTE', 120),
  statsIntervalMs = parseInterval(process.env.DEMO_STATS_INTERVAL_MS, 300_000),
  fetchImpl = fetch,
  now = Date.now,
  log = console.log,
} = {}) {
  const app = express();
  const cache = createCache({ ttlMs: cacheTtlMs });
  const limiter = demo
    ? createLimiter({
        perClient: { capacity: clientPerMinute, refillPerMinute: clientPerMinute },
        global: { capacity: globalPerMinute, refillPerMinute: globalPerMinute },
        now,
      })
    : null;

  // Demo-only aggregate counters. Flushed to stdout as one line per interval so
  // traffic and cap hits are visible in the host's logs without per-request
  // logging, cookies, or third parties. Counters reset after each line.
  const stats = { requests: 0, upstream: 0, cacheHits: 0, limited429: 0, busy503: 0 };
  function flushStats() {
    if (!demo) return;
    log(`demo stats: requests=${stats.requests} upstream=${stats.upstream} cache_hits=${stats.cacheHits} limited_429=${stats.limited429} busy_503=${stats.busy503} active_clients=${limiter.activeClients()}`);
    for (const k of Object.keys(stats)) stats[k] = 0;
  }
  if (demo && statsIntervalMs > 0) setInterval(flushStats, statsIntervalMs).unref();
  app.locals.flushStats = flushStats; // tests call it directly
  app.locals.statsIntervalMs = statsIntervalMs; // tests assert the env parse without probing timers

  // The only path to archive.org: cache → (demo global budget) → upstream → cache.
  // The budget is charged on misses only, so cached repeats are free in a spike.
  async function fetchCached(url) {
    const hit = cache.get(url);
    if (hit) { stats.cacheHits++; return hit; }
    if (limiter && !limiter.global.take()) { stats.busy503++; throw new DemoBusy(); }
    stats.upstream++;
    const raw = await iaFetch(url, { fetchImpl });
    cache.set(url, raw);
    return raw;
  }

  // 502 for anything upstream-shaped; DemoBusy carries its own 503.
  const fail = (res, err) => res.status(err.status ?? 502).json({ error: String(err.message ?? err) });

  function proxyRoute(buildUrl, reshape) {
    return async (req, res) => {
      try {
        const raw = await fetchCached(buildUrl(req));
        res.json(await reshape(raw, req));
      } catch (err) {
        fail(res, err);
      }
    };
  }

  if (demo) {
    app.set('trust proxy', true); // Railway fronts the app; req.ip must be the real client
    app.use('/api', (req, res, next) => {
      if (req.path === '/config') return next();
      stats.requests++;
      if (!limiter.client(req.ip).take()) {
        stats.limited429++;
        return res.status(429).json({ error: SLOW_DOWN });
      }
      next();
    });
  }

  app.get('/api/config', (req, res) => res.json({ demo, repo: REPO_URL }));

  app.get('/api/items', proxyRoute(
    (req) => {
      if (!req.query.q) throw new Error('missing q');
      return buildSearchUrl({
        q: req.query.q,
        page: Number(req.query.page) || 1,
        filters: {
          mediatype: String(req.query.mediatype || '').split(',').filter(Boolean),
          yearFrom: req.query.yearFrom || '',
          yearTo: req.query.yearTo || '',
          collection: req.query.collection || '',
          subject: req.query.subject || '',
        },
        aggregations: ['mediatype', 'year', 'collection'],
      });
    },
    (raw) => reshapeSearch(raw),
  ));

  app.get('/api/fulltext', proxyRoute(
    (req) => {
      if (!req.query.q) throw new Error('missing q');
      return buildFtsUrl({ q: req.query.q, page: Number(req.query.page) || 1 });
    },
    (raw) => reshapeFts(raw),
  ));

  app.get('/api/inside', async (req, res) => {
    try {
      const { id, q } = req.query;
      if (!id || !q) throw new Error('missing id or q');
      const meta = await fetchCached(`https://archive.org/metadata/${encodeURIComponent(id)}`);
      const url = insideUrl(meta, q);
      if (!url) return res.json({ matches: [] }); // item has no search-inside index
      res.json(reshapeInside(await fetchCached(url)));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/web', proxyRoute(
    (req) => {
      if (!req.query.q) throw new Error('missing q');
      return buildWebUrl(req.query.q);
    },
    (raw) => reshapeWeb(raw),
  ));

  app.get('/api/related/:id', proxyRoute(
    (req) => relatedUrl(req.params.id),
    (raw) => reshapeRelated(raw),
  ));

  // Not proxyRoute: archive.org answers `{}` with HTTP 200 for an unknown identifier,
  // which must surface as a 404 rather than an item with null fields.
  app.get('/api/item/:id', async (req, res) => {
    try {
      const item = reshapeItem(await fetchCached(`https://archive.org/metadata/${encodeURIComponent(req.params.id)}`));
      if (!item.identifier) return res.status(404).json({ error: 'item not found' });
      res.json(item);
    } catch (err) {
      fail(res, err);
    }
  });

  // Anchored to this module, not process.cwd() — the server must work started from any directory.
  app.use(express.static(path.join(import.meta.dirname, '..', 'public')));
  return app;
}
