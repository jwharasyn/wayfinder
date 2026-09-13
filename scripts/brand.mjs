// Renders public/favicon.svg into every PNG brand asset (favicons, app icons,
// OG/Twitter cards). Chrome is the renderer, so what ships is exactly what a
// browser draws. Requires Google Chrome.app. Run after changing favicon.svg.
import { readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PUBLIC = new URL('../public/', import.meta.url);
const CREAM = '#faf8f4'; // the page --bg, and site.webmanifest's background_color
// The compass dial is only ~66% of the SVG's 1024 canvas (it spans 172–852), so
// drawing the artwork at the box size leaves the mark swimming in cream. Scale the
// <img> up by 1/DIAL_RATIO and clip the empty margin, so `box` sizes the DIAL.
const DIAL_RATIO = 0.66;

const svg = readFileSync(new URL('favicon.svg', PUBLIC));
const LOGO = `data:image/svg+xml;base64,${svg.toString('base64')}`;

const TARGETS = [
  { file: 'favicon-16.png', w: 16, h: 16, box: 16, bg: null },
  { file: 'favicon-32.png', w: 32, h: 32, box: 32, bg: null },
  { file: 'apple-touch-icon.png', w: 180, h: 180, box: 150, bg: CREAM },
  { file: 'icon-192.png', w: 192, h: 192, box: 160, bg: CREAM },
  { file: 'icon-512.png', w: 512, h: 512, box: 428, bg: CREAM },
  { file: 'og-image.png', w: 1200, h: 630, box: 520, bg: CREAM },
  { file: 'twitter-card.png', w: 1200, h: 600, box: 500, bg: CREAM },
];

// A literal '#' in a data:text/html URL starts the fragment, so the cream would
// be truncated away. Base64 sidesteps the escaping question entirely.
const pageFor = ({ w, h, box, bg }) => {
  const art = box / DIAL_RATIO; // the whole canvas, sized so its dial lands at `box`
  const html = `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; padding: 0; }
body { width: ${w}px; height: ${h}px; display: flex; align-items: center; justify-content: center; overflow: hidden;${bg ? ` background: ${bg};` : ''} }
img { width: ${art}px; height: ${art}px; display: block; flex: none; }
</style><img src="${LOGO}" alt="">`;
  return `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
};

// launch() lives inside the try so a Chrome failure still reaches the finally.
let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  for (const t of TARGETS) {
    await page.setViewport({ width: t.w, height: t.h, deviceScaleFactor: 1 });
    await page.goto(pageFor(t));
    // load fires before the SVG is necessarily decoded; a blank PNG is the failure mode.
    await page.waitForFunction(() => document.images[0]?.complete && document.images[0].naturalWidth > 0);
    await page.screenshot({ path: new URL(t.file, PUBLIC).pathname, omitBackground: !t.bg });
    console.log(`wrote public/${t.file} (${t.w}×${t.h}, dial ${t.box}, art ${Math.round(t.box / DIAL_RATIO)}, ${t.bg ?? 'transparent'})`);
  }
} finally {
  if (browser) await browser.close();
}
