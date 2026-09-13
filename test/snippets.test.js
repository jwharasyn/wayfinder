import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ftsSnippet, insideSnippet, webSnippet, escapeHtml } from '../lib/snippets.js';

test('escapeHtml escapes all dangerous chars', () => {
  assert.equal(escapeHtml(`<script>"a" & 'b'</script>`),
    '&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;');
});

test('ftsSnippet converts {{{...}}} to mark and escapes the rest', () => {
  assert.equal(ftsSnippet('Data {{{fusion}}} <script>x</script>'),
    'Data <mark>fusion</mark> &lt;script&gt;x&lt;/script&gt;');
});

test('insideSnippet converts IA_FTS_MATCH tags to mark and escapes the rest', () => {
  assert.equal(insideSnippet('Algorithm <IA_FTS_MATCH>Fusion</IA_FTS_MATCH> <img src=x>'),
    'Algorithm <mark>Fusion</mark> &lt;img src=x&gt;');
});

test('webSnippet converts <b> tags to mark and escapes the rest', () => {
  assert.equal(webSnippet('<b>fusionanomaly</b> <script>x</script>'),
    '<mark>fusionanomaly</mark> &lt;script&gt;x&lt;/script&gt;');
});
