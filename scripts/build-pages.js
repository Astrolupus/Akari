// Builds the browser-only version of Akari into dist/ for GitHub Pages.
// Usage: npm run build:pages
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

fs.cpSync('public', out, { recursive: true });
fs.copyFileSync('web/static-backend.js', path.join(out, 'static-backend.js'));
fs.copyFileSync('lib/manifest.js', path.join(out, 'manifest.js'));
if (process.env.ENABLE_SAMPLE === 'true') {
  fs.mkdirSync(path.join(out, 'local/sample'), { recursive: true });
  fs.copyFileSync('sources/sample/anime-source.json', path.join(out, 'local/sample/anime-source.json'));
}

// Optional: bake in an AniList client ID so visitors don't have to enter one.
const clientId = process.env.ANILIST_CLIENT_ID_WEB || '';
const flags = `<script>window.AKARI_STATIC = true;${/^\d+$/.test(clientId) ? ` window.AKARI_ANILIST_CLIENT_ID = '${clientId}';` : ''}</script>`;
const indexPath = path.join(out, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
if (!html.includes('<script src="app.js"')) throw new Error('index.html no longer loads app.js; update build-pages.js.');
fs.writeFileSync(indexPath, html.replace('<script src="app.js"', `${flags}\n  <script src="app.js"`));
fs.writeFileSync(path.join(out, '.nojekyll'), '');

console.log(`Built the GitHub Pages site into ${path.relative(process.cwd(), out)}/`);
