const UA = 'wayfinder/1.0 (+https://github.com/jwharasyn/wayfinder)';

async function attempt(url, timeoutMs, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`upstream ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Network-level failures surface as a bare "fetch failed"; fold in the cause's
// code (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, TimeoutError…) and the host so a
// 502 body says what actually happened.
function describe(err, url) {
  if (err?.message?.startsWith('upstream ')) return err;
  const code = err?.cause?.code || err?.cause?.name || err?.name || 'unknown';
  const out = new Error(`${err?.message ?? err} (${code}) from ${new URL(url).host}`);
  out.cause = err;
  return out;
}

export async function iaFetch(url, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  try {
    return await attempt(url, timeoutMs, fetchImpl);
  } catch {
    try {
      return await attempt(url, timeoutMs, fetchImpl); // one retry; second failure propagates
    } catch (err) {
      throw describe(err, url);
    }
  }
}
