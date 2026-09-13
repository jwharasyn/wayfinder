const base = process.argv[2] ?? 'http://localhost:3000';
const checks = [
  ['/api/items?q=aeron+chair', (d) => d.total > 0 && d.items[0].identifier && d.returned === d.items.length && d.facets && d.facets.mediatype.length > 0],
  ['/api/items?q=apple+II&mediatype=texts&yearFrom=1983&yearTo=1985', (d) => d.items.length > 0 && d.items.every((i) => i.mediatype === 'texts' && i.year >= 1983 && i.year <= 1985) && d.facets.mediatype.some((b) => b.key === 'software')],
  ['/api/fulltext?q=fusion+anomaly', (d) => d.total > 0 && d.hits[0].snippets[0].includes('<mark>') && typeof d.hits[0].title === 'string' && typeof d.returned === 'number'],
  ['/api/inside?id=DTIC_ADA466482&q=fusion', (d) => d.matches.length > 0],
  ['/api/web?q=fusionanomaly', (d) => d.sites.length > 0],
  ['/api/item/DTIC_ADA466482', (d) => d.files.length > 0 && d.files[0].url.includes('/download/')],
  ['/api/related/byte-magazine-1982-05-rescan', (d) => d.items.length > 0 && d.items[0].identifier],
  ['/api/config', (d) => typeof d.demo === 'boolean' && d.repo === 'https://github.com/jwharasyn/wayfinder'],
];
let failed = 0;
for (const [path, ok] of checks) {
  try {
    const res = await fetch(base + path);
    const body = await res.json();
    if (res.ok && ok(body)) console.log(`PASS ${path}`);
    else { failed++; console.log(`FAIL ${path} — ${res.status} ${JSON.stringify(body).slice(0, 120)}`); }
  } catch (err) {
    failed++;
    console.log(`FAIL ${path} — ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
