import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const DIR = path.resolve(config.dataDir);
fs.mkdirSync(DIR, { recursive: true });

export function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

export function save(name, value) {
  const file = path.join(DIR, `${name}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
