import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IDEAS_SCHEMA, REVIEW_SCHEMA, CHAT_SCHEMA, chatPrompt, ideatePrompt, designPrompt, buildPrompt, revisePrompt, continuePrompt, reviewPrompt, summarizePrompt } from './prompts.js';
import { createRoles } from './roles.js';
import { parseRules, rulesFor, covered, claudeCodeRules, claudeCodeMode } from './permissions.js';

export const DEFAULT_DEV_TOOLS =
  'Read,Edit,Write,Glob,Grep,Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git add *),Bash(git commit *),Bash(npm test *),Bash(npm run *)';
const PM_READ_TOOLS = 'Read,Glob,Grep';
const DESIGNER_TOOLS = 'Read,Glob,Grep,Skill';
const PM_REVIEW_ALLOWED = 'Read,Glob,Grep,Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *)';
const OPEN = ['queued', 'in_progress', 'blocked', 'review', 'changes', 'escalated'];
const DEV_NAMES = ['Ada', 'Linus', 'Grace', 'Dennis', 'Barbara', 'Ken', 'Margaret', 'Alan', 'Edsger', 'Radia', 'Donald', 'Katherine'];
const clip = (s, n = 4000) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

export function createOrchestrator({ db, budget, runner, bus, dataDir, configDir, github, now = () => Date.now() }) {
  /** agentId -> { kind, taskId, since, abort } */
  const busy = new Map();
  /** projectId -> timestamp; set after a failed PM run so a broken setup does not burn the budget */
  const cooldown = new Map();
  let ticking = false;
  const rolePrompt = createRoles(dataDir);

  // Where each project lives on GitHub, refreshed in the background so prompts can name it.
  const repos = new Map();
  const refreshRepo = (project) => github?.status(project.workdir).then((st) => repos.set(project.id, st.missing ? null : st.web ?? st.remote)).catch(() => {});
  const seen = (project) => ({ ...project, repo: repos.get(project.id) ?? null });

  /** Sends approved work to GitHub. Booardroom does this itself, so no agent needs push rights. */
  async function publish(projectId, why) {
    const project = db.get('SELECT * FROM projects WHERE id = ?', projectId);
    if (!project || !github) return { ok: false, skipped: true };
    const res = await github.push(project.workdir);
    if (res.ok) emit(projectId, 'ceo', `Booardroom pushed ${why} to GitHub.`);
    else if (!res.skipped) emit(projectId, 'error', `Pushing to GitHub failed: ${res.error}`);
    refreshRepo(project);
    return res;
  }

  const emit = (projectId, type, text, extra = {}) => {
    const row = { project_id: projectId, type, text: clip(text), ts: now(), task_id: extra.taskId ?? null, agent_id: extra.agentId ?? null };
    row.id = db.insert('events', row);
    bus.emit('change', { projectId });
  };

  // ---- permissions ----------------------------------------------------

  const ownTools = (project) => parseRules(project.allowed_tools || DEFAULT_DEV_TOOLS);

  // What the person already allows Claude Code to do. Read from their settings, at most every ten seconds per folder.
  const inheritedCache = new Map();
  function inherited(project) {
    if (!project.inherit_claude) return { rules: [], mode: null };
    const hit = inheritedCache.get(project.workdir);
    if (hit && hit.at > Date.now() - 10_000) return hit.value;
    const value = { rules: claudeCodeRules(project.workdir, configDir), mode: claudeCodeMode(project.workdir, configDir) };
    inheritedCache.set(project.workdir, { at: Date.now(), value });
    return value;
  }

  /** Everything a developer may run: the project's own rules plus, when inheriting, the person's Claude Code rules. */
  const toolsOf = (project) => [...new Set([...ownTools(project), ...inherited(project).rules.map((r) => r.rule)])];

  /** Developers work in the mode the person uses for Claude Code when it is a looser one, else they may edit files only. */
  function modeOf(project) {
    if (project.permission_mode === 'bypassPermissions') return 'bypassPermissions';
    const theirs = inherited(project).mode;
    return theirs === 'bypassPermissions' || theirs === 'auto' ? theirs : 'acceptEdits';
  }

  /** A developer was denied a command. Ask the CEO once per rule whether the team may use it. */
  function recordDenials(project, agent, task, denials) {
    const have = toolsOf(project);
    for (const denial of denials) {
      for (const rule of rulesFor(denial)) {
        if (covered(rule, have)) continue;
        if (db.get('SELECT id FROM permission_requests WHERE project_id = ? AND rule = ?', project.id, rule)) continue;
        db.insert('permission_requests', {
          project_id: project.id,
          task_id: task?.id ?? null,
          agent_id: agent?.id ?? null,
          rule,
          example: clip(denial.command || denial.detail || denial.tool, 400),
          ts: now(),
        });
        emit(project.id, 'error', `${agent?.name ?? 'An agent'} was not allowed to run ${rule}. The CEO can allow it.`, { taskId: task?.id, agentId: agent?.id });
      }
    }
  }

  /** Should a run stop for this refusal? Yes, unless the CEO already said no to every rule it needs. */
  function needsDecision(project, denial) {
    const have = toolsOf(project);
    return rulesFor(denial).some((rule) => {
      if (covered(rule, have)) return false;
      const known = db.get('SELECT status FROM permission_requests WHERE project_id = ? AND rule = ?', project.id, rule);
      return !known || known.status === 'pending';
    });
  }

  function addRules(projectId, rules) {
    const project = db.get('SELECT * FROM projects WHERE id = ?', projectId);
    if (!project) throw new Error('Project not found.');
    const next = [...new Set([...ownTools(project), ...rules.map((r) => String(r).trim()).filter(Boolean)])];
    db.update('projects', projectId, { allowed_tools: next.join(',') });
    return next;
  }

  /** The CEO rules on a request. Allowing adds the rule to the project and gives blocked tasks another go. */
  function decidePermission(requestId, allow) {
    const req = db.get('SELECT * FROM permission_requests WHERE id = ?', requestId);
    if (!req || req.status !== 'pending') throw new Error('This request is already decided.');
    db.update('permission_requests', requestId, { status: allow ? 'allowed' : 'ignored' });
    if (allow) {
      addRules(req.project_id, [req.rule]);
      emit(req.project_id, 'ceo', `The CEO allowed the team to use ${req.rule}.`);
    }
    // Once every request from a task is answered, its developer picks the work up again.
    const task = req.task_id ? db.get('SELECT * FROM tasks WHERE id = ?', req.task_id) : null;
    const stillWaiting = req.task_id ? db.get("SELECT COUNT(*) AS n FROM permission_requests WHERE task_id = ? AND status = 'pending'", req.task_id).n : 0;
    if (task && !stillWaiting) {
      const answers = db.all("SELECT rule, status FROM permission_requests WHERE task_id = ? AND status != 'pending'", task.id);
      const yes = answers.filter((a) => a.status === 'allowed').map((a) => a.rule);
      const no = answers.filter((a) => a.status === 'ignored').map((a) => a.rule);
      const note = [yes.length ? `Allowed now: ${yes.join(', ')}.` : '', no.length ? `Still blocked, by the CEO's decision: ${no.join(', ')}. Do not ask for these again.` : ''].filter(Boolean).join('\n');
      if (task.status === 'blocked') {
        setTask(task, { status: 'changes', resume_note: note });
        emit(req.project_id, 'ceo', `“${task.title}” continues. ${note.replace(/\n/g, ' ')}`, { taskId: task.id });
      } else if (allow && ['escalated', 'failed'].includes(task.status)) {
        setTask(task, { status: task.report ? 'changes' : 'queued', iteration: 0, failures: 0, resume_note: note });
        emit(req.project_id, 'ceo', `“${task.title}” goes back to the developers with the new permission.`, { taskId: task.id });
      }
    }
    bus.emit('change', { projectId: req.project_id });
    tick();
  }

  /** Answers every open permission request at once, for one project or the whole company. */
  function allowAll(projectId) {
    const open = projectId
      ? db.all("SELECT id FROM permission_requests WHERE status = 'pending' AND project_id = ? ORDER BY id", projectId)
      : db.all("SELECT id FROM permission_requests WHERE status = 'pending' ORDER BY id");
    for (const req of open) decidePermission(req.id, true);
    return open.length;
  }

  // ---- projects ---------------------------------------------------------

  function createProject(input) {
    const name = String(input.name || '').trim();
    if (!name) throw new Error('A project needs a name.');
    let workdir = String(input.workdir || '').trim();
    if (workdir) {
      workdir = path.resolve(workdir.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
      if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) throw new Error(`Folder not found: ${workdir}`);
    } else {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
      workdir = path.resolve(dataDir, 'workspaces', `${slug}-${now().toString(36)}`);
      fs.mkdirSync(workdir, { recursive: true });
      try {
        execFileSync('git', ['init', '-q'], { cwd: workdir });
      } catch {}
    }
    const id = db.insert('projects', { name, brief: String(input.brief || ''), workdir, created_at: now() });
    db.insert('agents', { project_id: id, role: 'pm', name: 'Project Manager' });
    db.insert('agents', { project_id: id, role: 'designer', name: 'Designer' });
    updateProject(id, { devs: 2, ...input });
    emit(id, 'ceo', `The CEO founded the project “${name}”.`);
    github?.setIdentity(workdir).catch(() => {});
    refreshRepo({ id, workdir });
    return id;
  }

  function updateProject(id, patch) {
    const p = db.get('SELECT * FROM projects WHERE id = ?', id);
    if (!p) throw new Error('Project not found.');
    const next = {};
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim();
    if (typeof patch.brief === 'string') next.brief = patch.brief;
    if (['ceo', 'auto'].includes(patch.approval)) next.approval = patch.approval;
    if (['acceptEdits', 'bypassPermissions'].includes(patch.permission_mode)) next.permission_mode = patch.permission_mode;
    if (typeof patch.allowed_tools === 'string') next.allowed_tools = patch.allowed_tools.trim();
    if (typeof patch.model === 'string') next.model = patch.model.trim();
    if (patch.auto_push !== undefined) next.auto_push = ['1', 'true', 1, true].includes(patch.auto_push) ? 1 : 0;
    if (patch.inherit_claude !== undefined) next.inherit_claude = ['1', 'true', 1, true].includes(patch.inherit_claude) ? 1 : 0;
    const int = (key, lo, hi) => {
      if (patch[key] !== undefined && patch[key] !== '') next[key] = Math.min(hi, Math.max(lo, Math.round(Number(patch[key])) || lo));
    };
    int('ideas_per_round', 1, 8);
    int('max_iterations', 1, 6);
    int('max_turns', 5, 200);
    int('daily_task_cap', 0, 500);
    db.update('projects', id, next);

    if (patch.devs !== undefined) {
      const want = Math.min(DEV_NAMES.length, Math.max(1, Math.round(Number(patch.devs)) || 1));
      const devs = db.all("SELECT * FROM agents WHERE project_id = ? AND role = 'dev' ORDER BY id", id);
      for (let i = devs.length; i < want; i++) db.insert('agents', { project_id: id, role: 'dev', name: DEV_NAMES[i] });
      for (const extra of devs.slice(want).reverse()) {
        if (busy.has(extra.id)) break;
        db.run("UPDATE tasks SET assignee = NULL WHERE assignee = ?", extra.id);
        db.run('DELETE FROM agents WHERE id = ?', extra.id);
      }
    }
    if (next.approval === 'auto') {
      for (const idea of db.all("SELECT id FROM ideas WHERE project_id = ? AND status = 'proposed'", id)) decideIdea(idea.id, true, 'auto');
    }
    bus.emit('change', { projectId: id });
  }

  function setStatus(id, status) {
    db.update('projects', id, { status });
    cooldown.delete(id);
    emit(id, 'ceo', status === 'active' ? 'The CEO started the project.' : 'The CEO paused the project. Running work finishes first.');
    tick();
  }

  function deleteProject(id) {
    for (const [agentId, job] of busy) if (job.projectId === id) job.abort.abort();
    db.run('DELETE FROM projects WHERE id = ?', id);
    bus.emit('change', {});
  }

  // ---- ideas and tasks --------------------------------------------------

  function decideIdea(ideaId, approve, by = 'ceo', reason = '') {
    const idea = db.get('SELECT * FROM ideas WHERE id = ?', ideaId);
    if (!idea || idea.status !== 'proposed') throw new Error('This idea is already decided.');
    db.update('ideas', ideaId, { status: approve ? 'approved' : 'rejected', decided_by: by, decided_at: now(), reason: reason || null });
    if (approve) {
      const taskId = db.insert('tasks', {
        project_id: idea.project_id,
        idea_id: idea.id,
        title: idea.title,
        spec: [idea.pitch, idea.plan, idea.design ? `## Design spec from the designer\n${idea.design}` : ''].filter(Boolean).join('\n\n'),
        created_at: now(),
        updated_at: now(),
      });
      emit(idea.project_id, 'approve', by === 'ceo' ? `The CEO approved “${idea.title}”.` : `Auto-approved “${idea.title}”.`, { taskId });
    } else {
      emit(idea.project_id, 'reject', `The CEO rejected “${idea.title}”${reason ? `: ${reason}` : '.'}`);
    }
    tick();
  }

  const conversationOf = (projectId, limit = 16) =>
    db.all('SELECT role, text FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?', projectId, limit).reverse();

  /** The CEO says something to the project manager. The manager answers on its next free moment. */
  function tell(projectId, text) {
    const body = String(text || '').trim();
    if (!body) throw new Error('Write a message first.');
    if (!db.get('SELECT id FROM projects WHERE id = ?', projectId)) throw new Error('Project not found.');
    const id = db.insert('messages', { project_id: projectId, role: 'ceo', text: body.slice(0, 8000), ts: now() });
    emit(projectId, 'ceo', `The CEO told the project manager: ${body}`);
    cooldown.delete(projectId);
    tick();
    return id;
  }

  /** The manager answers the CEO and turns the conversation into guidance and work for the team. */
  function chat(project, pm) {
    const upTo = db.get('SELECT MAX(id) AS id FROM messages WHERE project_id = ?', project.id).id;
    const designer = db.get("SELECT id FROM agents WHERE project_id = ? AND role = 'designer'", project.id);
    start({
      project,
      agent: pm,
      kind: 'chat',
      options: {
        prompt: chatPrompt({
          project: seen(project),
          handovers: handoversOf(project.id),
          conversation: conversationOf(project.id),
          pending: db.all("SELECT title FROM ideas WHERE project_id = ? AND status IN ('proposed', 'design')", project.id),
          open: db.all("SELECT title, status FROM tasks WHERE project_id = ? AND status IN ('queued', 'in_progress', 'review', 'changes', 'escalated')", project.id),
          done: db.all("SELECT title FROM tasks WHERE project_id = ? AND status = 'done' ORDER BY id DESC LIMIT 15", project.id),
        }),
        tools: PM_READ_TOOLS,
        allowedTools: PM_READ_TOOLS,
        schema: CHAT_SCHEMA,
        maxTurns: 40,
      },
      onDone(res) {
        const out = res.ok ? (res.structured ?? parseJson(res.result)) : null;
        if (!out?.reply) {
          // Leave the messages unanswered so the manager tries again after the pause.
          cooldown.set(project.id, now() + 2 * 60_000);
          return;
        }
        // Mark the messages answered first: creating tasks below re-enters the scheduler.
        db.run('UPDATE messages SET answered = 1 WHERE project_id = ? AND role = ? AND id <= ?', project.id, 'ceo', upTo);
        const effects = {};
        if (typeof out.memo === 'string' && out.memo.trim() && out.memo.trim() !== project.memo) {
          db.update('projects', project.id, { memo: out.memo.trim().slice(0, 4000) });
          effects.memo = true;
        }
        if (out.withdraw_proposals) {
          const pending = db.all("SELECT id FROM ideas WHERE project_id = ? AND author = 'pm' AND status IN ('proposed', 'design')", project.id);
          for (const idea of pending) {
            db.update('ideas', idea.id, { status: 'rejected', decided_by: 'pm', decided_at: now(), reason: 'Withdrawn by the project manager after talking to the CEO.' });
          }
          if (pending.length) effects.withdrawn = pending.length;
        }
        const tasks = Array.isArray(out.tasks) ? out.tasks.filter((t) => t?.title).slice(0, 4) : [];
        for (const t of tasks) {
          const toDesigner = Boolean(t.needs_design && designer);
          const ideaId = db.insert('ideas', {
            project_id: project.id,
            title: clip(String(t.title), 140),
            pitch: 'Asked for by the CEO in conversation.',
            plan: String(t.plan ?? ''),
            effort: ['S', 'M', 'L'].includes(t.effort) ? t.effort : 'M',
            author: 'ceo',
            status: toDesigner ? 'design' : 'proposed',
            created_at: now(),
          });
          if (!toDesigner) decideIdea(ideaId, true, 'ceo');
        }
        if (tasks.length) effects.tasks = tasks.map((t) => String(t.title));
        db.insert('messages', { project_id: project.id, role: 'pm', text: String(out.reply), effects: JSON.stringify(effects), ts: now() });
        emit(project.id, 'chat', `To the CEO: ${out.reply}`, { agentId: pm.id });
        if (effects.memo) emit(project.id, 'chat', `Briefed the team. Standing guidance:\n${out.memo.trim()}`, { agentId: pm.id });
      },
    });
  }

  /** The CEO hands the team a directive. It skips approval. */
  function addDirective(projectId, { title, plan }) {
    if (!String(title || '').trim()) throw new Error('A directive needs a title.');
    const id = db.insert('ideas', { project_id: projectId, title: title.trim(), plan: String(plan || ''), author: 'ceo', created_at: now() });
    decideIdea(id, true, 'ceo');
  }

  function setTask(task, patch) {
    db.update('tasks', task.id, { ...patch, updated_at: now() });
    bus.emit('change', { projectId: task.project_id });
  }

  /** CEO rulings on escalated or failed tasks. */
  function ruleTask(taskId, action) {
    const task = db.get('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!task) throw new Error('Task not found.');
    if (action === 'accept' && task.status === 'escalated') {
      setTask(task, { status: 'done' });
      if (db.get('SELECT auto_push FROM projects WHERE id = ?', task.project_id)?.auto_push) publish(task.project_id, `“${task.title}”`);
      emit(task.project_id, 'ceo', `The CEO accepted “${task.title}” as it stands.`, { taskId });
    } else if (action === 'retry' && ['escalated', 'failed'].includes(task.status)) {
      setTask(task, { status: task.report ? 'changes' : 'queued', iteration: 0, failures: 0 });
      emit(task.project_id, 'ceo', `The CEO sent “${task.title}” back to the developers.`, { taskId });
    } else if (action === 'cancel' && !['done', 'cancelled'].includes(task.status)) {
      if (task.assignee && busy.get(task.assignee)?.taskId === task.id) busy.get(task.assignee).abort.abort();
      setTask(task, { status: 'cancelled' });
      emit(task.project_id, 'ceo', `The CEO cancelled “${task.title}”.`, { taskId });
    } else {
      throw new Error(`Cannot ${action} a task that is ${task.status}.`);
    }
    tick();
  }

  // ---- runs -------------------------------------------------------------

  const handoversOf = (projectId) => db.all('SELECT * FROM handovers WHERE project_id = ? ORDER BY id DESC', projectId);

  /** Starts one run for an agent and wires bookkeeping around it. */
  function start({ project, agent, task, kind, label, options, onDone }) {
    const abort = new AbortController();
    const runId = db.insert('runs', { project_id: project.id, agent_id: agent?.id ?? null, task_id: task?.id ?? null, kind, started_at: now() });
    const key = agent?.id ?? `run-${runId}`;
    busy.set(key, { kind, taskId: task?.id ?? null, label: label ?? null, projectId: project.id, since: now(), abort });
    bus.emit('change', { projectId: project.id });

    const ctx = { taskId: task?.id, agentId: agent?.id };
    const promise = Promise.resolve(github?.env().catch(() => ({})) ?? {}).then((env) => runner({
      env,
      ...options,
      kind,
      system: rolePrompt(agent?.role),
      cwd: project.workdir,
      model: project.model || undefined,
      signal: abort.signal,
      onEvent(e) {
        if (e.type === 'limits') budget.record(e.info);
        else emit(project.id, e.type, e.text, ctx);
      },
    }))
      .catch((err) => ({ ok: false, error: err.message, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }))
      .then((res) => {
        busy.delete(key);
        db.update('runs', runId, {
          status: res.ok ? 'ok' : res.paused ? 'paused' : 'error',
          cost_usd: res.costUsd || 0,
          input_tokens: res.inputTokens || 0,
          output_tokens: res.outputTokens || 0,
          turns: res.turns || 0,
          session_id: res.sessionId ?? null,
          error: res.ok || res.paused ? null : clip(res.error, 1000),
          ended_at: now(),
        });
        // The project may have been deleted while the run was in flight.
        if (db.get('SELECT id FROM projects WHERE id = ?', project.id)) {
          if (!res.ok && !res.paused) emit(project.id, 'error', `${agent?.name ?? 'Run'} failed: ${res.error}`, ctx);
          if (kind === 'build' && res.denials?.length) recordDenials(db.get('SELECT * FROM projects WHERE id = ?', project.id), agent, task, res.denials);
          onDone(res);
        }
        bus.emit('change', { projectId: project.id });
        tick();
        return res;
      });
    return promise;
  }

  function ideate(project, pm) {
    const count = project.ideas_per_round;
    const designer = db.get("SELECT id FROM agents WHERE project_id = ? AND role = 'designer'", project.id);
    emit(project.id, 'ideate', 'The project manager is reading the repository and drafting proposals.', { agentId: pm.id });
    start({
      project,
      agent: pm,
      kind: 'ideate',
      options: {
        prompt: ideatePrompt({
          project: seen(project),
          handovers: handoversOf(project.id),
          count,
          done: db.all("SELECT title FROM tasks WHERE project_id = ? AND status = 'done' ORDER BY id DESC LIMIT 40", project.id),
          open: db.all(`SELECT title FROM tasks WHERE project_id = ? AND status IN (${OPEN.map(() => '?').join(',')})`, project.id, ...OPEN),
          rejected: db.all("SELECT title, reason FROM ideas WHERE project_id = ? AND status = 'rejected' AND decided_by != 'pm' ORDER BY id DESC LIMIT 30", project.id),
          conversation: conversationOf(project.id, 8),
        }),
        tools: PM_READ_TOOLS,
        allowedTools: PM_READ_TOOLS,
        schema: IDEAS_SCHEMA(count),
        maxTurns: 40,
      },
      onDone(res) {
        const ideas = res.ok ? (res.structured?.ideas ?? parseJson(res.result)?.ideas) : null;
        if (!Array.isArray(ideas) || !ideas.length) {
          if (res.ok) emit(project.id, 'error', 'The project manager returned no usable proposals.', { agentId: pm.id });
          cooldown.set(project.id, now() + 5 * 60_000);
          return;
        }
        const fresh = db.get('SELECT approval FROM projects WHERE id = ?', project.id);
        for (const idea of ideas.slice(0, count)) {
          const id = db.insert('ideas', {
            project_id: project.id,
            title: clip(String(idea.title), 140),
            pitch: String(idea.pitch ?? ''),
            plan: String(idea.plan ?? ''),
            effort: ['S', 'M', 'L'].includes(idea.effort) ? idea.effort : 'M',
            status: idea.needs_design && designer ? 'design' : 'proposed',
            created_at: now(),
          });
          emit(project.id, 'idea', idea.needs_design && designer ? `Proposal: ${idea.title}. Sent to the designer first.` : `Proposal: ${idea.title}`, { agentId: pm.id });
          if (!(idea.needs_design && designer) && fresh.approval === 'auto') decideIdea(id, true, 'auto');
        }
      },
    });
  }

  /** The designer writes the design spec for a proposal before the CEO sees it. */
  function design(project, designer, idea) {
    emit(project.id, 'design', `Designing “${idea.title}”.`, { agentId: designer.id });
    start({
      project,
      agent: designer,
      kind: 'design',
      label: idea.title,
      options: {
        prompt: designPrompt({ project: seen(project), handovers: handoversOf(project.id), idea }),
        tools: DESIGNER_TOOLS,
        allowedTools: DESIGNER_TOOLS,
        maxTurns: 40,
      },
      onDone(res) {
        const current = db.get('SELECT * FROM ideas WHERE id = ?', idea.id);
        if (!current || current.status !== 'design') return;
        // A failed design run must not strand the proposal: it goes to the CEO without a spec.
        const spec = res.ok && res.result ? res.result : null;
        db.update('ideas', idea.id, { status: 'proposed', design: spec });
        if (spec) emit(project.id, 'design', `Design spec ready for “${idea.title}”.`, { agentId: designer.id });
        const fresh = db.get('SELECT approval FROM projects WHERE id = ?', project.id);
        // Work the CEO asked for in conversation is already approved.
        if (current.author === 'ceo') decideIdea(idea.id, true, 'ceo');
        else if (fresh.approval === 'auto') decideIdea(idea.id, true, 'auto');
      },
    });
  }

  function build(project, dev, task, peers) {
    const revision = task.status === 'changes';
    const resume = revision && task.session_id && task.assignee === dev.id ? task.session_id : undefined;
    const continuing = task.resume_note; // set when the CEO has just ruled on a blocked command
    const fresh = () => buildPrompt({ project: seen(project), handovers: handoversOf(project.id), task, peers });
    const prompt = continuing
      ? resume ? continuePrompt({ task }) : `${fresh()}\n\n## Decision from the CEO on blocked commands\n${continuing}`
      : resume ? revisePrompt({ task }) : fresh() + (revision && task.review_notes ? `\n\n## Review notes from the previous round\n${task.review_notes}` : '');
    setTask(task, { status: 'in_progress', assignee: dev.id, resume_note: null });
    emit(project.id, 'assign', continuing ? `PM → ${dev.name}: continue “${task.title}”. ${continuing}` : revision ? `PM → ${dev.name}: revise “${task.title}”.\n${task.review_notes ?? ''}` : `PM → ${dev.name}: build “${task.title}”.`, { taskId: task.id, agentId: dev.id });
    start({
      project,
      agent: dev,
      task,
      kind: 'build',
      options: {
        prompt,
        resume,
        permissionMode: modeOf(project),
        allowedTools: toolsOf(project).join(','),
        maxTurns: project.max_turns,
        // A refused command stops the run on the spot. The CEO is asked, and the session resumes with the answer.
        onDenial(denial) {
          const now_ = db.get('SELECT * FROM projects WHERE id = ?', project.id);
          if (!now_ || !needsDecision(now_, denial)) return false;
          recordDenials(now_, dev, task, [denial]);
          return true;
        },
      },
      onDone(res) {
        const current = db.get('SELECT * FROM tasks WHERE id = ?', task.id);
        if (!current || current.status !== 'in_progress') return; // cancelled meanwhile
        if (res.paused) {
          const waiting = db.all("SELECT rule FROM permission_requests WHERE task_id = ? AND status = 'pending'", task.id).map((r) => r.rule);
          setTask(current, { status: 'blocked', session_id: res.sessionId ?? current.session_id });
          emit(project.id, 'report', `${dev.name} → PM: I stopped. I need the CEO's permission for ${waiting.join(', ') || 'a command'} and will continue once it is decided.`, { taskId: task.id, agentId: dev.id });
          return;
        }
        if (res.ok) {
          setTask(current, { status: 'review', report: res.result || '(no report)', session_id: res.sessionId ?? current.session_id, failures: 0 });
          emit(project.id, 'report', `${dev.name} → PM: ${res.result || '(no report)'}`, { taskId: task.id, agentId: dev.id });
        } else {
          const failures = current.failures + 1;
          // A failed resume often means the session is gone: drop it so the retry starts clean.
          setTask(current, { status: failures >= 2 ? 'failed' : revision ? 'changes' : 'queued', failures, session_id: resume ? null : current.session_id, resume_note: continuing ?? null });
          if (failures >= 2) emit(project.id, 'error', `“${task.title}” failed twice and waits for the CEO.`, { taskId: task.id });
        }
      },
    });
  }

  function review(project, pm, task) {
    start({
      project,
      agent: pm,
      task,
      kind: 'review',
      options: {
        prompt: reviewPrompt({ project: seen(project), handovers: handoversOf(project.id), task }),
        tools: 'Read,Glob,Grep,Bash',
        allowedTools: PM_REVIEW_ALLOWED,
        schema: REVIEW_SCHEMA,
        maxTurns: 40,
      },
      onDone(res) {
        const current = db.get('SELECT * FROM tasks WHERE id = ?', task.id);
        if (!current || current.status !== 'review') return;
        const verdict = res.ok ? (res.structured ?? parseJson(res.result)) : null;
        if (!verdict?.verdict) {
          cooldown.set(project.id, now() + 5 * 60_000);
          return;
        }
        const notes = String(verdict.notes ?? '');
        if (verdict.verdict === 'approve') {
          setTask(current, { status: 'done', review_notes: notes });
          if (project.auto_push) publish(project.id, `“${task.title}”`);
          emit(project.id, 'review', `PM approved “${task.title}”. ${notes}`, { taskId: task.id, agentId: pm.id });
        } else if (current.iteration + 1 >= project.max_iterations) {
          setTask(current, { status: 'escalated', review_notes: notes, iteration: current.iteration + 1 });
          emit(project.id, 'review', `PM escalated “${task.title}” to the CEO after ${current.iteration + 1} review rounds. ${notes}`, { taskId: task.id, agentId: pm.id });
        } else {
          setTask(current, { status: 'changes', review_notes: notes, iteration: current.iteration + 1 });
          emit(project.id, 'review', `PM sent “${task.title}” back. ${notes}`, { taskId: task.id, agentId: pm.id });
        }
      },
    });
  }

  /** Summarises a transcript into a handover brief. Counts against the budget like any run. */
  function summarize(project, title, transcript) {
    const gate = budget.gate();
    if (!gate.ok) return Promise.resolve({ ok: false, error: gate.reason });
    return start({
      project,
      kind: 'summarize',
      options: { prompt: summarizePrompt({ title, transcript }), tools: '', maxTurns: 3 },
      onDone() {},
    });
  }

  // ---- scheduling -------------------------------------------------------

  function shouldIdeate(project, devCount) {
    if ((cooldown.get(project.id) ?? 0) > now()) return false;
    if (db.get("SELECT COUNT(*) AS n FROM ideas WHERE project_id = ? AND status IN ('proposed', 'design')", project.id).n > 0) return false;
    const waiting = db.get("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('queued', 'changes')", project.id).n;
    const active = db.get("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status IN ('in_progress', 'review')", project.id).n;
    if (waiting > 0 || active >= devCount) return false;
    if (project.daily_task_cap > 0) {
      const midnight = new Date(now());
      midnight.setHours(0, 0, 0, 0);
      const today = db.get('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND created_at >= ?', project.id, midnight.getTime()).n;
      if (today >= project.daily_task_cap) return false;
    }
    return true;
  }

  function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const gate = budget.gate();
      if (!gate.ok) return;
      const slots = () => budget.config().maxParallel - busy.size;
      // A message from the CEO comes before everything else, and is answered even while a project is paused.
      for (const row of db.all("SELECT DISTINCT project_id FROM messages WHERE role = 'ceo' AND answered = 0")) {
        if (slots() <= 0) break;
        if ((cooldown.get(row.project_id) ?? 0) > now()) continue;
        const project = db.get('SELECT * FROM projects WHERE id = ?', row.project_id);
        const pm = db.get("SELECT * FROM agents WHERE project_id = ? AND role = 'pm'", row.project_id);
        if (project && pm && !busy.has(pm.id)) chat(project, pm);
      }
      for (const project of db.all("SELECT * FROM projects WHERE status = 'active' ORDER BY id")) {
        if (slots() <= 0) break;
        const agents = db.all('SELECT * FROM agents WHERE project_id = ? ORDER BY id', project.id);
        const pm = agents.find((a) => a.role === 'pm');
        const devs = agents.filter((a) => a.role === 'dev');

        if ((cooldown.get(project.id) ?? 0) <= now() && !busy.has(pm.id)) {
          const inReview = db.get("SELECT * FROM tasks WHERE project_id = ? AND status = 'review' ORDER BY updated_at LIMIT 1", project.id);
          if (inReview) review(project, pm, inReview);
          else if (shouldIdeate(project, devs.length)) ideate(project, pm);
        }
        const designer = agents.find((a) => a.role === 'designer');
        if (designer && slots() > 0 && !busy.has(designer.id)) {
          const waiting = db.get("SELECT * FROM ideas WHERE project_id = ? AND status = 'design' ORDER BY id LIMIT 1", project.id);
          if (waiting) design(project, designer, waiting);
        }
        for (const dev of devs) {
          if (slots() <= 0) break;
          if (busy.has(dev.id)) continue;
          // A revision goes back to the developer who wrote the code. A new task goes to anyone free.
          const task =
            db.get("SELECT * FROM tasks WHERE project_id = ? AND status = 'changes' AND (assignee = ? OR assignee IS NULL) ORDER BY id LIMIT 1", project.id, dev.id) ??
            db.get("SELECT * FROM tasks WHERE project_id = ? AND status = 'queued' ORDER BY id LIMIT 1", project.id);
          if (task) build(project, dev, task, devs.length > 1);
        }
      }
    } finally {
      ticking = false;
    }
  }

  /** Work that was mid-flight when the server stopped goes back in the queue. */
  function recover() {
    for (const p of db.all('SELECT id, workdir FROM projects')) refreshRepo(p);
    db.run("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'", now());
    db.run("UPDATE tasks SET status = CASE WHEN report IS NULL THEN 'queued' ELSE 'changes' END WHERE status = 'in_progress'");
    // Projects founded before the designer role existed get one now.
    for (const p of db.all("SELECT id FROM projects WHERE id NOT IN (SELECT project_id FROM agents WHERE role = 'designer')")) {
      db.insert('agents', { project_id: p.id, role: 'designer', name: 'Designer' });
    }
  }

  return {
    createProject, updateProject, setStatus, deleteProject,
    publish, refreshRepo,
    decideIdea, addDirective, ruleTask, summarize, tell, decidePermission, allowAll, addRules, toolsOf, ownTools, inherited, modeOf,
    tick, recover,
    busy: () => busy,
  };
}

function parseJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  try {
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}
