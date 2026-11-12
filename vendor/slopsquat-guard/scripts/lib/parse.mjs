// Turns a shell command into the list of npm packages it would fetch.
// No network, no side effects (apart from one fs.existsSync for local npx bins).

import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~_][a-z0-9._~-]*$/i;
const REMOTE_PROTO = /^(https?|git|git\+[a-z]+|ssh|github|gitlab|bitbucket|gist):/i;
const LOCAL_PROTO = /^(file|link|workspace|portal|patch):/i;
const GH_SHORTHAND = /^[\w.-]+\/[\w.-]+(#.+)?$/;

/**
 * Classify one install argument ("react", "@scope/pkg@^1", "./local", "user/repo", ...).
 * @returns {{kind:'registry',name:string,range:string|null}|{kind:'local'}|{kind:'remote',raw:string}|{kind:'unresolved',raw:string}}
 */
export function classifySpec(raw, dynamic = false) {
  if (dynamic || !raw) return { kind: 'unresolved', raw: raw ?? '' };
  let s = raw;

  if (/^(\.{1,2}([\\/]|$)|[\\/]|~[\\/]|[a-zA-Z]:[\\/])/.test(s) || LOCAL_PROTO.test(s)) return { kind: 'local' };
  if (/\.(tgz|tar\.gz|tar)$/i.test(s) && !/^[a-z+]+:/i.test(s)) return { kind: 'local' };
  if (/^jsr:/i.test(s)) return { kind: 'local' };
  if (REMOTE_PROTO.test(s) || /^git@/.test(s)) return { kind: 'remote', raw };

  // alias@npm:real@range  /  npm:real@range
  const alias = /^(?:@[^/@\s]+\/)?[^@\s]+@npm:(.+)$/.exec(s);
  if (alias) s = alias[1];
  else if (s.startsWith('npm:')) s = s.slice(4);

  if (!s.startsWith('@') && GH_SHORTHAND.test(s)) return { kind: 'remote', raw };

  const m = /^(@[^/@\s]+\/[^@\s]+|[^@\s]+)(?:@(.*))?$/.exec(s);
  if (!m || !NAME_RE.test(m[1]) || m[1].length > 214) return { kind: 'unresolved', raw };

  const range = m[2] ?? null;
  if (range) {
    if (LOCAL_PROTO.test(range)) return { kind: 'local' };
    if (REMOTE_PROTO.test(range) || GH_SHORTHAND.test(range)) return { kind: 'remote', raw };
  }
  return { kind: 'registry', name: m[1], range };
}

/** `npm create vite` -> create-vite, `@scope` -> @scope/create, `@scope/x` -> @scope/create-x */
export function toInitializer(spec) {
  let m;
  if ((m = /^(@[^/@]+)\/([^@]+)(@.*)?$/.exec(spec))) return `${m[1]}/create-${m[2]}${m[3] ?? ''}`;
  if ((m = /^(@[^/@]+)(@.*)?$/.exec(spec))) return `${m[1]}/create${m[2] ?? ''}`;
  if ((m = /^([^@]+)(@.*)?$/.exec(spec))) return `create-${m[1]}${m[2] ?? ''}`;
  return spec;
}

/** Drop heredoc bodies so text written to files is not read as commands. */
export function stripHeredocs(command) {
  const lines = command.split('\n');
  const out = [];
  let until = null;
  let stripTabs = false;
  for (const line of lines) {
    if (until !== null) {
      const probe = stripTabs ? line.replace(/^\t+/, '') : line;
      if (probe === until) until = null;
      continue;
    }
    out.push(line);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (m) {
      stripTabs = m[1] === '-';
      until = m[3];
    }
  }
  return out.join('\n');
}

/**
 * Split a command line into simple commands, each a list of tokens.
 * Token: { text, quoted, dynamic } - dynamic means it contains $var / $(...) / backticks.
 */
export function splitSegments(command) {
  const segments = [];
  let tokens = [];
  let cur = null;
  const open = () => (cur ??= { text: '', quoted: false, dynamic: false });
  const push = () => {
    if (cur) tokens.push(cur);
    cur = null;
  };
  const end = () => {
    push();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      const j = command.indexOf("'", i + 1);
      const stop = j === -1 ? n : j;
      open().quoted = true;
      cur.text += command.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      open().quoted = true;
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < n) {
          cur.text += command[i + 1];
          i += 2;
          continue;
        }
        if (command[i] === '$' || command[i] === '`') cur.dynamic = true;
        cur.text += command[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === '\\') {
      if (command[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 < n) open().text += command[i + 1];
      i += 2;
      continue;
    }
    if (ch === '$') {
      open().dynamic = true;
      cur.text += ch;
      i++;
      continue;
    }
    if (ch === '#' && !cur) {
      while (i < n && command[i] !== '\n') i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      push();
      i++;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      end();
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '(' || ch === ')' || ch === '`') {
      end();
      i++;
      continue;
    }
    open().text += ch;
    i++;
  }
  end();
  return segments;
}

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'builtin', 'time', 'nohup', 'exec', 'corepack']);
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function dropRedirects(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.quoted && /^\d*(>>?|<)$/.test(t.text)) {
      i++; // operator and its target
      continue;
    }
    if (!t.quoted && /^\d*[<>]/.test(t.text)) continue;
    out.push(t);
  }
  return out;
}

