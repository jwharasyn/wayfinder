export function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Escape FIRST, then convert the escaped marker forms to <mark>.
export function ftsSnippet(raw) {
  return escapeHtml(raw)
    .replaceAll('{{{', '<mark>')
    .replaceAll('}}}', '</mark>');
}

export function insideSnippet(raw) {
  return escapeHtml(raw)
    .replaceAll('&lt;IA_FTS_MATCH&gt;', '<mark>')
    .replaceAll('&lt;/IA_FTS_MATCH&gt;', '</mark>');
}

export function webSnippet(raw) {
  return escapeHtml(raw)
    .replaceAll('&lt;b&gt;', '<mark>')
    .replaceAll('&lt;/b&gt;', '</mark>');
}
