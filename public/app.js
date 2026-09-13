const $ = (sel, el = document) => el.querySelector(sel);
const HITS_PER_PAGE = 20;
const state = {
  q: '',
  active: 'items',
  filters: { mediatype: [], yearFrom: '', yearTo: '', collection: '', subject: '' },
  open: { mediatype: false, year: false, collection: false },
  tabs: {
    // `gen` is bumped whenever a tab's results are invalidated; an in-flight
    // response whose generation has moved on is discarded instead of rendered.
    items: { page: 1, loaded: false, rows: [], total: 0, gen: 0 },
    fulltext: { page: 1, loaded: false, rows: [], total: 0, gen: 0 },
    web: { loaded: false, rows: [], gen: 0 },
  },
};

// Clear one tab's result state and invalidate anything already in flight for it.
function resetTabState(name) {
  const t = state.tabs[name];
  Object.assign(t, { page: 1, loaded: false, rows: [], total: 0 });
  t.gen += 1;
}

function panes(name) { return document.querySelectorAll(`.pane[data-pane="${name}"]`); }
function mainPane(name) { return $(`main .pane[data-pane="${name}"]`); }

function setStatus(name, text, withRetry = false) {
  const el = $('.status', mainPane(name));
  el.hidden = !text;
  el.textContent = text || '';
  if (withRetry) {
    const b = document.createElement('button');
    b.className = 'retry';
    b.textContent = 'Retry';
    b.onclick = () => loadTab(name, true);
    el.append(b);
  }
}

// The dial is the landing image (idle) and the spinner (loading). Hidden once a
// tab has results or an error of its own to show. The <p> is the hero's live
// region: sighted users read it idle and see the dial spin, screen readers hear
// it either way (the loading rule hides it visually, not from the a11y tree).
function showHero(mode) {
  const h = $('#hero');
  const p = $('p', h);
  if (mode === 'loading') p.textContent = 'Searching…';
  else if (mode === 'idle') p.textContent = 'Search the Internet Archive';
  h.hidden = !mode;
  h.className = mode || '';
}

// Wayback (web.archive.org) sometimes refuses this server's egress IP outright;
// say so instead of implying archive.org is down.
const WAYBACK_DOWN = /from web\.archive\.org$/;
const CONNECT_FAIL = /\b(UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|TimeoutError)\b/;
function failureMessage(tab, err) {
  if (err.status === 429 || err.status === 503) return err.message;
  if (tab === 'web' && WAYBACK_DOWN.test(err.message) && CONNECT_FAIL.test(err.message)) {
    return "Wayback isn't reachable from this server right now. Items and Full-text still work.";
  }
  return `archive.org didn't respond: ${err.message}`;
}

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status; // 429/503 carry demo-mode copy the UI shows verbatim
    throw err;
  }
  return body;
}

function itemsQuery(page) {
  const f = state.filters;
  const p = new URLSearchParams({ q: state.q, page });
  if (f.mediatype.length) p.set('mediatype', f.mediatype.join(','));
  for (const k of ['yearFrom', 'yearTo', 'collection', 'subject']) if (f[k]) p.set(k, f[k]);
  return `/api/items?${p}`;
}

// Apply a filter mutation, then reset and reload the Items tab. Filters
// persist across searches; only the tab's result state is cleared.
function setFilter(mutate) {
  mutate(state.filters);
  $('#yearFrom').value = state.filters.yearFrom;
  $('#yearTo').value = state.filters.yearTo;
  renderActive();
  resetTabState('items');
  const pane = mainPane('items');
  $('.results', pane).textContent = '';
  setStatus('items', '');
  $('.more', pane).hidden = true; // a stale "Load more" would fetch page 2 onto an emptied list
  if (state.active === 'items') loadTab('items');
}

function clearAllFilters() {
  setFilter((f) => Object.assign(f, { mediatype: [], yearFrom: '', yearTo: '', collection: '', subject: '' }));
}