function stripPrefix(tokens) {
  let t = dropRedirects(tokens);
  for (;;) {
    if (!t.length) return t;
    const w = t[0].text;
    if (ASSIGN.test(w)) {
      t = t.slice(1);
      continue;
    }
    if (w === 'env') {
      t = t.slice(1);
      while (t.length && (t[0].text.startsWith('-') || ASSIGN.test(t[0].text))) t = t.slice(1);
      continue;
    }
    if (WRAPPERS.has(w)) {
      t = t.slice(1);
      while (t.length && t[0].text.startsWith('-')) {
        const flag = t[0].text;
        t = t.slice(1);
        if (w === 'sudo' && SUDO_VALUE_FLAGS.has(flag)) t = t.slice(1);
      }
      continue;
    }
    return t;
  }
}

// Flags that consume the next argument. Anything else starting with "-" is treated as boolean.
const COMMON_VALUE_FLAGS = [
  '--registry', '--prefix', '--dir', '--cwd', '--tag', '--cache', '--userconfig', '--globalconfig',
  '--otp', '--loglevel', '--modules-folder', '--save-prefix', '--omit', '--include', '--before',
  '--cpu', '--os', '--libc', '--node-options', '--filter', '--workspace', '--store-dir',
  '--lockfile-dir', '--virtual-store-dir', '--reporter', '--network-concurrency', '--backend',
];
const VALUE_FLAGS = {
  npm: new Set([...COMMON_VALUE_FLAGS, '-C', '-w']),
  pnpm: new Set([...COMMON_VALUE_FLAGS, '-C', '-F']),
  yarn: new Set(COMMON_VALUE_FLAGS),
  bun: new Set([...COMMON_VALUE_FLAGS, '-c']),
};
const CWD_FLAGS = ['--prefix', '-C', '--dir', '--cwd'];

function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (a === '--' && !args[i].quoted) {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && !args[i].dynamic) {
      if (!a.includes('=') && valueFlags.has(a)) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function flagValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    for (const name of names) {
      if (a === name && args[i + 1] && !args[i + 1].dynamic) return args[i + 1].text;
      if (a.startsWith(name + '=')) return a.slice(name.length + 1);
    }
  }
  return null;
}

const hasFlag = (args, ...names) => args.some((a) => names.includes(a.text));

