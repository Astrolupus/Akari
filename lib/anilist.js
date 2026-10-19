import * as store from './store.js';

export async function anilistQuery(query, variables = {}, token) {
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errors?.length) {
    const e = new Error(`AniList: ${j.errors[0].message}`);
    e.status = j.errors[0].status || r.status;
    throw e;
  }
  if (!r.ok) {
    const e = new Error(r.status === 429 ? 'AniList rate limit reached; try again in a minute.' : `AniList answered ${r.status}.`);
    e.status = r.status;
    throw e;
  }
  return j.data;
}

// ---- Metadata (titles, art, synopsis) for shows that list an AniList id ----

const TTL = 24 * 3600e3;
const META_QUERY = `query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id idMal format episodes seasonYear season averageScore genres
      title { romaji english native }
      coverImage { extraLarge large color }
      bannerImage
      description(asHtml: false)
      studios(isMain: true) { nodes { name } }
    }
  }
}`;

let cache = store.load('meta-cache', {});

export async function fetchMeta(ids) {
  const now = Date.now();
  const unique = [...new Set(ids.filter(Boolean))];
  const need = unique.filter((id) => !cache[id] || now - cache[id].at > TTL);
  for (let i = 0; i < need.length; i += 50) {
    try {
      const data = await anilistQuery(META_QUERY, { ids: need.slice(i, i + 50) });
      for (const m of data.Page.media) cache[m.id] = { at: now, m };
    } catch (e) {
      console.warn('[metadata]', e.message); // keep serving stale or manifest-only data
    }
  }
  if (need.length) store.save('meta-cache', cache);
  return new Map(unique.filter((id) => cache[id]).map((id) => [id, cache[id].m]));
}
