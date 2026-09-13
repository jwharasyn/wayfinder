import { webSnippet } from './snippets.js';

export function buildWebUrl(q) {
  const u = new URL('https://web.archive.org/__wb/search/anchor');
  u.searchParams.set('q', q);
  return u.toString();
}

export function reshapeWeb(anchorJson) {
  const rows = Array.isArray(anchorJson) ? anchorJson : [];
  return {
    sites: rows.slice(0, 25).map((r) => ({
      name: r.display_name ?? r.name ?? '',
      link: r.link ?? '',
      waybackUrl: r.link ? `https://web.archive.org/web/*/${r.link}` : '',
      firstYear: r.first_captured ?? null,
      lastYear: r.last_captured ?? null,
      captures: r.capture ?? 0,
      snippetHtml: webSnippet(r.text ?? ''),
    })),
  };
}
