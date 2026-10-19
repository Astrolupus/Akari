// Library sources: GitHub repos that hold an anime-source.json manifest,
// plus the bundled sample source.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './store.js';
import * as gh from './github.js';
import { validateManifest } from './manifest.js';
import { fetchMeta } from './anilist.js';

const SAMPLE_DIR = path.resolve('sources/sample');
let sources = store.load('sources', []);
const persist = () => store.save('sources', sources.filter((s) => s.kind === 'github'));

export const list = () => sources;
export const find = (id) => sources.find((s) => s.id === id);

export function publicView(s) {
  return {
    id: s.id, kind: s.kind, name: s.manifest?.name || `${s.owner}/${s.repo}`,
    description: s.manifest?.description || '',
    repo: s.kind === 'github' ? `${s.owner}/${s.repo}` : null,
    ref: s.ref || null, path: s.path || null, private: Boolean(s.private),
    url: s.kind === 'github' ? `https://github.com/${s.owner}/${s.repo}/blob/${s.ref}/${s.path}` : null,
    shows: s.manifest?.shows?.length || 0,
    episodes: s.manifest?.shows?.reduce((n, x) => n + x.episodes.length, 0) || 0,
    sha: s.sha ? s.sha.slice(0, 7) : null, fetchedAt: s.fetchedAt || null, error: s.error || null,
  };
}

export function loadSample() {
  if (!config.enableSample) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'anime-source.json'), 'utf8'));
    sources = sources.filter((s) => s.id !== 'sample');
    sources.push({ id: 'sample', kind: 'local', manifest, fetchedAt: new Date().toISOString() });
  } catch (e) {
    console.warn('[sources] sample source not loaded:', e.message);
  }
}

function idFor(owner, repo, p) {
  const base = `gh-${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return p === 'anime-source.json' ? base : `${base}-${crypto.createHash('sha1').update(p).digest('hex').slice(0, 6)}`;
}

async function load(target) {
  const manifest = await gh.fetchManifest(target);
  const { errors } = validateManifest(manifest);
  if (errors.length) {
    const more = errors.length > 5 ? ` (and ${errors.length - 5} more)` : '';
    throw new Error(`${target.path} has problems: ${errors.slice(0, 5).join(' ')}${more}`);
  }
  return manifest;
}

export async function add(input, pathOverride) {
  const parsed = gh.parseRepoInput(input, pathOverride);
  if (!parsed) throw new Error('Enter a repo as owner/name or paste its github.com link.');
  const repo = await gh.getRepo(parsed.owner, parsed.repo);
  const target = {
    ...parsed,
    owner: repo.owner.login,
    repo: repo.name,
    ref: parsed.ref || repo.default_branch,
    private: repo.private,
  };
  const id = idFor(target.owner, target.repo, target.path);
  if (find(id)) throw new Error(`${target.owner}/${target.repo} is already in your library.`);
  const manifest = await load(target);
  const src = { id, kind: 'github', ...target, manifest, sha: await gh.latestSha(target.owner, target.repo, target.ref), fetchedAt: new Date().toISOString() };
  sources.push(src);
  persist();
  return src;
}

export async function refresh(id, { force = false } = {}) {
  const s = find(id);
  if (!s || s.kind !== 'github') throw new Error('That source is not a GitHub repo.');
  try {
    const sha = await gh.latestSha(s.owner, s.repo, s.ref);
    if (force || !sha || sha !== s.sha || !s.manifest) {
      s.manifest = await load(s);
      s.sha = sha;
    }
    s.error = null;
    s.fetchedAt = new Date().toISOString();
  } catch (e) {
    s.error = e.message; // keep serving the last good manifest
  }
  persist();
  return s;
}

export function remove(id) {
  const before = sources.length;
  sources = sources.filter((s) => !(s.id === id && s.kind === 'github'));
  persist();
  return sources.length < before;
}

export async function refreshAll() {
  for (const s of sources) if (s.kind === 'github') await refresh(s.id);
}

// ---------------------- Catalog building ----------------------

function resolver(s) {
  if (s.kind === 'local') {
    return (u) => (u == null ? null : /^https?:\/\//i.test(u) ? u : `/local/${s.id}/${u.replace(/^\/+/, '')}`);
  }
  const dir = path.posix.dirname(s.path);
  return (u) => {
    if (u == null) return null;
    if (/^https?:\/\//i.test(u)) return u;
    const repoPath = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, u)).replace(/^\/+/, '');
    return s.private
      ? `/media/${s.id}/${repoPath}`
      : `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${s.ref}/${repoPath}`;
  };
}

const stripTags = (t) => (t || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

export async function catalog() {
  const raw = [];
  for (const s of sources) {
    if (!s.manifest) continue;
    const r = resolver(s);
    const sourceLabel = s.kind === 'github' ? `${s.owner}/${s.repo}` : 'Bundled sample';
    for (const show of s.manifest.shows) {
      raw.push({
        key: `${s.id}~${show.slug}`,
        sourceId: s.id,
        sourceName: s.manifest.name || sourceLabel,
        sourceLabel,
        slug: show.slug,
        manifest: show,
        r,
      });
    }
  }
  const meta = await fetchMeta(raw.map((x) => x.manifest.ids?.anilist));

  return raw.map(({ manifest: m, r, ...base }) => {
    const a = meta.get(m.ids?.anilist) || null;
    const episodes = [...m.episodes].sort((x, y) => x.number - y.number).map((e) => ({
      number: e.number,
      title: e.title || null,
      src: r(e.src),
      duration: e.duration || null,
      thumbnail: r(e.thumbnail),
      intro: e.intro || null,
      subtitles: (e.subtitles || []).map((t) => ({ lang: t.lang || 'und', label: t.label || t.lang || 'Subtitles', src: r(t.src), default: Boolean(t.default) })),
    }));
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
      ids: {
        anilist: m.ids?.anilist || null,
        mal: m.ids?.mal || a?.idMal || null,
        kitsu: m.ids?.kitsu || null,
      },
      license: m.license || null,
      episodes,
    };
  });
}
