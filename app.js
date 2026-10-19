// Akari front end: hash-routed, no build step.
// Tabs: Library · Updates · History · Browse · More
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = (html) => { $('#view').innerHTML = html; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

const STATUS_LABEL = { watching: 'Watching', planning: 'Plan to watch', completed: 'Completed', paused: 'Paused', dropped: 'Dropped' };
const TRACKER_NAME = { anilist: 'AniList', mal: 'MyAnimeList', kitsu: 'Kitsu' };
const CHEVRON = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const ICON = {
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.7 6.3A8 8 0 104 12h2a6 6 0 1110.3-4.2L13 11h7V4z" fill="currentColor"/></svg>',
  remove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12l-1 13H7zM9 4h6l1 2H8z" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>',
};

// The GitHub Pages build sets AKARI_STATIC and answers /api routes in the browser.
const STATIC = window.AKARI_STATIC === true;
const backend = STATIC ? await import('./static-backend.js') : null;

async function api(path, opts = {}) {
  if (STATIC) return backend.handle(opts.method || 'GET', path, opts.body);
  const r = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `The server answered ${r.status}.`);
  return j;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4500);
}

const pref = {
  get(k, d) { try { return localStorage.getItem(`akari:pref:${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`akari:pref:${k}`, v); } catch { /* optional */ } },
};

const fmt = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const minutes = (sec) => (Number.isFinite(sec) && sec > 0 ? `${Math.max(1, Math.round(sec / 60))}m` : '');
const plural = (n, word) => `${n} ${word}${n === 1 || word.endsWith('s') ? '' : 's'}`;
const epCode = (n) => `E${n}`;
const hue = (t) => [...String(t)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : 'var(--panel-2)');
const cssUrl = (u) => `url("${String(u).replace(/["\\\n]/g, '')}")`;
const showHref = (s) => `#/show/${enc(s.key)}`;
const watchHref = (key, n) => `#/watch/${enc(key)}/${n}`;

function poster(s, cls = 'poster') {
  return s.cover
    ? `<img class="${cls}" src="${esc(s.cover)}" alt="" loading="lazy" style="background:${safeColor(s.color)}">`
    : `<div class="${cls} poster-gen" style="--h:${hue(s.title)}" aria-hidden="true"><span>${esc(s.title)}</span></div>`;
}

function metaLine(s) {
  const bits = [
    s.format && esc(String(s.format).replace(/_/g, ' ')),
    s.year && `<span class="mono">${s.year}</span>`,
    s.totalEpisodes ? plural(s.totalEpisodes, 'episode') : s.episodeCount ? `${s.episodeCount} available` : '',
    s.studio && esc(s.studio),
    s.score && `<span class="score">${s.score}%</span>`,
  ].filter(Boolean);
  return `<div class="meta-line">${bits.map((b) => `<span>${b}</span>`).join('<span aria-hidden="true">·</span>')}</div>`;
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function groupBy(items, keyFn) {
  const out = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(it);
  }
  return out;
}

const emptyState = (glyph, title, body, action = '') =>
  `<div class="empty"><div class="glyph" aria-hidden="true">${glyph}</div><h2>${title}</h2><p>${body}</p>${action}</div>`;
const NO_REPOS = emptyState('(｡•́︿•̀｡)', 'Your library is empty',
  'Add a GitHub repository with an <code>anime-source.json</code> file and its shows appear here.',
  '<a class="btn primary" href="#/browse/repos">Add a repository</a>');

// ---------------- Data ----------------
let catalog = null;
async function loadCatalog(force = false) {
  if (!catalog || force) catalog = await api('/api/catalog');
  return catalog;
}

function watchState(show, p) {
  const nums = show.episodeNumbers || [];
  const watched = new Set((p?.watched || []).filter((n) => nums.includes(n)));
  const unwatched = nums.length - watched.size;
  const status = !p ? 'new' : unwatched === 0 ? 'completed' : 'watching';
  const next = nums.find((n) => !watched.has(n)) ?? nums[0] ?? show.firstEpisode;
  return { watched, unwatched, status, next };
}

// ---------------- Router ----------------
let teardown = null;
const routes = [
  [/^#?\/?$/, libraryPage, 'library'],
  [/^#\/updates$/, updatesPage, 'updates'],
  [/^#\/history$/, historyPage, 'history'],
  [/^#\/browse$/, browseSourcesPage, 'browse'],
  [/^#\/browse\/repos$/, browseReposPage, 'browse'],
  [/^#\/source\/([^/]+)$/, sourcePage, 'browse'],
  [/^#\/more$/, morePage, 'more'],
  [/^#\/(?:more\/trackers|settings)$/, trackersPage, 'more'],
  [/^#\/more\/about$/, aboutPage, 'more'],
  [/^#\/show\/([^/]+)$/, showPage, 'library'],
  [/^#\/watch\/([^/]+)\/([\d.]+)$/, watchPage, 'library'],
  [/^#\/search\/?(.*)$/, searchPage, 'library'],
];

async function route() {
  if (teardown) { teardown(); teardown = null; }
  if (STATIC && /access_token=/.test(location.hash)) {
    // AniList's browser sign-in returns the token in the URL fragment.
    const fragment = location.hash;
    history.replaceState(null, '', `${location.pathname}#/more/trackers`);
    try {
      await backend.finishAniListSignIn(fragment);
      toast('Connected AniList.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  const h = location.hash || '#/';
  for (const [re, fn, tab] of routes) {
    const m = h.match(re);
    if (!m) continue;
    $$('[data-nav]').forEach((a) => (a.dataset.nav === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    document.title = 'Akari';
    view('<div class="loading">Loading…</div>');
    try {
      await fn(...m.slice(1).map((x) => decodeURIComponent(x || '')));
    } catch (e) {
      view(`<div class="wrap"><div class="notice error">${esc(e.message)}</div><a class="btn quiet" href="#/">Back to library</a></div>`);
    }
    window.scrollTo(0, 0);
    return;
  }
  view(`<div class="wrap">${emptyState('404', 'Page not found', 'That address does not match anything in Akari.', '<a class="btn quiet" href="#/">Back to library</a>')}</div>`);
}
window.addEventListener('hashchange', route);

// ---------------- Library ----------------
const LIB_TABS = [['all', 'All'], ['watching', 'Watching'], ['new', 'Not started'], ['completed', 'Completed']];
const SORTS = [['recent', 'Last watched'], ['title', 'Title'], ['unwatched', 'Unwatched episodes'], ['source', 'Source']];

async function libraryPage() {
  const c = await loadCatalog(true);
  if (!c.shows.length) { view(`<div class="wrap">${NO_REPOS}</div>`); return; }

  const rows = c.shows.map((s) => ({ s, p: c.progress[s.key], w: watchState(s, c.progress[s.key]) }));
  const recent = rows.filter((r) => r.p).sort((a, b) => (b.p.updatedAt || '').localeCompare(a.p.updatedAt || ''));
  const resume = recent.find((r) => r.w.status === 'watching');

  const hero = resume ? (() => {
    const { s, p, w } = resume;
    const sameEp = p.ep === w.next && p.duration;
    const pct = sameEp ? Math.min(100, (p.position / p.duration) * 100) : 0;
    return `<section class="hero" aria-label="Continue watching">
      <div class="hero-art" style="background-image:${s.banner ? cssUrl(s.banner) : 'none'};background-color:${safeColor(s.color)}"></div>
      <div class="wrap"><div class="hero-body">
        <span class="eyebrow">Continue watching</span>
        <h1>${esc(s.title)}</h1>
        ${metaLine(s)}
        ${s.synopsis ? `<p>${esc(s.synopsis)}</p>` : ''}
        ${pct ? `<div class="progressline"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
        <div class="actions">
          <a class="btn primary" href="${watchHref(s.key, w.next)}"><span class="play-glyph" aria-hidden="true"></span>${sameEp ? `Continue ${epCode(w.next)}` : `Watch ${epCode(w.next)}`}</a>
          <a class="btn quiet" href="${showHref(s)}">Series details</a>
        </div>
      </div></div>
    </section>`;
  })() : '';

  let tab = pref.get('lib-tab', 'all');
  let sort = pref.get('lib-sort', 'recent');
  const counts = Object.fromEntries(LIB_TABS.map(([k]) => [k, k === 'all' ? rows.length : rows.filter((r) => r.w.status === k).length]));

  view(`${hero}<div class="wrap">
    <div class="page-head"><h1>Library</h1></div>
    <div class="subtabs" role="tablist" aria-label="Library categories">
      ${LIB_TABS.map(([k, l]) => `<button role="tab" type="button" data-tab="${k}" aria-selected="${k === tab}">${l}<span class="count">${counts[k]}</span></button>`).join('')}
    </div>
    <div class="toolbar">
      <span id="lib-count"></span>
      <label>Sort <select id="lib-sort">${SORTS.map(([k, l]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="grid" id="lib-grid"></div>
  </div>`);

  const paint = () => {
    let list = rows.filter((r) => tab === 'all' || r.w.status === tab);
    const by = {
      recent: (a, b) => (b.p?.updatedAt || '').localeCompare(a.p?.updatedAt || '') || a.s.title.localeCompare(b.s.title),
      title: (a, b) => a.s.title.localeCompare(b.s.title),
      unwatched: (a, b) => b.w.unwatched - a.w.unwatched || a.s.title.localeCompare(b.s.title),
      source: (a, b) => a.s.sourceLabel.localeCompare(b.s.sourceLabel) || a.s.title.localeCompare(b.s.title),
    }[sort];
    list = list.sort(by);
    $('#lib-count').textContent = `${list.length} series`;
    $('#lib-grid').innerHTML = list.length ? list.map(({ s, p, w }) => {
      const pct = p?.duration && p.ep === w.next ? Math.min(100, (p.position / p.duration) * 100) : 0;
      const badge = w.status === 'completed' ? '<span class="badge done" title="All watched">✓</span>'
        : w.unwatched ? `<span class="badge" title="${plural(w.unwatched, 'unwatched episode')}">${w.unwatched}</span>` : '';
      return `<a class="card" href="${showHref(s)}">
        <div class="art">${poster(s)}${badge}${pct ? `<span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>` : ''}</div>
        <span class="title">${esc(s.title)}</span>
        <span class="sub">${esc(s.sourceLabel)}</span></a>`;
    }).join('') : `<div style="grid-column:1/-1">${emptyState('—', 'Nothing here yet', tab === 'completed' ? 'Series you finish move here.' : tab === 'watching' ? 'Start an episode and the series shows up here.' : 'Every series has been started.')}</div>`;
  };
  paint();
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab; pref.set('lib-tab', tab);
    $$('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    paint();
  }));
  $('#lib-sort').addEventListener('change', (e) => { sort = e.target.value; pref.set('lib-sort', sort); paint(); });
}

// ---------------- Updates ----------------
async function updatesPage() {
  const c = await loadCatalog(true);
  const items = c.shows.flatMap((s) => (s.releases || []).map((e) => ({ s, e, watched: c.progress[s.key]?.watched?.includes(e.number) })))
    .filter((x) => Date.parse(x.e.released) <= Date.now() + 86400e3)
    .sort((a, b) => Date.parse(b.e.released) - Date.parse(a.e.released))
    .slice(0, 200);
  const body = !c.shows.length ? NO_REPOS
    : !items.length ? emptyState('( ˘ω˘ )', 'No new episodes', 'Episodes show up here when a repository gives them a <code>released</code> date.')
      : [...groupBy(items, (x) => dayLabel(x.e.released))].map(([label, list]) => `
        <div class="group-label">${esc(label)}</div>
        <div class="list">${list.map(({ s, e, watched }) => `
          <a class="row" href="${watchHref(s.key, e.number)}">
            ${poster(s, 'thumb')}
            <span class="main"><span class="name">${esc(s.title)}</span>
              <span class="detail"><b>${epCode(e.number)}</b>${e.title ? ` · ${esc(e.title)}` : ''}${watched ? ' · Watched' : ''}</span></span>
            <span class="end"><span class="icon-btn" aria-hidden="true">${ICON.play}</span></span>
          </a>`).join('')}</div>`).join('');
  view(`<div class="wrap"><div class="page-head"><h1>Updates</h1></div>${body}<div style="height:48px"></div></div>`);
}

// ---------------- History ----------------
async function historyPage() {
  const c = await loadCatalog(true);
  const byKey = new Map(c.shows.map((s) => [s.key, s]));
  const items = Object.entries(c.progress).filter(([k, p]) => byKey.has(k) && p.updatedAt)
    .map(([k, p]) => ({ s: byKey.get(k), p }))
    .sort((a, b) => b.p.updatedAt.localeCompare(a.p.updatedAt));
  const body = !items.length ? emptyState('(・_・;)', 'Nothing watched yet', 'Episodes you start appear here, newest first.')
    : [...groupBy(items, (x) => dayLabel(x.p.updatedAt))].map(([label, list]) => `
      <div class="group-label">${esc(label)}</div>
      <div class="list">${list.map(({ s, p }) => {
        const left = p.duration ? p.duration - p.position : 0;
        const done = p.watched?.includes(p.ep);
        return `<div class="row">
          <a href="${showHref(s)}" tabindex="-1" aria-hidden="true">${poster(s, 'thumb')}</a>
          <a class="main" href="${watchHref(s.key, p.ep)}" style="text-decoration:none">
            <span class="name">${esc(s.title)}</span>
            <span class="detail"><b>${epCode(p.ep)}</b> · ${done ? 'Watched' : left > 5 ? `${fmt(left)} left` : 'Started'} · ${new Date(p.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
          </a>
          <span class="end">
            <a class="icon-btn" href="${watchHref(s.key, p.ep)}" aria-label="Resume ${esc(s.title)}">${ICON.play}</a>
            <button class="icon-btn" type="button" data-forget="${esc(s.key)}" aria-label="Remove ${esc(s.title)} from history">${ICON.remove}</button>
          </span>
        </div>`;
      }).join('')}</div>`).join('');
  view(`<div class="wrap"><div class="page-head"><h1>History</h1></div>${body}<div style="height:48px"></div></div>`);
  $$('[data-forget]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/progress/${enc(b.dataset.forget)}`, { method: 'DELETE' });
    toast('Removed from history. Your tracker lists were not changed.');
    route();
  }));
}

// ---------------- Browse ----------------
const browseTabs = (active) => `<div class="subtabs">
  <a href="#/browse" ${active === 'sources' ? 'aria-current="page"' : ''}>Sources</a>
  <a href="#/browse/repos" ${active === 'repos' ? 'aria-current="page"' : ''}>Repositories</a>
</div>`;

async function browseSourcesPage() {
  const srcs = await api('/api/sources');
  const body = !srcs.length ? NO_REPOS : `<div class="list" style="margin-top:8px">${srcs.map((s) => `
    <a class="row icon-row" href="#/source/${enc(s.id)}">
      <span class="avatar" style="--h:${hue(s.name)}" aria-hidden="true">${esc(s.name.trim()[0]?.toUpperCase() || '?')}</span>
      <span class="main"><span class="name">${esc(s.name)}</span>
        <span class="detail">${s.repo ? esc(s.repo) : 'Bundled'} · ${plural(s.shows, 'series')} · ${plural(s.episodes, 'episode')}${s.error ? ' · <b style="color:var(--bad)">update failed</b>' : ''}</span></span>
      <span class="end">${CHEVRON}</span>
    </a>`).join('')}</div>`;
  view(`<div class="wrap"><div class="page-head"><h1>Browse</h1></div>${browseTabs('sources')}${body}<div style="height:48px"></div></div>`);
}

async function sourcePage(id) {
  const c = await loadCatalog(true);
  const src = c.sources.find((s) => s.id === id);
  if (!src) throw new Error('That repository is not in Akari anymore.');
  const shows = c.shows.filter((s) => s.sourceId === id);
  document.title = `${src.name} · Akari`;
  view(`<div class="wrap">
    <div class="page-head"><div style="display:grid;gap:4px"><a class="eyebrow" href="#/browse" style="text-decoration:none">← Browse</a><h1>${esc(src.name)}</h1>
      ${src.description ? `<p>${esc(src.description)}</p>` : ''}</div>
      ${src.url ? `<a class="btn quiet small" href="${esc(src.url)}" target="_blank" rel="noopener">View on GitHub</a>` : ''}</div>
    <div class="grid">${shows.map((s) => `<a class="card" href="${showHref(s)}"><div class="art">${poster(s)}</div><span class="title">${esc(s.title)}</span><span class="sub">${esc([s.year, s.genres?.[0]].filter(Boolean).join(' · '))}</span></a>`).join('')}</div>
  </div>`);
}

async function browseReposPage() {
  const srcs = await api('/api/sources');
  const repoRow = (s) => `<div class="row icon-row">
    <span class="avatar" style="--h:${hue(s.name)}" aria-hidden="true">${esc(s.name.trim()[0]?.toUpperCase() || '?')}</span>
    <span class="main"><span class="name">${esc(s.name)}</span>
      <span class="detail">${s.repo ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.repo)}</a> · ${esc(s.ref)}` : 'Bundled with Akari'}${s.fetchedAt ? ` · checked ${new Date(s.fetchedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}` : ''}</span>
      ${s.error ? `<span class="err">${esc(s.error)} Showing the last version that loaded.</span>` : ''}</span>
    <span class="end">${s.kind === 'github' ? `
      <button class="icon-btn" type="button" data-refresh="${esc(s.id)}" aria-label="Refresh ${esc(s.repo)}">${ICON.refresh}</button>
      <button class="icon-btn" type="button" data-remove="${esc(s.id)}" data-name="${esc(s.repo)}" aria-label="Remove ${esc(s.repo)}">${ICON.remove}</button>` : ''}</span>
  </div>`;

  view(`<div class="wrap">
    <div class="page-head"><h1>Browse</h1></div>
    ${browseTabs('repos')}
    <div class="stack">
      <form class="add-source" id="add-source">
        <label class="field">Repository<input id="src-repo" placeholder="owner/repo or github.com link" required autocomplete="off" spellcheck="false"></label>
        <label class="field">Manifest path (optional)<input id="src-path" placeholder="anime-source.json" autocomplete="off" spellcheck="false"></label>
        <button class="btn primary" type="submit">Add</button>
      </form>
      <p class="lede">Akari reads an <code>anime-source.json</code> manifest from each repository and re-checks it every 30 minutes.${STATIC ? ' This web version reads public repositories only.' : ''} Only add video you have the rights to stream.</p>
      <div class="list">${srcs.map(repoRow).join('') || ''}</div>
      <details><summary>Manifest format</summary>
<pre class="manifest" style="margin-top:10px">{
  "schema": "akari-source/1",
  "name": "My Library",
  "shows": [{
    "slug": "my-series",
    "ids": { "anilist": 21, "mal": 21 },
    "episodes": [
      { "number": 1, "src": "https://cdn.example.com/ep1/master.m3u8",
        "released": "2026-10-19",
        "intro": { "start": 62, "end": 152 },
        "subtitles": [{ "lang": "en", "label": "English", "src": "subs/ep1.vtt" }] },
      { "number": 2, "src": "videos/ep2.mp4" }
    ]
  }]
}</pre>
        <p class="lede" style="margin-top:10px">With an AniList id, the title, art, synopsis and MyAnimeList id fill in automatically. <code>released</code> dates feed the Updates tab. Paths without <code>https://</code> are read from the repository itself.</p>
      </details>
    </div>
  </div>`);

  $('#add-source').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true; btn.textContent = 'Reading…';
    try {
      const s = await api('/api/sources', { method: 'POST', body: { repo: $('#src-repo').value, path: $('#src-path').value } });
      toast(`Added ${s.repo}: ${plural(s.shows, 'series')}, ${plural(s.episodes, 'episode')}.`, 'ok');
      catalog = null;
      browseReposPage();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Add';
    }
  });
  $$('[data-refresh]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const s = await api(`/api/sources/${enc(b.dataset.refresh)}/refresh`, { method: 'POST' });
      toast(s.error ? s.error : `Refreshed ${s.repo}.`, s.error ? 'error' : 'ok');
      catalog = null;
      browseReposPage();
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  }));
  $$('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.style.color = 'var(--bad)';
      toast(`Tap remove again to take ${b.dataset.name} out of Akari.`);
      setTimeout(() => { b.dataset.armed = ''; b.style.color = ''; }, 4000);
      return;
    }
    try {
      await api(`/api/sources/${enc(b.dataset.remove)}`, { method: 'DELETE' });
      toast(`Removed ${b.dataset.name}.`);
      catalog = null;
      browseReposPage();
    } catch (err) { toast(err.message, 'error'); }
  }));
}

// ---------------- More ----------------
async function morePage() {
  const tr = await api('/api/trackers');
  const connected = Object.values(tr).filter((t) => t.connected).map((t) => t.name);
  const item = (href, glyph, name, detail) => `<a class="row icon-row" href="${href}">
    <span class="avatar" style="--h:${hue(name)}" aria-hidden="true">${glyph}</span>
    <span class="main"><span class="name">${name}</span><span class="detail">${detail}</span></span>
    <span class="end">${CHEVRON}</span></a>`;
  view(`<div class="wrap"><div class="page-head"><h1>More</h1></div>
    <div class="list" style="margin-top:8px">
      ${item('#/more/trackers', '↻', 'Tracking', connected.length ? `Connected: ${connected.join(', ')}` : 'Sync progress to AniList, MyAnimeList and Kitsu')}
      ${item('#/browse/repos', '⌥', 'Repositories', 'Add, refresh or remove GitHub sources')}
      ${item('#/history', '◷', 'Watch history', 'Resume or clear what you have watched')}
      ${item('#/more/about', 'A', 'About Akari', STATIC ? 'Web version · data stays in this browser' : 'Self-hosted version')}
    </div></div>`);
}

async function aboutPage() {
  view(`<div class="wrap"><div class="page-head"><div style="display:grid;gap:4px"><a class="eyebrow" href="#/more" style="text-decoration:none">← More</a><h1>About Akari</h1></div></div>
    <div class="stack">
      <p class="lede">Akari plays the shows listed in GitHub repositories you add, and keeps AniList, MyAnimeList and Kitsu up to date as you watch. It does not find or scrape video; each repository decides what it lists.</p>
      <p class="lede">${STATIC ? 'This is the web version. Your repositories, watch history and sign-ins are saved in this browser only. MyAnimeList sync and private repositories need the self-hosted version.' : 'This is the self-hosted version. Everything Akari remembers is stored on this server.'}</p>
      <div><a class="btn quiet" href="https://github.com/Astrolupus/Akari" target="_blank" rel="noopener">Source code on GitHub</a></div>
    </div></div>`);
}

async function trackersPage() {
  const tr = await api('/api/trackers');
  document.title = 'Tracking · Akari';
  const card = (key, t) => {
    let body;
    if (t.connected) {
      body = `<div class="user">${t.user?.avatar ? `<img src="${esc(t.user.avatar)}" alt="">` : ''}<span>Signed in as <a href="${esc(t.user?.url || '#')}" target="_blank" rel="noopener"><b>${esc(t.user?.name || 'you')}</b></a></span></div>
        <p>Episodes you watch past 85% update your ${t.name} list.</p>
        <div><button class="btn small quiet danger" data-disconnect="${key}" type="button">Disconnect</button></div>`;
    } else if (t.unavailable) {
      body = `<p>${esc(t.unavailable)}</p>`;
    } else if (t.needsClientId) {
      body = `<p>AniList needs a free app registration once. On <a href="https://anilist.co/settings/developer" target="_blank" rel="noopener">AniList → Developer</a>, create a client with this redirect URL:</p>
        <p><code>${esc(t.redirect)}</code></p>
        <form id="anilist-client-form">
          <label class="field">Client ID<input id="anilist-client-id" inputmode="numeric" autocomplete="off" required placeholder="12345"></label>
          <div><button class="btn small primary" type="submit">Save</button></div>
        </form>`;
    } else if (key === 'kitsu') {
      body = `<p>Sign in with your Kitsu account. Akari keeps the access token, never your password.</p>
        <form id="kitsu-form">
          <label class="field">Email<input id="kitsu-user" type="email" autocomplete="username" required></label>
          <label class="field">Password<input id="kitsu-pass" type="password" autocomplete="current-password" required></label>
          <div><button class="btn small primary" type="submit">Sign in</button></div>
        </form>`;
    } else if (!t.configured) {
      body = `<p>Register an app with ${t.name}, add ${t.setup.map((v) => `<code>${v}</code>`).join(' and ')} to <code>.env</code>, then restart Akari.</p>
        <p>Redirect URL: <code>${esc(t.redirect)}</code></p>`;
    } else {
      body = `<p>You'll sign in on ${t.name} and come straight back here.</p><div><a class="btn small primary" href="${esc(t.authUrl)}">Connect</a></div>`;
    }
    return `<div class="tracker"><div class="tracker-top"><h3>${t.name}</h3><span class="chip ${t.connected ? 'completed' : ''}">${t.connected ? 'Connected' : 'Not connected'}</span></div>${body}</div>`;
  };
  view(`<div class="wrap">
    <div class="page-head"><div style="display:grid;gap:4px"><a class="eyebrow" href="#/more" style="text-decoration:none">← More</a><h1>Tracking</h1>
      <p>Akari matches series by AniList, MyAnimeList or Kitsu id and moves them to Watching or Completed as you go. It never lowers your progress.</p></div></div>
    <div class="stack"><div class="tracker-list">${Object.entries(tr).map(([k, t]) => card(k, t)).join('')}</div></div>
  </div>`);

  $$('[data-disconnect]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/trackers/${b.dataset.disconnect}/disconnect`, { method: 'POST' });
    toast(`Disconnected ${TRACKER_NAME[b.dataset.disconnect]}.`);
    catalog = null;
    trackersPage();
  }));
  $('#anilist-client-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/trackers/anilist/client', { method: 'POST', body: { clientId: $('#anilist-client-id').value } });
      trackersPage();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#kitsu-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      await api('/api/trackers/kitsu/login', { method: 'POST', body: { username: $('#kitsu-user').value, password: $('#kitsu-pass').value } });
      toast('Connected Kitsu.', 'ok');
      trackersPage();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
}

// ---------------- Search ----------------
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  location.hash = `#/search/${enc($('#search-input').value.trim())}`;
});
let searchTimer;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    if (q) location.hash = `#/search/${enc(q)}`;
    else if (location.hash.startsWith('#/search')) location.hash = '#/';
  }, 250);
});

async function searchPage(q) {
  const c = await loadCatalog();
  const needle = q.toLowerCase();
  const hits = c.shows.filter((s) => [s.title, s.titleNative, ...(s.genres || []), s.studio].join(' ').toLowerCase().includes(needle));
  $('#search-input').value = q;
  view(`<div class="wrap">
    <div class="page-head"><h1>${hits.length} result${hits.length === 1 ? '' : 's'} for “${esc(q)}”</h1></div>
    ${hits.length ? `<div class="grid">${hits.map((s) => `<a class="card" href="${showHref(s)}"><div class="art">${poster(s)}</div><span class="title">${esc(s.title)}</span><span class="sub">${esc(s.sourceLabel)}</span></a>`).join('')}</div>`
      : emptyState('?', 'No matches', c.shows.length ? 'Search covers titles, genres and studios in your repositories.' : 'Add a repository first, then search its shows.')}
  </div>`);
}

// ---------------- Series page ----------------
function episodeCard(show, e, p, current) {
  const watched = p?.watched?.includes(e.number);
  const inProgress = p?.ep === e.number && !watched && p.duration;
  const pct = inProgress ? Math.min(100, (p.position / p.duration) * 100) : watched ? 100 : 0;
  const art = e.thumbnail || show.banner;
  return `<a class="ep-card${watched ? ' watched' : ''}" href="${watchHref(show.key, e.number)}" ${current ? 'aria-current="true"' : ''}>
    <span class="still" style="background-image:${art ? cssUrl(art) : 'none'};background-color:${safeColor(show.color)}">
      ${e.duration ? `<span class="ep-badge">${minutes(e.duration)}</span>` : ''}
      ${pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}
    </span>
    <span style="display:grid;gap:2px;min-width:0">
      <span class="ep-title">${epCode(e.number)} – ${esc(e.title || `Episode ${e.number}`)}</span>
      <span class="ep-meta">${watched ? 'Watched' : inProgress ? `${fmt(p.duration - p.position)} left` : e.released ? new Date(e.released).toLocaleDateString() : ''}</span>
    </span>
  </a>`;
}

async function showPage(key) {
  const s = await api(`/api/show/${enc(key)}`);
  const p = s.progress;
  const watched = new Set(p?.watched || []);
  const next = s.episodes.find((e) => !watched.has(e.number)) || s.episodes[0];
  const resuming = p && p.ep === next.number && !watched.has(next.number) && p.position > 5;
  document.title = `${s.title} · Akari`;

  view(`
    <section class="series-hero">
      <div class="hero-art" style="background-image:${s.banner ? cssUrl(s.banner) : 'none'};background-color:${safeColor(s.color)}"></div>
      <div class="wrap series-top">
        ${poster(s)}
        <div class="series-info">
          <span class="eyebrow">${esc(s.sourceLabel)}${s.license ? ` · ${esc(s.license)}` : ''}</span>
          <h1>${esc(s.title)}</h1>
          ${s.titleNative ? `<div class="native">${esc(s.titleNative)}</div>` : ''}
          ${metaLine({ ...s, episodeCount: s.episodes.length })}
          <div class="actions">
            <a class="btn primary" href="${watchHref(s.key, next.number)}"><span class="play-glyph" aria-hidden="true"></span>${resuming ? `Continue ${epCode(next.number)}` : watched.size ? `Watch ${epCode(next.number)}` : `Start watching ${epCode(next.number)}`}</a>
          </div>
        </div>
      </div>
    </section>
    <div class="wrap series-body">
      <div style="display:grid;gap:22px;align-content:start;min-width:0">
        ${s.synopsis ? `<p class="synopsis">${esc(s.synopsis)}</p>` : ''}
        ${s.genres?.length ? `<div class="genres">${s.genres.map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
        <section aria-label="Episodes">
          <div class="section-head"><h2>Episodes</h2><span class="eyebrow">${s.episodes.length}${s.totalEpisodes ? ` of ${s.totalEpisodes}` : ''} available · ${watched.size} watched</span></div>
          <div class="ep-grid">${s.episodes.map((e) => episodeCard(s, e, p, false)).join('')}</div>
        </section>
      </div>
      <aside class="side">
        <div class="panel" id="tracker-panel"><h2>Tracking</h2><p class="lede">Checking your lists…</p></div>
        ${p ? '<button class="btn quiet small" id="reset-progress" type="button">Clear watch history for this series</button>' : ''}
      </aside>
    </div>`);

  $('#reset-progress')?.addEventListener('click', async () => {
    await api(`/api/progress/${enc(s.key)}`, { method: 'DELETE' });
    toast('Cleared watch history for this series. Your tracker lists were not changed.');
    route();
  });
  renderTrackerPanel(s);
}

async function renderTrackerPanel(s) {
  const panel = $('#tracker-panel');
  let status;
  try {
    status = await api(`/api/show/${enc(s.key)}/trackers`);
  } catch (e) {
    panel.innerHTML = `<h2>Tracking</h2><p class="err">${esc(e.message)}</p>`;
    return;
  }
  if (!panel.isConnected) return;
  const keys = Object.keys(status);
  if (!keys.length) {
    panel.innerHTML = '<h2>Tracking</h2><p class="lede">Connect AniList, MyAnimeList or Kitsu in <a href="#/more/trackers">More → Tracking</a> and Akari updates your lists as you watch.</p>';
    return;
  }
  const rows = keys.map((k) => {
    const t = status[k];
    let right;
    if (!t.ok) right = '<span class="chip error">Error</span>';
    else if (!t.linked) right = '<span class="chip">No id for this series</span>';
    else if (!t.entry) right = '<span class="chip">Not on your list</span>';
    else right = `<span class="chip ${t.entry.status}">${STATUS_LABEL[t.entry.status]} · <span class="mono">${t.entry.progress}${s.totalEpisodes ? `/${s.totalEpisodes}` : ''}</span></span>`;
    return `<div class="tracker-row"><b>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${TRACKER_NAME[k]}</a>` : TRACKER_NAME[k]}</b>${right}</div>
      ${t.ok === false ? `<p class="err">${esc(t.reason)}</p>` : ''}`;
  }).join('');
  const first = Object.values(status).find((t) => t.entry)?.entry;
  panel.innerHTML = `<h2>Tracking</h2>${rows}
    <form class="tracker-form" id="tracker-form">
      <label class="sr-only" for="tr-status">List status</label>
      <select id="tr-status">${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${first?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="sr-only" for="tr-progress">Episodes watched</label>
      <input id="tr-progress" type="number" min="0" ${s.totalEpisodes ? `max="${s.totalEpisodes}"` : ''} value="${first?.progress ?? 0}" inputmode="numeric">
      <button class="btn small primary" type="submit">Update</button>
    </form>`;
  $('#tracker-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      const res = await api(`/api/show/${enc(s.key)}/trackers`, { method: 'POST', body: { status: $('#tr-status').value, progress: $('#tr-progress').value } });
      reportSync(res, 'Updated');
      renderTrackerPanel(s);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
}

function reportSync(results, verb) {
  const ok = [], bad = [];
  for (const [k, r] of Object.entries(results || {})) (r.ok ? ok : bad).push(r.ok ? TRACKER_NAME[k] : `${TRACKER_NAME[k]}: ${r.reason}`);
  if (ok.length) toast(`${verb} ${ok.join(', ')}`, 'ok');
  for (const b of bad) toast(b, 'error');
}

// ---------------- Player ----------------
let hlsLoader;
function loadHls() {
  hlsLoader ??= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
    sc.onload = () => resolve(window.Hls);
    sc.onerror = () => reject(new Error('Could not load the HLS player.'));
    document.head.append(sc);
  });
  return hlsLoader;
}

async function attachSource(video, src) {
  const isHls = /\.m3u8(\?|$)/i.test(src);
  if (!isHls || video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    return null;
  }
  const Hls = await loadHls();
  if (!Hls.isSupported()) throw new Error('This browser cannot play HLS streams.');
  const hls = new Hls({ enableWorker: true });
  hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) toast(`Playback error: ${d.details}`, 'error'); });
  hls.loadSource(src);
  hls.attachMedia(video);
  return hls;
}

async function watchPage(key, epStr) {
  const s = await api(`/api/show/${enc(key)}`);
  const n = Number(epStr);
  const idx = s.episodes.findIndex((e) => e.number === n);
  if (idx < 0) throw new Error(`${epCode(n)} is not in this series' repository.`);
  const ep = s.episodes[idx], prev = s.episodes[idx - 1], next = s.episodes[idx + 1];
  const p = s.progress;
  document.title = `${epCode(ep.number)} · ${s.title} · Akari`;

  view(`
    <div class="theatre"><div class="player">
      <video id="video" controls playsinline preload="metadata" ${ep.thumbnail || s.banner ? `poster="${esc(ep.thumbnail || s.banner)}"` : ''} ${ep.subtitles.length ? 'crossorigin="anonymous"' : ''}>
        ${ep.subtitles.map((t) => `<track kind="subtitles" srclang="${esc(t.lang)}" label="${esc(t.label)}" src="${esc(t.src)}" ${t.default ? 'default' : ''}>`).join('')}
      </video>
      <button class="btn overlay-btn" id="skip-intro" type="button" hidden>Skip intro</button>
      <div class="next-card" id="next-card" hidden></div>
    </div></div>
    <div class="wrap watch-layout">
      <div class="watch-info">
        <a class="show-link" href="${showHref(s)}">${esc(s.title)}</a>
        <h1>${epCode(ep.number)} – ${esc(ep.title || `Episode ${ep.number}`)}</h1>
        <div class="actions">
          ${prev ? `<a class="btn quiet small" href="${watchHref(s.key, prev.number)}">Previous</a>` : ''}
          ${next ? `<a class="btn quiet small" href="${watchHref(s.key, next.number)}">Next episode</a>` : ''}
          <span class="chip" id="sync-chip">Syncs at 85%</span>
        </div>
        <p class="keys"><kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> 10 s · <kbd>F</kbd> fullscreen · <kbd>N</kbd> next episode</p>
      </div>
      <aside class="watch-side" aria-label="Episodes">
        <div class="section-head"><h2>Episodes</h2></div>
        <div class="ep-grid">${s.episodes.map((e) => episodeCard(s, e, p, e.number === ep.number)).join('')}</div>
      </aside>
    </div>`);

  const video = $('#video');
  let hls = null, lastSave = 0, synced = Boolean(p?.watched?.includes(ep.number)), countdown = null;
  if (synced) $('#sync-chip').textContent = 'Already watched';

  try { hls = await attachSource(video, ep.src); } catch (e) { toast(e.message, 'error'); }

  video.addEventListener('loadedmetadata', () => {
    if (p?.ep === ep.number && p.position > 5 && p.position < video.duration - 30) video.currentTime = p.position;
  }, { once: true });

  const save = (force) => {
    if (!video.duration || (!force && Date.now() - lastSave < 10e3)) return;
    lastSave = Date.now();
    api('/api/progress', { method: 'POST', body: { key: s.key, ep: ep.number, position: video.currentTime, duration: video.duration } }).catch(() => {});
  };

  video.addEventListener('timeupdate', () => {
    save(false);
    const t = video.currentTime;
    $('#skip-intro').hidden = !(ep.intro && t >= ep.intro.start && t < ep.intro.end - 1);
    if (!synced && video.duration && t / video.duration >= 0.85) {
      synced = true;
      const chip = $('#sync-chip');
      chip.textContent = 'Syncing…';
      api('/api/watched', { method: 'POST', body: { key: s.key, ep: ep.number } })
        .then((r) => {
          const count = Object.keys(r.trackers).length;
          chip.textContent = count ? 'Marked watched' : 'Marked watched here';
          chip.className = 'chip completed';
          if (count) reportSync(r.trackers, `Updated ${epCode(ep.number)} on`);
        })
        .catch((e) => { chip.textContent = 'Sync failed'; chip.className = 'chip error'; toast(e.message, 'error'); synced = false; });
    }
  });
  video.addEventListener('pause', () => save(true));
  $('#skip-intro').addEventListener('click', () => { video.currentTime = ep.intro.end; });

  video.addEventListener('ended', () => {
    save(true);
    if (!next) return;
    const card = $('#next-card');
    let left = 8;
    card.hidden = false;
    const paint = () => {
      card.innerHTML = `<span class="eyebrow">Up next</span><b>${epCode(next.number)} – ${esc(next.title || `Episode ${next.number}`)}</b>
        <span>Starting in <span class="count">${left}</span> s</span>
        <div class="actions"><a class="btn small primary" href="${watchHref(s.key, next.number)}">Play now</a><button class="btn small quiet" type="button" id="cancel-next">Cancel</button></div>`;
      $('#cancel-next').onclick = () => { clearInterval(countdown); card.hidden = true; };
    };
    paint();
    countdown = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(countdown); location.hash = watchHref(s.key, next.number); } else paint();
    }, 1000);
  });

  const onKey = (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); video.paused ? video.play() : video.pause(); }
    else if (e.key === 'ArrowRight' && e.target !== video) video.currentTime += 10;
    else if (e.key === 'ArrowLeft' && e.target !== video) video.currentTime -= 10;
    else if (e.key.toLowerCase() === 'f') (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen?.())?.catch?.(() => {});
    else if (e.key.toLowerCase() === 'n' && next) location.hash = watchHref(s.key, next.number);
  };
  document.addEventListener('keydown', onKey);
  video.play().catch(() => {}); // autoplay with sound may be blocked; controls stay available

  teardown = () => {
    save(true);
    clearInterval(countdown);
    document.removeEventListener('keydown', onKey);
    hls?.destroy();
    video.removeAttribute('src');
    video.load();
  };
}

// ---------------- Boot ----------------
const qs = new URLSearchParams(location.search);
if (qs.has('connected')) toast(`Connected ${TRACKER_NAME[qs.get('connected')] || qs.get('connected')}.`, 'ok');
if (qs.has('auth_error')) toast(qs.get('auth_error'), 'error');
if ([...qs].length) history.replaceState(null, '', `${location.pathname}${location.hash}`);
route();
