// Headless click-through against the real app + live IA. Run before pushing UI
// changes (reproduce-before-pushing rule). Requires Google Chrome.app.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const PORT = 3124;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };

// launch() lives inside the try: a Chrome launch failure must still reach the
// finally, or the server spawned above orphans on the port.
let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`http://localhost:${PORT}/`);

  // Palette: slate primary from the logo's clock hands, gold focus ring from
  // the dial's search bar. The default focus ring is the platform blue — the whole
  // point of the rule is that no blue survives on the focused box.
  await page.focus('#q');
  const palette = await page.evaluate(() => {
    const q = document.querySelector('#q');
    const cs = getComputedStyle(q);
    return {
      h1: getComputedStyle(document.querySelector('h1')).color,
      submit: getComputedStyle(document.querySelector('#search-form button[type="submit"]')).backgroundColor,
      tab: getComputedStyle(document.querySelector('.tab.active')).borderBottomColor,
      focused: q.matches(':focus'),
      border: cs.borderTopColor,
      fill: cs.backgroundColor,
      outline: cs.outlineStyle,
      shadow: cs.boxShadow,
    };
  });
  const paletteOk = palette.h1 === 'rgb(58, 74, 94)' && palette.submit === 'rgb(58, 74, 94)'
    && palette.tab === 'rgb(58, 74, 94)' && palette.focused
    && palette.border === 'rgb(138, 109, 51)' && palette.fill === 'rgb(251, 246, 232)'
    && palette.outline === 'none' && palette.shadow.includes('138, 109, 51');
  if (!paletteOk) console.log(`  detail: ${JSON.stringify(palette)}`);
  check(paletteOk, 'palette: slate primary, gold focus');

  // 0. Landing state: the dial greets you, the ✕ stays out of the way until you type.
  const landing = await page.evaluate(() => ({
    heroShown: !document.querySelector('#hero').hidden,
    heroClass: document.querySelector('#hero').className,
    live: document.querySelector('#hero').getAttribute('aria-live'),
    prompt: document.querySelector('#hero p').textContent,
    clearHidden: document.querySelector('#clear').hidden,
    hook: typeof window.__wf === 'object' && window.__wf !== null,
  }));
  check(landing.heroShown && landing.heroClass === 'idle' && landing.clearHidden
    && landing.live === 'polite' && landing.prompt === 'Search the Internet Archive' && landing.hook,
    `landing shows the idle dial in a polite live region, no ✕, test hook present (${JSON.stringify(landing)})`);

  // 0a. #filters is the Items-only facet pane; it used to keep its padding with
  // both children hidden, so the dial sat 12px lower on Items than on the other
  // two tabs and jumped as you switched.
  const heroTops = async () => {
    const tops = {};
    for (const tab of ['items', 'fulltext', 'web']) {
      await page.click(`.tab[data-tab="${tab}"]`);
      tops[tab] = await page.$eval('#hero', (el) => +el.getBoundingClientRect().top.toFixed(2));
    }
    await page.click('.tab[data-tab="items"]');
    return tops;
  };
  const spread = (tops) => Math.max(...Object.values(tops)) - Math.min(...Object.values(tops));
  const landingTops = await heroTops();
  check(spread(landingTops) <= 0.5, `landing: the dial sits at the same height on every tab (spread ${spread(landingTops)}px, ${JSON.stringify(landingTops)})`);

  // 0b. The dial is inline layered SVG now, not an <img>: the ring and the two
  // hands each need their own group and their own pivot. The hands run like a
  // clock run backwards — both counter-clockwise, the minute hand 12× the hour hand — so a frame paused
  // at a known time has exact angles to assert, not merely a direction.
  const dial = await page.evaluate(() => {
    const el = document.querySelector('#hero .dial');
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    const h = document.querySelector('#hero');
    h.classList.add('loading');
    // Pause all three at the same instant before reading anything: the angles and
    // the centres below have to describe one frame, not three.
    const groups = ['ring', 'minute', 'hour'].map((id) => document.querySelector(`#hero .dial #${id}`));
    if (groups.some((g) => !g)) { h.classList.remove('loading'); return { missing: true }; }
    for (const g of groups) for (const a of g.getAnimations()) { a.pause(); a.currentTime = 1000; }
    const angle = (g) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(g).transform);
      return +((Math.atan2(m.b, m.a) * 180) / Math.PI).toFixed(2);
    };
    const centre = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return [+(b.x + b.width / 2).toFixed(2), +(b.y + b.height / 2).toFixed(2)];
    };
    const [ring, minute, hour] = groups.map(angle);
    const out = {
      w: Math.round(r.width),
      h: Math.round(r.height),
      layers: [...el.querySelectorAll('g[id]')].map((g) => g.id),
      paused: groups.every((g) => g.getAnimations().every((a) => a.playState === 'paused')),
      spin: { ring, minute, hour },
      ringCentre: centre('#hero .dial #ring'),
      pinCentre: centre('#hero .dial #pin circle'),
    };
    h.classList.remove('loading');
    return out;
  });
  check(dial.w === 200 && dial.h === 200 && dial.layers.join() === 'ring,face,hour,minute,pin,glass',
    `the hero is a 200px dial layered ring,face,hour,minute,pin,glass (${dial.w}×${dial.h}, ${dial.layers?.join()})`);
  // 1000 ms of a 14 s turn = +25.71°; the hands go back in time: minute −90° (4 s turn), hour −7.5° (48 s).
  check(dial.paused && Math.abs(dial.spin.ring - 25.71) <= 1,
    `paused at 1000ms: the ring has turned +25.7° clockwise (${dial.spin.ring}°)`);
  check(Math.abs(dial.spin.minute + 90) <= 2,
    `paused at 1000ms: the minute hand is −90° counter-clockwise, a quarter of its 4s turn (${dial.spin.minute}°)`);
  check(Math.abs(dial.spin.hour + 7.5) <= 1,
    `paused at 1000ms: the hour hand is −7.5° counter-clockwise, exactly 1/12 of the minute hand (${dial.spin.hour}°)`);
  const offCentre = Math.hypot(dial.ringCentre[0] - dial.pinCentre[0], dial.ringCentre[1] - dial.pinCentre[1]);
  check(offCentre <= 0.5,
    `the turning ring stays concentric with the centre pin (${offCentre.toFixed(2)}px apart: ring ${dial.ringCentre}, pin ${dial.pinCentre})`);

  // 0c. The footer is a centred one-liner under a centred page.
  const footerAlign = await page.evaluate(() => getComputedStyle(document.querySelector('footer')).textAlign);
  check(footerAlign === 'center', `the footer text is centred (text-align: ${footerAlign})`);

  // 1. Search → facet strip renders with ~counts.
  await page.type('#q', 'apple II');
  check(await page.$eval('#clear', (el) => !el.hidden), '✕ appears as soon as the box has text');
  await page.click('#search-form button[type="submit"]');
  // Read the hero before awaiting anything: on a fast response the spinner is
  // already gone by the time a waitForSelector resolves.
  const spinning = await page.evaluate(() => {
    const h = document.querySelector('#hero');
    return { cls: h.className, hidden: h.hidden, text: h.querySelector('p').textContent };
  });
  check((spinning.cls === 'loading' && spinning.text === 'Searching…') || spinning.hidden,
    `hero shows loading (announcing "Searching…") or results already landed (${JSON.stringify(spinning)})`);
  await page.waitForSelector('.facet-row[data-facet="mediatype"] .chip');
  check(await page.$eval('#hero', (el) => el.hidden), 'hero is out of the way once results render');
  const firstChip = await page.$eval('.facet-row[data-facet="mediatype"] .chip', (el) => ({ key: el.dataset.key, text: el.textContent }));
  check(firstChip.text.includes('~'), `type chip shows approximate count: "${firstChip.text}"`);
  // Collections are containers, not a type people filter results by; the Collection facet covers them.
  const rawHasCollection = await page.evaluate(() => fetch('/api/items?q=apple%20II').then((r) => r.json()).then((d) => d.facets.mediatype.some((b) => b.key === 'collection')));
  const collTypeChips = await page.$$eval('.facet-row[data-facet="mediatype"] .chip[data-key="collection"]', (els) => els.length);
  check(collTypeChips === 0, `Type facet hides mediatype=collection (chips ${collTypeChips}; raw facet offers it: ${rawHasCollection})`);

  // 2. Click the Type chip → pill appears, every visible row carries that mediatype, sibling counts remain.
  // Pills live inside a collapsed blind; open it first or the click has nothing to hit.
  await page.click('.facet-row[data-facet="mediatype"] .facet-head');
  const typeOpen = await page.$eval('.facet-row[data-facet="mediatype"] .facet-head', (el) => el.getAttribute('aria-expanded'));
  check(typeOpen === 'true', 'Type blind opens on header click');
  await page.click('.facet-row[data-facet="mediatype"] .chip');
  await page.waitForSelector('#active .pill');
  await page.waitForFunction((k) => {
    const rows = [...document.querySelectorAll('main .pane[data-pane="items"] .row .meta')];
    return rows.length > 0 && rows.every((m) => m.textContent.includes(k));
  }, {}, firstChip.key);
  const pill = await page.$eval('#active .pill', (el) => el.textContent);
  check(pill.includes(firstChip.key), `active pill "${pill}" names the selected type`);
  const typeChips = await page.$$eval('.facet-row[data-facet="mediatype"] .chip', (els) => els.length);
  check(typeChips >= 2, `type row still lists ${typeChips} types after filtering (post-filter facets)`);
  const selected = await page.$eval('.facet-row[data-facet="mediatype"] .chip.selected', (el) => el.dataset.key);
  check(selected === firstChip.key, 'selected chip is highlighted');

  // 3. Year chip → single-year pill.
  await page.click('.facet-row[data-facet="year"] .facet-head');
  const yearKey = await page.$eval('.facet-row[data-facet="year"] .chip', (el) => el.dataset.key);
  await page.click('.facet-row[data-facet="year"] .chip');
  await page.waitForFunction((y) => [...document.querySelectorAll('#active .pill')].some((p) => p.textContent.includes(y)), {}, yearKey);
  check(await page.$('#active .pill.clear') !== null, 'Clear all appears with two filters');

  // Blinds survive the re-render a pill click triggers, and closed facets describe themselves.
  // Wait for the reloaded list first: renderFacets runs in the same task that appends the rows,
  // so a row on screen is proof the facets (and blinds) have actually been re-rendered.
  await page.waitForSelector('main .pane[data-pane="items"] .row');
  const stillOpen = await page.$eval('.facet-row[data-facet="mediatype"] .facet-head', (el) => el.getAttribute('aria-expanded'));
  check(stillOpen === 'true', 'Type blind stays open across a filter reload');
  const collSummary = await page.$eval('.facet-row[data-facet="collection"] .facet-summary', (el) => el.textContent);
  check(/\d+ collections/.test(collSummary), `closed Collection blind summarises itself: "${collSummary}"`);

  // 4. Expand a row → chips + related. (The year click emptied and reloaded the list.)
  await page.waitForSelector('main .pane[data-pane="items"] .row');
  await page.click('main .pane[data-pane="items"] .row');
  await page.waitForSelector('main .pane[data-pane="items"] .detail:not([hidden]) .chips-row .chip.scope');
  await page.waitForFunction(() => {
    const r = document.querySelector('main .pane[data-pane="items"] .detail:not([hidden]) .related');
    return r && !r.textContent.startsWith('Loading');
  });
  const relatedText = await page.$eval('main .pane[data-pane="items"] .detail:not([hidden]) .related', (el) => el.textContent);
  check(relatedText.includes('Related') || relatedText.includes('No related'), `related section settled: "${relatedText.slice(0, 40)}"`);

  // 4b. Description sanitiser: hostile input never yields executable markup; real HTML renders formatted.
  const hostile = '<div>Hi <script>window.__pwned=1</script><img src=x onerror="window.__pwned=1"><a href="javascript:alert(1)">bad</a> <a href="https://example.org/" onclick="x()">ok</a> &amp; <b>bold</b></div><div><br></div><p>Second</p>';
  const san = await page.evaluate((h) => {
    const box = document.createElement('div');
    box.append(window.__wf.renderDescription(h));
    return {
      html: box.innerHTML, // read-only inspection of what we built — not a sink
      pwned: !!window.__pwned,
      scripts: box.querySelectorAll('script,img,iframe').length,
      onattrs: [...box.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => a.name.startsWith('on'))).length,
      links: [...box.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.rel, a.target]),
      text: box.textContent,
      paras: box.querySelectorAll('p').length,
      nested: box.querySelectorAll('p p').length,
    };
  }, hostile);
  check(!san.pwned && san.scripts === 0 && san.onattrs === 0, 'sanitiser: no script/img/iframe/on* survives');
  check(san.links.length === 1 && san.links[0][0] === 'https://example.org/' && san.links[0][1] === 'nofollow noopener' && san.links[0][2] === '_blank', `sanitiser: only the https link survives, hardened (${JSON.stringify(san.links)})`);
  check(san.text.includes('bad') && san.text.includes('&') && san.text.includes('bold'), 'sanitiser: unsafe elements are unwrapped to text, entities decoded');
  check(san.paras === 2 && san.nested === 0, `sanitiser: empty <div><br></div> dropped, two unnested paragraphs remain (${san.paras}, nested ${san.nested})`);
  const nest = await page.evaluate(() => {
    const b = document.createElement('div');
    b.append(window.__wf.renderDescription('<div><div>certain portions</div></div><div>after<div>inner</div>tail</div>'));
    return { nested: b.querySelectorAll('p p').length, texts: [...b.children].map((e) => e.textContent) };
  });
  check(nest.nested === 0 && nest.texts.join('|') === 'certain portions|after|inner|tail', `nested <div> flattens to sibling paragraphs in order (${JSON.stringify(nest.texts)})`);
  const svg = await page.evaluate(() => {
    const box = document.createElement('div');
    box.append(window.__wf.renderDescription('<svg><script>window.__pwned=1</script><style>body{display:none}</style></svg><div>vis</div>'));
    return { text: box.textContent, pwned: !!window.__pwned };
  });
  check(svg.text === 'vis' && !svg.pwned, `sanitiser: svg-namespaced script/style are dropped, not unwrapped to text ("${svg.text}")`);
  const snippet = await page.evaluate(() => window.__wf.descriptionText('<div>a<div>b</div>c</div><ul><li>d</li></ul>'));
  check(snippet === 'a b c d', `snippet text: blocks opening and closing mid-text are spaced, never a run-on ("${snippet}")`);
  const plain = await page.evaluate(() => { const b = document.createElement('div'); b.append(window.__wf.renderDescription('One\nTwo\n\nThree')); return { p: b.querySelectorAll('p').length, br: b.querySelectorAll('br').length }; });
  check(plain.p === 2 && plain.br === 1, 'plain-text description: blank line → paragraph, newline → br');
  const rawTags = await page.$$eval('main .pane[data-pane="items"] .detail:not([hidden]) .desc-full', (els) => els.map((e) => e.textContent).join('').includes('<div>'));
  check(!rawTags, 'expanded description shows no literal tags');
  // Long descriptions clamp behind "Read more" so the viewer/files stay in reach.
  const clamp = await page.evaluate(() => {
    const detail = document.createElement('div'); detail.className = 'detail';
    document.body.append(detail);
    const long = Array.from({ length: 40 }, (_, i) => `<div>Paragraph ${i} of a very long uploader description that goes on and on.</div>`).join('');
    window.__wf.renderDetail(detail, { description: long, collection: [], subject: [], files: [], embedUrl: 'about:blank', detailsUrl: 'https://archive.org/' });
    const box = detail.querySelector('.desc-full'); const btn = detail.querySelector('.read-more');
    const before = { collapsed: box.classList.contains('collapsed'), h: box.getBoundingClientRect().height, label: btn && btn.textContent, expanded: btn && btn.getAttribute('aria-expanded') };
    btn.click();
    const after = { collapsed: box.classList.contains('collapsed'), h: box.getBoundingClientRect().height, label: btn.textContent, expanded: btn.getAttribute('aria-expanded') };
    const short = document.createElement('div'); short.className = 'detail'; document.body.append(short);
    window.__wf.renderDetail(short, { description: 'Short and sweet.', collection: [], subject: [], files: [], embedUrl: 'about:blank', detailsUrl: 'https://archive.org/' });
    const shortHasButton = !!short.querySelector('.read-more');
    detail.remove(); short.remove();
    return { before, after, shortHasButton };
  });
  check(clamp.before.collapsed && clamp.before.label === 'Read more' && clamp.before.expanded === 'false' && clamp.before.h < 200
    && !clamp.after.collapsed && clamp.after.label === 'Show less' && clamp.after.expanded === 'true' && clamp.after.h > clamp.before.h * 3
    && !clamp.shortHasButton,
    `long description clamps behind Read more and expands on click; short ones don't get a button (${JSON.stringify(clamp)})`);

  // 4c. Failure copy: a Wayback connect failure names Wayback, not "archive.org didn't
  // respond" — the other two tabs still work. Demo-mode copy still passes through verbatim.
  const fail = await page.evaluate(() => ({
    wayback: window.__wf.failureMessage('web', { message: 'fetch failed (ECONNREFUSED) from web.archive.org' }),
    items: window.__wf.failureMessage('items', { message: 'fetch failed (ECONNREFUSED) from archive.org' }),
    limited: window.__wf.failureMessage('web', { status: 503, message: 'busy' }),
  }));
  check(fail.wayback === "Wayback isn't reachable from this server right now. Items and Full-text still work."
    && fail.items.startsWith("archive.org didn't respond")
    && fail.limited === 'busy',
    `failure copy: Wayback connect failure named separately, other tabs generic, demo copy verbatim (${JSON.stringify(fail)})`);

  // 5. Collection chip → collection pill, Items reload.
  const collChip = await page.$('main .pane[data-pane="items"] .detail:not([hidden]) .chips-row .chip.scope');
  const collText = await collChip.evaluate((el) => el.textContent);
  await collChip.click();
  await page.waitForFunction((t) => [...document.querySelectorAll('#active .pill')].some((p) => p.textContent.includes(t.replace(/^in: |^# /, ''))), {}, collText);
  await page.waitForSelector('main .pane[data-pane="items"] .row');
  check(true, `scope chip "${collText}" became a pill and results reloaded`);

  // 6. Keyboard: focus first row, press Enter → detail opens.
  await page.focus('main .pane[data-pane="items"] .row');
  await page.keyboard.press('Enter');
  await page.waitForSelector('main .pane[data-pane="items"] .detail:not([hidden])');
  check(true, 'Enter on a focused row expands it');

  // 7. Full-text tab renders titles and Load More.
  await page.click('.tab[data-tab="fulltext"]');
  await page.waitForSelector('main .pane[data-pane="fulltext"] .row h3');
  const ftTitle = await page.$eval('main .pane[data-pane="fulltext"] .row h3', (el) => el.textContent);
  check(ftTitle.length > 0, `fulltext row has a title: "${ftTitle.slice(0, 40)}"`);
  const moreHidden = await page.$eval('main .pane[data-pane="fulltext"] .more', (el) => el.hidden);
  check(moreHidden === false, 'fulltext Load More visible on a full first page');

  // 7b. ✕ is the reset — not an empty box. Results, facets and filters all go,
  // but the tab you were on stays put.
  await page.click('.tab[data-tab="items"]');
  await page.$eval('#q', (el) => { el.value = ''; }); // set directly: only ✕ may reset
  await page.type('#q', 'apple II');
  await page.click('#search-form button[type="submit"]');
  await page.waitForSelector('main .pane[data-pane="items"] .row');
  const pillsBefore = await page.$$eval('#active .pill', (els) => els.length);
  check(pillsBefore > 0, `filters survive a re-search, so the reset has something to clear (${pillsBefore} pills)`);
  await page.$eval('#q', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const typedEmpty = await page.evaluate(() => ({
    rows: document.querySelectorAll('main .pane[data-pane="items"] .row').length,
    clearHidden: document.querySelector('#clear').hidden,
  }));
  check(typedEmpty.rows > 0 && typedEmpty.clearHidden,
    `emptying the box by typing keeps results; only ✕ clears (${JSON.stringify(typedEmpty)})`);
  await page.type('#q', 'apple II');
  check(await page.$eval('#clear', (el) => !el.hidden), '✕ is back once the box has text again');
  await page.click('#clear');
  const after = await page.evaluate(() => ({
    rows: document.querySelectorAll('main .pane[data-pane="items"] .row').length,
    facets: document.querySelector('#facets').hidden,
    active: document.querySelector('#active').hidden,
    itemsTab: document.querySelector('.tab[data-tab="items"]').classList.contains('active'),
    hero: document.querySelector('#hero').hidden ? 'hidden' : document.querySelector('#hero').className,
    clearHidden: document.querySelector('#clear').hidden,
    q: document.querySelector('#q').value,
  }));
  const reset = after.rows === 0 && after.facets && after.active && after.itemsTab
    && after.hero === 'idle' && after.clearHidden && after.q === '';
  if (!reset) console.log(`  detail: ${JSON.stringify(after)}`);
  check(reset, '✕ resets results, facets and filters, empties the box and restores the idle dial');
  const resetTops = await heroTops();
  check(spread(resetTops) <= 0.5, `after ✕: the dial sits at the same height on every tab (spread ${spread(resetTops)}px, ${JSON.stringify(resetTops)})`);

  // 8. Phone width: the facet blinds are the whole point — nothing may scroll sideways.
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`http://localhost:${PORT}/`);
  await page.type('#q', 'apple II');
  await page.click('#search-form button[type="submit"]');
  await page.waitForSelector('.facet-row[data-facet="mediatype"] .chip');
  await page.click('.facet-row[data-facet="mediatype"] .facet-head');
  await page.waitForSelector('.facet-row[data-facet="mediatype"] .facet-body:not([hidden])');
  const box = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  check(box.scroll <= 390, `mobile: no horizontal overflow at 390px (scrollWidth ${box.scroll}, clientWidth ${box.client})`);
  // Expanded detail at phone width: long file names wrap instead of widening the page.
  await page.click('main .pane[data-pane="items"] .row');
  await page.waitForSelector('main .pane[data-pane="items"] .detail:not([hidden]) .files li');
  const filesFit = await page.evaluate(() => document.documentElement.scrollWidth <= 390 && [...document.querySelectorAll('.detail:not([hidden]) .files li')].every((li) => li.getBoundingClientRect().right <= 390));
  check(filesFit, 'mobile: expanded file list stays inside the viewport (file names wrap)');
  const headHeights = await page.$$eval('.facet-head', (els) => els.map((el) => el.getBoundingClientRect().height));
  check(headHeights.length === 3 && headHeights.every((h) => h >= 44), `mobile: facet headers are tap-sized (${headHeights.join(', ')})`);
} finally {
  try { if (browser) await browser.close(); } finally { server.kill(); }
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
