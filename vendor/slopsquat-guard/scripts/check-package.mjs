#!/usr/bin/env node
// Usage: node check-package.mjs [--json] <package> [<package> ...]
// Exit code: 0 = all ok, 1 = at least one needs review, 2 = at least one blocked.

import { describe } from './lib/assess.mjs';
import { checkNames } from './lib/guard.mjs';
import { classifySpec } from './lib/parse.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const specs = args.filter((a) => !a.startsWith('--'));

if (!specs.length || args.includes('--help')) {
  console.log('Usage: node check-package.mjs [--json] <package> [<package> ...]');
  process.exit(specs.length ? 0 : 64);
}

const names = [];
const rejected = [];
for (const spec of specs) {
  const c = classifySpec(spec);
  if (c.kind === 'registry') {
    if (!names.includes(c.name)) names.push(c.name);
  } else rejected.push({ spec, kind: c.kind });
}

const results = await checkNames(names, process.cwd());

if (json) {
  console.log(JSON.stringify({ results, rejected }, null, 2));
} else {
  const label = { ok: 'OK    ', review: 'CHECK ', block: 'BLOCK ' };
  for (const a of results) {
    const facts = describe(a);
    console.log(`${label[a.verdict]} ${a.name}${facts ? `  [${facts}]` : ''}`);
    for (const s of a.signals) console.log(`         - ${s.message}`);
  }
  for (const r of rejected) {
    console.log(`CHECK  ${r.spec}`);
    console.log(
      r.kind === 'remote'
        ? '         - comes from a URL or git repository, not the registry'
        : r.kind === 'local'
          ? '         - local path, nothing to look up'
          : '         - not a valid npm package name',
    );
  }
}

const blocked = results.some((a) => a.verdict === 'block');
const review = results.some((a) => a.verdict === 'review') || rejected.some((r) => r.kind !== 'local');
process.exit(blocked ? 2 : review ? 1 : 0);
