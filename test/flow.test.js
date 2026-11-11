import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp } from '../src/server.js';
import { createMockRunner } from '../src/claude.js';
import { openDb } from '../src/db.js';
import { createBudget } from '../src/budget.js';
import { execFileSync } from 'node:child_process';
import { rulesFor, covered, parseRules, claudeCodeRules } from '../src/permissions.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'booardroom-test-'));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
};

function company(runner = createMockRunner({ delay: 10 })) {
  const configDir = tmp();
  const app = createApp({ dataDir: tmp(), runner, mock: true, configDir });
  return { ...app, configDir };
}

test('an approved proposal becomes a task that developers build and the PM reviews', async () => {
  const { db, orch, close } = company();
  const id = orch.createProject({ name: 'Shop', brief: 'Sell socks', devs: 1 });
  orch.setStatus(id, 'active');
  await until(() => db.get("SELECT COUNT(*) AS n FROM ideas WHERE status = 'proposed'").n === 3);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, 0, 'nothing is built before the CEO approves');

  const idea = db.get("SELECT * FROM ideas WHERE status = 'proposed' ORDER BY id LIMIT 1");
  orch.decideIdea(idea.id, true);
  await until(() => db.get('SELECT status FROM tasks WHERE idea_id = ?', idea.id).status === 'done');
  const task = db.get('SELECT * FROM tasks WHERE idea_id = ?', idea.id);
  assert.ok(task.report.includes('Implemented'));
  assert.throws(() => orch.decideIdea(idea.id, false), /already decided/);
  close();
});

test('autopilot approves proposals without the CEO', async () => {
  const { db, orch, close } = company();
  const id = orch.createProject({ name: 'Auto', approval: 'auto', devs: 2, daily_task_cap: 3 });
  orch.setStatus(id, 'active');
  await until(() => db.get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'").n >= 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM ideas WHERE decided_by = 'ceo'").n, 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks').n, 3, 'the daily task cap stops new rounds');
  close();
});

test('a task the PM keeps rejecting escalates to the CEO', async () => {
  const base = createMockRunner({ delay: 5 });
  const runner = async (o) => {
    const res = await base(o);
    if (o.kind === 'review') res.structured = { verdict: 'revise', notes: 'Not there yet.' };
    return res;
  };
  const { db, orch, close } = company(runner);
  const id = orch.createProject({ name: 'Strict', devs: 1, max_iterations: 2 });
  orch.addDirective(id, { title: 'Do the thing' });
  orch.setStatus(id, 'active');
  await until(() => db.get('SELECT status FROM tasks').status === 'escalated');
  const task = db.get('SELECT * FROM tasks');
  assert.equal(task.iteration, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM runs WHERE kind = 'build'").n, 2);
  orch.ruleTask(task.id, 'accept');
  assert.equal(db.get('SELECT status FROM tasks').status, 'done');
  close();
});

test('the budget gate stops agents at their share and at the ceiling', () => {
  let now = 1_000_000;
  const db = openDb(':memory:');
  const budget = createBudget(db, () => now);
  const resetsAt = now / 1000 + 3600;
  const reading = (u) => ({ unifiedWindows: { five_hour: { utilization: u, resetsAt, status: 'allowed' } } });
  budget.setConfig({ sharePct: 10, ceilingPct: 80 });

  assert.equal(budget.gate().ok, true, 'no reading yet means go');
  budget.record(reading(0.3));
  budget.record(reading(0.39));
  assert.equal(budget.gate().ok, true);
  assert.equal(budget.windows().five_hour.agentsPct, 9);
  budget.record(reading(0.4));
  assert.match(budget.gate().reason, /10% share/);

  budget.setConfig({ sharePct: 0 });
  assert.equal(budget.gate().ok, true);
  budget.record(reading(0.8));
  assert.match(budget.gate().reason, /80%/);

  now += 3601 * 1000;
  assert.equal(budget.gate().ok, true, 'a reset window opens the gate again');
});

test('agents stay idle while the gate is closed', async () => {
  const { db, orch, budget, close } = company();
  budget.record({ unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: Date.now() / 1000 + 3600, status: 'allowed' } } });
  const id = orch.createProject({ name: 'Blocked' });
  orch.setStatus(id, 'active');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM runs').n, 0);
  close();
});