function button(className, text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

// A pill clips with an ellipsis when its value is long, so the full text has to
// survive somewhere: the title. Not in button() — that also builds Clear all and Retry.
function pill(label, onClick) {
  const b = button('pill', `✕ ${label}`, onClick);
  b.title = label;
  return b;
}

function renderActive() {
  const box = $('#active');
  box.textContent = '';
  const f = state.filters;
  for (const m of f.mediatype) {
    box.append(pill(m, () => setFilter((x) => { x.mediatype = x.mediatype.filter((v) => v !== m); })));
  }
  if (f.yearFrom || f.yearTo) {
    const label = f.yearFrom && f.yearTo && f.yearFrom === f.yearTo ? f.yearFrom : `${f.yearFrom || '…'}–${f.yearTo || '…'}`;
    box.append(pill(label, () => setFilter((x) => { x.yearFrom = ''; x.yearTo = ''; })));
  }
  if (f.collection) box.append(pill(`in: ${f.collection}`, () => setFilter((x) => { x.collection = ''; })));
  if (f.subject) box.append(pill(`# ${f.subject}`, () => setFilter((x) => { x.subject = ''; })));
  if (box.children.length >= 2) box.append(button('pill clear', 'Clear all', clearAllFilters));
  box.hidden = box.children.length === 0;
}

function compact(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Type icons: static SVGs in public/icons painted via CSS mask (see .glyph in style.css),
// so they inherit currentColor. Mediatypes without an icon get a dot.
const ICON = { texts: 'book', movies: 'film-strip', audio: 'music-note', etree: 'microphone', software: 'floppy-disk', image: 'images', web: 'webpage', data: 'spreadsheet' };
function iconNode(key) {
  const s = document.createElement('span');
  const name = ICON[key];
  s.className = 'glyph' + (name ? '' : ' dot');
  if (name) s.dataset.icon = name;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function setOpen(name, open) {
  state.open[name] = open;
  const row = $(`.facet-row[data-facet="${name}"]`);
  $('.facet-head', row).setAttribute('aria-expanded', String(open));
  $('.facet-body', row).hidden = !open;
  row.classList.toggle('open', open);
}

function closeAllBlinds() { for (const name of Object.keys(state.open)) setOpen(name, false); }

// One-line description of a facet while its blind is closed.
function summarize(name, buckets) {
  const f = state.filters;
  const el = $(`.facet-row[data-facet="${name}"] .facet-summary`);
  el.textContent = '';
  if (name === 'mediatype') {
    // Buckets arrive in count order; a selected-but-small type would fall off the
    // end of the slice and the closed blind would show no sign of the filter.
    const ordered = [...buckets].sort((a, b) => Number(f.mediatype.includes(b.key)) - Number(f.mediatype.includes(a.key)));
    for (const b of ordered.slice(0, 6)) {
      const s = document.createElement('span');
      s.className = 'sum' + (f.mediatype.includes(b.key) ? ' selected' : '');
      s.title = b.key;
      s.append(iconNode(b.key), document.createTextNode(compact(b.count)));
      el.append(s);
    }
  } else if (name === 'year') {
    if (f.yearFrom || f.yearTo) {
      el.textContent = f.yearFrom && f.yearTo && f.yearFrom === f.yearTo ? f.yearFrom : `${f.yearFrom || '…'}–${f.yearTo || '…'}`;
    } else if (buckets.length) {
      el.textContent = `${buckets[0].key}–${buckets[buckets.length - 1].key} · ${buckets.length} years`;
    }
  } else {
    el.textContent = f.collection || `▥ ${buckets.length} collections`;
  }
}

function chip(key, count, selected, onClick, icon = false) {
  const label = `${key} ~${compact(count)}`;
  const b = button('chip' + (selected ? ' selected' : ''), label, onClick);
  b.dataset.key = String(key);
  b.title = label; // the chip ellipsizes; the title is the only way back to the full key
  // After the label is set, so textContent stays the label. Unmapped types get no
  // chip icon at all: the summary's fallback dot reads as a heavy blob on a pill.
  if (icon && ICON[key]) b.prepend(iconNode(key));
  return b;
}

function renderFacets(facets) {
  const strip = $('#facets');
  if (!facets) { strip.hidden = true; return; }
  const f = state.filters;
  // Re-rendering destroys the pill that was just clicked; put focus back on its replacement.
  const focused = document.activeElement?.classList?.contains('chip') ? {
    facet: document.activeElement.closest('.facet-row')?.dataset.facet, key: document.activeElement.dataset.key,
  } : null;
  const fill = (name, chips) => {
    const box = $(`.facet-row[data-facet="${name}"] .chips`);
    box.textContent = '';
    for (const c of chips) box.append(c);
  };
  // archive.org models collections as items with mediatype=collection; they are containers,
  // not results people filter for, and the Collection facet already covers membership.
  const types = facets.mediatype.filter((b) => b.key !== 'collection');
  fill('mediatype', types.map((b) => chip(b.key, b.count, f.mediatype.includes(b.key), () => setFilter((x) => {
    x.mediatype = x.mediatype.includes(b.key) ? x.mediatype.filter((v) => v !== b.key) : [...x.mediatype, b.key];
  }), true)));
  fill('year', facets.year.map((b) => {
    const y = String(b.key);
    return chip(y, b.count, f.yearFrom === y && f.yearTo === y, () => setFilter((x) => {
      const on = x.yearFrom === y && x.yearTo === y; // read live state, not render-time state
      if (on) { x.yearFrom = ''; x.yearTo = ''; } else { x.yearFrom = y; x.yearTo = y; }
    }));
  }));
  fill('collection', facets.collection.map((b) => chip(b.key, b.count, f.collection === b.key, () => setFilter((x) => {
    x.collection = x.collection === b.key ? '' : b.key;
  }))));
  summarize('mediatype', types);
  summarize('year', facets.year);
  summarize('collection', facets.collection);
  for (const name of Object.keys(state.open)) setOpen(name, state.open[name]); // blinds keep their state across a reload
  strip.hidden = false;
  if (focused?.key) $(`.facet-row[data-facet="${focused.facet}"] .chip[data-key="${CSS.escape(focused.key)}"]`)?.focus();
}

function humanSize(n) {
  if (n == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// IA descriptions are uploader HTML. Parse with DOMParser (inert: nothing executes,
// no resource loads), then rebuild only an allowlisted subset with createElement.
// This is the app's one deliberate markup consumer besides lib/snippets.js; markup
// strings are never assigned into the DOM here.
const DESC_INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'CODE', 'A', 'BR']);
const DESC_BLOCK = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const DESC_DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED']);
const SAFE_HREF = /^https?:\/\//i;

function looksLikeHtml(s) { return /<\/?[a-z][^>]*>/i.test(s); }

// Plain text: blank lines → paragraphs, single newlines → <br>.
function textToFragment(text) {
  const frag = document.createDocumentFragment();
  for (const para of text.split(/\n\s*\n/)) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const p = document.createElement('p');
    lines.forEach((l, i) => { if (i) p.append(document.createElement('br')); p.append(l); });
    frag.append(p);
  }
  return frag;
}

const isPara = (n) => n.nodeType === Node.ELEMENT_NODE && n.tagName === 'P';

// Rebuilds `node` inside `out` and returns the node its later siblings belong to.
// Uploaders nest blocks inside blocks (<div><div>…</div></div>); since <div> maps
// to <p>, a block landing in a <p> is hoisted to that paragraph's parent and the
// text after it continues in a fresh sibling paragraph — so nothing nests wrongly
// and reading order survives.
function cloneSafe(node, out) {
  if (node.nodeType === Node.TEXT_NODE) { out.append(node.textContent); return out; }
  if (node.nodeType !== Node.ELEMENT_NODE) return out;
  const tag = node.tagName.toUpperCase(); // SVG/MathML elements report lowercase local names
  if (DESC_DROP.has(tag)) return out; // dropped whole: their text is not prose
  if (tag === 'BR') { out.append(document.createElement('br')); return out; }
  let el = null;
  if (tag === 'A') {
    const href = node.getAttribute('href') || '';
    if (SAFE_HREF.test(href)) {
      el = document.createElement('a'); // only href is copied: on* handlers can't ride along
      el.href = href;
      el.rel = 'nofollow noopener';
      el.target = '_blank';
    }
  } else if (DESC_INLINE.has(tag)) {
    el = document.createElement(tag === 'B' ? 'strong' : tag === 'I' ? 'em' : tag.toLowerCase());
  } else if (DESC_BLOCK.has(tag)) {
    el = document.createElement(tag === 'DIV' || tag.startsWith('H') ? 'p' : tag.toLowerCase());
  }
  if (!el) { // unknown/unsafe tags are unwrapped: children still render as text
    let target = out;
    for (const child of node.childNodes) target = cloneSafe(child, target);
    return target;
  }
  const hoist = !DESC_INLINE.has(el.tagName) && isPara(out);
  const host = hoist ? out.parentNode ?? out : out;
  host.append(el); // append before recursing: children look up at their parent
  let inner = el;
  for (const child of node.childNodes) inner = cloneSafe(child, inner);
  if (el.tagName === 'A' && !el.textContent.trim()) el.remove(); // empty links
  if (!hoist) return out;
  const cont = document.createElement('p'); // empty ones are swept in renderDescription
  host.append(cont);
  return cont;
}

// html → DocumentFragment (formatted) — safe to append anywhere.
function renderDescription(text) {
  const src = String(text ?? '');
  if (!looksLikeHtml(src)) return textToFragment(src);
  const doc = new DOMParser().parseFromString(src, 'text/html');
  const raw = document.createDocumentFragment();
  for (const child of doc.body.childNodes) cloneSafe(child, raw);
  // Bare inline runs at the top level (text directly in <body>) get wrapped in <p>.
  const frag = document.createDocumentFragment();
  let p = null;
  for (const n of [...raw.childNodes]) {
    const inline = n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && DESC_INLINE.has(n.tagName));
    if (!inline) { p = null; frag.append(n); continue; }
    if (!p && n.nodeType === Node.TEXT_NODE && !n.textContent.trim()) continue; // whitespace between blocks
    if (!p) { p = document.createElement('p'); frag.append(p); }
    p.append(n);
  }
  // Drop paragraph spacers (<div><br></div>) and any continuation left unused.
  for (const el of [...frag.querySelectorAll('p')]) if (!el.textContent.trim()) el.remove();
  return frag;
}

// html → plain text (for the clamped row snippet).
function descriptionText(text) {
  const src = String(text ?? '');
  if (!looksLikeHtml(src)) return src.replace(/\s+/g, ' ').trim();
  const doc = new DOMParser().parseFromString(src, 'text/html');
  for (const el of doc.querySelectorAll('script,style,iframe,object,embed')) el.remove(); // same drop list as cloneSafe
  // textContent alone welds blocks together ("<div>a</div><div>b</div>" → "ab"),
  // which reads as a run-on in the clamped row snippet. Space both edges of every
  // break out first — a block opening mid-text needs the space as much as one closing.
  for (const el of doc.body.querySelectorAll('br,p,div,ul,ol,li,td,th,tr,h1,h2,h3,h4,h5,h6,pre,blockquote')) { el.before(' '); el.after(' '); }
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function makeRow({ identifier, title, metaLine, descText, snippetHtmls, expandable, href }) {
  const row = document.createElement('div');
  row.className = 'row';
  if (identifier) {
    const img = document.createElement('img');
    img.src = `https://archive.org/services/img/${identifier}`;
    img.loading = 'lazy';
    img.onerror = () => { img.hidden = true; };
    row.append(img);
  }
  // A linked row's body is a real <a>: keyboard focus, middle-click and the
  // status-bar URL preview all come for free. With no destination it stays a
  // plain <div> — an href="" would reload the page instead of navigating.
  const body = document.createElement(href ? 'a' : 'div');
  body.className = 'body';
  if (href) body.href = href;
  const h = document.createElement('h3');
  h.textContent = title || identifier || '(untitled)';
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = metaLine;
  body.append(h, meta);
  if (descText) {
    const d = document.createElement('p');
    d.className = 'desc';
    d.textContent = descriptionText(descText);
    body.append(d);
  }
  for (const html of snippetHtmls || []) {
    const s = document.createElement('p');
    s.className = 'snippet';
    s.innerHTML = html; // server-escaped snippet HTML — safe innerHTML sink (one of two; see renderInside)
    body.append(s);
  }
  row.append(body);

  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.hidden = true;

  if (expandable) {
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    };
    let loading = false; // guards against a double-click firing two fetches
    row.onclick = async () => {
      detail.hidden = !detail.hidden;
      if (detail.hidden || detail.dataset.loaded || loading) return;
      loading = true;
      detail.textContent = 'Loading…';
      try {
        const item = await api(`/api/item/${encodeURIComponent(identifier)}`);
        renderDetail(detail, item);
        detail.dataset.loaded = '1'; // only after a render actually succeeded
      } catch (err) {
        // dataset.loaded stays unset, so collapsing and re-expanding retries.
        detail.textContent = `Couldn't load details: ${err.message}`;
        return;
      } finally {
        loading = false;
      }
      if (state.active === 'fulltext') {
        try {
          const inside = await api(`/api/inside?id=${encodeURIComponent(identifier)}&q=${encodeURIComponent(state.q)}`);
          renderInside(detail, inside);
        } catch (err) {
          // Append — never clear: the item details above this line loaded fine.
          const p = document.createElement('p');
          p.className = 'inside-error';
          p.textContent = `Couldn't load matches inside this item: ${err.message}`;
          detail.append(p);
        }
      }
      const relBox = $('.related', detail);
      try {
        const rel = await api(`/api/related/${encodeURIComponent(identifier)}`);
        renderRelated(relBox, rel);
      } catch (err) {
        relBox.textContent = `Couldn't load related items: ${err.message}`; // append-only: the detail above stays
      }
    };
  }
  const frag = document.createDocumentFragment();
  frag.append(row, detail);
  return frag;
}

function scopeChip(text, mutate) {
  const b = button('chip scope', text, () => {
    activateTab('items', { load: false }); // setFilter does the (single) reload
    setFilter(mutate);
  });
  b.title = text; // subjects run long and the chip ellipsizes them
  return b;
}

const DESC_CLAMP_CHARS = 500;

function renderDetail(detail, item) {
  detail.textContent = '';
  if (item.description) {
    const box = document.createElement('div');
    box.className = 'desc-full';
    box.append(renderDescription(item.description));
    detail.append(box);
    // Long descriptions would push the viewer and the files off screen: clamp
    // them behind a "Read more" so the actual content sits right underneath.
    if (descriptionText(item.description).length > DESC_CLAMP_CHARS) {
      box.classList.add('collapsed');
      const more = button('read-more', 'Read more', () => {
        const open = box.classList.toggle('collapsed') === false;
        more.textContent = open ? 'Show less' : 'Read more';
        more.setAttribute('aria-expanded', String(open));
        if (!open) detail.scrollIntoView({ block: 'start' });
      });
      more.setAttribute('aria-expanded', 'false');
      detail.append(more);
    }
  }
  const chips = document.createElement('div');
  chips.className = 'chips-row';
  for (const c of item.collection.filter(Boolean)) chips.append(scopeChip(`in: ${c}`, (f) => { f.collection = c; }));
  // IA often stores subjects as one ';'-joined string. Split on ';' only — never ',' (names carry commas).
  const subjects = [...new Set(item.subject.flatMap((s) => String(s).split(';')).map((s) => s.trim()).filter(Boolean))];
  for (const s of subjects.slice(0, 10)) chips.append(scopeChip(`# ${s}`, (f) => { f.subject = s; }));
  if (chips.children.length) detail.append(chips);
  const iframe = document.createElement('iframe');
  iframe.src = item.embedUrl;
  iframe.loading = 'lazy';
  iframe.allowFullscreen = true;
  detail.append(iframe);
  const ul = document.createElement('ul');
  ul.className = 'files';
  for (const f of item.files) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = f.url;
    a.textContent = f.name;
    li.append(a, ` — ${f.format ?? ''} ${humanSize(f.size)}`);
    ul.append(li);
  }
  detail.append(ul);
  const related = document.createElement('div');
  related.className = 'related';
  related.textContent = 'Loading related…';
  detail.append(related);
  const link = document.createElement('a');
  link.href = item.detailsUrl;
  link.textContent = 'on archive.org →';
  detail.append(link);
}

