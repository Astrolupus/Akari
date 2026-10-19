// Browser-only stand-in for server.js, used by the GitHub Pages build.
// It answers the same /api/... routes, keeps everything in this browser's
// localStorage, and talks to GitHub, AniList and Kitsu directly.
//
// Differences from the server version:
//   • only public GitHub repos (no token can be kept safely in a browser)
//   • AniList signs in with the implicit grant (client id only, no secret)
//   • MyAnimeList is unavailable: its API does not allow calls from browsers
//   • sources, progress and sign-ins live in this browser only
import { validateManifest } from './manifest.js';

const PAGE_URL = `${location.origin}${location.pathname}`;
const STATUSES = ['watching', 'planning', 'completed', 'paused', 'dropped'];

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------- Storage ----------------
const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`akari:${key}`);
      return v ? JSON.parse(v) : structuredClone(fallback);
    } catch {
      return structuredClone(fallback);
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`akari:${key}`, JSON.stringify(value));
    } catch {
      throw new ApiError(507, 'This browser would not save Akari data. Storage may be full or blocked for this site.');
    }
  },
  del(key) { try { localStorage.removeItem(`akari:${key}`); } catch { /* ignore */ } },
};

// ---------------- GitHub sources ----------------
let sample;
async function loadSample() {
  if (sample !== undefined) return sample;
  try {
    const r = await fetch('local/sample/anime-source.json');
    sample = r.ok ? { id: 'sample', kind: 'local', manifest: await r.json(), fetchedAt: new Date().toISOString() } : null;
  } catch {
    sample = null;
  }
  return sample;
}
const githubSources = () => LS.get('sources', []);
const saveSources = (list) => LS.set('sources', list);
async function allSources() {
  const s = await loadSample();
  return [...(s ? [s] : []), ...githubSources()];
}

function parseRepoInput(input, pathOverride) {
  const s = String(input || '').trim().replace(/\.git$/, '');
  let owner, repo, ref, p;
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*?))?)?\/?$/i);
  if (m) [, owner, repo, ref, p] = m;
  else {
    m = s.match(/^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/);
    if (!m) return null;
    [, owner, repo, ref] = m;
  }
  p = (pathOverride || p || 'anime-source.json').replace(/^\/+/, '');
  if (!p.endsWith('.json')) p = `${p.replace(/\/+$/, '')}/anime-source.json`;
  return { owner, repo, ref: ref || '', path: p };
}

function shortHash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).slice(0, 6);
}
const sourceId = (o, r, p) => {
  const base = `gh-${o}-${r}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return p === 'anime-source.json' ? base : `${base}-${shortHash(p)}`;
};

const rawUrl = (src, filePath) =>
  `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${encodeURI(src.ref)}/${filePath.split('/').map(encodeURIComponent).join('/')}`;

async function fetchManifest(src) {
  let r;
  try {
    r = await fetch(rawUrl(src, src.path), { cache: 'no-store' });
  } catch {
    throw new ApiError(502, 'Could not reach GitHub. Check your internet connection.');
  }
  if (r.status === 404) throw new ApiError(404, `${src.path} was not found on branch "${src.ref}" of ${src.owner}/${src.repo}.`);
  if (!r.ok) throw new ApiError(502, `GitHub answered ${r.status} when reading ${src.path}.`);
  let manifest;
  try {
    manifest = JSON.parse(await r.text());
  } catch (e) {
    throw new ApiError(400, `${src.path} is not valid JSON (${e.message}).`);
  }
  const { errors } = validateManifest(manifest);
  if (errors.length) {
    const more = errors.length > 5 ? ` (and ${errors.length - 5} more)` : '';
    throw new ApiError(400, `${src.path} has problems: ${errors.slice(0, 5).join(' ')}${more}`);
  }
  return manifest;
}

async function addSource(input, pathOverride) {
  const p = parseRepoInput(input, pathOverride);
  if (!p) throw new ApiError(400, 'Enter a repo as owner/name or paste its github.com link.');
  let r;
  try {
    r = await fetch(`https://api.github.com/repos/${p.owner}/${p.repo}`, { headers: { Accept: 'application/vnd.github+json' } });
  } catch {
    throw new ApiError(502, 'Could not reach GitHub. Check your internet connection.');
  }
  if (r.status === 404) throw new ApiError(404, `github.com/${p.owner}/${p.repo} was not found. The web version can only read public repos.`);
  if (r.status === 403 || r.status === 429) throw new ApiError(429, 'GitHub limits how many repos a browser can look up (60 an hour). Try again later.');
  if (!r.ok) throw new ApiError(502, `GitHub answered ${r.status} for ${p.owner}/${p.repo}.`);
  const repo = await r.json();
  if (repo.private) throw new ApiError(400, 'That repo is private. The web version can only read public repos.');

  const src = { kind: 'github', owner: repo.owner.login, repo: repo.name, ref: p.ref || repo.default_branch, path: p.path };
  src.id = sourceId(src.owner, src.repo, src.path);
  const list = githubSources();
  if (list.some((s) => s.id === src.id)) throw new ApiError(409, `${src.owner}/${src.repo} is already in your library.`);
  src.manifest = await fetchManifest(src);
  src.fetchedAt = new Date().toISOString();
  list.push(src);
  saveSources(list);
  return src;
}

