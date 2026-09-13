import { ftsSnippet } from './snippets.js';
import { buildSearchUrl, asString } from './search.js';

const MAX_SNIPPETS_PER_ITEM = 4;

export function buildFtsUrl({ q, page = 1, hitsPerPage = 20 }) {
  return buildSearchUrl({ q, page, hitsPerPage, backend: 'fts' });
}

// FTS returns one hit per *file*; several files can belong to one item, so
// hits are grouped by identifier and snippets accumulate up to the cap.
// `total` is file-level — never derive page counts from it.
export function reshapeFts(ftsJson) {
  const hitsObj = ftsJson?.response?.body?.hits ?? { total: 0, returned: 0, hits: [] };
  const byId = new Map();
  for (const h of hitsObj.hits ?? []) {
    const f = h.fields ?? {};
    const id = f.identifier;
    if (!id) continue;
    if (!byId.has(id)) {
      byId.set(id, { identifier: id, title: asString(f.title), year: f.year ?? null, mediatype: f.mediatype ?? null, snippets: [] });
    }
    const entry = byId.get(id);
    for (const raw of h.highlight?.text ?? []) {
      if (entry.snippets.length < MAX_SNIPPETS_PER_ITEM) entry.snippets.push(ftsSnippet(raw));
    }
  }
  return {
    total: hitsObj.total ?? 0,
    returned: hitsObj.returned ?? (hitsObj.hits ?? []).length,
    hits: [...byId.values()],
  };
}