// Related rows are full rows: they expand inline too. Their detail nodes sit
// inside this parent's detail, and .detail is a sibling of .row, so clicks
// never bubble into the parent row's toggle.
function renderRelated(box, rel) {
  box.textContent = '';
  if (!rel.items.length) { box.textContent = 'No related items.'; return; }
  const h = document.createElement('h4');
  h.textContent = 'Related';
  box.append(h);
  for (const it of rel.items) {
    box.append(makeRow({
      identifier: it.identifier,
      title: it.title,
      metaLine: [it.year, it.mediatype, it.downloads ? `${it.downloads} downloads` : null].filter(Boolean).join(' · '),
      expandable: true,
    }));
  }
}

function renderInside(detail, inside) {
  for (const m of inside.matches) {
    const p = document.createElement('p');
    p.className = 'inside-match';
    if (m.page) {
      const pg = document.createElement('span');
      pg.className = 'pg';
      pg.textContent = `p.${m.page}`;
      p.append(pg);
    }
    const span = document.createElement('span');
    span.innerHTML = m.html; // server-escaped snippet HTML — safe innerHTML sink (one of two; see makeRow)
    p.append(span);
    detail.append(p);
  }
}

const renderers = {
  items(pane, data, append) {
    const box = $('.results', pane);
    if (!append) box.textContent = '';
    for (const it of data.items) {
      box.append(makeRow({
        identifier: it.identifier,
        title: it.title,
        metaLine: [it.year, it.mediatype, it.downloads ? `${it.downloads} downloads` : null].filter(Boolean).join(' · '),
        descText: it.description,
        expandable: true,
      }));
    }
    if (!append) renderFacets(data.facets); // counts follow the endpoint's post-filter behaviour
    $('.more', pane).hidden = data.returned < HITS_PER_PAGE || data.items.length === 0;
    if (!append && data.items.length === 0) setStatus('items', 'No results.');
  },
  fulltext(pane, data, append) {
    const box = $('.results', pane);
    if (!append) box.textContent = '';
    for (const h of data.hits) {
      box.append(makeRow({
        identifier: h.identifier,
        title: h.title,
        metaLine: [h.year, h.mediatype].filter(Boolean).join(' · '),
        snippetHtmls: h.snippets,
        expandable: true,
      }));
    }
    $('.more', pane).hidden = data.returned < HITS_PER_PAGE || data.hits.length === 0;
    if (!append && data.hits.length === 0) setStatus('fulltext', 'No results.');
  },
  web(pane, data) {
    const box = $('.results', pane);
    box.textContent = '';
    for (const s of data.sites) {
      box.append(makeRow({
        identifier: null,
        title: s.name,
        metaLine: [s.firstYear && s.lastYear ? `${s.firstYear}–${s.lastYear}` : null, `${s.captures} captures`].filter(Boolean).join(' · '),
        snippetHtmls: s.snippetHtml ? [s.snippetHtml] : [],
        expandable: false,
        href: s.waybackUrl, // the wayback page IS the destination — a plain link out
      }));
    }
    if (data.sites.length === 0) setStatus('web', 'No results.');
  },
};

