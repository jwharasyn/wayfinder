// Builds public/hero.svg from public/favicon.svg and inlines it into
// public/index.html between the hero:start / hero:end markers.
//
// The favicon is one flat pile of shapes. The hero needs the compass ring and
// the clock hands to turn independently, so this splits that pile into <g>
// layers by index. The indices below are the favicon's own document order; if
// favicon.svg is ever re-drawn they will not survive, hence the hard child-count
// assertion — better a loud failure than a silently scrambled dial.
//
// Paint order is preserved where it can be seen: the ring layer holds only the
// gold rim and its markings (everything at r >= 298), the face layer the disc
// and its contents, so hoisting the ring below the face changes no pixels.
//
// Run: npm run hero  (idempotent — re-running yields no diff)
import { readFileSync, writeFileSync } from 'node:fs';

const PUBLIC = new URL('../public/', import.meta.url);
const GROUP_OPEN = '<g transform="translate(42 42)">';
const CHILD_COUNT = 78;

// index -> layer. The two hands get a layer each so each can turn at its own
// rate: hour first, minute second, so the long hand rides over the short one the
// way it does on a real clock. Within the old single hands layer the draw order
// was already 72, 73, 74, 71, so splitting it changes no pixels.
// The centre pin (75/76) goes in its own layer above both hands,
// which is where it sits in the favicon anyway; drawing it a second time under
// the hands as well costs 17 extra pixels of antialiasing drift (the dark r=9
// circle composites twice and its edge darkens by up to 48/255), so it is drawn
// exactly once.
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const LAYERS = [
  ['ring', [0, 3, 5, 6, 7]],                 // gold disc, rim stroke, band ticks, pointers, N/E/S/W
  ['face', [1, 2, 4, ...range(8, 70)]],      // bezel, cream face, hour ticks, labels, folder, search bar
  ['hour', [72]],                            // short angled arrow hand, 130u, pre-rotated 240°
  ['minute', [73, 74, 71]],                  // long down arrow: line 172u, chevron, base bar 186u
  ['pin', [75, 76]],                         // centre pin — the hands pivot under it
  // id "gloss" is already taken by a <linearGradient> in <defs>; "glass" keeps
  // the document's ids unique. No stylesheet references this layer.
  ['glass', [77]],                           // glass dome
];

// Splits an element's inner markup into its direct children. Depth-counts tags
// rather than parsing: no dependency, and the child-count assertion below is
// what actually guards it.
function splitChildren(inner) {
  const nodes = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)\b[^>]*?(\/?)>/g;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = tag.exec(inner))) {
    const closing = m[1] === '/';
    const selfClosing = m[3] === '/';
    if (closing) {
      depth -= 1;
      if (depth === 0) { nodes.push(inner.slice(start, tag.lastIndex)); start = -1; }
      if (depth < 0) throw new Error('unbalanced markup in the translate group');
      continue;
    }
    if (depth === 0) start = m.index;
    if (selfClosing) { if (depth === 0) { nodes.push(inner.slice(start, tag.lastIndex)); start = -1; } }
    else depth += 1;
  }
  if (depth !== 0) throw new Error('unbalanced markup in the translate group');
  return nodes;
}

const favicon = readFileSync(new URL('favicon.svg', PUBLIC), 'utf8');

// The C2PA manifest is provenance for the icon file, not markup the page needs.
let svg = favicon
  .replace(/<metadata>[\s\S]*?<\/metadata>/, '')
  .replace(/\s+xmlns:c2pa="[^"]*"/, '');

// Drop width/height so CSS sizes the inline copy; declare the layer role.
svg = svg.replace(/<svg\b[^>]*>/, (open) => {
  const viewBox = /viewBox="([^"]*)"/.exec(open);
  if (!viewBox) throw new Error('favicon.svg has no viewBox');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox[1]}"`
    + ' preserveAspectRatio="xMidYMid meet" class="dial" aria-hidden="true" focusable="false">';
});

const open = svg.indexOf(GROUP_OPEN);
if (open === -1) throw new Error(`favicon.svg no longer contains ${GROUP_OPEN}`);
const innerStart = open + GROUP_OPEN.length;
// Walk forward to the </g> that closes the translate group.
const innerEnd = (() => {
  const tag = /<(\/?)g\b[^>]*?(\/?)>/g;
  tag.lastIndex = innerStart;
  let depth = 0;
  let m;
  while ((m = tag.exec(svg))) {
    if (m[1] === '/') { if (depth === 0) return m.index; depth -= 1; }
    else if (m[2] !== '/') depth += 1;
  }
  throw new Error('the translate group is never closed');
})();
const children = splitChildren(svg.slice(innerStart, innerEnd));
if (children.length !== CHILD_COUNT) {
  throw new Error(`expected ${CHILD_COUNT} children in the translate group, found ${children.length}`
    + ' — favicon.svg changed shape; re-derive the layer indices before trusting this script');
}
const covered = new Set(LAYERS.flatMap(([, idx]) => idx));
for (let i = 0; i < CHILD_COUNT; i += 1) {
  if (!covered.has(i)) throw new Error(`child ${i} is not assigned to a layer`);
}

const layers = LAYERS
  .map(([id, idx]) => `<g id="${id}">\n${idx.map((i) => children[i].trim()).join('\n')}\n</g>`)
  .join('\n');
const hero = `${svg.slice(0, innerStart)}\n${layers}\n${svg.slice(innerEnd)}`
  .replace(/\n{3,}/g, '\n\n')
  .trim() + '\n';

writeFileSync(new URL('hero.svg', PUBLIC), hero);

// Inline the same markup into index.html. Static, first-party markup written at
// build time — the page itself never touches innerHTML.
const indexUrl = new URL('index.html', PUBLIC);
const index = readFileSync(indexUrl, 'utf8');
const block = /(<!-- hero:start -->)[\s\S]*?(<!-- hero:end -->)/;
if (!block.test(index)) throw new Error('index.html is missing the hero:start / hero:end markers');
writeFileSync(indexUrl, index.replace(block, `$1\n${hero.trim()}\n      $2`));

console.log(`hero.svg: ${CHILD_COUNT} children → ${LAYERS.map(([id, i]) => `${id} (${i.length})`).join(', ')}`);
console.log('index.html: hero block inlined');
