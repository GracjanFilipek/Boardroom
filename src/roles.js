import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILT_IN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'roles');
const FILES = { pm: 'project-manager.md', designer: 'designer.md', dev: 'developer.md' };

/**
 * The master prompt for a role. It rides along on every run of that agent as an appended system prompt.
 * A file with the same name in `<data dir>/roles` replaces the built-in one, so a company can rewrite
 * its own job descriptions without touching the code. Read on each call: edits apply to the next run.
 */
export function createRoles(dataDir) {
  return function rolePrompt(role) {
    const name = FILES[role];
    if (!name) return undefined;
    for (const dir of [dataDir && dataDir !== ':memory:' ? path.join(dataDir, 'roles') : null, BUILT_IN]) {
      if (!dir) continue;
      try {
        const text = fs.readFileSync(path.join(dir, name), 'utf8').trim();
        if (text) return text;
      } catch {}
    }
    return undefined;
  };
}
