import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { insideUrl, reshapeInside } from '../lib/inside.js';

const meta = JSON.parse(readFileSync(new URL('./fixtures/metadata.json', import.meta.url)));
const inside = JSON.parse(readFileSync(new URL('./fixtures/inside.json', import.meta.url)));

test('insideUrl builds from metadata server and dir', () => {
  const u = new URL(insideUrl(meta, 'fusion'));
  assert.equal(u.hostname, meta.server);
  assert.equal(u.pathname, '/fulltext/inside.php');
  assert.equal(u.searchParams.get('item_id'), meta.metadata.identifier);
  assert.equal(u.searchParams.get('doc'), meta.metadata.identifier);
  assert.equal(u.searchParams.get('path'), meta.dir);
  assert.equal(u.searchParams.get('q'), 'fusion');
});

test('insideUrl returns null when server info missing', () => {
  assert.equal(insideUrl({ metadata: { identifier: 'x' } }, 'q'), null);
});

test('reshapeInside converts markers, adds 1-based pages, caps at 20', () => {
  const out = reshapeInside(inside);
  assert.ok(out.matches.length > 0 && out.matches.length <= 20);
  assert.ok(out.matches[0].html.includes('<mark>'));
  assert.ok(!out.matches[0].html.includes('IA_FTS_MATCH'));
  assert.equal(out.matches[0].page, inside.matches[0].par[0].page + 1);
});

test('reshapeInside escapes html in match text', () => {
  const out = reshapeInside({ matches: [{ text: '<IA_FTS_MATCH>a</IA_FTS_MATCH> <script>x</script>', par: [] }] });
  assert.equal(out.matches[0].html, '<mark>a</mark> &lt;script&gt;x&lt;/script&gt;');
  assert.equal(out.matches[0].page, null);
});
