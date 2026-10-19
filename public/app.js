// Akari front end: a small hash-routed app with no build step.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = (html) => { $('#view').innerHTML = html; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

const STATUS_LABEL = { watching: 'Watching', planning: 'Plan to watch', completed: 'Completed', paused: 'Paused', dropped: 'Dropped' };
const TRACKER_NAME = { anilist: 'AniList', mal: 'MyAnimeList', kitsu: 'Kitsu' };

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

const fmt = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const epCode = (n) => `E${String(n).padStart(2, '0')}`;
const hue = (t) => [...String(t)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : 'var(--panel-2)');
const cssUrl = (u) => `url("${String(u).replace(/["\\\n]/g, '')}")`;
const showHref = (s) => `#/show/${enc(s.key)}`;
const watchHref = (key, n) => `#/watch/${enc(key)}/${n}`;

function poster(s) {
  return s.cover
    ? `<img class="poster" src="${esc(s.cover)}" alt="" loading="lazy" style="background:${safeColor(s.color)}">`
    : `<div class="poster poster-gen" style="--h:${hue(s.title)}" aria-hidden="true"><span>${esc(s.title)}</span></div>`;
}

function metaLine(s, extra = '') {
  const bits = [
    s.format && esc(String(s.format).replace(/_/g, ' ')),
    s.year && `<span class="mono">${s.year}</span>`,
    s.totalEpisodes ? `<span class="mono">${s.totalEpisodes}</span> episode${s.totalEpisodes === 1 ? '' : 's'}` : s.episodeCount ? `<span class="mono">${s.episodeCount}</span> available` : '',
    s.studio && esc(s.studio),
    s.score && `<span class="score mono">${s.score}%</span>`,
  ].filter(Boolean);
  return `<div class="meta-line">${bits.map((b) => `<span>${b}</span>`).join('')}${extra}</div>`;
}

// ---------------- Data ----------------
let catalog = null;
async function loadCatalog(force = false) {
  if (!catalog || force) catalog = await api('/api/catalog');
  return catalog;
}

