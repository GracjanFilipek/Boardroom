// Scoring: registry facts in, verdict out. Pure functions, no I/O.

import { POPULAR } from './popular.mjs';

export const REVIEW_THRESHOLD = 3;
const DAY = 86_400_000;

/** Optimal-string-alignment distance (edits + adjacent swaps), capped for speed. */
export function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

const squash = (s) => s.replace(/[-_.]/g, '').replace(/js$/, '');

/** Returns the popular package this name imitates, or null. Scoped names are not compared. */
export function lookalikeOf(name) {
  const n = name.toLowerCase();
  if (n.startsWith('@') || POPULAR.has(n)) return null;
  const flat = squash(n);
  for (const p of POPULAR) {
    if (p.length < 4) continue;
    if (flat === squash(p)) return p;
    const max = p.length >= 9 ? 2 : 1;
    if (editDistance(n, p, max) <= max) return p;
  }
  return null;
}

function humanAge(days) {
  if (days < 1) return 'less than a day';
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

/**
 * @param {string} name
 * @param {{status:'found',info:object}|{status:'not-found'}|{status:'error',message:string}} result
 * @param {number|null} downloads weekly downloads, null when unknown
 * @returns {{name:string, verdict:'ok'|'review'|'block', score:number, signals:{id:string,weight:number,message:string}[], facts:object}}
 */
export function assess(name, result, downloads = null, now = Date.now()) {
  if (result.status === 'not-found') {
    return {
      name,
      verdict: 'block',
      score: Infinity,
      signals: [{ id: 'not-found', weight: Infinity, message: 'does not exist on the registry (likely a hallucinated name)' }],
      facts: {},
    };
  }
  if (result.status === 'error') {
    return {
      name,
      verdict: 'review',
      score: REVIEW_THRESHOLD,
      signals: [{ id: 'lookup-failed', weight: REVIEW_THRESHOLD, message: `could not verify: ${result.message}` }],
      facts: {},
    };
  }

  const info = result.info;
  const signals = [];
  const add = (id, weight, message) => signals.push({ id, weight, message });
  const ageDays = info.created ? (now - Date.parse(info.created)) / DAY : null;

  if (info.latest && /-security$/.test(info.latest)) {
    return {
      name,
      verdict: 'block',
      score: Infinity,
      signals: [{ id: 'security-holder', weight: Infinity, message: `npm replaced this package with a security placeholder (${info.latest})` }],
      facts: { ...info, ageDays, downloads },
    };
  }

  if (ageDays === null) add('no-date', 1, 'registry gives no creation date');
  else if (ageDays < 30) add('very-new', 3, `first published ${humanAge(ageDays)} ago`);
  else if (ageDays < 90) add('new', 2, `first published ${humanAge(ageDays)} ago`);
  else if (ageDays < 365) add('young', 1, `first published ${humanAge(ageDays)} ago`);

  if (downloads !== null) {
    if (downloads < 100) add('barely-used', 2, `${downloads} downloads last week`);
    else if (downloads < 1000) add('low-usage', 1, `${downloads} downloads last week`);
  }

  if (info.installScripts.length) add('install-scripts', 1, `runs code on install (${info.installScripts.join(', ')})`);
  if (!info.repository) add('no-repo', 1, 'no source repository listed');
  if (info.versionCount <= 1) add('single-version', 1, 'only one version ever published');

  const twin = lookalikeOf(name);
  if (twin) add('lookalike', 2, `name is close to the popular package "${twin}"`);

  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  return {
    name,
    verdict: score >= REVIEW_THRESHOLD ? 'review' : 'ok',
    score,
    signals,
    facts: { ...info, ageDays, downloads },
  };
}

export function describe(a) {
  const f = a.facts ?? {};
  const bits = [];
  if (typeof f.ageDays === 'number') bits.push(`age ${humanAge(f.ageDays)}`);
  if (typeof f.versionCount === 'number') bits.push(`${f.versionCount} version${f.versionCount === 1 ? '' : 's'}`);
  if (typeof f.downloads === 'number') bits.push(`${f.downloads.toLocaleString('en-US')} downloads/week`);
  if (f.repository) bits.push(f.repository.replace(/^git\+/, '').replace(/\.git$/, ''));
  return bits.join(', ');
}
