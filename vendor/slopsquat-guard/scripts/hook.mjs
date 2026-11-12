#!/usr/bin/env node
// Claude Code PreToolUse hook for the Bash tool.
// Reads the hook payload on stdin. Prints a deny/ask decision when an install
// looks unsafe, and prints nothing otherwise so the normal permission flow applies.
// It never auto-approves a command.

import { decide, evaluate, loadConfig } from './lib/guard.mjs';

const QUICK = /\b(npm|npx|pnpm|pnpx|yarn|bun|bunx)\b/;

function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // not a hook payload, stay out of the way
  }
  if (payload?.tool_name !== 'Bash') return;
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string' || !QUICK.test(command)) return;

  const cfg = loadConfig();
  try {
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
    const evaluation = await evaluate(command, cwd, cfg);
    const { decision, reason } = decide(evaluation, cfg);
    if (decision) emit(decision, reason);
  } catch (err) {
    emit(
      cfg.strict ? 'deny' : 'ask',
      `slopsquat-guard could not check this command (${err?.message ?? err}). Review the packages it installs by hand.`,
    );
  }
}

await main();