async function loadTab(name, force = false) {
  const t = state.tabs[name];
  if (!state.q || (t.loaded && !force)) return;
  const pane = mainPane(name);
  const gen = t.gen; // this request belongs to the query/filters as they are now
  const append = t.page > 1;
  // "Load more" keeps its rows on screen, so the hero would sit on top of them;
  // that path keeps the old text status as its only feedback.
  if (append) setStatus(name, 'Searching…');
  else { setStatus(name, ''); showHero('loading'); }
  try {
    let data;
    if (name === 'items') data = await api(itemsQuery(t.page));
    else if (name === 'fulltext') data = await api(`/api/fulltext?q=${encodeURIComponent(state.q)}&page=${t.page}`);
    else data = await api(`/api/web?q=${encodeURIComponent(state.q)}`);
    if (gen !== t.gen) return; // a newer search or filter change superseded this
    t.loaded = true;
    if (name !== 'web') {
      t.total = data.total;
      t.rows = append ? t.rows.concat(data.items ?? data.hits) : (data.items ?? data.hits);
    }
    setStatus(name, '');
    renderers[name](pane, data, append);
    // Only the visible tab may retire the hero: a background tab finishing first
    // must not pull the spinner out from under the one you are looking at.
    if (name === state.active) showHero(null);
  } catch (err) {
    if (gen !== t.gen) return; // stale failure — the query it belonged to is gone
    if (name === state.active) showHero(null); // the Retry message needs the room
    setStatus(name, failureMessage(name, err), true);
  }
}