test('the archive reads Claude Code sessions and claude.ai exports, and hands them over', async () => {
  const { history, orch, db, server, configDir, close } = company();
  const dir = path.join(configDir, 'projects', '-home-me-shop');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'user', cwd: '/home/me/shop', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'Add a cart page' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Edit', input: {} }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Cart page added.' }] } },
  ];
  fs.writeFileSync(path.join(dir, 'abc-123.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));

  assert.equal(history.importExport([{ uuid: 'u1', name: 'Pricing', updated_at: '2026-02-01T00:00:00Z', chat_messages: [{ sender: 'human', text: 'What should socks cost?' }, { sender: 'assistant', text: 'Five dollars.' }] }]), 1);
  history.importExport([{ uuid: 'u1', name: 'Pricing v2', chat_messages: [{ sender: 'human', text: 'hi' }] }]);
  const list = history.list();
  assert.deepEqual(list.map((s) => s.title).sort(), ['Add a cart page', 'Pricing v2']);

  const chat = history.read('claude-code', '-home-me-shop/abc-123');
  assert.equal(chat.messages.length, 2, 'tool results are dropped and assistant rows merged');
  assert.equal(chat.messages[1].text, 'On it.\n\nCart page added.');
  assert.throws(() => history.read('claude-code', '../../etc/passwd'));

  const id = orch.createProject({ name: 'Shop' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(`/api/projects/${id}/handovers`, { source: 'claude-code', id: '-home-me-shop/abc-123', summarize: true })).status, 200);
  assert.match(db.get('SELECT body FROM handovers').body, /Handover brief/);
  assert.equal((await post('/api/projects', { name: 'Evil' }, { Origin: 'https://evil.example' })).status, 403);

  // The export arrives from claude.ai as a zip. Build a small one and import it untouched.
  const zip = (name, text, deflate) => {
    const raw = Buffer.from(text);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(deflate ? 8 : 0, 8); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + data.length, 16);
    return Buffer.concat([head, Buffer.from(name), data, central, Buffer.from(name), end]);
  };
  const exported = JSON.stringify([{ uuid: 'z1', name: 'From the zip', chat_messages: [{ sender: 'human', text: 'hello' }] }]);
  for (const deflate of [true, false]) {
    const res = await fetch(base + '/api/history/import', { method: 'POST', body: zip('data-2026/conversations.json', exported, deflate) });
    assert.deepEqual(await res.json(), { imported: 1 });
  }
  assert.ok(history.list().some((s) => s.title === 'From the zip'));
  assert.equal((await fetch(base + '/api/history/import', { method: 'POST', body: zip('users.json', '[]', true) })).status, 400);
  close();
});

