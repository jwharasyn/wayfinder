// be-api is a third undocumented host (Elasticsearch-shaped). Isolated here so
// a breakage only loses the "Related" section of an expanded row.
const BASE = 'https://be-api.us.archive.org/mds/v1/get_related/all/';
const MAX_RELATED = 6;

const first = (v) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export function relatedUrl(id) {
  return BASE + encodeURIComponent(id);
}

function yearOf(s) {
  const y = Number(first(s.year));
  if (Number.isInteger(y) && y > 0) return y;
  const d = first(s.date); // content date; publicdate is the upload date and would mislead
  const fromDate = d ? Number(String(d).slice(0, 4)) : NaN;
  return Number.isInteger(fromDate) && fromDate > 0 ? fromDate : null;
}

export function reshapeRelated(json) {
  const hits = json?.hits?.hits ?? [];
  const items = hits
    .slice(0, MAX_RELATED)
    .map((h) => {
      const s = h._source ?? {};
      return {
        identifier: h._id ?? null,
        title: first(s.title),
        mediatype: first(s.mediatype),
        year: yearOf(s),
        downloads: Number(first(s.downloads)) || 0,
      };
    })
    .filter((it) => it.identifier);
  return { items };
}
