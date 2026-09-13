import { insideSnippet } from './snippets.js';

export function insideUrl(metaJson, q) {
  const id = metaJson?.metadata?.identifier;
  const { server, dir } = metaJson ?? {};
  if (!id || !server || !dir) return null;
  const u = new URL(`https://${server}/fulltext/inside.php`);
  u.searchParams.set('item_id', id);
  u.searchParams.set('doc', id);
  u.searchParams.set('path', dir);
  u.searchParams.set('q', q);
  return u.toString();
}

export function reshapeInside(insideJson) {
  const matches = (insideJson.matches ?? []).slice(0, 20).map((m) => ({
    html: insideSnippet(m.text ?? ''),
    page: Number.isInteger(m.par?.[0]?.page) ? m.par[0].page + 1 : null,
  }));
  return { matches };
}
