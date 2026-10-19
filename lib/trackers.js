// AniList, MyAnimeList and Kitsu: sign-in, reading list entries, and writing progress.
// Akari uses one set of list statuses internally and maps each tracker onto it.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './store.js';
import { anilistQuery } from './anilist.js';

export const STATUSES = ['watching', 'planning', 'completed', 'paused', 'dropped'];

let auth = store.load('auth', {});
const persist = () => store.save('auth', auth);
const callbackUrl = (p) => `${config.publicUrl}/auth/${p}/callback`;

// ---- OAuth state ----
const pending = new Map();
function newState(provider, extra = {}) {
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60e3) pending.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { provider, at: Date.now(), ...extra });
  return state;
}
function takeState(state, provider) {
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.provider !== provider) throw new Error('That sign-in link expired. Start the connection again from Settings.');
  return p;
}

export function summary() {
  return {
    anilist: {
      name: 'AniList',
      configured: Boolean(config.anilist.clientId && config.anilist.clientSecret),
      connected: Boolean(auth.anilist),
      user: auth.anilist?.user || null,
      setup: ['ANILIST_CLIENT_ID', 'ANILIST_CLIENT_SECRET'],
      redirect: callbackUrl('anilist'),
    },
    mal: {
      name: 'MyAnimeList',
      configured: Boolean(config.mal.clientId),
      connected: Boolean(auth.mal),
      user: auth.mal?.user || null,
      setup: ['MAL_CLIENT_ID', 'MAL_CLIENT_SECRET'],
      redirect: callbackUrl('mal'),
    },
    kitsu: {
      name: 'Kitsu',
      configured: true,
      connected: Boolean(auth.kitsu),
      user: auth.kitsu?.user || null,
    },
  };
}

export function disconnect(provider) {
  delete auth[provider];
  persist();
}

// =========================== AniList ===========================
const AL_IN = { CURRENT: 'watching', REPEATING: 'watching', PLANNING: 'planning', COMPLETED: 'completed', PAUSED: 'paused', DROPPED: 'dropped' };
const AL_OUT = { watching: 'CURRENT', planning: 'PLANNING', completed: 'COMPLETED', paused: 'PAUSED', dropped: 'DROPPED' };

export function anilistAuthUrl() {
  const u = new URL('https://anilist.co/api/v2/oauth/authorize');
  u.search = new URLSearchParams({
    client_id: config.anilist.clientId,
    redirect_uri: callbackUrl('anilist'),
    response_type: 'code',
    state: newState('anilist'),
  });
  return u.toString();
}

export async function anilistCallback(q) {
  takeState(q.state, 'anilist');
  if (q.error) throw new Error(`AniList sign-in was cancelled (${q.error}).`);
  const r = await fetch('https://anilist.co/api/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.anilist.clientId,
      client_secret: config.anilist.clientSecret,
      redirect_uri: callbackUrl('anilist'),
      code: q.code,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`AniList refused the sign-in (${j.message || j.error || r.status}).`);
  const v = (await anilistQuery('{ Viewer { id name siteUrl avatar { medium } } }', {}, j.access_token)).Viewer;
  auth.anilist = { token: j.access_token, user: { id: v.id, name: v.name, avatar: v.avatar?.medium || null, url: v.siteUrl } };
  persist();
}

const anilist = {
  async idFor(show) { return show.ids.anilist || null; },
  async get(id) {
    try {
      const d = await anilistQuery(
        'query ($m: Int, $u: Int) { MediaList(mediaId: $m, userId: $u) { status progress } }',
        { m: id, u: auth.anilist.user.id }, auth.anilist.token);
      return d.MediaList ? { status: AL_IN[d.MediaList.status], progress: d.MediaList.progress } : null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },
  async set(id, { status, progress }) {
    await anilistQuery(
      'mutation ($m: Int, $s: MediaListStatus, $p: Int) { SaveMediaListEntry(mediaId: $m, status: $s, progress: $p) { id } }',
      { m: id, s: AL_OUT[status], p: progress }, auth.anilist.token);
  },
  url: (id) => `https://anilist.co/anime/${id}`,
};

let listCache = { at: 0, entries: null };
/** The signed-in user's AniList entries that are in progress or planned. */
export async function anilistOpenEntries() {
  if (!auth.anilist) return [];
  if (listCache.entries && Date.now() - listCache.at < 120e3) return listCache.entries;
  const d = await anilistQuery(
    `query ($u: Int) { MediaListCollection(userId: $u, type: ANIME, status_in: [CURRENT, REPEATING, PLANNING, PAUSED]) {
       lists { entries { mediaId status progress } } } }`,
    { u: auth.anilist.user.id }, auth.anilist.token);
  const entries = d.MediaListCollection.lists.flatMap((l) => l.entries)
    .map((e) => ({ anilistId: e.mediaId, status: AL_IN[e.status], progress: e.progress }));
  listCache = { at: Date.now(), entries };
  return entries;
}

// ========================= MyAnimeList =========================
const MAL_IN = { watching: 'watching', plan_to_watch: 'planning', completed: 'completed', on_hold: 'paused', dropped: 'dropped' };
const MAL_OUT = { watching: 'watching', planning: 'plan_to_watch', completed: 'completed', paused: 'on_hold', dropped: 'dropped' };

export function malAuthUrl() {
  // MAL only supports the "plain" PKCE method, so the challenge is the verifier itself.
  const verifier = crypto.randomBytes(48).toString('base64url'); // 64 chars
  const u = new URL('https://myanimelist.net/v1/oauth2/authorize');
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.mal.clientId,
    state: newState('mal', { verifier }),
    redirect_uri: callbackUrl('mal'),
    code_challenge: verifier,
    code_challenge_method: 'plain',
  });
  return u.toString();
}

