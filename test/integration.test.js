// End-to-end checks for GitHub sources and tracker sync, with every external API stubbed.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'akari-test-'));
process.env.ANILIST_CLIENT_ID = 'al-id';
process.env.ANILIST_CLIENT_SECRET = 'al-secret';
process.env.MAL_CLIENT_ID = 'mal-id';
process.env.PUBLIC_URL = 'http://localhost:3000';
process.env.ENABLE_SAMPLE = 'false';

const manifest = {
  schema: 'akari-source/1',
  name: 'Test Library',
  shows: [{
    slug: 'cowboy',
    ids: { anilist: 1 },
    episodes: [
      { number: 2, src: 'https://cdn.example.com/ep2.m3u8' },
      { number: 1, src: 'videos/01.mp4', subtitles: [{ lang: 'en', src: 'subs/01.vtt' }] },
    ],
  }],
};

const calls = [];
const lists = { anilist: null, mal: null, kitsu: null };
const reply = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method || 'GET';
  const body = typeof init.body === 'string' ? init.body : init.body?.toString();
  calls.push(`${method} ${url.host}${url.pathname}`);

  // ---- GitHub ----
  if (url.host === 'api.github.com') {
    if (url.pathname === '/repos/me/library') return reply({ owner: { login: 'me' }, name: 'library', default_branch: 'main', private: true });
    if (url.pathname === '/repos/me/library/commits/main') return reply('abc1234def5678');
    if (url.pathname === '/repos/me/library/contents/anime-source.json') return reply(manifest);
    if (url.pathname === '/repos/me/empty') return reply({ owner: { login: 'me' }, name: 'empty', default_branch: 'main', private: false });
    return reply({ message: 'Not Found' }, 404);
  }

  // ---- AniList ----
  if (url.host === 'anilist.co' && url.pathname === '/api/v2/oauth/token') return reply({ access_token: 'al-token' });
  if (url.host === 'graphql.anilist.co') {
    const { query, variables } = JSON.parse(body);
    if (query.includes('Page(')) return reply({ data: { Page: { media: [{ id: 1, idMal: 1, episodes: 2, title: { english: 'Cowboy Bebop', romaji: 'Cowboy Bebop', native: 'カウボーイビバップ' }, coverImage: { extraLarge: 'https://img/cover.jpg', color: '#e4a15d' }, bannerImage: 'https://img/banner.jpg', description: 'Bounty hunters<br>in space.', genres: ['Action'], studios: { nodes: [{ name: 'Sunrise' }] }, format: 'TV', seasonYear: 1998 }] } } });
    if (query.includes('Viewer')) return reply({ data: { Viewer: { id: 42, name: 'spike', siteUrl: 'https://anilist.co/user/spike', avatar: { medium: null } } } });
    if (query.includes('SaveMediaListEntry')) { lists.anilist = { status: variables.s, progress: variables.p }; return reply({ data: { SaveMediaListEntry: { id: 9 } } }); }
    if (query.includes('MediaListCollection')) return reply({ data: { MediaListCollection: { lists: lists.anilist ? [{ entries: [{ mediaId: 1, ...lists.anilist }] }] : [] } } });
    if (query.includes('MediaList(')) return lists.anilist ? reply({ data: { MediaList: lists.anilist } }) : reply({ errors: [{ message: 'Not Found.', status: 404 }], data: { MediaList: null } }, 404);
  }

  // ---- MyAnimeList ----
  if (url.host === 'myanimelist.net' && url.pathname === '/v1/oauth2/token') {
    const p = new URLSearchParams(body);
    assert.equal(p.get('code_verifier')?.length, 64);
    return reply({ access_token: 'mal-token', refresh_token: 'mal-refresh', expires_in: 2415600 });
  }
  if (url.host === 'api.myanimelist.net') {
    if (url.pathname === '/v2/users/@me') return reply({ name: 'faye' });
    if (url.pathname === '/v2/anime/1' && method === 'GET') return reply({ id: 1, ...(lists.mal ? { my_list_status: lists.mal } : {}) });
    if (url.pathname === '/v2/anime/1/my_list_status') {
      const p = new URLSearchParams(body);
      lists.mal = { status: p.get('status'), num_episodes_watched: Number(p.get('num_watched_episodes')) };
      return reply(lists.mal);
    }
  }

  // ---- Kitsu ----
  if (url.host === 'kitsu.app') {
    if (url.pathname === '/api/oauth/token') return reply({ access_token: 'ki-token', refresh_token: 'ki-refresh', expires_in: 2592000 });
    if (url.pathname === '/api/edge/users') return reply({ data: [{ id: '7', attributes: { name: 'jet', slug: 'jet' } }] });
    if (url.pathname === '/api/edge/mappings') {
      assert.equal(url.searchParams.get('filter[externalSite]'), 'myanimelist/anime');
      return reply({ data: [{ relationships: { item: { data: { type: 'anime', id: '1' } } } }] });
    }
    if (url.pathname === '/api/edge/library-entries' && method === 'GET') {
      return reply({ data: lists.kitsu ? [{ id: '55', attributes: lists.kitsu }] : [] });
    }
    if (url.pathname === '/api/edge/library-entries' && method === 'POST') {
      lists.kitsu = JSON.parse(body).data.attributes;
      return reply({ data: { id: '55' } }, 201);
    }
    if (url.pathname === '/api/edge/library-entries/55' && method === 'PATCH') {
      lists.kitsu = JSON.parse(body).data.attributes;
      return reply({ data: { id: '55' } });
    }
  }
  throw new Error(`Unexpected request in test: ${method} ${url}`);
};

const sources = await import('../lib/sources.js');
const trackers = await import('../lib/trackers.js');
const gh = await import('../lib/github.js');