// ---------------- Router ----------------
let teardown = null;
const routes = [
  [/^#?\/?$/, home],
  [/^#\/show\/([^/]+)$/, showPage],
  [/^#\/watch\/([^/]+)\/([\d.]+)$/, watchPage],
  [/^#\/search\/?(.*)$/, searchPage],
  [/^#\/settings$/, settingsPage],
];

async function route() {
  if (teardown) { teardown(); teardown = null; }
  if (STATIC && /access_token=/.test(location.hash)) {
    // AniList's browser sign-in returns the token in the URL fragment.
    const fragment = location.hash;
    history.replaceState(null, '', `${location.pathname}#/settings`);
    try {
      await backend.finishAniListSignIn(fragment);
      toast('Connected AniList.', 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  const h = location.hash || '#/';
  $$('[data-nav]').forEach((a) => a.removeAttribute('aria-current'));
  $(`[data-nav="${h.startsWith('#/settings') ? 'settings' : 'home'}"]`)?.setAttribute('aria-current', 'page');
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (!m) continue;
    view('<div class="loading">Loading…</div>');
    try {
      await fn(...m.slice(1).map((x) => decodeURIComponent(x || '')));
    } catch (e) {
      view(`<div class="wrap"><div class="notice error">${esc(e.message)}</div><a class="btn" href="#/">Back to library</a></div>`);
    }
    window.scrollTo(0, 0);
    return;
  }
  view('<div class="wrap empty"><h1>Page not found</h1><a class="btn" href="#/">Back to library</a></div>');
}
window.addEventListener('hashchange', route);

// ---------------- Home ----------------
function continueItems(c) {
  const byKey = new Map(c.shows.map((s) => [s.key, s]));
  return Object.entries(c.progress)
    .filter(([k]) => byKey.has(k))
    .sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''))
    .map(([k, p]) => ({ show: byKey.get(k), p }))
    .filter(({ show, p }) => !(p.watched?.includes(p.ep) && p.ep >= show.episodeCount && p.position >= (p.duration || 1) * 0.85));
}

async function home() {
  const c = await loadCatalog(true);
  if (!c.shows.length) {
    view(`<div class="wrap empty">
      <span class="eyebrow">Library is empty</span>
      <h1>Connect a GitHub repo to fill your library</h1>
      <p>Akari reads an <code>anime-source.json</code> file from each repo you add and builds your catalog from it. Titles, art and synopses come from AniList.</p>
      <a class="btn primary" href="#/settings">Add a repo</a>
    </div>`);
    return;
  }

  const cont = continueItems(c);
  const featured = cont[0]?.show || c.shows.find((s) => s.banner) || c.shows[0];
  const fp = c.progress[featured.key];
  const resumeEp = fp?.ep ?? featured.firstEpisode;
  const left = fp?.duration ? fp.duration - fp.position : 0;
  const playLabel = fp && left > 30 ? `Resume ${epCode(resumeEp)} · ${fmt(left)} left` : `Play ${epCode(resumeEp)}`;

  const onListIds = new Map(c.onList.map((e) => [e.anilistId, e]));
  const onList = c.shows.filter((s) => s.ids.anilist && onListIds.has(s.ids.anilist));

  const shelf = (title, sub, items, wide = false) => items.length ? `
    <section aria-label="${esc(title)}">
      <div class="shelf-head"><h2>${esc(title)}</h2>${sub ? `<span class="eyebrow">${sub}</span>` : ''}</div>
      <div class="row${wide ? ' wide' : ''}">${items.join('')}</div>
    </section>` : '';

  const card = (s, sub) => `<a class="card" href="${showHref(s)}">${poster(s)}<span class="title">${esc(s.title)}</span><span class="sub">${sub ?? esc([s.year, s.genres?.slice(0, 2).join(' · ')].filter(Boolean).join(' · '))}</span></a>`;
  const contCard = ({ show: s, p }) => {
    const pct = p.duration ? Math.min(100, (p.position / p.duration) * 100) : 0;
    return `<a class="card" href="${watchHref(s.key, p.ep)}">
      <div class="still" style="background-image:${s.banner ? cssUrl(s.banner) : 'none'};background-color:${safeColor(s.color)}">
        <span class="ep-badge">${epCode(p.ep)}</span><span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>
      </div>
      <span class="title">${esc(s.title)}</span>
      <span class="sub mono">${p.duration ? `${fmt(p.duration - p.position)} left` : 'Started'}</span></a>`;
  };

  const bySource = c.sources.filter((src) => src.shows).map((src) =>
    shelf(src.name, esc(src.repo ? `github.com/${src.repo}` : 'Bundled sample'), c.shows.filter((s) => s.sourceId === src.id).map((s) => card(s))));

  view(`
    <section class="hero">
      <div class="hero-art" style="background-image:${featured.banner ? cssUrl(featured.banner) : 'none'};background-color:${safeColor(featured.color)}"></div>
      <div class="wrap"><div class="hero-body">
        <span class="eyebrow">${cont[0] ? 'Continue watching' : `From ${esc(featured.sourceLabel)}`}</span>
        <h1>${esc(featured.title)}</h1>
        ${featured.titleNative ? `<div class="native">${esc(featured.titleNative)}</div>` : ''}
        ${metaLine(featured)}
        ${featured.synopsis ? `<p>${esc(featured.synopsis)}</p>` : ''}
        <div class="actions">
          <a class="btn primary" href="${watchHref(featured.key, resumeEp)}"><span class="play-glyph" aria-hidden="true"></span>${playLabel}</a>
          <a class="btn ghost" href="${showHref(featured)}">Episodes and details</a>
        </div>
      </div></div>
    </section>
    <div class="wrap shelves">
      ${shelf('Continue watching', '', cont.slice(0, 12).map(contCard), true)}
      ${shelf('On your AniList', 'watching, paused or planned', onList.map((s) => {
        const e = onListIds.get(s.ids.anilist);
        return card(s, `${STATUS_LABEL[e.status]} · ${e.progress}/${s.totalEpisodes || '?'}`);
      }))}
      ${bySource.join('')}
    </div>`);
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
    <div class="page-head"><span class="eyebrow">Search</span><h1>${hits.length} result${hits.length === 1 ? '' : 's'} for “${esc(q)}”</h1></div>
    ${hits.length ? `<div class="grid">${hits.map((s) => `<a class="card" href="${showHref(s)}">${poster(s)}<span class="title">${esc(s.title)}</span><span class="sub">${esc(s.sourceLabel)}</span></a>`).join('')}</div>`
      : '<p class="lede">Nothing in your connected repos matches that. Search covers titles, genres and studios.</p>'}
  </div>`);
}

// ---------------- Show page ----------------
function episodeRow(show, e, p, current) {
  const watched = p?.watched?.includes(e.number);
  const inProgress = p?.ep === e.number && !watched && p.duration;
  const pct = inProgress ? Math.min(100, (p.position / p.duration) * 100) : watched ? 100 : 0;
  return `<a class="ep${watched ? ' watched' : ''}${current ? ' current' : ''}" href="${watchHref(show.key, e.number)}" ${current ? 'aria-current="true"' : ''}>
    <span class="num">${epCode(e.number)}</span>
    <span class="still" style="background-image:${e.thumbnail || show.banner ? cssUrl(e.thumbnail || show.banner) : 'none'};background-color:${safeColor(show.color)}">${pct ? `<span class="bar"><i style="width:${pct}%"></i></span>` : ''}</span>
    <span><span class="ep-title">${esc(e.title || `Episode ${e.number}`)}</span><br>
      <span class="ep-meta">${watched ? 'Watched' : inProgress ? `${fmt(p.duration - p.position)} left` : esc(fmt(e.duration))}</span></span>
    <span class="ep-meta right">${esc(fmt(e.duration))}</span>
  </a>`;
}

async function showPage(key) {
  const s = await api(`/api/show/${enc(key)}`);
  const p = s.progress;
  const next = p ? (p.watched?.includes(p.ep) ? s.episodes.find((e) => e.number > p.ep) : s.episodes.find((e) => e.number === p.ep)) : s.episodes[0];
  const target = next || s.episodes[0];
  document.title = `${s.title} · Akari`;

  view(`
    <div class="show-banner" style="background-image:${s.banner ? cssUrl(s.banner) : 'none'};background-color:${safeColor(s.color)}"></div>
    <div class="wrap show-layout">
      <aside class="show-side">
        ${poster(s)}
        <div class="panel" id="tracker-panel"><h2>Trackers</h2><p class="lede">Checking your lists…</p></div>
      </aside>
      <div class="show-main">
        <div style="display:grid;gap:8px">
          <span class="eyebrow">From ${esc(s.sourceLabel)}${s.license ? ` · ${esc(s.license)}` : ''}</span>
          <h1>${esc(s.title)}</h1>
          ${s.titleNative ? `<div class="native" style="color:var(--muted)">${esc(s.titleNative)}</div>` : ''}
          ${metaLine({ ...s, episodeCount: s.episodes.length })}
        </div>
        <div class="actions">
          <a class="btn primary" href="${watchHref(s.key, target.number)}"><span class="play-glyph" aria-hidden="true"></span>${p ? (next ? `Continue with ${epCode(target.number)}` : 'Watch again') : `Play ${epCode(target.number)}`}</a>
          ${p ? '<button class="btn ghost" id="reset-progress" type="button">Clear watch history</button>' : ''}
        </div>
        ${s.synopsis ? `<p class="synopsis">${esc(s.synopsis)}</p>` : ''}
        ${s.genres?.length ? `<div class="genres">${s.genres.map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
        <section aria-label="Episodes">
          <div class="shelf-head"><h2>Episodes</h2><span class="eyebrow mono">${s.episodes.length}${s.totalEpisodes ? ` of ${s.totalEpisodes}` : ''} available</span></div>
          <div class="episodes">${s.episodes.map((e) => episodeRow(s, e, p, false)).join('')}</div>
        </section>
      </div>
    </div>`);

  $('#reset-progress')?.addEventListener('click', async () => {
    await api(`/api/progress/${enc(s.key)}`, { method: 'DELETE' });
    toast('Cleared watch history for this show. Your tracker lists were not changed.');
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
    panel.innerHTML = `<h2>Trackers</h2><p class="chip error">${esc(e.message)}</p>`;
    return;
  }
  if (!panel.isConnected) return;
  const keys = Object.keys(status);
  if (!keys.length) {
    panel.innerHTML = `<h2>Trackers</h2><p class="lede" style="font-size:var(--step--1)">Connect AniList, MyAnimeList or Kitsu in <a href="#/settings">Settings</a> and Akari will update your list as you watch.</p>`;
    return;
  }
  const rows = keys.map((k) => {
    const t = status[k];
    let right;
    if (!t.ok) right = `<span class="chip error" title="${esc(t.reason)}">Error</span>`;
    else if (!t.linked) right = '<span class="chip">No id for this show</span>';
    else if (!t.entry) right = '<span class="chip">Not on your list</span>';
    else right = `<span class="chip ${t.entry.status}">${STATUS_LABEL[t.entry.status]} · <span class="mono">${t.entry.progress}${s.totalEpisodes ? `/${s.totalEpisodes}` : ''}</span></span>`;
    return `<div class="tracker-row"><b>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">${TRACKER_NAME[k]}</a>` : TRACKER_NAME[k]}</b>${right}</div>
      ${t.ok === false ? `<p style="margin:0;font-size:var(--step--1);color:var(--bad)">${esc(t.reason)}</p>` : ''}`;
  }).join('');
  const first = Object.values(status).find((t) => t.entry)?.entry;
  panel.innerHTML = `<h2>Trackers</h2>${rows}
    <form class="tracker-form" id="tracker-form">
      <label class="sr-only" for="tr-status">List status</label>
      <select id="tr-status">${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${first?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="sr-only" for="tr-progress">Episodes watched</label>
      <input id="tr-progress" type="number" min="0" ${s.totalEpisodes ? `max="${s.totalEpisodes}"` : ''} value="${first?.progress ?? 0}" inputmode="numeric">
      <button class="btn small primary" type="submit">Update all</button>
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
  if (idx < 0) throw new Error(`${epCode(n)} is not in this show's source.`);
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
        <h1><span class="mono" style="color:var(--yuzu)">${epCode(ep.number)}</span> ${esc(ep.title || `Episode ${ep.number}`)}</h1>
        <div class="actions">
          ${prev ? `<a class="btn small" href="${watchHref(s.key, prev.number)}">Previous · ${epCode(prev.number)}</a>` : ''}
          ${next ? `<a class="btn small" href="${watchHref(s.key, next.number)}">Next · ${epCode(next.number)}</a>` : ''}
          <span class="chip" id="sync-chip">Syncs at 85%</span>
        </div>
        <p class="keys"><kbd>Space</kbd> play/pause · <kbd>←</kbd><kbd>→</kbd> 10 s · <kbd>F</kbd> fullscreen · <kbd>N</kbd> next episode</p>
      </div>
      <aside class="watch-side" aria-label="Episodes">
        <div class="episodes">${s.episodes.map((e) => episodeRow(s, e, p, e.number === ep.number)).join('')}</div>
      </aside>
    </div>`);

  const video = $('#video');
  let hls = null, lastSave = 0, synced = Boolean(p?.watched?.includes(ep.number)), countdown = null;
  if (synced) $('#sync-chip').textContent = 'Already marked watched';

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
          const n = Object.keys(r.trackers).length;
          chip.textContent = n ? 'Marked watched' : 'Marked watched here';
          chip.className = 'chip completed';
          if (n) reportSync(r.trackers, `Updated ${epCode(ep.number)} on`);
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
      card.innerHTML = `<span class="eyebrow">Up next</span><b>${epCode(next.number)} ${esc(next.title || '')}</b>
        <span>Starting in <span class="count">${left}</span> s</span>
        <div class="actions"><a class="btn small primary" href="${watchHref(s.key, next.number)}">Play now</a><button class="btn small ghost" type="button" id="cancel-next">Stay here</button></div>`;
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
  video.play().catch(() => {}); // browsers may block autoplay with sound; controls stay available

  teardown = () => {
    save(true);
    clearInterval(countdown);
    document.removeEventListener('keydown', onKey);
    hls?.destroy();
    video.removeAttribute('src');
    video.load();
    document.title = 'Akari';
  };
}

// ---------------- Settings ----------------
async function settingsPage() {
  const [srcs, tr] = await Promise.all([api('/api/sources'), api('/api/trackers')]);
  document.title = 'Settings · Akari';

  const sourceCard = (s) => `<div class="source">
    <div>
      <div class="name">${esc(s.name)}</div>
      <div class="repo">${s.repo ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.repo)}</a> · ${esc(s.ref)} · ${esc(s.path)}${s.private ? ' · private' : ''}` : 'Bundled with Akari'}</div>
      <div class="stats">${plural(s.shows, 'show')} · ${plural(s.episodes, 'episode')}${s.sha ? ` · commit <span class="mono">${esc(s.sha)}</span>` : ''}${s.fetchedAt ? ` · checked ${new Date(s.fetchedAt).toLocaleString()}` : ''}</div>
    </div>
    <div class="btns">${s.kind === 'github' ? `<button class="btn small" data-refresh="${esc(s.id)}" type="button">Refresh</button><button class="btn small ghost danger" data-remove="${esc(s.id)}" data-name="${esc(s.repo)}" type="button">Remove</button>` : ''}</div>
    ${s.error ? `<p class="err">${esc(s.error)} Showing the last version that loaded.</p>` : ''}
  </div>`;

  const trackerCard = (key, t) => {
    let body;
    if (t.connected) {
      body = `<div class="user">${t.user?.avatar ? `<img src="${esc(t.user.avatar)}" alt="">` : ''}<span>Signed in as <a href="${esc(t.user?.url || '#')}" target="_blank" rel="noopener"><b>${esc(t.user?.name || 'you')}</b></a></span></div>
        <p>Episodes you watch past 85% update your ${t.name} list.</p>
        <div><button class="btn small ghost danger" data-disconnect="${key}" type="button">Disconnect</button></div>`;
    } else if (t.unavailable) {
      body = `<p>${esc(t.unavailable)}</p>`;
    } else if (t.needsClientId) {
      body = `<p>AniList needs a free app registration once. On <a href="https://anilist.co/settings/developer" target="_blank" rel="noopener">AniList → Developer</a>, create a client with this redirect URL:</p>
        <p><code>${esc(t.redirect)}</code></p>
        <form id="anilist-client-form">
          <label class="field">Client ID<input id="anilist-client-id" inputmode="numeric" autocomplete="off" required placeholder="12345"></label>
          <div><button class="btn small primary" type="submit">Save and continue</button></div>
        </form>`;
    } else if (key === 'kitsu') {
      body = `<p>Sign in with your Kitsu account. Akari keeps the access token and never stores your password.</p>
        <form id="kitsu-form">
          <label class="field">Email<input id="kitsu-user" type="email" autocomplete="username" required></label>
          <label class="field">Password<input id="kitsu-pass" type="password" autocomplete="current-password" required></label>
          <div><button class="btn small primary" type="submit">Sign in to Kitsu</button></div>
        </form>`;
    } else if (!t.configured) {
      body = `<p>Register an app with ${t.name}, then add ${t.setup.map((v) => `<code>${v}</code>`).join(' and ')} to <code>.env</code> and restart Akari.</p>
        <p>Redirect URL to register: <code>${esc(t.redirect)}</code></p>`;
    } else {
      body = `<p>You'll sign in on ${t.name} and come straight back here.</p><div><a class="btn small primary" href="${esc(t.authUrl)}">Connect ${t.name}</a></div>`;
    }
    return `<div class="tracker"><div class="tracker-top"><h3>${t.name}</h3><span class="chip ${t.connected ? 'completed' : ''}">${t.connected ? 'Connected' : 'Not connected'}</span></div>${body}</div>`;
  };

  view(`<div class="wrap">
    <div class="page-head"><span class="eyebrow">Settings</span><h1>Sources and trackers</h1>
      <p>Your library is built from GitHub repos. Your watch history syncs to the anime trackers you connect.</p>
      ${STATIC ? '<p>This web version reads public repos only and keeps your sources, progress and sign-ins in this browser.</p>' : ''}</div>
    <div class="settings">
      <section aria-labelledby="h-src">
        <h2 id="h-src">GitHub sources</h2>
        <p class="lede">Each repo needs an <code>anime-source.json</code> manifest that lists shows and episode video links. Akari re-reads it every 30 minutes and whenever you press Refresh. Only add video you have the rights to stream.</p>
        <form class="add-source" id="add-source">
          <label class="field">Repository<input id="src-repo" placeholder="owner/repo or https://github.com/owner/repo" required autocomplete="off" spellcheck="false"></label>
          <label class="field">Manifest path (optional)<input id="src-path" placeholder="anime-source.json" autocomplete="off" spellcheck="false"></label>
          <button class="btn primary" type="submit">Add repo</button>
        </form>
        <div class="source-list">${srcs.map(sourceCard).join('') || '<p class="lede">No sources yet.</p>'}</div>
        <details><summary>Manifest format</summary>
<pre class="manifest">{
  "schema": "akari-source/1",
  "name": "My Library",
  "shows": [{
    "slug": "my-series",
    "ids": { "anilist": 21, "mal": 21 },
    "episodes": [
      { "number": 1, "src": "https://cdn.example.com/ep1/master.m3u8",
        "intro": { "start": 62, "end": 152 },
        "subtitles": [{ "lang": "en", "label": "English", "src": "subs/ep1.vtt" }] },
      { "number": 2, "src": "videos/ep2.mp4" }
    ]
  }]
}</pre>
          <p class="lede">With an AniList id, the title, art, synopsis and MyAnimeList id are filled in for you. Paths without <code>https://</code> are read from the repo itself.</p>
        </details>
      </section>
      <section aria-labelledby="h-tr">
        <h2 id="h-tr">Anime trackers</h2>
        <p class="lede">Akari matches shows by their AniList, MyAnimeList or Kitsu id and moves them to Watching or Completed as you go. It never lowers your progress.</p>
        <div class="tracker-list">${Object.entries(tr).map(([k, t]) => trackerCard(k, t)).join('')}</div>
      </section>
    </div></div>`);

  $('#add-source').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true; btn.textContent = 'Reading repo…';
    try {
      const s = await api('/api/sources', { method: 'POST', body: { repo: $('#src-repo').value, path: $('#src-path').value } });
      toast(`Added ${s.repo}: ${plural(s.shows, 'show')}, ${plural(s.episodes, 'episode')}.`, 'ok');
      catalog = null;
      settingsPage();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false; btn.textContent = 'Add repo';
    }
  });
  $$('[data-refresh]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const s = await api(`/api/sources/${enc(b.dataset.refresh)}/refresh`, { method: 'POST' });
      toast(s.error ? s.error : `Refreshed ${s.repo}.`, s.error ? 'error' : 'ok');
      catalog = null;
      settingsPage();
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  }));
  $$('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Press again to remove'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Remove'; }, 4000); return; }
    try {
      await api(`/api/sources/${enc(b.dataset.remove)}`, { method: 'DELETE' });
      toast(`Removed ${b.dataset.name}.`);
      catalog = null;
      settingsPage();
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-disconnect]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/trackers/${b.dataset.disconnect}/disconnect`, { method: 'POST' });
    toast(`Disconnected ${TRACKER_NAME[b.dataset.disconnect]}.`);
    catalog = null;
    settingsPage();
  }));
  $('#anilist-client-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/trackers/anilist/client', { method: 'POST', body: { clientId: $('#anilist-client-id').value } });
      settingsPage();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#kitsu-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      await api('/api/trackers/kitsu/login', { method: 'POST', body: { username: $('#kitsu-user').value, password: $('#kitsu-pass').value } });
      toast('Connected Kitsu.', 'ok');
      settingsPage();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
}

// ---------------- Boot ----------------
const qs = new URLSearchParams(location.search);
if (qs.has('connected')) toast(`Connected ${TRACKER_NAME[qs.get('connected')] || qs.get('connected')}.`, 'ok');
if (qs.has('auth_error')) toast(qs.get('auth_error'), 'error');
if ([...qs].length) history.replaceState(null, '', `${location.pathname}${location.hash}`);
route();