async function refreshSource(id) {
  const list = githubSources();
  const s = list.find((x) => x.id === id);
  if (!s) throw new ApiError(404, 'That source is not a GitHub repo.');
  try {
    s.manifest = await fetchManifest(s);
    s.error = null;
  } catch (e) {
    s.error = e.message; // keep the last good manifest
  }
  s.fetchedAt = new Date().toISOString();
  saveSources(list);
  return s;
}

let refreshing = false;
function refreshStaleInBackground() {
  if (refreshing) return;
  const stale = githubSources().filter((s) => Date.now() - Date.parse(s.fetchedAt || 0) > 30 * 60e3);
  if (!stale.length) return;
  refreshing = true;
  Promise.allSettled(stale.map((s) => refreshSource(s.id))).finally(() => { refreshing = false; });
}

function publicView(s) {
  return {
    id: s.id, kind: s.kind, name: s.manifest?.name || `${s.owner}/${s.repo}`,
    description: s.manifest?.description || '',
    repo: s.kind === 'github' ? `${s.owner}/${s.repo}` : null,
    ref: s.ref || null, path: s.path || null, private: false,
    url: s.kind === 'github' ? `https://github.com/${s.owner}/${s.repo}/blob/${s.ref}/${s.path}` : null,
    shows: s.manifest?.shows?.length || 0,
    episodes: s.manifest?.shows?.reduce((n, x) => n + x.episodes.length, 0) || 0,
    sha: null, fetchedAt: s.fetchedAt || null, error: s.error || null,
  };
}

// ---------------- AniList ----------------
async function anilistQuery(query, variables = {}, token) {
  let r;
  try {
    r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw Object.assign(new Error('Could not reach AniList.'), { status: 502 });
  }
  const j = await r.json().catch(() => ({}));
  if (j.errors?.length) throw Object.assign(new Error(`AniList: ${j.errors[0].message}`), { status: j.errors[0].status || r.status });
  if (!r.ok) throw Object.assign(new Error(r.status === 429 ? 'AniList rate limit reached; try again in a minute.' : `AniList answered ${r.status}.`), { status: r.status });
  return j.data;
}

const META_QUERY = `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) {
  id idMal format episodes seasonYear season averageScore genres
  title { romaji english native } coverImage { extraLarge large color } bannerImage
  description(asHtml: false) studios(isMain: true) { nodes { name } } } } }`;

async function fetchMeta(ids) {
  const cache = LS.get('meta-cache', {});
  const now = Date.now();
  const unique = [...new Set(ids.filter(Boolean))];
  const need = unique.filter((id) => !cache[id] || now - cache[id].at > 24 * 3600e3);
  for (let i = 0; i < need.length; i += 50) {
    try {
      const data = await anilistQuery(META_QUERY, { ids: need.slice(i, i + 50) });
      for (const m of data.Page.media) cache[m.id] = { at: now, m };
    } catch (e) {
      console.warn('[metadata]', e.message);
    }
  }
  if (need.length) { try { LS.set('meta-cache', cache); } catch { /* cache is optional */ } }
  return new Map(unique.filter((id) => cache[id]).map((id) => [id, cache[id].m]));
}

