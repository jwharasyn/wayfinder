// Captures the README screenshots against the real app + live archive.org.
// Requires Google Chrome.app. Output: docs/screenshots/*.png (1280×800 @2x).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const PORT = 3125;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname;
const ITEMS = 'main .pane[data-pane="items"]';
const FULLTEXT = 'main .pane[data-pane="fulltext"]';
mkdirSync(OUT, { recursive: true });

const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));

let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(45_000);
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}${name}.png` });
    console.log(`wrote docs/screenshots/${name}.png`);
  };
  const search = async (q) => {
    await page.$eval('#q', (el) => { el.value = ''; });
    await page.type('#q', q);
    await page.click('#search-form button[type="submit"]');
  };
  const imagesSettled = (scope) => page.waitForFunction((sel) => {
    const imgs = [...document.querySelectorAll(`${sel} .row img`)].slice(0, 5);
    return imgs.length > 0 && imgs.every((i) => i.complete);
  }, {}, scope);
  // The archive.org embed reports load/readyState well before the book page is
  // on screen; wait for a real page image inside the frame, then let it settle.
  const viewerPainted = async (scope) => {
    const handle = await page.waitForSelector(`${scope} .detail:not([hidden]) iframe`);
    const frame = await handle.contentFrame();
    if (!frame) return;
    await frame.waitForFunction(() => [...document.images].some((i) => i.complete && i.naturalWidth > 300));
    await new Promise((r) => setTimeout(r, 4000));
  };

  await page.goto(`http://localhost:${PORT}/`);

  // 1. Items with the texts facet selected.
  await search('apple II');
  await page.waitForSelector('.facet-row[data-facet="mediatype"] .chip');
  // Type's blind has to be open for its pills to be clickable (and visible in the shot);
  // Year and Collection stay closed so their summaries are what the screenshot shows.
  await page.click('.facet-row[data-facet="mediatype"] .facet-head');
  await page.waitForSelector('.facet-row[data-facet="mediatype"] .facet-body:not([hidden])');
  const texts = await page.$('.facet-row[data-facet="mediatype"] .chip[data-key="texts"]');
  await (texts ?? (await page.$('.facet-row[data-facet="mediatype"] .chip'))).click();
  await page.waitForSelector('#active .pill');
  await page.waitForSelector(`${ITEMS} .row`);
  await imagesSettled(ITEMS);
  await shot('items');

  // 2. First row expanded: chips, viewer, related.
  await page.click(`${ITEMS} .row`);
  await page.waitForSelector(`${ITEMS} .detail:not([hidden]) .chips-row`);
  await page.waitForFunction(() => {
    const r = document.querySelector('main .pane[data-pane="items"] .detail:not([hidden]) .related');
    return r && (r.querySelector('h4') || r.textContent.startsWith('No related'));
  });
  // Scroll first: the viewer iframe is loading="lazy", so it only starts
  // fetching once it is on screen. Then wait for BookReader to actually paint —
  // "load" fires long before the first page image is composited (black box).
  await page.$eval(`${ITEMS} .detail:not([hidden])`, (el) => el.scrollIntoView({ block: 'start' }));
  await viewerPainted(ITEMS);
  await page.$eval(`${ITEMS} .detail:not([hidden])`, (el) => el.scrollIntoView({ block: 'start' }));
  await shot('expanded');

  // 3. Full-text result list with highlighted snippets.
  await page.click('.tab[data-tab="fulltext"]');
  await search('fusion anomaly');
  await page.waitForSelector(`${FULLTEXT} .row .snippet mark`);
  await imagesSettled(FULLTEXT);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('fulltext');

  // 4. Web tab.
  await page.click('.tab[data-tab="web"]');
  await search('fusionanomaly');
  await page.waitForSelector('main .pane[data-pane="web"] .row');
  await shot('web');
} finally {
  try { if (browser) await browser.close(); } finally { server.kill(); }
}
