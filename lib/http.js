// A small router and helpers on top of node:http, so Akari has no dependencies.
import fs from 'node:fs';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.vtt': 'text/vtt; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment',
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

export function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

export function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

/** Serves files under `root`, supporting Range requests (needed for video seeking). */
export function serveStatic(req, res, root, relPath) {
  let rel;
  try { rel = decodeURIComponent(relPath); } catch { return false; }
  const file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
  if (!file.startsWith(path.resolve(root) + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start); end = Math.min(end, stat.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return true; }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  return true;
}

export class Router {
  routes = [];
  add(method, pattern, handler) {
    // "/api/show/:key" → named groups; a trailing "*" captures the rest of the path.
    const re = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/:(\w+)/g, '(?<$1>[^/]+)').replace(/\*$/, '(?<rest>.+)')}$`);
    this.routes.push({ method, re, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  async handle(req, res, url) {
    for (const r of this.routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      for (const [k, v] of Object.entries(m.groups || {})) {
        try { params[k] = decodeURIComponent(v); } catch { params[k] = v; }
      }
      await r.handler(req, res, { params, query: Object.fromEntries(url.searchParams), url });
      return true;
    }
    return false;
  }
}
