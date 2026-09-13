// Token buckets for demo mode. Refill is lazy (computed from elapsed time on
// each take) so there are no timers to leak. The clock is injectable for tests.
export function createBucket({ capacity, refillPerMinute, now = Date.now }) {
  let tokens = capacity;
  let last = now();
  return {
    take(n = 1) {
      const t = now();
      tokens = Math.min(capacity, tokens + (Math.max(0, t - last) / 60_000) * refillPerMinute);
      last = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
  };
}

// One shared `global` bucket plus a per-client bucket keyed by IP. The client
// map is bounded FIFO (oldest inserted evicted first), like lib/cache.js.
export function createLimiter({ perClient, global, now = Date.now, maxClients = 5000 }) {
  const clients = new Map();
  return {
    global: createBucket({ ...global, now }),
    client(ip) {
      let bucket = clients.get(ip);
      if (!bucket) {
        if (clients.size >= maxClients) clients.delete(clients.keys().next().value);
        bucket = createBucket({ ...perClient, now });
        clients.set(ip, bucket);
      }
      return bucket;
    },
    activeClients: () => clients.size,
  };
}