function resetTabs() {
  for (const name of Object.keys(state.tabs)) {
    resetTabState(name);
    const pane = mainPane(name);
    $('.results', pane).textContent = '';
    setStatus(name, '');
    const more = $('.more', pane);
    if (more) more.hidden = true;
  }
}

$('#search-form').onsubmit = (e) => {
  e.preventDefault();
  state.q = $('#q').value.trim();
  if (!state.q) return;
  resetTabs();
  closeAllBlinds();
  loadTab(state.active);
};

// An empty search box is a blank slate: no results, no facets, no filters, blinds shut.
function clearSearch() {
  state.q = '';
  Object.assign(state.filters, { mediatype: [], yearFrom: '', yearTo: '', collection: '', subject: '' });
  $('#yearFrom').value = ''; $('#yearTo').value = '';
  renderActive();
  closeAllBlinds();
  $('#facets').hidden = true;
  resetTabs();
  showHero('idle');
}

// ✕ is the only reset: typing the box empty leaves the results you were reading.
const syncClear = () => { $('#clear').hidden = !$('#q').value; };
$('#q').addEventListener('input', syncClear);
$('#clear').onclick = () => { $('#q').value = ''; syncClear(); clearSearch(); $('#q').focus(); };
syncClear();

for (const el of ['#yearFrom', '#yearTo'].map((s) => $(s))) {
  el.onchange = () => setFilter((f) => { f.yearFrom = $('#yearFrom').value; f.yearTo = $('#yearTo').value; });
}

function activateTab(name, { load = true } = {}) {
  state.active = name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.pane')) p.hidden = p.dataset.pane !== name;
  if (!state.q) showHero('idle');
  else if (state.tabs[name].loaded) showHero(null);
  if (load) loadTab(name); // an unloaded tab gets its spinner from loadTab
}
for (const btn of document.querySelectorAll('.tab')) btn.onclick = () => activateTab(btn.dataset.tab);

for (const name of ['items', 'fulltext']) {
  $('.more', mainPane(name)).onclick = () => {
    state.tabs[name].page += 1;
    state.tabs[name].loaded = false;
    loadTab(name);
  };
}

for (const row of document.querySelectorAll('.facet-row')) {
  $('.facet-head', row).onclick = () => setOpen(row.dataset.facet, !state.open[row.dataset.facet]);
}

// Demo deployments announce themselves; a failed config fetch just means no banner.
fetch('/api/config').then((r) => r.json()).then((c) => { if (c.demo) $('#demo-banner').hidden = false; }).catch(() => {});

window.__wf = { renderDescription, descriptionText, failureMessage, renderDetail }; // test hook for scripts/verify.mjs