// ---------------- Catalog ----------------
const stripTags = (t) => (t || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

function normalizePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

function resolver(s) {
  if (s.kind === 'local') return (u) => (u == null ? null : /^https?:\/\//i.test(u) ? u : `local/${s.id}/${u.replace(/^\/+/, '')}`);
  const dir = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '';
  return (u) => (u == null ? null : /^https?:\/\//i.test(u) ? u : rawUrl(s, normalizePath(`${dir}/${u}`)));
}

async function catalog() {
  const raw = [];
  for (const s of await allSources()) {
    if (!s.manifest) continue;
    const r = resolver(s);
    const sourceLabel = s.kind === 'github' ? `${s.owner}/${s.repo}` : 'Bundled sample';
    for (const show of s.manifest.shows) {
      raw.push({ key: `${s.id}~${show.slug}`, sourceId: s.id, sourceName: s.manifest.name || sourceLabel, sourceLabel, slug: show.slug, m: show, r });
    }
  }
  const meta = await fetchMeta(raw.map((x) => x.m.ids?.anilist));
  return raw.map(({ m, r, ...base }) => {
    const a = meta.get(m.ids?.anilist) || null;
    return {
      ...base,
      title: m.title || a?.title?.english || a?.title?.romaji || 'Untitled',
      titleNative: m.titleNative || a?.title?.native || null,
      synopsis: m.synopsis || stripTags(a?.description) || '',
      cover: r(m.cover) || a?.coverImage?.extraLarge || a?.coverImage?.large || null,
      banner: r(m.banner) || a?.bannerImage || null,
      color: m.color || a?.coverImage?.color || null,
      year: m.year || a?.seasonYear || null,
      season: a?.season || null,
      format: m.format || a?.format || null,
      studio: m.studio || a?.studios?.nodes?.[0]?.name || null,
      genres: m.genres || a?.genres || [],
      score: a?.averageScore || null,
      totalEpisodes: m.totalEpisodes || a?.episodes || null,
      ids: { anilist: m.ids?.anilist || null, mal: m.ids?.mal || a?.idMal || null, kitsu: m.ids?.kitsu || null },
      license: m.license || null,
      episodes: [...m.episodes].sort((x, y) => x.number - y.number).map((e) => ({
        number: e.number, title: e.title || null, src: r(e.src), duration: e.duration || null,
        thumbnail: r(e.thumbnail), intro: e.intro || null, released: e.released || null,
        subtitles: (e.subtitles || []).map((t) => ({ lang: t.lang || 'und', label: t.label || t.lang || 'Subtitles', src: r(t.src), default: Boolean(t.default) })),
      })),
    };
  });
}

async function getShow(key) {
  const show = (await catalog()).find((s) => s.key === key);
  if (!show) throw new ApiError(404, 'That show is not in your library anymore. Its source may have been removed or renamed.');
  return show;
}

// ---------------- Trackers ----------------
const auth = () => LS.get('auth', {});
const saveAuth = (a) => LS.set('auth', a);
const anilistClientId = () => LS.get('anilist-client-id', '') || window.AKARI_ANILIST_CLIENT_ID || '';

const AL_IN = { CURRENT: 'watching', REPEATING: 'watching', PLANNING: 'planning', COMPLETED: 'completed', PAUSED: 'paused', DROPPED: 'dropped' };
const AL_OUT = { watching: 'CURRENT', planning: 'PLANNING', completed: 'COMPLETED', paused: 'PAUSED', dropped: 'DROPPED' };
const KI_IN = { current: 'watching', planned: 'planning', completed: 'completed', on_hold: 'paused', dropped: 'dropped' };
const KI_OUT = { watching: 'current', planning: 'planned', completed: 'completed', paused: 'on_hold', dropped: 'dropped' };
const KITSU = 'https://kitsu.app/api';

function summary() {
  const a = auth();
  const clientId = anilistClientId();
  return {
    anilist: {
      name: 'AniList',
      configured: Boolean(clientId),
      connected: Boolean(a.anilist),
      user: a.anilist?.user || null,
      needsClientId: !clientId,
      redirect: PAGE_URL,
      authUrl: clientId ? `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=token` : null,
    },
    mal: {
      name: 'MyAnimeList',
      configured: false,
      connected: false,
      user: null,
      unavailable: 'MyAnimeList does not allow sign-in or list updates from a web page on another site. Run Akari on a server to sync with MyAnimeList.',
    },
    kitsu: { name: 'Kitsu', configured: true, connected: Boolean(a.kitsu), user: a.kitsu?.user || null },
  };
}

/** Called on page load when AniList redirects back with #access_token=… */
export async function finishAniListSignIn(fragment) {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const token = params.get('access_token');
  if (!token) throw new Error('AniList did not send a sign-in token.');
  const v = (await anilistQuery('{ Viewer { id name siteUrl avatar { medium } } }', {}, token)).Viewer;
  const a = auth();
  a.anilist = {
    token,
    expiresAt: Date.now() + Number(params.get('expires_in') || 0) * 1000,
    user: { id: v.id, name: v.name, avatar: v.avatar?.medium || null, url: v.siteUrl },
  };
  saveAuth(a);
}

async function kitsuApi(method, path, body) {
  const a = auth();
  let r;
  try {
    r = await fetch(`${KITSU}${path}`, {
      method,
      headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', Authorization: `Bearer ${a.kitsu.access}` },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach Kitsu from this page.');
  }
  if (r.status === 401) { delete a.kitsu; saveAuth(a); throw new Error('Your Kitsu sign-in expired. Sign in again in Settings.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Kitsu: ${j.errors?.[0]?.detail || j.errors?.[0]?.title || r.status}`);
  return j;
}

async function kitsuLogin(username, password) {
  if (!username || !password) throw new ApiError(400, 'Enter your Kitsu email and password.');
  let r;
  try {
    r = await fetch(`${KITSU}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'password', username, password }),
    });
  } catch {
    throw new ApiError(502, 'Could not reach Kitsu from this page. Kitsu may not allow sign-in from other sites; the server version of Akari always works.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new ApiError(401, j.error === 'invalid_grant' ? 'Kitsu did not accept that email and password.' : `Kitsu refused the sign-in (${j.error_description || j.error || r.status}).`);
  }
  const a = auth();
  a.kitsu = { access: j.access_token, user: null };
  saveAuth(a);
  const me = (await kitsuApi('GET', '/edge/users?filter[self]=true')).data?.[0];
  if (!me) { delete a.kitsu; saveAuth(a); throw new ApiError(502, 'Kitsu signed in but did not return your profile.'); }
  a.kitsu.user = { id: me.id, name: me.attributes.name, avatar: me.attributes.avatar?.small || null, url: `https://kitsu.app/users/${me.attributes.slug || me.id}` };
  saveAuth(a); // the password itself is never stored
}

const adapters = {
  anilist: {
    async idFor(show) { return show.ids.anilist || null; },
    async get(id) {
      const a = auth().anilist;
      try {
        const d = await anilistQuery('query ($m: Int, $u: Int) { MediaList(mediaId: $m, userId: $u) { status progress } }', { m: id, u: a.user.id }, a.token);
        return d.MediaList ? { status: AL_IN[d.MediaList.status], progress: d.MediaList.progress } : null;
      } catch (e) {
        if (e.status === 404) return null;
        if (e.status === 401 || e.status === 400 && /token/i.test(e.message)) { const x = auth(); delete x.anilist; saveAuth(x); throw new Error('Your AniList sign-in expired. Connect it again in Settings.'); }
        throw e;
      }
    },
    async set(id, { status, progress }) {
      await anilistQuery('mutation ($m: Int, $s: MediaListStatus, $p: Int) { SaveMediaListEntry(mediaId: $m, status: $s, progress: $p) { id } }',
        { m: id, s: AL_OUT[status], p: progress }, auth().anilist.token);
    },
    url: (id) => `https://anilist.co/anime/${id}`,
  },
  kitsu: {
    async idFor(show) {
      if (show.ids.kitsu) return show.ids.kitsu;
      const map = LS.get('kitsu-map', {});
      for (const [site, ext] of [['myanimelist/anime', show.ids.mal], ['anilist/anime', show.ids.anilist]]) {
        if (!ext) continue;
        const key = `${site}:${ext}`;
        if (!(key in map)) {
          const j = await kitsuApi('GET', `/edge/mappings?filter[externalSite]=${encodeURIComponent(site)}&filter[externalId]=${ext}&include=item`);
          const id = j.data?.[0]?.relationships?.item?.data?.id;
          map[key] = id ? Number(id) : null;
          LS.set('kitsu-map', map);
        }
        if (map[key]) return map[key];
      }
      return null;
    },
    async get(id) {
      const j = await kitsuApi('GET', `/edge/library-entries?filter[userId]=${auth().kitsu.user.id}&filter[animeId]=${id}`);
      const e = j.data?.[0];
      return e ? { status: KI_IN[e.attributes.status], progress: e.attributes.progress, entryId: e.id } : null;
    },
    async set(id, { status, progress }, existing) {
      const attributes = { status: KI_OUT[status], progress };
      if (existing?.entryId) {
        await kitsuApi('PATCH', `/edge/library-entries/${existing.entryId}`, { data: { id: existing.entryId, type: 'libraryEntries', attributes } });
      } else {
        await kitsuApi('POST', '/edge/library-entries', { data: { type: 'libraryEntries', attributes, relationships: {
          user: { data: { type: 'users', id: String(auth().kitsu.user.id) } },
          anime: { data: { type: 'anime', id: String(id) } },
        } } });
      }
    },
    url: (id) => `https://kitsu.app/anime/${id}`,
  },
};

async function eachConnected(fn) {
  const a = auth();
  const out = {};
  await Promise.all(Object.entries(adapters).map(async ([key, adapter]) => {
    if (!a[key]) return;
    try { out[key] = await fn(adapter); } catch (e) { out[key] = { ok: false, reason: e.message }; }
  }));
  return out;
}
const plain = (e) => (e ? { status: e.status, progress: e.progress } : null);

function statusFor(show) {
  return eachConnected(async (ad) => {
    const id = await ad.idFor(show);
    if (!id) return { ok: true, linked: false };
    return { ok: true, linked: true, url: ad.url(id), entry: plain(await ad.get(id)) };
  });
}

function applyAll(show, decide) {
  listCache = null;
  return eachConnected(async (ad) => {
    const id = await ad.idFor(show);
    if (!id) return { ok: false, reason: 'This show has no id for this tracker.' };
    const cur = await ad.get(id);
    const next = decide(cur);
    if (!next) return { ok: true, unchanged: true, entry: plain(cur) };
    await ad.set(id, next, cur);
    return { ok: true, entry: next, url: ad.url(id) };
  });
}

function recordWatched(show, ep) {
  const total = show.totalEpisodes;
  return applyAll(show, (cur) => {
    if (cur?.status === 'completed') return null;
    const progress = Math.max(cur?.progress || 0, Math.floor(ep));
    const status = total && progress >= total ? 'completed' : 'watching';
    if (cur && cur.progress === progress && cur.status === status) return null;
    return { status, progress };
  });
}

function setEntry(show, status, progress) {
  if (!STATUSES.includes(status)) throw new ApiError(400, `Status must be one of: ${STATUSES.join(', ')}.`);
  return applyAll(show, (cur) => ({
    status,
    progress: Number.isInteger(progress) ? progress : status === 'completed' && show.totalEpisodes ? show.totalEpisodes : cur?.progress || 0,
  }));
}

let listCache = null;
async function anilistOpenEntries() {
  const a = auth().anilist;
  if (!a) return [];
  if (listCache && Date.now() - listCache.at < 120e3) return listCache.entries;
  const d = await anilistQuery(`query ($u: Int) { MediaListCollection(userId: $u, type: ANIME, status_in: [CURRENT, REPEATING, PLANNING, PAUSED]) {
    lists { entries { mediaId status progress } } } }`, { u: a.user.id }, a.token);
  const entries = d.MediaListCollection.lists.flatMap((l) => l.entries).map((e) => ({ anilistId: e.mediaId, status: AL_IN[e.status], progress: e.progress }));
  listCache = { at: Date.now(), entries };
  return entries;
}

// ---------------- Routes ----------------
const progressStore = () => LS.get('progress', {});

const routes = [
  ['GET', /^\/api\/catalog$/, async () => {
    refreshStaleInBackground();
    const shows = await catalog();
    let onList = [];
    try { onList = await anilistOpenEntries(); } catch (e) { console.warn('[anilist list]', e.message); }
    return {
      shows: shows.map(({ episodes, ...s }) => ({
      ...s,
      episodeCount: episodes.length,
      episodeNumbers: episodes.map((e) => e.number),
      firstEpisode: episodes[0]?.number ?? 1,
      releases: episodes.filter((e) => e.released).map(({ number, title, released, thumbnail }) => ({ number, title, released, thumbnail })),
    })),
      sources: (await allSources()).map(publicView),
      progress: progressStore(),
      onList,
    };
  }],
  ['GET', /^\/api\/show\/([^/]+)$/, async (m) => {
    const show = await getShow(m[1]);
    return { ...show, progress: progressStore()[show.key] || null };
  }],
  ['GET', /^\/api\/show\/([^/]+)\/trackers$/, async (m) => statusFor(await getShow(m[1]))],
  ['POST', /^\/api\/show\/([^/]+)\/trackers$/, async (m, b) => {
    const p = b.progress;
    return setEntry(await getShow(m[1]), b.status, p == null || p === '' ? undefined : Number(p));
  }],
  ['POST', /^\/api\/progress$/, async (m, b) => {
    if (typeof b.key !== 'string' || typeof b.ep !== 'number') throw new ApiError(400, 'Progress needs a show key and an episode number.');
    const all = progressStore();
    const cur = all[b.key] || { watched: [] };
    all[b.key] = { ...cur, ep: b.ep, position: Math.max(0, Number(b.position) || 0), duration: Number(b.duration) || null, updatedAt: new Date().toISOString() };
    LS.set('progress', all);
    return { ok: true };
  }],
  ['POST', /^\/api\/watched$/, async (m, b) => {
    const show = await getShow(b.key);
    const all = progressStore();
    const cur = all[b.key] || { ep: b.ep, position: 0, watched: [] };
    if (!cur.watched.includes(b.ep)) cur.watched.push(b.ep);
    all[b.key] = { ...cur, updatedAt: new Date().toISOString() };
    LS.set('progress', all);
    return { trackers: await recordWatched(show, b.ep) };
  }],
  ['DELETE', /^\/api\/progress\/([^/]+)$/, async (m) => {
    const all = progressStore();
    delete all[m[1]];
    LS.set('progress', all);
    return { ok: true };
  }],
  ['GET', /^\/api\/sources$/, async () => (await allSources()).map(publicView)],
  ['POST', /^\/api\/sources$/, async (m, b) => publicView(await addSource(b.repo, String(b.path || '').trim() || undefined))],
  ['POST', /^\/api\/sources\/([^/]+)\/refresh$/, async (m) => publicView(await refreshSource(m[1]))],
  ['DELETE', /^\/api\/sources\/([^/]+)$/, async (m) => {
    const list = githubSources();
    const next = list.filter((s) => s.id !== m[1]);
    if (next.length === list.length) throw new ApiError(404, 'That source was already removed.');
    saveSources(next);
    return { ok: true };
  }],
  ['GET', /^\/api\/trackers$/, async () => summary()],
  ['POST', /^\/api\/trackers\/anilist\/client$/, async (m, b) => {
    const id = String(b.clientId || '').trim();
    if (!/^\d+$/.test(id)) throw new ApiError(400, 'An AniList client ID is a number, like 12345.');
    LS.set('anilist-client-id', id);
    return summary();
  }],
  ['POST', /^\/api\/trackers\/kitsu\/login$/, async (m, b) => {
    await kitsuLogin(String(b.username || '').trim(), String(b.password || ''));
    return summary();
  }],
  ['POST', /^\/api\/trackers\/(\w+)\/disconnect$/, async (m) => {
    const a = auth();
    delete a[m[1]];
    saveAuth(a);
    return summary();
  }],
];

export async function handle(method, path, body = {}) {
  const pathname = path.split('?')[0];
  for (const [mth, re, fn] of routes) {
    if (mth !== method) continue;
    const m = pathname.match(re);
    if (!m) continue;
    return fn(m.map((x, i) => (i ? decodeURIComponent(x) : x)), body || {});
  }
  throw new ApiError(404, 'Not found.');
}