async function malToken(params) {
  const body = new URLSearchParams({
    client_id: config.mal.clientId,
    ...(config.mal.clientSecret ? { client_secret: config.mal.clientSecret } : {}),
    ...params,
  });
  const r = await fetch('https://myanimelist.net/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`MyAnimeList refused the sign-in (${j.message || j.error || r.status}).`);
  return { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 0) * 1000 };
}

async function malRefresh() {
  try {
    Object.assign(auth.mal, await malToken({ grant_type: 'refresh_token', refresh_token: auth.mal.refresh }));
    persist();
  } catch {
    disconnect('mal');
    throw new Error('Your MyAnimeList sign-in expired. Connect it again in Settings.');
  }
}

async function malApi(method, path, form) {
  if (auth.mal.expiresAt - Date.now() < 3600e3) await malRefresh();
  const go = () => fetch(`https://api.myanimelist.net/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.mal.access}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  let r = await go();
  if (r.status === 401) { await malRefresh(); r = await go(); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`MyAnimeList: ${j.message || j.error || r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

export async function malCallback(q) {
  const p = takeState(q.state, 'mal');
  if (q.error) throw new Error(`MyAnimeList sign-in was cancelled (${q.error}).`);
  const t = await malToken({ grant_type: 'authorization_code', code: q.code, code_verifier: p.verifier, redirect_uri: callbackUrl('mal') });
  auth.mal = { ...t, user: null };
  const me = await malApi('GET', '/users/@me?fields=picture');
  auth.mal.user = { name: me.name, avatar: me.picture || null, url: `https://myanimelist.net/profile/${encodeURIComponent(me.name)}` };
  persist();
}

const mal = {
  async idFor(show) { return show.ids.mal || null; },
  async get(id) {
    try {
      const j = await malApi('GET', `/anime/${id}?fields=my_list_status`);
      const s = j.my_list_status;
      return s ? { status: MAL_IN[s.status], progress: s.num_episodes_watched } : null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  },
  async set(id, { status, progress }) {
    await malApi('PATCH', `/anime/${id}/my_list_status`, { status: MAL_OUT[status], num_watched_episodes: String(progress) });
  },
  url: (id) => `https://myanimelist.net/anime/${id}`,
};

// ============================ Kitsu ============================
const KI_IN = { current: 'watching', planned: 'planning', completed: 'completed', on_hold: 'paused', dropped: 'dropped' };
const KI_OUT = { watching: 'current', planning: 'planned', completed: 'completed', paused: 'on_hold', dropped: 'dropped' };
let kitsuMap = store.load('kitsu-map', {});

async function kitsuToken(params) {
  const r = await fetch(`${config.kitsuBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(j.error === 'invalid_grant' ? 'Kitsu did not accept that email and password.' : `Kitsu refused the sign-in (${j.error_description || j.error || r.status}).`);
  }
  return { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 0) * 1000 };
}

async function kitsuRefresh() {
  try {
    Object.assign(auth.kitsu, await kitsuToken({ grant_type: 'refresh_token', refresh_token: auth.kitsu.refresh }));
    persist();
  } catch {
    disconnect('kitsu');
    throw new Error('Your Kitsu sign-in expired. Sign in again in Settings.');
  }
}

async function kitsuApi(method, path, body) {
  if (auth.kitsu.expiresAt && auth.kitsu.expiresAt - Date.now() < 3600e3) await kitsuRefresh();
  const go = () => fetch(`${config.kitsuBase}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${auth.kitsu.access}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await go();
  if (r.status === 401) { await kitsuRefresh(); r = await go(); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Kitsu: ${j.errors?.[0]?.detail || j.errors?.[0]?.title || r.status}`);
  return j;
}

export async function kitsuLogin(username, password) {
  if (!username || !password) throw new Error('Enter your Kitsu email and password.');
  auth.kitsu = { ...(await kitsuToken({ grant_type: 'password', username, password })), user: null };
  const me = (await kitsuApi('GET', '/edge/users?filter[self]=true')).data?.[0];
  if (!me) { disconnect('kitsu'); throw new Error('Kitsu signed in but did not return your profile.'); }
  auth.kitsu.user = { id: me.id, name: me.attributes.name, avatar: me.attributes.avatar?.small || null, url: `https://kitsu.app/users/${me.attributes.slug || me.id}` };
  persist(); // the password itself is never stored
}

const kitsu = {
  async idFor(show) {
    if (show.ids.kitsu) return show.ids.kitsu;
    for (const [site, ext] of [['myanimelist/anime', show.ids.mal], ['anilist/anime', show.ids.anilist]]) {
      if (!ext) continue;
      const key = `${site}:${ext}`;
      if (!(key in kitsuMap)) {
        const j = await kitsuApi('GET', `/edge/mappings?filter[externalSite]=${encodeURIComponent(site)}&filter[externalId]=${ext}&include=item`);
        const id = j.data?.[0]?.relationships?.item?.data?.id;
        kitsuMap[key] = id ? Number(id) : null;
        store.save('kitsu-map', kitsuMap);
      }
      if (kitsuMap[key]) return kitsuMap[key];
    }
    return null;
  },
  async get(id) {
    const j = await kitsuApi('GET', `/edge/library-entries?filter[userId]=${auth.kitsu.user.id}&filter[animeId]=${id}`);
    const e = j.data?.[0];
    return e ? { status: KI_IN[e.attributes.status], progress: e.attributes.progress, entryId: e.id } : null;
  },
  async set(id, { status, progress }, existing) {
    const attributes = { status: KI_OUT[status], progress };
    if (existing?.entryId) {
      await kitsuApi('PATCH', `/edge/library-entries/${existing.entryId}`, { data: { id: existing.entryId, type: 'libraryEntries', attributes } });
    } else {
      await kitsuApi('POST', '/edge/library-entries', {
        data: {
          type: 'libraryEntries',
          attributes,
          relationships: {
            user: { data: { type: 'users', id: String(auth.kitsu.user.id) } },
            anime: { data: { type: 'anime', id: String(id) } },
          },
        },
      });
    }
  },
  url: (id) => `https://kitsu.app/anime/${id}`,
};

// ======================= Shared sync logic =======================
const ADAPTERS = { anilist, mal, kitsu };

async function eachConnected(fn) {
  const out = {};
  await Promise.all(Object.entries(ADAPTERS).map(async ([key, adapter]) => {
    if (!auth[key]) return;
    try {
      out[key] = await fn(adapter, key);
    } catch (e) {
      out[key] = { ok: false, reason: e.message };
    }
  }));
  return out;
}

const plain = (e) => (e ? { status: e.status, progress: e.progress } : null);

/** What each connected tracker currently has for this show. */
export function statusFor(show) {
  return eachConnected(async (a) => {
    const id = await a.idFor(show);
    if (!id) return { ok: true, linked: false };
    return { ok: true, linked: true, url: a.url(id), entry: plain(await a.get(id)) };
  });
}

/** Called when an episode is mostly watched. Never lowers progress. */
export function recordWatched(show, episodeNumber) {
  const total = show.totalEpisodes;
  return applyAll(show, (cur) => {
    if (cur?.status === 'completed') return null;
    const progress = Math.max(cur?.progress || 0, Math.floor(episodeNumber));
    const status = total && progress >= total ? 'completed' : 'watching';
    if (cur && cur.progress === progress && cur.status === status) return null;
    return { status, progress };
  });
}

/** Explicit status change from the show page. */
export function setEntry(show, status, progress) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}.`);
  return applyAll(show, (cur) => ({
    status,
    progress: Number.isInteger(progress) ? progress
      : status === 'completed' && show.totalEpisodes ? show.totalEpisodes
        : cur?.progress || 0,
  }));
}

function applyAll(show, decide) {
  listCache.at = 0;
  return eachConnected(async (a) => {
    const id = await a.idFor(show);
    if (!id) return { ok: false, reason: 'This show has no id for this tracker.' };
    const cur = await a.get(id);
    const next = decide(cur);
    if (!next) return { ok: true, unchanged: true, entry: plain(cur) };
    await a.set(id, next, cur);
    return { ok: true, entry: next, url: a.url(id) };
  });
}
