// The format a GitHub repo uses to describe what it streams.
// See README.md → "Source manifest" for the full reference.
export const SCHEMA = 'akari-source/1';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isUrlish(v) {
  if (typeof v !== 'string' || !v) return false;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false; // javascript:, data:, etc.
  return !v.split('/').includes('..');
}

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { errors: ['The manifest must be a JSON object.'] };
  if (m.schema !== SCHEMA) errors.push(`Set "schema" to "${SCHEMA}".`);
  if (!Array.isArray(m.shows) || m.shows.length === 0) errors.push('Add at least one entry to "shows".');

  const slugs = new Set();
  (Array.isArray(m.shows) ? m.shows : []).forEach((s, i) => {
    const at = `shows[${i}]`;
    if (!SLUG.test(s?.slug || '')) errors.push(`${at}.slug must use lowercase letters, digits and hyphens.`);
    else if (slugs.has(s.slug)) errors.push(`${at}.slug "${s.slug}" is used twice.`);
    else slugs.add(s.slug);

    if (!s?.title && !s?.ids?.anilist) errors.push(`${at} needs a "title" or an "ids.anilist" number.`);
    for (const k of ['anilist', 'mal', 'kitsu']) {
      if (s?.ids?.[k] != null && !Number.isInteger(s.ids[k])) errors.push(`${at}.ids.${k} must be a whole number.`);
    }
    for (const k of ['cover', 'banner']) {
      if (s?.[k] != null && !isUrlish(s[k])) errors.push(`${at}.${k} must be an https URL or a path inside the repo.`);
    }

    if (!Array.isArray(s?.episodes) || s.episodes.length === 0) {
      errors.push(`${at}.episodes must list at least one episode.`);
      return;
    }
    const nums = new Set();
    s.episodes.forEach((e, j) => {
      const ep = `${at}.episodes[${j}]`;
      if (!(typeof e?.number === 'number' && e.number > 0)) errors.push(`${ep}.number must be a positive number.`);
      else if (nums.has(e.number)) errors.push(`${ep}.number ${e.number} is used twice.`);
      else nums.add(e.number);
      if (!isUrlish(e?.src)) errors.push(`${ep}.src must be an https URL or a path inside the repo.`);
      if (e?.thumbnail != null && !isUrlish(e.thumbnail)) errors.push(`${ep}.thumbnail must be an https URL or a repo path.`);
      if (e?.intro && !(e.intro.end > e.intro.start && e.intro.start >= 0)) errors.push(`${ep}.intro needs "start" and "end" in seconds, with end after start.`);
      (Array.isArray(e?.subtitles) ? e.subtitles : []).forEach((t, k) => {
        if (!isUrlish(t?.src)) errors.push(`${ep}.subtitles[${k}].src must be an https URL or a repo path.`);
      });
    });
  });
  return { errors };
}
