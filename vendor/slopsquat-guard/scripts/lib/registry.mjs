// Registry lookups. Uses `npm view` so the user's own registry, scopes and auth apply.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const NAME_RE = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~_][a-z0-9._~-]*$/i;
const WIN = process.platform === 'win32';
const NPM = WIN ? 'npm.cmd' : 'npm';

function run(args, cwd, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(
      NPM,
      args,
      {
        cwd: cwd && fs.existsSync(cwd) ? cwd : os.tmpdir(),
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        shell: WIN, // .cmd needs a shell on Windows; every argument is validated first
        env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const FIELDS = [
  'name', 'dist-tags.latest', 'time.created', 'time.modified', 'versions',
  'maintainers', 'repository', 'scripts', 'deprecated',
];

/**
 * @returns {Promise<{status:'found', info:object}|{status:'not-found'}|{status:'error', message:string}>}
 */
export async function lookup(name, cwd) {
  if (!NAME_RE.test(name)) return { status: 'error', message: 'not a valid npm package name' };
  const { error, stdout, stderr } = await run(['view', name, ...FIELDS, '--json'], cwd);
  const json = parseJson(stdout.trim());
  if (json?.error) {
    if (json.error.code === 'E404') return { status: 'not-found' };
    return { status: 'error', message: `${json.error.code ?? 'npm error'}: ${json.error.summary ?? ''}`.trim() };
  }
  if (error) {
    if (/E404|404 Not Found/.test(stderr)) return { status: 'not-found' };
    const reason = error.killed ? 'registry lookup timed out' : (stderr.split('\n').find(Boolean) ?? error.message);
    return { status: 'error', message: reason };
  }
  if (!json || typeof json !== 'object') {
    // npm prints nothing when a name resolves but has no matching version
    return { status: 'error', message: 'registry returned no data' };
  }
  const versions = Array.isArray(json.versions) ? json.versions : json.versions ? [json.versions] : [];
  const scripts = json.scripts && typeof json.scripts === 'object' ? json.scripts : {};
  const repo = json.repository;
  return {
    status: 'found',
    info: {
      name: json.name ?? name,
      latest: json['dist-tags.latest'] ?? null,
      created: json['time.created'] ?? null,
      modified: json['time.modified'] ?? null,
      versionCount: versions.length,
      maintainers: Array.isArray(json.maintainers) ? json.maintainers.length : json.maintainers ? 1 : 0,
      repository: typeof repo === 'string' ? repo : (repo?.url ?? null),
      installScripts: ['preinstall', 'install', 'postinstall'].filter((k) => typeof scripts[k] === 'string'),
      deprecated: typeof json.deprecated === 'string' ? json.deprecated : null,
    },
  };
}

const registryCache = new Map();

/** Which registry serves this package name (respects per-scope config). */
export function registryFor(name, cwd) {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : '';
  const key = `${scope}\0${cwd ?? ''}`;
  if (!registryCache.has(key)) {
    registryCache.set(
      key,
      (async () => {
        const keys = scope ? [`${scope}:registry`, 'registry'] : ['registry'];
        const { stdout } = await run(['config', 'get', ...keys], cwd, 10000);
        const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
        const values = {};
        if (keys.length === 1) values[keys[0]] = lines[0];
        else for (const l of lines) values[l.slice(0, l.indexOf('='))] = l.slice(l.indexOf('=') + 1);
        const scoped = scope ? values[`${scope}:registry`] : undefined;
        return scoped && scoped !== 'undefined' ? scoped : (values.registry ?? '');
      })(),
    );
  }
  return registryCache.get(key);
}

/**
 * Weekly downloads from the public npm API, or null when unknown.
 * Skipped for packages served by a private registry so their names never leave the machine.
 */
export async function weeklyDownloads(name, cwd) {
  try {
    const registry = await registryFor(name, cwd);
    if (!/^https:\/\/registry\.npmjs\.org\/?$/.test(registry)) return null;
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${name}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.downloads === 'number' ? body.downloads : null;
  } catch {
    return null;
  }
}

/** Run async jobs with a concurrency cap, keeping order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
