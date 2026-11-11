import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Splits a rule list on commas that sit outside parentheses, so `Bash(a, b)` stays whole. */
export function parseRules(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of String(text || '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '\n') && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return [...new Set(out)];
}

// Shell words that need no permission of their own, or that only set the scene for the real command.
const SKIP = new Set(['cd', 'echo', 'true', 'false', 'export', 'set', 'test', '[', 'then', 'do', 'done', 'fi', 'if', 'for', 'while', 'time']);
// Tools where the second word decides what happens, so the rule names both.
const TWO_WORDS = new Set(['git', 'docker', 'kubectl', 'gh', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'dotnet', 'brew', 'apt', 'apt-get', 'systemctl']);

/**
 * Turns a denied tool call into the permission rules that would have let it through.
 * `python3 -m pytest tests/ && docker exec app ls` yields `Bash(python3 *)` and `Bash(docker exec *)`.
 */
export function rulesFor(denial) {
  if (!denial?.tool) return [];
  if (denial.tool !== 'Bash') return [denial.tool];
  const rules = [];
  for (const part of String(denial.command || '').split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift(); // FOO=bar prefixes
    const cmd = words[0];
    if (!cmd || SKIP.has(cmd) || !/^[\w./~-]+$/.test(cmd)) continue;
    const second = words[1];
    const rule = TWO_WORDS.has(cmd) && second && /^[\w-]+$/.test(second) ? `Bash(${cmd} ${second} *)` : `Bash(${cmd} *)`;
    if (!rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

/** True when a Bash rule already in `rules` covers `rule`. `Bash(git *)` covers `Bash(git push *)`. */
export function covered(rule, rules) {
  if (rules.includes(rule)) return true;
  const prefix = rule.match(/^Bash\((.+) \*\)$/)?.[1];
  if (!prefix) return false;
  return rules.some((r) => {
    const have = r.match(/^Bash\((.+) \*\)$/)?.[1];
    return have && (prefix === have || prefix.startsWith(`${have} `));
  });
}

/**
 * Collects the allow rules a person already granted Claude Code: in their user settings, in this
 * project folder, and as "always allow" answers remembered for any folder.
 */
export function claudeCodeRules(workdir, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  const found = new Map(); // rule -> where it came from
  const add = (rules, source) => {
    for (const rule of Array.isArray(rules) ? rules : []) {
      if (typeof rule === 'string' && rule.trim() && !found.has(rule.trim())) found.set(rule.trim(), source);
    }
  };
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  for (const name of ['settings.json', 'settings.local.json']) {
    add(read(path.join(workdir, '.claude', name))?.permissions?.allow, 'This folder');
  }
  for (const name of ['settings.json', 'settings.local.json']) {
    add(read(path.join(configDir, name))?.permissions?.allow, 'Your Claude Code settings');
  }
  // "Always allow" answers are remembered per folder in the user's state file.
  const state = read(path.join(path.dirname(configDir), '.claude.json')) ?? read(path.join(configDir, '.claude.json'));
  const projects = state?.projects ?? {};
  add(projects[workdir]?.allowedTools, 'This folder');
  for (const [dir, entry] of Object.entries(projects)) {
    if (dir !== workdir) add(entry?.allowedTools, `Allowed in ${path.basename(dir)}`);
  }
  return [...found].map(([rule, source]) => ({ rule, source }));
}

/** The permission mode the person runs Claude Code in, when their settings name one. */
export function claudeCodeMode(workdir, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  for (const file of [path.join(workdir, '.claude', 'settings.local.json'), path.join(workdir, '.claude', 'settings.json'), path.join(configDir, 'settings.local.json'), path.join(configDir, 'settings.json')]) {
    try {
      const mode = JSON.parse(fs.readFileSync(file, 'utf8'))?.permissions?.defaultMode;
      if (typeof mode === 'string') return mode;
    } catch {}
  }
  return null;
}
