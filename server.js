import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { config } from './lib/config.js';
import * as store from './lib/store.js';
import * as sources from './lib/sources.js';
import * as gh from './lib/github.js';
import * as trackers from './lib/trackers.js';
import { Router, HttpError, json, redirect, readJson, serveStatic, MIME } from './lib/http.js';

const PUBLIC_DIR = path.resolve('public');
const SAMPLE_DIR = path.resolve('sources/sample');
const router = new Router();

// ---- Watch progress (kept on the server so it follows you across devices) ----
let progress = store.load('progress', {});
const saveProgress = () => store.save('progress', progress);

async function getShow(key) {
  const show = (await sources.catalog()).find((s) => s.key === key);
  if (!show) throw new HttpError(404, 'That show is not in your library anymore. Its source may have been removed or renamed.');
  return show;
}

// ============================== Library ==============================

router.get('/api/catalog', async (req, res) => {
  const shows = await sources.catalog();
  let onList = [];
  try { onList = await trackers.anilistOpenEntries(); } catch (e) { console.warn('[anilist list]', e.message); }
  json(res, 200, {
    shows: shows.map(({ episodes, ...s }) => ({ ...s, episodeCount: episodes.length, firstEpisode: episodes[0]?.number ?? 1 })),
    sources: sources.list().map(sources.publicView),
    progress,
    onList,
  });
});

router.get('/api/show/:key', async (req, res, { params }) => {
  const show = await getShow(params.key);
  json(res, 200, { ...show, progress: progress[show.key] || null });
});

router.get('/api/show/:key/trackers', async (req, res, { params }) => {
  json(res, 200, await trackers.statusFor(await getShow(params.key)));
});

router.post('/api/show/:key/trackers', async (req, res, { params }) => {
  const show = await getShow(params.key);
  const body = await readJson(req);
  const p = body.progress;
  json(res, 200, await trackers.setEntry(show, body.status, p == null || p === '' ? undefined : Number(p)));
});

router.post('/api/progress', async (req, res) => {
  const { key, ep, position, duration } = await readJson(req);
  if (typeof key !== 'string' || typeof ep !== 'number') throw new HttpError(400, 'Progress needs a show key and an episode number.');
  const cur = progress[key] || { watched: [] };
  progress[key] = { ...cur, ep, position: Math.max(0, Number(position) || 0), duration: Number(duration) || null, updatedAt: new Date().toISOString() };
  saveProgress();
  json(res, 200, { ok: true });
});

router.post('/api/watched', async (req, res) => {
  const { key, ep } = await readJson(req);
  const show = await getShow(key);
  const cur = progress[key] || { ep, position: 0, watched: [] };
  if (!cur.watched.includes(ep)) cur.watched.push(ep);
  progress[key] = { ...cur, updatedAt: new Date().toISOString() };
  saveProgress();
  json(res, 200, { trackers: await trackers.recordWatched(show, ep) });
});

router.delete('/api/progress/:key', async (req, res, { params }) => {
  delete progress[params.key];
  saveProgress();
  json(res, 200, { ok: true });
});

// ============================== Sources ==============================

router.get('/api/sources', async (req, res) => json(res, 200, sources.list().map(sources.publicView)));

router.post('/api/sources', async (req, res) => {
  const body = await readJson(req);
  const s = await sources.add(body.repo, String(body.path || '').trim() || undefined);
  json(res, 200, sources.publicView(s));
});

router.post('/api/sources/:id/refresh', async (req, res, { params }) => {
  json(res, 200, sources.publicView(await sources.refresh(params.id, { force: true })));
});

router.delete('/api/sources/:id', async (req, res, { params }) => {
  if (!sources.remove(params.id)) throw new HttpError(404, 'That source was already removed.');
  json(res, 200, { ok: true });
});

// ============================== Trackers ==============================

router.get('/api/trackers', async (req, res) => json(res, 200, trackers.summary()));

router.post('/api/trackers/kitsu/login', async (req, res) => {
  const body = await readJson(req);
  await trackers.kitsuLogin(String(body.username || '').trim(), String(body.password || ''));
  json(res, 200, trackers.summary());
});

router.post('/api/trackers/:provider/disconnect', async (req, res, { params }) => {
  if (!['anilist', 'mal', 'kitsu'].includes(params.provider)) throw new HttpError(404, 'Unknown tracker.');
  trackers.disconnect(params.provider);
  json(res, 200, trackers.summary());
});

const backToSettings = (res, q) => redirect(res, `/?${new URLSearchParams(q)}#/settings`);

router.get('/auth/anilist', async (req, res) => {
  if (!trackers.summary().anilist.configured) return backToSettings(res, { auth_error: 'Set ANILIST_CLIENT_ID and ANILIST_CLIENT_SECRET in .env first.' });
  redirect(res, trackers.anilistAuthUrl());
});
router.get('/auth/mal', async (req, res) => {
  if (!trackers.summary().mal.configured) return backToSettings(res, { auth_error: 'Set MAL_CLIENT_ID in .env first.' });
  redirect(res, trackers.malAuthUrl());
});
for (const [provider, handler] of [['anilist', trackers.anilistCallback], ['mal', trackers.malCallback]]) {
  router.get(`/auth/${provider}/callback`, async (req, res, { query }) => {
    try {
      await handler(query);
      backToSettings(res, { connected: provider });
    } catch (e) {
      backToSettings(res, { auth_error: e.message });
    }
  });
}

// ============================== Media ==============================

// Files from private repos stream through the server using GITHUB_TOKEN.
router.get('/media/:sid/*', async (req, res, { params }) => {
  const s = sources.find(params.sid);
  const filePath = params.rest;
  if (!s || s.kind !== 'github' || filePath.split('/').includes('..')) throw new HttpError(404, 'File not found.');
  const r = await gh.getFile(s.owner, s.repo, s.ref, filePath, req.headers.range ? { Range: req.headers.range } : {});
  const headers = { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || r.headers.get('content-type') || 'application/octet-stream' };
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag']) {
    const v = r.headers.get(h);
    if (v) headers[h] = v;
  }
  res.writeHead(r.status, headers);
  if (!r.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
});

router.get('/local/sample/*', async (req, res, { params }) => {
  if (!serveStatic(req, res, SAMPLE_DIR, params.rest)) throw new HttpError(404, 'File not found.');
});

// ============================== Server ==============================

function authorized(req) {
  if (!config.appPassword) return true;
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !b64) return false;
  const pass = Buffer.from(Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':'));
  const expected = Buffer.from(config.appPassword);
  return pass.length === expected.length && crypto.timingSafeEqual(pass, expected);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Akari", charset="UTF-8"', 'Content-Type': 'text/plain' });
    return res.end('Sign in to Akari.');
  }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (await router.handle(req, res, url)) return;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (serveStatic(req, res, PUBLIC_DIR, rel)) return;
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e.status && e.status < 500 ? e.status : 400;
    if (!(e instanceof HttpError)) console.warn(`[${req.method} ${url.pathname}]`, e.message);
    if (res.headersSent) return res.destroy();
    json(res, status, { error: e.message });
  }
});

sources.loadSample();
server.listen(config.port, config.host, () => {
  console.log(`Akari is running at ${config.publicUrl} (listening on ${config.host}:${config.port})`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.appPassword) {
    console.warn('Warning: Akari is reachable from other machines without a password. Set APP_PASSWORD in .env.');
  }
  sources.refreshAll().catch(() => {});
  setInterval(() => sources.refreshAll().catch(() => {}), 30 * 60e3).unref();
});