test('parses the ways people paste a repo', () => {
  assert.deepEqual(gh.parseRepoInput('me/library'), { owner: 'me', repo: 'library', ref: '', path: 'anime-source.json' });
  assert.deepEqual(gh.parseRepoInput('me/library@dev'), { owner: 'me', repo: 'library', ref: 'dev', path: 'anime-source.json' });
  assert.deepEqual(gh.parseRepoInput('https://github.com/me/library.git'), { owner: 'me', repo: 'library', ref: '', path: 'anime-source.json' });
  assert.deepEqual(gh.parseRepoInput('https://github.com/me/library/tree/main/anime'), { owner: 'me', repo: 'library', ref: 'main', path: 'anime/anime-source.json' });
  assert.deepEqual(gh.parseRepoInput('https://github.com/me/library/blob/main/lists/a.json'), { owner: 'me', repo: 'library', ref: 'main', path: 'lists/a.json' });
  assert.equal(gh.parseRepoInput('hello world'), null);
});

test('adds a GitHub repo and builds the catalog with AniList metadata', async () => {
  const s = await sources.add('https://github.com/me/library');
  assert.equal(s.id, 'gh-me-library');
  assert.equal(s.ref, 'main');
  assert.equal(s.sha, 'abc1234def5678');
  await assert.rejects(sources.add('me/library'), /already in your library/);
  await assert.rejects(sources.add('me/empty'), /anime-source\.json was not found on branch "main"/);

  const [show] = await sources.catalog();
  assert.equal(show.key, 'gh-me-library~cowboy');
  assert.equal(show.title, 'Cowboy Bebop');
  assert.equal(show.synopsis, 'Bounty hunters\nin space.');
  assert.equal(show.ids.mal, 1, 'MAL id comes from AniList');
  assert.equal(show.totalEpisodes, 2);
  assert.deepEqual(show.episodes.map((e) => e.number), [1, 2], 'episodes are sorted');
  assert.equal(show.episodes[0].src, '/media/gh-me-library/videos/01.mp4', 'private repo files go through the proxy');
  assert.equal(show.episodes[0].subtitles[0].src, '/media/gh-me-library/subs/01.vtt');
  assert.equal(show.episodes[1].src, 'https://cdn.example.com/ep2.m3u8');
});

test('connects AniList, MyAnimeList and Kitsu', async () => {
  const al = new URL(trackers.anilistAuthUrl());
  assert.equal(al.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/anilist/callback');
  await assert.rejects(trackers.anilistCallback({ state: 'forged', code: 'x' }), /expired/);
  await trackers.anilistCallback({ state: al.searchParams.get('state'), code: 'abc' });

  const mal = new URL(trackers.malAuthUrl());
  assert.equal(mal.searchParams.get('code_challenge_method'), 'plain');
  await trackers.malCallback({ state: mal.searchParams.get('state'), code: 'abc' });

  await trackers.kitsuLogin('jet@example.com', 'hunter2');

  const sum = trackers.summary();
  assert.equal(sum.anilist.user.name, 'spike');
  assert.equal(sum.mal.user.name, 'faye');
  assert.equal(sum.kitsu.user.name, 'jet');
  assert.ok(!JSON.stringify(trackers.summary()).includes('hunter2'));
  assert.ok(!fs.readFileSync(path.join(process.env.DATA_DIR, 'auth.json'), 'utf8').includes('hunter2'), 'password is never stored');
});

test('watching episodes updates every tracker and never lowers progress', async () => {
  const [show] = await sources.catalog();

  const before = await trackers.statusFor(show);
  assert.equal(before.anilist.entry, null);
  assert.equal(before.kitsu.linked, true);

  let r = await trackers.recordWatched(show, 1);
  assert.ok(r.anilist.ok && r.mal.ok && r.kitsu.ok, JSON.stringify(r));
  assert.deepEqual(lists.anilist, { status: 'CURRENT', progress: 1 });
  assert.deepEqual(lists.mal, { status: 'watching', num_episodes_watched: 1 });
  assert.deepEqual(lists.kitsu, { status: 'current', progress: 1 });

  r = await trackers.recordWatched(show, 2);
  assert.deepEqual(lists.anilist, { status: 'COMPLETED', progress: 2 });
  assert.deepEqual(lists.mal, { status: 'completed', num_episodes_watched: 2 });
  assert.deepEqual(lists.kitsu, { status: 'completed', progress: 2 }, 'existing Kitsu entry is patched');

  r = await trackers.recordWatched(show, 1);
  assert.ok(r.anilist.unchanged && r.mal.unchanged && r.kitsu.unchanged, 'rewatching an earlier episode changes nothing');

  await trackers.setEntry(show, 'paused', 1);
  assert.deepEqual(lists.anilist, { status: 'PAUSED', progress: 1 });
  assert.deepEqual(lists.mal, { status: 'on_hold', num_episodes_watched: 1 });
  assert.deepEqual(lists.kitsu, { status: 'on_hold', progress: 1 });
  assert.throws(() => trackers.setEntry(show, 'binged'), /Status must be one of/);

  const open = await trackers.anilistOpenEntries();
  assert.deepEqual(open, [{ anilistId: 1, status: 'paused', progress: 1 }]);
});

test('a broken manifest update keeps the last good version', async () => {
  manifest.shows[0].episodes.push({ number: 3, src: 'javascript:alert(1)' });
  calls.length = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).endsWith('/commits/main') ? new Response('newsha') : original(u, i));
  const s = await sources.refresh('gh-me-library');
  globalThis.fetch = original;
  assert.match(s.error, /episodes\[2\]\.src must be an https URL/);
  assert.equal(s.manifest.shows[0].episodes.length, 2);
});
