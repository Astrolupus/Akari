import { config } from './config.js';

const API = 'https://api.github.com';

function headers(accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'User-Agent': 'akari-anime', 'X-GitHub-Api-Version': '2022-11-28' };
  if (config.githubToken) h.Authorization = `Bearer ${config.githubToken}`;
  return h;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * Accepts "owner/repo", "owner/repo@branch", or a github.com URL
 * (including /tree/<branch>/<folder> and /blob/<branch>/<file>.json).
 */
export function parseRepoInput(input, pathOverride) {
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

async function ghFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(`Could not reach GitHub (${e.cause?.code || e.message}). Check this server's internet connection.`);
  }
}

async function explain(r, what) {
  if (r.status === 404) return what;
  if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')) {
    return 'GitHub rate limit reached. Set GITHUB_TOKEN in .env, or try again in an hour.';
  }
  const j = await r.json().catch(() => ({}));
  return `GitHub answered ${r.status}${j.message ? `: ${j.message}` : '.'}`;
}

export async function getRepo(owner, repo) {
  const r = await ghFetch(`${API}/repos/${owner}/${repo}`, { headers: headers() });
  if (!r.ok) throw new Error(await explain(r, `github.com/${owner}/${repo} was not found. Check the name, or set GITHUB_TOKEN to reach a private repo.`));
  return r.json();
}

export async function latestSha(owner, repo, ref) {
  const r = await ghFetch(`${API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: headers('application/vnd.github.sha'),
  });
  return r.ok ? (await r.text()).trim() : null;
}

export function getFile(owner, repo, ref, filePath, extra = {}) {
  const url = `${API}/repos/${owner}/${repo}/contents/${encPath(filePath)}?ref=${encodeURIComponent(ref)}`;
  return ghFetch(url, { headers: { ...headers('application/vnd.github.raw+json'), ...extra } });
}

export async function fetchManifest(src) {
  const r = await getFile(src.owner, src.repo, src.ref, src.path);
  if (!r.ok) throw new Error(await explain(r, `${src.path} was not found on branch "${src.ref}" of ${src.owner}/${src.repo}.`));
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${src.path} is not valid JSON (${e.message}).`);
  }
}
