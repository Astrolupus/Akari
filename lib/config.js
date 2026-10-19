import fs from 'node:fs';

// Minimal .env loader so the app has no extra dependencies.
try {
  for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch { /* no .env file */ }

const env = process.env;
const port = Number(env.PORT || 3000);

export const config = {
  port,
  host: env.HOST || '127.0.0.1',
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  appPassword: env.APP_PASSWORD || '',
  dataDir: env.DATA_DIR || 'data',
  githubToken: env.GITHUB_TOKEN || '',
  enableSample: env.ENABLE_SAMPLE !== 'false',
  anilist: { clientId: env.ANILIST_CLIENT_ID || '', clientSecret: env.ANILIST_CLIENT_SECRET || '' },
  mal: { clientId: env.MAL_CLIENT_ID || '', clientSecret: env.MAL_CLIENT_SECRET || '' },
  kitsuBase: (env.KITSU_API_BASE || 'https://kitsu.app/api').replace(/\/$/, ''),
};
