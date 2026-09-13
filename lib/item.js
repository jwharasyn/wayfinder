import { asArray } from './search.js';

const SKIP_NAME = /(_meta\.xml|_files\.xml|_meta\.sqlite)$/;
// Exact matches for the plumbing formats; Log/Index stay substring matches as before.
const SKIP_FORMAT = /^(Metadata|Thumbnail)$|Log|Index/i;

export function reshapeItem(metaJson) {
  const id = metaJson?.metadata?.identifier ?? null;
  const md = metaJson?.metadata ?? {};
  const files = (metaJson?.files ?? [])
    .filter((f) => f.name && !SKIP_NAME.test(f.name) && !SKIP_FORMAT.test(f.format ?? ''))
    .map((f) => ({
      name: f.name,
      size: f.size != null ? Number(f.size) : null,
      format: f.format ?? null,
      url: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`,
    }))
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, 50);
  return {
    identifier: id,
    title: md.title ?? null,
    description: Array.isArray(md.description) ? md.description.join(' ') : (md.description ?? null),
    mediatype: md.mediatype ?? null,
    collection: asArray(md.collection),
    subject: asArray(md.subject),
    embedUrl: `https://archive.org/embed/${id}`,
    detailsUrl: `https://archive.org/details/${id}`,
    files,
  };
}