const NPM_INSTALL = new Set([
  'install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall',
  'add', 'install-test', 'it',
]);
const NPM_CREATE = new Set(['create', 'init', 'innit']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/**
 * @typedef {{spec:string, dynamic:boolean, mode:'install'|'exec'|'create', source:string, cwd:string, localBin?:boolean}} Target
 * @returns {{targets: Target[], bare: {cwd:string, source:string}[]}}
 */
export function parseCommand(command, cwd = process.cwd(), depth = 0) {
  const result = { targets: [], bare: [] };
  if (typeof command !== 'string' || depth > 3) return result;

  for (const rawTokens of splitSegments(stripHeredocs(command))) {
    const tokens = stripPrefix(rawTokens);
    if (!tokens.length || tokens[0].dynamic) continue;
    const bin = path
      .basename(tokens[0].text)
      .replace(/\.(cmd|exe|ps1)$/i, '')
      .toLowerCase();
    const args = tokens.slice(1);

    if (bin === 'cd') {
      if (args[0] && !args[0].dynamic && args[0].text !== '-') cwd = path.resolve(cwd, args[0].text);
      continue;
    }

    if (SHELLS.has(bin)) {
      const ci = args.findIndex((a) => /^-[a-z]*c$/.test(a.text));
      if (ci !== -1 && args[ci + 1]) {
        const inner = parseCommand(args[ci + 1].text, cwd, depth + 1);
        result.targets.push(...inner.targets);
        result.bare.push(...inner.bare);
      }
      continue;
    }

    const add = (tok, mode, source, extra = {}) =>
      result.targets.push({ spec: tok.text, dynamic: tok.dynamic, mode, source, cwd: extra.cwd ?? cwd, ...extra });

    const exec = (execArgs, source, { preferLocal }) => {
      const pkgs = [];
      let cmd = null;
      for (let i = 0; i < execArgs.length; i++) {
        const a = execArgs[i].text;
        if (a === '--') {
          cmd = execArgs[i + 1] ?? null;
          break;
        }
        if (a === '-p' || a === '--package') {
          if (execArgs[i + 1]) pkgs.push(execArgs[++i]);
          continue;
        }
        if (a.startsWith('--package=')) {
          pkgs.push({ ...execArgs[i], text: a.slice('--package='.length) });
          continue;
        }
        if (a === '-c' || a === '--call') {
          i++;
          continue;
        }
        if (a.startsWith('-') && !execArgs[i].dynamic) continue;
        cmd = execArgs[i];
        break;
      }
      if (pkgs.length) for (const p of pkgs) add(p, 'exec', source);
      else if (cmd) add(cmd, 'exec', source, { localBin: preferLocal });
    };

    const create = (tok, source) => {
      if (!tok) return;
      const kind = classifySpec(tok.text, tok.dynamic).kind;
      const text = kind === 'registry' ? toInitializer(tok.text) : tok.text;
      add({ ...tok, text }, 'create', source);
    };

    if (bin === 'npx' || bin === 'pnpx' || bin === 'bunx') {
      exec(args, bin, { preferLocal: bin !== 'pnpx' });
      continue;
    }

    if (bin !== 'npm' && bin !== 'pnpm' && bin !== 'yarn' && bin !== 'bun') continue;

    const pos = positionals(args, VALUE_FLAGS[bin]);
    const sub = pos[0] && !pos[0].dynamic ? pos[0].text : undefined;
    const rest = pos.slice(1);
    const subIndex = pos[0] ? args.indexOf(pos[0]) : -1;
    const afterSub = subIndex === -1 ? [] : args.slice(subIndex + 1);
    const dirFlag = flagValue(args, CWD_FLAGS);
    const here = dirFlag ? path.resolve(cwd, dirFlag) : cwd;
    const global = hasFlag(args, '-g', '--global');
    const installOrBare = (names, source) => {
      if (names.length) for (const t of names) add(t, 'install', source, { cwd: here });
      else if (!global) result.bare.push({ cwd: here, source });
    };

    if (bin === 'npm') {
      if (NPM_INSTALL.has(sub)) installOrBare(rest, `npm ${sub}`);
      else if (sub === 'exec' || sub === 'x') exec(afterSub, `npm ${sub}`, { preferLocal: true });
      else if (NPM_CREATE.has(sub)) create(rest[0], `npm ${sub}`);
    } else if (bin === 'pnpm') {
      if (sub === 'add') installOrBare(rest, 'pnpm add');
      else if (sub === 'install' || sub === 'i') installOrBare(rest, `pnpm ${sub}`);
      else if (sub === 'dlx') exec(afterSub, 'pnpm dlx', { preferLocal: false });
      else if (sub === 'create') create(rest[0], 'pnpm create');
    } else if (bin === 'yarn') {
      if (sub === undefined && !pos.length) installOrBare([], 'yarn');
      else if (sub === 'install') installOrBare([], 'yarn install');
      else if (sub === 'add') installOrBare(rest, 'yarn add');
      else if (sub === 'global' && rest[0]?.text === 'add') {
        for (const t of rest.slice(1)) add(t, 'install', 'yarn global add');
      } else if (sub === 'workspace' && rest[1]?.text === 'add') {
        for (const t of rest.slice(2)) add(t, 'install', 'yarn workspace add', { cwd: here });
      } else if (sub === 'dlx') exec(afterSub, 'yarn dlx', { preferLocal: false });
      else if (sub === 'create') create(rest[0], 'yarn create');
    } else if (bin === 'bun') {
      if (sub === 'add' || sub === 'a') installOrBare(rest, 'bun add');
      else if (sub === 'install' || sub === 'i') installOrBare(rest, `bun ${sub}`);
      else if (sub === 'x') exec(afterSub, 'bun x', { preferLocal: true });
      else if (sub === 'create' || sub === 'c') create(rest[0], 'bun create');
    }
  }
  return result;
}

/** True when `npx <name>` would run a binary that is already installed in the project. */
export function hasLocalBin(cwd, name) {
  const bare = name.replace(/^@[^/]+\//, '').replace(/@.*$/, '');
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'node_modules', '.bin', bare))) return true;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}
