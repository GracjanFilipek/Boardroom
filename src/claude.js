import { spawn } from 'node:child_process';

/**
 * Runs one headless Claude Code call (`claude -p`) and resolves with its result.
 * The CLI uses whatever login the machine has, so a Pro/Max subscription pays for the run.
 *
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} o.cwd
 * @param {string} [o.tools]           built-in tools available, comma separated ("" disables all)
 * @param {string} [o.allowedTools]    tools that run without a permission prompt
 * @param {string} [o.permissionMode]
 * @param {number} [o.maxTurns]
 * @param {string} [o.model]
 * @param {object} [o.schema]          JSON Schema; the reply arrives in `structured`
 * @param {string} [o.resume]          session id to continue
 * @param {string} [o.system]          appended system prompt
 * @param {Record<string, string>} [o.env]  extra environment for the run, e.g. GitHub credentials
 * @param {AbortSignal} [o.signal]
 * @param {(e: {type: string, text?: string, info?: object}) => void} [o.onEvent]
 */
export function runClaude(o) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (o.tools !== undefined) args.push('--tools', o.tools);
  if (o.allowedTools) args.push('--allowedTools', o.allowedTools);
  if (o.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
  if (o.maxTurns) args.push('--max-turns', String(o.maxTurns));
  if (o.model) args.push('--model', o.model);
  if (o.schema) args.push('--json-schema', JSON.stringify(o.schema));
  if (o.resume) args.push('--resume', o.resume);
  if (o.system) args.push('--append-system-prompt', o.system);

  return new Promise((resolve) => {
    const started = Date.now();
    const out = { ok: false, result: '', structured: null, sessionId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, error: null };
    let child;
    try {
      child = spawn(process.env.CLAUDE_BIN || 'claude', args, { cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, env: o.env ? { ...process.env, ...o.env } : process.env });
    } catch (err) {
      out.error = err.message;
      return resolve(out);
    }

    let buf = '';
    let stderr = '';
    const handle = (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.session_id) out.sessionId = msg.session_id;
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text.trim()) o.onEvent?.({ type: 'say', text: block.text.trim() });
          if (block.type === 'tool_use') o.onEvent?.({ type: 'tool', text: describeTool(block) });
        }
      } else if (msg.type === 'rate_limit_event') {
        o.onEvent?.({ type: 'limits', info: msg.rate_limit_info });
      } else if (msg.type === 'result') {
        out.ok = !msg.is_error;
        out.result = typeof msg.result === 'string' ? msg.result : '';
        out.structured = msg.structured_output ?? null;
        out.costUsd = msg.total_cost_usd ?? 0;
        out.turns = msg.num_turns ?? 0;
        out.denials = (msg.permission_denials ?? []).map((d) => ({ tool: d.tool_name, command: d.tool_input?.command ?? '', detail: d.tool_input?.file_path ?? d.tool_input?.url ?? '' }));
        const u = msg.usage ?? {};
        out.inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        out.outputTokens = u.output_tokens ?? 0;
        if (msg.is_error) out.error = out.result || msg.subtype || 'run failed';
      }
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.on('error', (err) => {
      out.error = err.name === 'AbortError' ? 'stopped' : err.code === 'ENOENT' ? 'claude CLI not found on PATH' : err.message;
      out.durationMs = Date.now() - started;
      resolve(out);
    });
    child.on('close', (code) => {
      handle(buf);
      if (!out.ok && !out.error) out.error = stderr.trim() || `claude exited with code ${code}`;
      out.durationMs = Date.now() - started;
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(o.prompt);
  });
}

function describeTool(block) {
  const i = block.input ?? {};
  const detail = i.file_path ?? i.command ?? i.pattern ?? i.path ?? i.description ?? '';
  return `${block.name}${detail ? ` ${String(detail).slice(0, 160)}` : ''}`;
}

/**
 * Stand-in for the CLI. `npm run demo` and the tests use it, so the whole
 * company runs without touching your subscription.
 */
export function createMockRunner({ delay = 900 } = {}) {
  let utilization = 0.02;
  let counter = 0;
  let denied = false;
  const resetsAt = Math.floor(Date.now() / 1000) + 5 * 3600;
  const themes = ['Keyboard shortcuts', 'Empty states', 'CSV export', 'Onboarding checklist', 'Faster search', 'Undo for deletes', 'Weekly digest', 'Dark mode polish'];

  return async function mockRun(o) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(delay / 2);
    if (o.signal?.aborted) return { ok: false, error: 'stopped', costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 };
    const n = ++counter;
    let result = '';
    let structured = null;

    if (o.kind === 'ideate') {
      const count = o.schema?.properties?.ideas?.maxItems ?? 3;
      structured = {
        ideas: Array.from({ length: count }, (_, i) => {
          const t = themes[(n * 3 + i) % themes.length];
          return {
            title: t,
            pitch: `Users ask for ${t.toLowerCase()} in support tickets. Shipping it removes a daily annoyance.`,
            plan: `1. Find the code that owns this area.\n2. Implement ${t.toLowerCase()}.\n3. Add a test.\n4. Update the README.`,
            effort: ['S', 'M', 'L'][(n + i) % 3],
            needs_design: i === 0,
          };
        }),
      };
    } else if (o.kind === 'review') {
      const approve = n % 3 !== 0;
      structured = approve
        ? { verdict: 'approve', notes: 'Matches the spec. Tests pass.' }
        : { verdict: 'revise', notes: 'The happy path works. Add a test for the empty input case.' };
    } else if (o.kind === 'chat') {
      structured = {
        reply: 'Understood. I added that to the standing guidance and queued one task for it. The developers pick it up next.',
        memo: '- Keep every screen usable on a phone.\n- No new dependencies without a reason in the work order.',
        tasks: [{ title: 'Make the main screen work on a phone', plan: '1. Find the layout styles.\n2. Stack the columns under 600px.\n3. Check at 390px wide.', effort: 'S', needs_design: false }],
        withdraw_proposals: false,
      };
    } else if (o.kind === 'design') {
      o.onEvent?.({ type: 'tool', text: 'Read public/app.css' });
      result = 'Goal\nOne clear action per screen.\n\nLayout\nReuse the existing card and the primary button.\n\nStates\nEmpty, loading, done, error.\n\nCopy\nButton: "Undo". Toast: "Restored."';
    } else if (o.kind === 'summarize') {
      result = `Handover brief (demo)\n\n- Goal: carried over from the imported chat.\n- Decisions so far: see transcript.\n- Next step: pick up the first open question.`;
    } else {
      o.onEvent?.({ type: 'tool', text: 'Read src/index.js' });
      await wait(delay / 4);
      o.onEvent?.({ type: 'tool', text: 'Edit src/index.js' });
      result = 'Implemented the change in src/index.js and added a test. `npm test` passes.';
    }

    await wait(delay / 2);
    utilization = Math.min(1, utilization + 0.002);
    o.onEvent?.({
      type: 'limits',
      info: {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization, resetsAt, status: 'allowed' },
          seven_day: { utilization: utilization / 4, resetsAt: resetsAt + 6 * 86400, status: 'allowed' },
        },
      },
    });
    // CORP_MOCK_DENY=1 makes the first demo build hit a blocked command, to show the permission request.
    const denials = process.env.CORP_MOCK_DENY && o.kind === 'build' && !denied ? ((denied = true), [{ tool: 'Bash', command: 'python3 -m pytest tests/ -q' }]) : [];
    return { ok: true, denials, result, structured, sessionId: `mock-${n}`, costUsd: 0.08, inputTokens: 4200, outputTokens: 380, turns: 3, error: null, durationMs: delay };
  };
}
