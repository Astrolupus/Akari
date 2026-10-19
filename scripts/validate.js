// Usage: npm run validate -- path/to/anime-source.json
import fs from 'node:fs';
import { validateManifest } from '../lib/manifest.js';

const file = process.argv[2] || 'anime-source.json';
let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`Could not read ${file}: ${e.message}`);
  process.exit(1);
}
const { errors } = validateManifest(data);
if (errors.length) {
  console.error(`${file} has ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  • ${e}`);
  process.exit(1);
}
const eps = data.shows.reduce((n, s) => n + s.episodes.length, 0);
console.log(`${file} is valid: ${data.shows.length} show(s), ${eps} episode(s).`);
