import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createBudget } from './budget.js';
import { runClaude, createMockRunner } from './claude.js';
import { createOrchestrator, DEFAULT_DEV_TOOLS } from './orchestrator.js';
import { createHistory, transcriptText } from './history.js';
import { pickFolder, revealFolder } from './native.js';
import { createGitHub } from './github.js';
import { unzipEntry } from './zip.js';
import { execFileSync } from 'node:child_process';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

export function createApp({ dataDir, runner, mock = false, configDir, github: githubOptions } = {}) {
  const db = openDb(dataDir);
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const budget = createBudget(db);
  const github = createGitHub(db, githubOptions);
  const orch = createOrchestrator({ db, budget, runner, bus, configDir, github, dataDir: dataDir === ':memory:' ? fs.mkdtempSync('/tmp/boardroom-') : dataDir });
  const history = createHistory(db, configDir ? { configDir } : undefined);
  orch.recover();

  const agentsOf = (projectId) =>
    db.all('SELECT * FROM agents WHERE project_id = ? ORDER BY id', projectId).map((a) => {
      const job = orch.busy().get(a.id);
      return { ...a, job: job ? { kind: job.kind, taskId: job.taskId, label: job.label, since: job.since } : null };
    });

  function state() {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const projects = db.all('SELECT * FROM projects ORDER BY id').map((p) => {
      const count = (sql, ...args) => db.get(sql, p.id, ...args).n;
      const agents = agentsOf(p.id).map((a) => ({ id: a.id, role: a.role, name: a.name, job: a.job }));
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        approval: p.approval,
        proposed: count("SELECT COUNT(*) AS n FROM ideas WHERE project_id = ? AND status = 'proposed'"),
        open: count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('queued','in_progress','blocked','review','changes')"),
        done: count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'done'"),
        attention: count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('escalated','failed')") + count("SELECT COUNT(*) AS n FROM permission_requests WHERE project_id = ? AND status = 'pending'"),
        working: agents.filter((a) => a.job).length,
        headcount: agents.length,
        agents,
      };
    });
    const inbox = [
      ...db.all("SELECT r.*, p.name AS project_name, a.name AS agent_name FROM permission_requests r JOIN projects p ON p.id = r.project_id LEFT JOIN agents a ON a.id = r.agent_id WHERE r.status = 'pending' ORDER BY r.id").map((r) => ({ kind: 'permission', ...r })),
      ...db.all("SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.status IN ('escalated','failed') ORDER BY t.id").map((t) => ({ kind: 'task', ...t })),
      ...db.all("SELECT i.*, p.name AS project_name FROM ideas i JOIN projects p ON p.id = i.project_id WHERE i.status = 'proposed' ORDER BY i.id").map((i) => ({ kind: 'idea', ...i })),
    ];
    return {
      runner: mock ? 'mock' : 'claude',
      budget: { config: budget.config(), windows: budget.windows(), gate: budget.gate(), today: budget.spentToday() },
      stats: {
        working: projects.reduce((n, p) => n + p.working, 0),
        headcount: projects.reduce((n, p) => n + p.headcount, 0),
        shippedToday: db.get("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND updated_at >= ?", midnight.getTime()).n,
      },
      projects,
      inbox,
      feed: db.all(
        `SELECT e.id, e.type, e.text, e.ts, e.project_id, p.name AS project_name, a.role, a.name AS agent_name
         FROM events e JOIN projects p ON p.id = e.project_id LEFT JOIN agents a ON a.id = e.agent_id
         WHERE e.type NOT IN ('tool', 'say', 'idea') ORDER BY e.id DESC LIMIT 12`,
      ),
    };
  }

  async function projectDetail(id) {
    const project = db.get('SELECT * FROM projects WHERE id = ?', id);
    if (!project) throw httpError(404, 'Project not found.');
    return {
      project: { ...project, default_tools: DEFAULT_DEV_TOOLS, tools: orch.toolsOf(project), own_tools: orch.ownTools(project), inherited: orch.inherited(project).rules, run_mode: orch.modeOf(project), is_git: fs.existsSync(path.join(project.workdir, '.git')) },
      permissions: db.all("SELECT r.*, a.name AS agent_name FROM permission_requests r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.project_id = ? AND r.status = 'pending' ORDER BY r.id", id),
      agents: agentsOf(id),
      ideas: db.all("SELECT * FROM ideas WHERE project_id = ? AND (status IN ('proposed', 'design') OR author = 'pm') ORDER BY status = 'proposed' DESC, id DESC LIMIT 40", id),
      tasks: db.all("SELECT t.*, i.effort FROM tasks t LEFT JOIN ideas i ON i.id = t.idea_id WHERE t.project_id = ? AND t.status != 'cancelled' ORDER BY t.id DESC LIMIT 120", id),
      events: db.all('SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT 200', id),
      handovers: db.all('SELECT * FROM handovers WHERE project_id = ? ORDER BY id DESC', id),
      messages: db.all('SELECT * FROM (SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT 100) ORDER BY id', id).map((m) => ({ ...m, effects: m.effects ? JSON.parse(m.effects) : null })),
      spend: db.get('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS runs FROM runs WHERE project_id = ?', id),
      repo: await github.status(project.workdir),
      github: await github.account(),
    };
  }

  const routes = [
    ['GET', /^\/api\/state$/, () => state()],
    ['GET', /^\/api\/projects\/(\d+)$/, ({ m }) => projectDetail(+m[1])],
    ['POST', /^\/api\/projects$/, ({ body }) => ({ id: orch.createProject(body) })],
    ['PATCH', /^\/api\/projects\/(\d+)$/, ({ m, body }) => orch.updateProject(+m[1], body)],
    ['DELETE', /^\/api\/projects\/(\d+)$/, ({ m }) => orch.deleteProject(+m[1])],
    ['POST', /^\/api\/projects\/(\d+)\/(start|pause)$/, ({ m }) => orch.setStatus(+m[1], m[2] === 'start' ? 'active' : 'paused')],
    ['POST', /^\/api\/projects\/(\d+)\/messages$/, ({ m, body }) => ({ id: orch.tell(+m[1], body.text) })],
    ['POST', /^\/api\/projects\/(\d+)\/directives$/, ({ m, body }) => orch.addDirective(+m[1], body)],
    ['POST', /^\/api\/ideas\/(\d+)\/(approve|reject)$/, ({ m, body }) => orch.decideIdea(+m[1], m[2] === 'approve', 'ceo', String(body.reason || '').slice(0, 500))],
    ['POST', /^\/api\/permissions\/(\d+)\/(allow|ignore)$/, ({ m }) => orch.decidePermission(+m[1], m[2] === 'allow')],
    ['POST', /^\/api\/projects\/(\d+)\/git-init$/, ({ m }) => {
      const project = db.get('SELECT workdir FROM projects WHERE id = ?', +m[1]);
      if (!project) throw httpError(404, 'Project not found.');
      try {
        execFileSync('git', ['init', '-q'], { cwd: project.workdir });
      } catch {
        throw httpError(500, 'git init failed. Is git installed?');
      }
      bus.emit('change', {});
    }],
    ['GET', /^\/api\/github$/, async () => ({ account: await github.account() })],
    ['POST', /^\/api\/github\/connect$/, async ({ body }) => ({ account: await github.connect(body.token) })],
    ['DELETE', /^\/api\/github$/, () => github.disconnect()],
    ['POST', /^\/api\/projects\/(\d+)\/github\/(create|link|push)$/, async ({ m, body }) => {
      const project = db.get('SELECT * FROM projects WHERE id = ?', +m[1]);
      if (!project) throw httpError(404, 'Project not found.');
      let out;
      if (m[2] === 'create') out = await github.createRepo(project.workdir, { name: body.name || project.name, isPrivate: body.private !== false && body.private !== 'false', description: project.brief.split('\n')[0] });
      else if (m[2] === 'link') out = await github.link(project.workdir, body.url);
      else {
        out = await orch.publish(project.id, 'the current work');
        if (!out.ok) throw httpError(502, out.error || 'Nothing to push.');
      }
      if (m[2] !== 'push') db.insert('events', { project_id: project.id, type: 'ceo', text: `The CEO connected the project to ${out.url}.`, ts: Date.now() });
      await orch.refreshRepo(project);
      bus.emit('change', { projectId: project.id });
      return out;
    }],
    ['POST', /^\/api\/pick-folder$/, async () => ({ path: await pickFolder() })],
    ['POST', /^\/api\/projects\/(\d+)\/reveal$/, ({ m }) => {
      const project = db.get('SELECT workdir FROM projects WHERE id = ?', +m[1]);
      if (!project) throw httpError(404, 'Project not found.');
      revealFolder(project.workdir);
    }],
    ['GET', /^\/api\/tasks\/(\d+)$/, ({ m }) => {
      const task = db.get('SELECT * FROM tasks WHERE id = ?', +m[1]);
      if (!task) throw httpError(404, 'Task not found.');
      return {
        task,
        events: db.all('SELECT * FROM events WHERE task_id = ? ORDER BY id', task.id),
        runs: db.all('SELECT * FROM runs WHERE task_id = ? ORDER BY id', task.id),
      };
    }],
    ['POST', /^\/api\/tasks\/(\d+)\/(accept|retry|cancel)$/, ({ m }) => orch.ruleTask(+m[1], m[2])],
    ['PUT', /^\/api\/budget$/, ({ body }) => {
      budget.setConfig(body);
      bus.emit('change', {});
      orch.tick();
    }],
    ['GET', /^\/api\/history$/, ({ url }) => ({ sessions: history.list(url.searchParams.get('q') || ''), root: history.root })],
    ['GET', /^\/api\/history\/chat$/, ({ url }) => history.read(url.searchParams.get('source'), url.searchParams.get('id') || '')],
    ['POST', /^\/api\/history\/import$/, ({ raw }) => {
      // Takes the export as it arrives from claude.ai (a zip) or the conversations.json inside it.
      let json = raw;
      if (raw.length > 3 && raw[0] === 0x50 && raw[1] === 0x4b) {
        json = unzipEntry(raw, (name) => /(^|\/)conversations\.json$/.test(name));
        if (!json) throw httpError(400, 'This zip has no conversations.json. Pick the archive claude.ai sent you.');
      }
      let data;
      try {
        data = JSON.parse(json.toString('utf8'));
      } catch {
        throw httpError(400, 'This file is not a claude.ai export. Pick the zip from claude.ai, or the conversations.json inside it.');
      }
      return { imported: history.importExport(data) };
    }],
    ['POST', /^\/api\/history\/notes$/, ({ body }) => ({ id: history.addNote(body.title, body.text) })],
    ['DELETE', /^\/api\/history\/chat\/(\d+)$/, ({ m }) => history.remove(m[1])],
    ['POST', /^\/api\/projects\/(\d+)\/handovers$/, async ({ m, body }) => {
      const project = db.get('SELECT * FROM projects WHERE id = ?', +m[1]);
      if (!project) throw httpError(404, 'Project not found.');
      const chat = history.read(body.source, String(body.id));
      const transcript = transcriptText(chat);
      let text = transcript.length > 30000 ? `${transcript.slice(0, 30000)}\n[cut]` : transcript;
      let summarized = 0;
      if (body.summarize) {
        const res = await orch.summarize(project, chat.title, transcript);
        if (!res.ok || !res.result) throw httpError(502, `The summary failed: ${res.error || 'empty reply'}`);
        text = res.result;
        summarized = 1;
      }
      const id = db.insert('handovers', { project_id: project.id, title: chat.title, origin: `${chat.source}:${chat.id}`, body: text, summarized, created_at: Date.now() });
      db.insert('events', { project_id: project.id, type: 'ceo', text: `The CEO handed over the chat “${chat.title}”.`, ts: Date.now() });
      bus.emit('change', { projectId: project.id });
      return { id };
    }],
    ['DELETE', /^\/api\/handovers\/(\d+)$/, ({ m }) => {
      db.run('DELETE FROM handovers WHERE id = ?', +m[1]);
      bus.emit('change', {});
    }],
  ];

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      let timer = null;
      const onChange = () => {
        // Runs emit bursts of events. One nudge per 150 ms is plenty for the UI.
        timer ??= setTimeout(() => {
          timer = null;
          res.write('data: change\n\n');
        }, 150);
      };
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      bus.on('change', onChange);
      req.on('close', () => {
        bus.off('change', onChange);
        clearInterval(ping);
        clearTimeout(timer);
      });
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        // The API can start agents that edit files, so refuse requests another site's page could forge.
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) throw httpError(403, 'Cross-origin request refused.');
        for (const [method, pattern, fn] of routes) {
          const m = req.method === method && url.pathname.match(pattern);
          if (!m) continue;
          const wantsRaw = url.pathname === '/api/history/import';
          const raw = req.method === 'GET' ? null : await readBody(req);
          const body = raw && !wantsRaw ? parseJson(raw) : {};
          const out = await fn({ m, body, raw, url });
          return send(res, 200, out ?? { ok: true });
        }
        throw httpError(404, 'No such endpoint.');
      } catch (err) {
        return send(res, err.status || 400, { error: err.message });
      }
    }

    const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[/\\]+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(handle);
  const interval = setInterval(() => orch.tick(), 5000);
  interval.unref();
  return { server, db, orch, budget, history, bus, close: () => (clearInterval(interval), server.close(), server.closeAllConnections?.()) };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseJson(raw) {
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'The request body is not valid JSON.');
  }
}

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'The upload is too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mock = process.env.CORP_RUNNER === 'mock';
  const app = createApp({
    dataDir: path.resolve(process.env.CORP_DATA_DIR || 'data'),
    runner: mock ? createMockRunner({ delay: Number(process.env.CORP_MOCK_DELAY) || 2500 }) : runClaude,
    mock,
  });
  const port = Number(process.env.PORT) || 4317;
  const host = process.env.HOST || '127.0.0.1';
  app.server.listen(port, host, () => {
    console.log(`Boardroom is open at http://${host}:${port}${mock ? '  (demo runner, no Claude calls)' : ''}`);
    app.orch.tick();
  });
}
