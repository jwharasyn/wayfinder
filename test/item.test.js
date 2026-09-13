import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reshapeItem } from '../lib/item.js';

const meta = JSON.parse(readFileSync(new URL('./fixtures/metadata.json', import.meta.url)));

test('reshapeItem maps fixture', () => {
  const out = reshapeItem(meta);
  assert.equal(out.identifier, meta.metadata.identifier);
  assert.equal(out.embedUrl, `https://archive.org/embed/${out.identifier}`);
  assert.equal(out.detailsUrl, `https://archive.org/details/${out.identifier}`);
  assert.ok(out.files.length > 0);
  for (const f of out.files) {
    assert.ok(f.url.startsWith(`https://archive.org/download/${out.identifier}/`));
    assert.ok(!f.name.endsWith('_meta.xml'), 'plumbing files must be filtered');
  }
  // sorted largest first
  const sizes = out.files.map((f) => f.size ?? 0);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});

test('reshapeItem encodes file names in urls', () => {
  const out = reshapeItem({ metadata: { identifier: 'x' }, files: [{ name: 'a file #1.pdf', size: '10', format: 'Text PDF' }] });
  assert.equal(out.files[0].url, 'https://archive.org/download/x/a%20file%20%231.pdf');
  assert.equal(out.files[0].size, 10);
});

test('reshapeItem caps at 50 files, keeping the largest', () => {
  const files = Array.from({ length: 60 }, (_, i) => ({ name: `f${i}.pdf`, size: String(i), format: 'Text PDF' }));
  const out = reshapeItem({ metadata: { identifier: 'x' }, files });
  assert.equal(out.files.length, 50);
  // sort runs before the cap, so the 50 biggest survive and f0..f9 are dropped
  assert.equal(out.files[0].name, 'f59.pdf');
  assert.equal(out.files[49].name, 'f10.pdf');
});

test('reshapeItem yields a null identifier for an empty metadata response', () => {
  // archive.org answers `{}` with HTTP 200 for an unknown item; the route turns this into a 404.
  const out = reshapeItem({});
  assert.equal(out.identifier, null);
  assert.equal(out.title, null);
  assert.deepEqual(out.files, []);
});

test('reshapeItem exposes collection and subject as arrays (fixture subject is a single string)', () => {
  const out = reshapeItem(meta);
  assert.deepEqual(out.collection, meta.metadata.collection);
  assert.equal(typeof meta.metadata.subject, 'string', 'fixture precondition');
  assert.deepEqual(out.subject, [meta.metadata.subject]);
  const empty = reshapeItem({ metadata: { identifier: 'x' }, files: [] });
  assert.deepEqual(empty.collection, []);
  assert.deepEqual(empty.subject, []);
});

test('reshapeItem skips Thumbnail-format files but keeps real content', () => {
  const out = reshapeItem({ metadata: { identifier: 'x' }, files: [
    { name: 'movie.thumbs/frame_000001.jpg', size: '9000', format: 'Thumbnail' },
    { name: 'movie.mp4', size: '100', format: 'h.264' },
    { name: 'catalog.pdf', size: '50', format: 'Text PDF' },
  ] });
  assert.deepEqual(out.files.map((f) => f.name), ['movie.mp4', 'catalog.pdf']);
});
