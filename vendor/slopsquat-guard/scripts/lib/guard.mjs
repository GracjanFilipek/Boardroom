// Glue: command -> package names -> registry checks -> decision.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assess, describe } from './assess.mjs';
import { classifySpec, hasLocalBin, parseCommand } from './parse.mjs';
import { lookup, pool, weeklyDownloads } from './registry.mjs';

const MAX_PACKAGES = 40;
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * User-level settings only. A config file inside the project is ignored on purpose:
 * a cloned repository (or the agent itself) could otherwise allowlist its own packages.
 */
export function loadConfig(env = process.env) {
  const file = env.SLOPSQUAT_GUARD_CONFIG || path.join(os.homedir(), '.config', 'slopsquat-guard', 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    cfg = {};
  }
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const fromEnv = (env.SLOPSQUAT_GUARD_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    allow: new Set([...list(cfg.allow), ...fromEnv]),
    allowScopes: new Set(list(cfg.allowScopes)),
    strict: cfg.strict === true || env.SLOPSQUAT_GUARD_STRICT === '1',
  };
}

export function isAllowed(name, cfg) {
  if (cfg.allow.has(name)) return true;
  return name.startsWith('@') && cfg.allowScopes.has(name.slice(0, name.indexOf('/')));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Returns a predicate: is this package already pinned by the nearest lockfile? */
export function lockIndex(cwd) {
  let dir = cwd;
  for (let depth = 0; depth < 8; depth++) {
    for (const file of LOCKFILES) {
      const full = path.join(dir, file);
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (file.endsWith('.json')) {
        try {
          const lock = JSON.parse(text);
          const names = new Set(Object.keys(lock.dependencies ?? {}));
          for (const key of Object.keys(lock.packages ?? {})) {
            const i = key.lastIndexOf('node_modules/');
            if (i !== -1) names.add(key.slice(i + 'node_modules/'.length));
          }
          return (name) => names.has(name);
        } catch {
          return () => false;
        }
      }
      return (name) => new RegExp(`(^|[\\s'"/,])${escapeRe(name)}(@|['"]?:)`, 'm').test(text);
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return () => false;
}

/** Look up and score a list of package names. */
export async function checkNames(names, cwd, deps = { lookup, weeklyDownloads }) {
  return pool(names, 6, async (name) => {
    const [result, downloads] = await Promise.all([deps.lookup(name, cwd), deps.weeklyDownloads(name, cwd)]);
    return assess(name, result, result.status === 'found' ? downloads : null);
  });
}

/**
 * @returns {Promise<{relevant:boolean, checked:object[], notes:string[], skipped:string[]}>}
 */
export async function evaluate(command, cwd, cfg, deps) {
  const parsed = parseCommand(command, cwd);
  const relevant = parsed.targets.length + parsed.bare.length > 0;
  const wanted = new Map(); // name -> cwd
  const notes = [];
  const skipped = [];
  const locks = new Map();
  const locked = (dir) => {
    if (!locks.has(dir)) locks.set(dir, lockIndex(dir));
    return locks.get(dir);
  };

  for (const t of parsed.targets) {
    const c = classifySpec(t.spec, t.dynamic);
    if (c.kind === 'local') continue;
    if (c.kind === 'remote') {
      notes.push(`"${t.spec}" (${t.source}) comes from a URL or git repository, not the registry`);
      continue;
    }
    if (c.kind === 'unresolved') {
      notes.push(`cannot tell which package "${t.spec}" resolves to (${t.source})`);
      continue;
    }
    if (t.localBin && hasLocalBin(t.cwd, c.name)) continue;
    if (isAllowed(c.name, cfg)) continue;
    if (t.mode === 'install' && locked(t.cwd)(c.name)) continue;
    if (!wanted.has(c.name)) wanted.set(c.name, t.cwd);
  }

  for (const b of parsed.bare) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(b.cwd, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const inLock = locked(b.cwd);
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries(pkg?.[field] ?? {})) {
        if (typeof range !== 'string' || inLock(dep)) continue;
        const c = classifySpec(`${dep}@${range}`);
        if (c.kind === 'remote') notes.push(`"${dep}" in package.json comes from a URL or git repository (${range})`);
        if (c.kind !== 'registry' || isAllowed(c.name, cfg)) continue;
        if (!wanted.has(c.name)) wanted.set(c.name, b.cwd);
      }
    }
  }

  let names = [...wanted.keys()];
  if (names.length > MAX_PACKAGES) {
    skipped.push(...names.slice(MAX_PACKAGES));
    notes.push(`${skipped.length} more new packages were not checked (limit ${MAX_PACKAGES} per command)`);
    names = names.slice(0, MAX_PACKAGES);
  }

  const byCwd = new Map();
  for (const n of names) {
    const dir = wanted.get(n);
    byCwd.set(dir, [...(byCwd.get(dir) ?? []), n]);
  }
  const checked = [];
  for (const [dir, group] of byCwd) checked.push(...(await checkNames(group, dir, deps)));
  return { relevant, checked, notes, skipped };
}

/** @returns {{decision:'deny'|'ask'|null, reason:string}} */
export function decide(evaluation, cfg) {
  const blocked = evaluation.checked.filter((a) => a.verdict === 'block');
  const review = evaluation.checked.filter((a) => a.verdict === 'review');
  if (!blocked.length && !review.length && !evaluation.notes.length) return { decision: null, reason: '' };

  const decision = blocked.length || cfg.strict ? 'deny' : 'ask';
  const lines = [
    decision === 'deny'
      ? 'slopsquat-guard blocked this install.'
      : 'slopsquat-guard wants a human to confirm this install.',
  ];
  for (const a of blocked) lines.push(`BLOCK  ${a.name}: ${a.signals.map((s) => s.message).join('; ')}`);
  for (const a of review) {
    const facts = describe(a);
    lines.push(`CHECK  ${a.name}: ${a.signals.map((s) => s.message).join('; ')}${facts ? ` [${facts}]` : ''}`);
  }
  for (const note of evaluation.notes) lines.push(`CHECK  ${note}`);
  lines.push(
    blocked.length
      ? 'Do not retry with another guessed name. Find the real package in the project docs or on npmjs.com, or ask the user which dependency they want.'
      : 'Approve only if you recognise these packages. If the name came from an AI suggestion, confirm it against the library\'s own documentation first.',
  );
  return { decision, reason: lines.join('\n') };
}
