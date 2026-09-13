import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWebUrl, reshapeWeb } from '../lib/web.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/web-anchor.json', import.meta.url)));

test('buildWebUrl', () => {
  assert.equal(buildWebUrl('fusion anomaly'),
    'https://web.archive.org/__wb/search/anchor?q=fusion+anomaly');
});

test('reshapeWeb maps fixture sites', () => {
  const out = reshapeWeb(fixture);
  assert.ok(out.sites.length > 0);
  const s = out.sites[0];
  assert.ok(s.name);
  assert.ok(s.link.startsWith('http'));
  assert.equal(s.waybackUrl, `https://web.archive.org/web/*/${s.link}`);
  assert.ok(Number.isInteger(s.firstYear));
  assert.ok(s.captures >= 0);
  assert.ok(!s.snippetHtml.includes('<b>'), 'b tags must be converted');
});

test('reshapeWeb caps at 25 sites', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    display_name: `s${i}.test`, link: `http://s${i}.test/`, first_captured: 2000, capture: i, text: '<b>hit</b>',
  }));
  const out = reshapeWeb(rows);
  assert.equal(out.sites.length, 25);
  assert.equal(out.sites[0].name, 's0.test', 'cap must keep the first 25, in order');
  assert.equal(out.sites[24].name, 's24.test');
});

test('reshapeWeb escapes html and tolerates junk', () => {
  const out = reshapeWeb([{ name: 'x', link: 'http://x.test/', text: '<b>x</b><script>y</script>' }]);
  assert.equal(out.sites[0].snippetHtml, '<mark>x</mark>&lt;script&gt;y&lt;/script&gt;');
  assert.equal(reshapeWeb({}).sites.length, 0);
});