test('a proposal that needs design goes through the designer, and every agent gets its master prompt', async () => {
  const seen = [];
  const base = createMockRunner({ delay: 5 });
  const runner = (o) => {
    seen.push({ kind: o.kind, system: o.system });
    return base(o);
  };
  const { db, orch, close } = company(runner);
  const id = orch.createProject({ name: 'Studio', devs: 1 });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agents WHERE role = 'designer'").n, 1);
  orch.setStatus(id, 'active');
  await until(() => db.get("SELECT COUNT(*) AS n FROM ideas WHERE status = 'proposed'").n === 3);

  const designed = db.all('SELECT * FROM ideas WHERE design IS NOT NULL');
  assert.equal(designed.length, 1, 'only the proposal flagged needs_design visits the designer');
  orch.decideIdea(designed[0].id, true);
  assert.match(db.get('SELECT spec FROM tasks WHERE idea_id = ?', designed[0].id).spec, /Design spec from the designer/);
  await until(() => seen.some((r) => r.kind === 'review'));

  const prompt = (kind) => seen.find((r) => r.kind === kind).system;
  assert.match(prompt('ideate'), /^# Project Manager/);
  assert.match(prompt('review'), /^# Project Manager/);
  assert.match(prompt('design'), /^# Designer/);
  assert.match(prompt('build'), /^# Developer/);
  close();
});

test('the CEO talks to the manager, who briefs the team and queues the work', async () => {
  const prompts = [];
  const base = createMockRunner({ delay: 5 });
  const runner = (o) => {
    prompts.push({ kind: o.kind, prompt: o.prompt });
    return base(o);
  };
  const { db, orch, close } = company(runner);
  const id = orch.createProject({ name: 'Talkative', devs: 1 });
  assert.throws(() => orch.tell(id, '   '), /Write a message/);
  orch.tell(id, 'Everything must work on a phone from now on.');

  // The manager answers even though the project was never started.
  await until(() => db.get("SELECT COUNT(*) AS n FROM messages WHERE role = 'pm'").n === 1);
  const reply = db.get("SELECT * FROM messages WHERE role = 'pm'");
  assert.deepEqual(Object.keys(JSON.parse(reply.effects)).sort(), ['memo', 'tasks']);
  assert.equal(db.get("SELECT answered FROM messages WHERE role = 'ceo'").answered, 1);
  assert.match(db.get('SELECT memo FROM projects').memo, /usable on a phone/);
  const task = db.get('SELECT * FROM tasks');
  assert.equal(task.title, 'Make the main screen work on a phone');
  assert.equal(db.get('SELECT decided_by FROM ideas WHERE id = ?', task.idea_id).decided_by, 'ceo');

  // Once the project runs, the developer gets the memo and the manager plans with the conversation in mind.
  orch.setStatus(id, 'active');
  await until(() => prompts.some((p) => p.kind === 'build') && prompts.some((p) => p.kind === 'ideate'));
  assert.match(prompts.find((p) => p.kind === 'build').prompt, /Standing guidance from the CEO[\s\S]*usable on a phone/);
  assert.match(prompts.find((p) => p.kind === 'ideate').prompt, /CEO: Everything must work on a phone/);
  close();
});

test('a refused command stops the developer, asks the CEO, and the same session continues with the answer', async () => {
  const runs = [];
  const base = createMockRunner({ delay: 5 });
  // What the developer tries on each run of the task, in order.
  const attempts = [
    [{ tool: 'Bash', command: 'cd app && python3 -m pytest tests/ | tail -5 && sudo make install' }],
    [{ tool: 'Bash', command: 'docker exec web ls' }],
    [{ tool: 'Bash', command: 'sudo make install; ls' }], // already refused by the CEO: must not stop the run again
  ];
  const runner = async (o) => {
    if (o.kind !== 'build') return base(o);
    runs.push({ resume: o.resume, prompt: o.prompt, tools: o.allowedTools });
    for (const denial of attempts[runs.length - 1] ?? []) {
      if (o.onDenial(denial)) return { ok: false, paused: true, error: 'paused for permission', sessionId: 'session-1', denials: [denial] };
    }
    return base(o);
  };
  const { db, orch, close } = company(runner);
  const id = orch.createProject({ name: 'Blocked', devs: 1 });
  orch.addDirective(id, { title: 'Run the tests' });
  orch.setStatus(id, 'active');

  await until(() => db.get('SELECT status FROM tasks').status === 'blocked');
  assert.equal(runs.length, 1, 'the developer does not carry on while it waits');
  let requests = db.all("SELECT * FROM permission_requests WHERE status = 'pending' ORDER BY id");
  assert.deepEqual(requests.map((r) => r.rule), ['Bash(python3 *)', 'Bash(sudo *)']);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM events WHERE type = ?', 'error').n, 2, 'a pause is not reported as a failed run');

  orch.decidePermission(requests[0].id, true);
  assert.equal(db.get('SELECT status FROM tasks').status, 'blocked', 'it waits until every request is answered');
  orch.decidePermission(requests[1].id, false);

  // Second run: same session, told what was decided, and it stops again on the next unknown command.
  await until(() => runs.length === 2 && db.get('SELECT status FROM tasks').status === 'blocked');
  assert.equal(runs[1].resume, 'session-1');
  assert.match(runs[1].prompt, /Allowed now: Bash\(python3 \*\)\.\nStill blocked, by the CEO's decision: Bash\(sudo \*\)/);
  assert.match(runs[1].tools, /Bash\(python3 \*\)$/);
  requests = db.all("SELECT * FROM permission_requests WHERE status = 'pending'");
  assert.deepEqual(requests.map((r) => r.rule), ['Bash(docker exec *)']);
  orch.decidePermission(requests[0].id, true);

  await until(() => db.get('SELECT status FROM tasks').status === 'done');
  assert.equal(runs.length, 3, 'the command the CEO refused did not stop the third run');
  close();
});

test('permission rules are derived, compared and read from Claude Code settings', () => {
  assert.deepEqual(rulesFor({ tool: 'Bash', command: 'FOO=1 git push origin main; echo done' }), ['Bash(git push *)']);
  assert.deepEqual(rulesFor({ tool: 'WebFetch' }), ['WebFetch']);
  assert.ok(covered('Bash(git push *)', ['Bash(git *)']));
  assert.ok(!covered('Bash(gitx *)', ['Bash(git *)']));
  assert.deepEqual(parseRules('Read, Bash(a, b *),Edit'), ['Read', 'Bash(a, b *)', 'Edit']);

  const home = tmp();
  const work = tmp();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(work, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(python3 *)'] } }));
  fs.writeFileSync(path.join(work, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(make *)'] } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/elsewhere/shop': { allowedTools: ['Bash(curl *)', 'Bash(python3 *)'] } } }));
  assert.deepEqual(claudeCodeRules(work, path.join(home, '.claude')), [
    { rule: 'Bash(make *)', source: 'This folder' },
    { rule: 'Bash(python3 *)', source: 'Your Claude Code settings' },
    { rule: 'Bash(curl *)', source: 'Allowed in shop' },
  ]);
});

test('developers inherit what the CEO allows Claude Code, unless the project opts out', async () => {
  const seen = [];
  const base = createMockRunner({ delay: 5 });
  const runner = (o) => {
    if (o.kind === 'build') seen.push({ tools: o.allowedTools, mode: o.permissionMode });
    return base(o);
  };
  const { db, orch, configDir, close } = company(runner);
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(python3 *)', 'Bash(docker *)'], defaultMode: 'auto' } }));

  const id = orch.createProject({ name: 'Heir', devs: 1 });
  orch.addDirective(id, { title: 'First' });
  orch.setStatus(id, 'active');
  await until(() => seen.length === 1);
  assert.match(seen[0].tools, /Bash\(python3 \*\),Bash\(docker \*\)$/);
  assert.equal(seen[0].mode, 'auto');

  orch.setStatus(id, 'paused'); // free the run slots for the second project
  const own = orch.createProject({ name: 'Strict', devs: 1, inherit_claude: '0' });
  orch.addDirective(own, { title: 'Second' });
  orch.setStatus(own, 'active');
  await until(() => seen.some((run) => !/python3/.test(run.tools)));
  assert.equal(seen.find((run) => !/python3/.test(run.tools)).mode, 'acceptEdits');
  close();
});

test('Booardroom creates the repository, signs commits as the account and pushes approved work', async () => {
  // A bare repository on disk stands in for GitHub: the fake API hands out its path as the clone URL.
  // The machine running the tests may name a git author of its own. Take that out of the picture.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  const remote = tmp();
  execFileSync('git', ['init', '-q', '--bare', remote]);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    const body = url.endsWith('/user') ? { login: 'ceo', id: 7, name: 'The CEO' } : { clone_url: remote, html_url: 'https://github.com/ceo/shop' };
    return { ok: true, status: 200, json: async () => body };
  };
  const dataDir = tmp();
  const seen = [];
  const base = createMockRunner({ delay: 5 });
  const runner = async (o) => {
    if (o.kind === 'build') {
      seen.push({ prompt: o.prompt, token: o.env?.GH_TOKEN });
      fs.writeFileSync(path.join(o.cwd, 'feature.txt'), 'done');
      execFileSync('git', ['add', '-A'], { cwd: o.cwd });
      execFileSync('git', ['commit', '-q', '-m', 'Add feature'], { cwd: o.cwd });
    }
    return base(o);
  };
  const app = createApp({ dataDir, runner, mock: true, configDir: tmp(), github: { fetchImpl, useCli: false } });
  const { db, orch, server } = app;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(baseUrl + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

  try {
    assert.equal((await post('/api/github/connect', { token: 'secret-token' })).account.login, 'ceo');
    const { id } = await post('/api/projects', { name: 'Shop', devs: 1 });
    const workdir = db.get('SELECT workdir FROM projects').workdir;
    assert.equal((await post(`/api/projects/${id}/github/create`, { name: 'shop' })).url, 'https://github.com/ceo/shop');
    assert.deepEqual(calls, ['GET /user', 'POST /user/repos']);
    assert.equal(execFileSync('git', ['config', '--local', 'user.email'], { cwd: workdir }).toString().trim(), '7+ceo@users.noreply.github.com');

    orch.addDirective(id, { title: 'Ship the feature' });
    orch.setStatus(id, 'active');
    await until(() => db.get("SELECT COUNT(*) AS n FROM events WHERE text LIKE 'Booardroom pushed%'").n === 1);
    assert.match(execFileSync('git', ['log', '--format=%an <%ae> %s', '--all'], { cwd: remote }).toString(), /The CEO <7\+ceo@users\.noreply\.github\.com> Add feature/);
    assert.equal(seen[0].token, 'secret-token', 'agents get the account in their environment');
    assert.match(seen[0].prompt, /Booardroom pushes approved work there by itself/);
  } finally {
    app.close();
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.GIT_CONFIG_SYSTEM;
  }
});
