export function createCache({ ttlMs = 600_000, max = 200 } = {}) {
  const map = new Map(); // insertion order = age
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (Date.now() > e.expires) {
        map.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value) {
      if (map.size >= max && !map.has(key)) {
        map.delete(map.keys().next().value);
      }
      map.set(key, { value, expires: Date.now() + ttlMs });
    },
  };
}
