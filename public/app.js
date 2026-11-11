import { openSheet } from './motion.js';

// ---- tiny DOM toolkit -------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) (el._on ??= {})[k] = el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Syncs `a` to look like `b` in place, so running animations, scroll and focus survive a refresh. */
function morph(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return a.replaceWith(b);
  if (a.nodeType === Node.TEXT_NODE) {
    if (a.data !== b.data) a.data = b.data;
    return;
  }
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && !(name === 'open' && a.nodeName === 'DETAILS')) a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  for (const k in a._on ?? {}) a[k] = null;
  for (const k in b._on ?? {}) a[k] = b._on[k];
  a._on = b._on;
  const ac = [...a.childNodes];
  const bc = [...b.childNodes];
  bc.forEach((child, i) => (ac[i] ? morph(ac[i], child) : a.append(child)));
  ac.slice(bc.length).forEach((n) => n.remove());
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

/** Runs a mutation, reports a failure, then pulls fresh state. */
async function act(fn) {
  try {
    await fn();
  } catch (err) {
    toast(err.message);
  }
  await refresh();
}

const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const clock = (ts) => new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const usd = (n) => `$${n.toFixed(2)}`;

// ---- state ------------------------------------------------------------------

const S = { state: null, detail: null, sessions: null, query: '', showTools: false, expanded: new Set() };

function route() {
  const m = location.hash.match(/^#\/p\/(\d+)/);
  if (m) return { name: 'project', id: +m[1] };
  if (location.hash.startsWith('#/archive')) return { name: 'archive' };
  return { name: 'board' };
}

let inflight = false;
let dirty = false;
async function refresh() {
  if (inflight) return void (dirty = true);
  inflight = true;
  try {
    S.state = await api('GET', '/api/state');
    const r = route();
    if (r.name === 'project') {
      try {
        S.detail = await api('GET', `/api/projects/${r.id}`);
      } catch {
        S.detail = null;
        location.hash = '#/';
      }
    }
    if (r.name === 'archive' && !S.sessions) S.sessions = (await api('GET', '/api/history')).sessions;
    render();
  } catch (err) {
    console.error(err);
  } finally {
    inflight = false;
    if (dirty) {
      dirty = false;
      refresh();
    }
  }
}

function render() {
  if (!S.state) return;
  const r = route();
  const view = r.name === 'project' ? (S.detail ? projectView() : h('div')) : r.name === 'archive' ? archiveView() : boardView();
  const current = document.getElementById('view').firstElementChild;
  if (current && current.dataset.view === view.dataset.view) morph(current, view);
  else {
    document.getElementById('view').replaceChildren(view);
    scrollTo(0, 0);
  }
  const side = sidebar();
  const nav = document.getElementById('sidebar');
  if (nav.firstElementChild) morph(nav, side);
  else nav.replaceWith(side);
}

// ---- sidebar ----------------------------------------------------------------

function sidebar() {
  const { projects, inbox, budget } = S.state;
  const r = route();
  const link = (href, current, ...kids) => h('a', { class: 'nav-item', href, 'aria-current': current ? 'page' : null }, kids);
  return h('nav', { id: 'sidebar', 'aria-label': 'Company' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('crown')), h('span', null, 'Agent Corp')),
    link('#/', r.name === 'board', icon('board'), h('span', { class: 'grow' }, 'Boardroom'), inbox.length ? h('span', { class: 'badge' }, String(inbox.length)) : null),
    link('#/archive', r.name === 'archive', icon('archive'), h('span', { class: 'grow' }, 'Archive')),
    h('div', { class: 'nav-label' }, 'Projects'),
    projects.map((p) =>
      link(`#/p/${p.id}`, r.name === 'project' && r.id === p.id,
        h('span', { class: `dot ${p.working ? 'busy' : p.status === 'active' ? 'on' : ''}` }),
        h('span', { class: 'grow' }, p.name),
        p.proposed + p.attention ? h('span', { class: 'badge' }, String(p.proposed + p.attention)) : null)),
    h('button', { class: 'nav-item', onclick: () => projectForm() }, icon('plus'), h('span', { class: 'grow' }, 'New project')),
    h('div', { class: 'sidebar-foot' },
      h('button', { class: 'side-gauge', onclick: budgetSheet, 'aria-label': 'Budget' }, gauge(budget, budget.config.window, true)),
      h('div', { class: 'you' }, h('div', { class: 'avatar sm ceo' }, icon('crown')), h('div', null, h('strong', null, 'You'), h('small', null, 'Chief Executive')))),
  );
}

function gauge(budget, name, compact = false) {
  const w = budget.windows[name];
  const label = name === 'five_hour' ? '5-hour limit' : 'Weekly limit';
  const cfg = budget.config;
  const isBudgetWindow = cfg.window === name;
  return h('div', { class: 'gauge' },
    h('div', { class: 'gauge-head' },
      h('span', null, compact ? 'Budget' : label),
      h('span', { class: 'muted' }, w ? (compact ? `agents ${w.agentsPct}% of ${cfg.sharePct || '∞'}%` : `${w.usedPct}% used, agents ${w.agentsPct}%`) : 'no reading yet')),
    h('div', { class: 'gauge-track' },
      h('div', { class: 'gauge-fill', style: `width:${w?.usedPct ?? 0}%` }),
      h('div', { class: 'gauge-fill agents', style: `width:${w?.agentsPct ?? 0}%` }),
      isBudgetWindow && cfg.ceilingPct ? h('div', { class: 'gauge-mark', style: `left:${cfg.ceilingPct}%` }) : null),
    !compact && w ? h('div', { class: 'small muted' }, `Resets ${clock(w.resetsAt)}`) : null,
  );
}

// ---- boardroom ----------------------------------------------------------------

function banners() {
  const { budget, runner } = S.state;
  return [
    !budget.gate.ok && h('div', { class: 'banner' }, icon('gauge'), h('div', null, h('strong', null, 'Agents are on hold. '), budget.gate.reason, budget.gate.until ? ` Work resumes ${clock(budget.gate.until)}.` : '')),
    runner === 'mock' && h('div', { class: 'banner info' }, icon('alert'), h('div', null, h('strong', null, 'Demo runner. '), 'Agents return canned answers and use none of your subscription.')),
  ];
}

function boardView() {
  const { projects, inbox } = S.state;
  return h('div', { 'data-view': 'board' },
    h('h1', { class: 'display' }, 'Boardroom'),
    h('p', { class: 'lede' }, inbox.length ? `${inbox.length} ${inbox.length === 1 ? 'decision waits' : 'decisions wait'} for you.` : 'No decisions wait for you.'),
    banners(),
    h('div', { class: 'section-head' }, h('h2', null, 'Waiting for you')),
    inbox.length
      ? h('div', { class: 'stack' }, inbox.map((item) => (item.kind === 'idea' ? ideaCard(item, true) : attentionCard(item, true))))
      : h('div', { class: 'empty' }, 'Proposals from your project managers and tasks they escalate land here.'),
    h('div', { class: 'section-head' }, h('h2', null, 'Projects'), h('button', { class: 'btn primary', onclick: () => projectForm() }, icon('plus'), 'New project')),
    projects.length
      ? h('div', { class: 'grid' }, projects.map((p) =>
          h('a', { class: 'card project-card', href: `#/p/${p.id}` },
            h('h3', null, h('span', { class: `dot ${p.working ? 'busy' : p.status === 'active' ? 'on' : ''}` }), p.name),
            h('div', { class: 'stats' },
              h('div', null, h('b', null, String(p.proposed)), 'proposals'),
              h('div', null, h('b', null, String(p.open)), 'in work'),
              h('div', null, h('b', null, String(p.done)), 'shipped')),
            h('div', { class: 'actions' },
              h('span', { class: `chip ${p.status === 'active' ? 'green' : ''}` }, p.status === 'active' ? (p.working ? `${p.working} of ${p.headcount} working` : 'Running') : 'Paused'),
              h('span', { class: 'chip' }, p.approval === 'auto' ? 'Autopilot' : 'You approve')))))
      : h('div', { class: 'empty' }, 'Found your first project. A project manager and two developers join it.'),
  );
}

function ideaCard(idea, showProject) {
  const decide = (approve, reason) => (e) => {
    e.target.closest('.idea')?.classList.add('leaving');
    act(() => api('POST', `/api/ideas/${idea.id}/${approve ? 'approve' : 'reject'}`, { reason }));
  };
  return h('article', { class: 'card idea' },
    h('div', { class: 'idea-top' },
      h('div', { class: 'avatar sm pm' }, icon('idea')),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', null, idea.title),
        h('div', { class: 'actions', style: 'margin-top:.3rem' },
          showProject ? h('span', { class: 'chip blue' }, idea.project_name) : null,
          h('span', { class: 'chip' }, `Effort ${idea.effort}`),
          h('span', { class: 'chip' }, `${ago(idea.created_at)} ago`.replace('now ago', 'just now')))),
    ),
    idea.pitch ? h('p', { class: 'pitch' }, idea.pitch) : null,
    idea.plan ? h('details', null, h('summary', null, 'Work order'), h('div', { class: 'plan' }, idea.plan)) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn good', onclick: decide(true) }, icon('check'), 'Approve'),
      h('button', { class: 'btn bad', onclick: () => rejectSheet(idea) }, icon('x'), 'Reject')),
  );
}

function rejectSheet(idea) {
  const input = h('textarea', { name: 'reason', placeholder: 'Optional. The project manager reads this before the next round.' });
  const sheet = openSheet({
    title: `Reject “${idea.title}”`,
    body: h('label', { class: 'field' }, h('span', null, 'Reason'), input),
    foot: [
      h('button', { class: 'btn', onclick: () => sheet.close() }, 'Keep it'),
      h('button', { class: 'btn bad', onclick: () => { sheet.close(); act(() => api('POST', `/api/ideas/${idea.id}/reject`, { reason: input.value })); } }, 'Reject'),
    ],
  });
}

function attentionCard(task, showProject) {
  const rule = (action) => () => act(() => api('POST', `/api/tasks/${task.id}/${action}`));
  const escalated = task.status === 'escalated';
  return h('article', { class: 'card idea' },
    h('div', { class: 'idea-top' },
      h('div', { class: 'feed-icon err' }, icon('alert')),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', null, task.title),
        h('div', { class: 'actions', style: 'margin-top:.3rem' },
          showProject ? h('span', { class: 'chip blue' }, task.project_name) : null,
          h('span', { class: `chip ${escalated ? 'orange' : 'red'}` }, escalated ? `Escalated after ${task.iteration} review rounds` : 'Failed twice')))),
    task.review_notes && escalated ? h('p', { class: 'pitch' }, `Project manager: ${task.review_notes}`) : null,
    h('div', { class: 'actions' },
      escalated ? h('button', { class: 'btn good', onclick: rule('accept') }, icon('check'), 'Accept the work') : null,
      h('button', { class: 'btn', onclick: rule('retry') }, icon('back'), 'Send back'),
      h('button', { class: 'btn bad', onclick: rule('cancel') }, 'Cancel task'),
      h('button', { class: 'btn ghost', onclick: () => taskSheet(task.id) }, 'Details')),
  );
}

// ---- project ----------------------------------------------------------------

function projectView() {
  const { project: p, agents, ideas, tasks, events, handovers, spend } = S.detail;
  const pm = agents.find((a) => a.role === 'pm');
  const devs = agents.filter((a) => a.role === 'dev');
  const active = p.status === 'active';
  const proposed = ideas.filter((i) => i.status === 'proposed');
  const attention = tasks.filter((t) => ['escalated', 'failed'].includes(t.status));
  const taskTitle = (id) => tasks.find((t) => t.id === id)?.title ?? 'a task';
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const doing = (a) => {
    if (a.job?.kind === 'ideate') return ['Drafting proposals', true];
    if (a.job?.kind === 'review') return [`Reviewing “${taskTitle(a.job.taskId)}”`, true];
    if (a.job?.kind === 'build') return [`Building “${taskTitle(a.job.taskId)}”`, true];
    if (!active) return ['Off the clock', false];
    if (a.role === 'pm' && proposed.length) return ['Waiting for your decision', false];
    return ['Idle', false];
  };
  const node = (kind, iconName, name, role, status) =>
    h('div', { class: 'org-node' },
      h('div', { class: `avatar ${kind}${status?.[1] ? ' busy' : ''}` }, icon(iconName)),
      h('strong', null, name),
      h('span', { class: 'role' }, role),
      status ? h('span', { class: `doing${status[1] ? ' live' : ''}` }, status[0]) : null);
  const setApproval = (mode) => () => act(() => api('PATCH', `/api/projects/${p.id}`, { approval: mode }));

  const lanes = [
    ['Queued', tasks.filter((t) => ['queued', 'changes'].includes(t.status)).reverse()],
    ['Building', tasks.filter((t) => t.status === 'in_progress')],
    ['In review', tasks.filter((t) => t.status === 'review')],
    ['Shipped', tasks.filter((t) => t.status === 'done').slice(0, 8)],
  ];
  const shown = events.filter((e) => S.showTools || e.type !== 'tool').slice(0, 60);

  return h('div', { 'data-view': `project-${p.id}` },
    h('div', { class: 'actions', style: 'justify-content:space-between;align-items:flex-start' },
      h('div', { style: 'min-width:0;flex:1 1 20rem' },
        h('h1', { class: 'display' }, p.name),
        h('p', { class: 'lede' }, p.brief ? (p.brief.length > 220 ? `${p.brief.slice(0, 220)}…` : p.brief) : 'No brief yet. Open Settings and tell the project manager what this project is for.')),
      h('div', { class: 'actions' },
        active
          ? h('button', { class: 'btn', onclick: () => act(() => api('POST', `/api/projects/${p.id}/pause`)) }, icon('pause'), 'Pause')
          : h('button', { class: 'btn primary', onclick: () => act(() => api('POST', `/api/projects/${p.id}/start`)) }, icon('play'), 'Start'),
        h('button', { class: 'btn', onclick: () => directiveSheet(p) }, icon('megaphone'), 'Directive'),
        h('button', { class: 'btn icon-only', 'aria-label': 'Project settings', onclick: () => projectForm(p, devs.length) }, icon('sliders')))),
    banners(),

    h('div', { class: 'card org', style: 'margin-top:1.6rem;padding:0' },
      h('div', { class: 'org' }, h('div', { class: 'org-inner' },
        node('ceo', 'crown', 'You', 'Chief Executive'),
        h('div', { class: 'org-link' },
          h('div', { class: 'org-stem' }),
          h('div', { class: 'seg', role: 'group', 'aria-label': 'Who approves proposals' },
            h('button', { 'aria-pressed': String(p.approval === 'ceo'), onclick: setApproval('ceo') }, 'You approve'),
            h('button', { 'aria-pressed': String(p.approval === 'auto'), onclick: setApproval('auto') }, 'Autopilot')),
          h('div', { class: 'org-stem' })),
        node('pm', 'pm', pm.name, 'Runs the roadmap', doing(pm)),
        h('div', { class: 'org-stem' }),
        h('div', { class: 'org-children' }, devs.map((d) => h('div', { class: 'org-child' }, node('dev', 'dev', d.name, 'Developer', doing(d)))))))),
    h('p', { class: 'small muted', style: 'margin-top:.6rem' },
      `${spend.runs} runs so far, worth ${usd(spend.usd)} at API prices. `,
      h('span', { class: 'mono' }, p.workdir)),

    h('div', { class: 'section-head' }, h('h2', null, 'Waiting for you', h('span', { class: 'count' }, String(proposed.length + attention.length)))),
    proposed.length + attention.length
      ? h('div', { class: 'stack' }, attention.map((t) => attentionCard(t)), proposed.map((i) => ideaCard(i)))
      : h('div', { class: 'empty' }, p.approval === 'auto' ? 'Autopilot is on. Proposals go straight to the developers.' : active ? 'The project manager will bring proposals here.' : 'Start the project and the project manager drafts the first proposals.'),

    h('div', { class: 'section-head' }, h('h2', null, 'Pipeline')),
    h('div', { class: 'pipeline' }, lanes.map(([name, list]) =>
      h('div', { class: 'lane' },
        h('h3', null, name, h('span', null, String(list.length))),
        list.map((t) => {
          const who = agentById.get(t.assignee);
          return h('button', { class: 'ticket', onclick: () => taskSheet(t.id) },
            t.title,
            h('span', { class: 'ticket-meta' },
              who ? [h('span', { class: 'dot on' }), who.name] : 'Unassigned',
              t.status === 'changes' ? h('span', { class: 'chip orange' }, 'Revise') : null,
              t.iteration > 0 ? h('span', { class: 'chip' }, `Round ${t.iteration + 1}`) : null));
        })))),

    h('div', { class: 'section-head' },
      h('h2', null, 'Activity'),
      h('div', { class: 'seg' },
        h('button', { 'aria-pressed': String(!S.showTools), onclick: () => { S.showTools = false; render(); } }, 'Messages'),
        h('button', { 'aria-pressed': String(S.showTools), onclick: () => { S.showTools = true; render(); } }, 'With tool calls'))),
    shown.length
      ? h('div', { class: 'card feed', style: 'padding:0' }, shown.map((e) => {
          const role = e.type === 'error' ? 'err' : ['ceo', 'approve', 'reject'].includes(e.type) ? 'ceo' : e.type === 'assign' ? 'pm' : (agentById.get(e.agent_id)?.role ?? 'pm');
          const glyph = { err: 'alert', ceo: 'crown', pm: 'pm', dev: 'dev' }[role];
          const open = S.expanded.has(e.id);
          return h('div', { class: 'feed-item' },
            h('div', { class: `feed-icon ${role}` }, icon(glyph)),
            h('div', { class: `feed-text${e.type === 'tool' ? ' tool' : ''}${open ? ' open' : ''}`, onclick: () => { open ? S.expanded.delete(e.id) : S.expanded.add(e.id); render(); } }, e.text),
            h('div', { class: 'feed-time' }, ago(e.ts)));
        }))
      : h('div', { class: 'empty' }, 'Messages between the project manager and the developers appear here.'),

    h('div', { class: 'section-head' }, h('h2', null, 'Handovers'), h('a', { class: 'btn', href: '#/archive' }, icon('archive'), 'Pick a chat')),
    handovers.length
      ? h('div', { class: 'stack' }, handovers.map((ho) =>
          h('div', { class: 'card idea' },
            h('div', { class: 'idea-top' },
              h('div', { class: 'feed-icon' }, icon('handover')),
              h('div', { style: 'flex:1;min-width:0' }, h('h3', null, ho.title), h('span', { class: 'chip' }, ho.summarized ? 'Brief written by Claude' : 'Raw transcript')),
              h('button', { class: 'btn icon-only', 'aria-label': 'Remove handover', onclick: () => act(() => api('DELETE', `/api/handovers/${ho.id}`)) }, icon('trash'))),
            h('details', null, h('summary', null, 'Read'), h('div', { class: 'plan' }, ho.body)))))
      : h('div', { class: 'empty' }, 'Hand a past chat to this team. The project manager and developers read it before each run.'),
  );
}

function directiveSheet(p) {
  const form = h('form', null,
    h('label', { class: 'field' }, h('span', null, 'What should the team build?'), h('input', { name: 'title', required: true, maxlength: 140, placeholder: 'Add CSV export to the reports page' })),
    h('label', { class: 'field' }, h('span', null, 'Details'), h('textarea', { name: 'plan', placeholder: 'Constraints, files, how you will check the result.' }), h('small', null, 'A directive skips approval and goes to the next free developer.')));
  const submit = () => {
    if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    sheet.close();
    act(() => api('POST', `/api/projects/${p.id}/directives`, body));
  };
  form.onsubmit = (e) => (e.preventDefault(), submit());
  const sheet = openSheet({ title: 'Directive from the CEO', body: form, foot: [h('button', { class: 'btn primary', onclick: submit }, 'Send to the team')] });
}

function projectForm(p, devCount = 2) {
  const v = p ?? { name: '', brief: '', approval: 'ceo', ideas_per_round: 3, max_iterations: 2, max_turns: 40, daily_task_cap: 10, permission_mode: 'acceptEdits', allowed_tools: '', model: '' };
  const select = (name, options, value) => h('select', { name }, options.map(([val, label]) => h('option', { value: val, selected: String(val) === String(value) }, label)));
  const num = (name, value, min, max) => h('input', { name, type: 'number', min, max, value: String(value), inputmode: 'numeric' });
  const form = h('form', null,
    h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { name: 'name', required: true, value: v.name, placeholder: 'Invoice app' })),
    h('label', { class: 'field' }, h('span', null, 'Brief'), h('textarea', { name: 'brief', placeholder: 'What the product does, who uses it, what matters this month.' }, v.brief), h('small', null, 'The project manager plans from this text. Agents read it before each run.')),
    p ? null : h('label', { class: 'field' }, h('span', null, 'Folder'), h('input', { name: 'workdir', placeholder: '~/code/invoice-app' }), h('small', null, 'An existing repository on this machine. Leave empty and Agent Corp creates a fresh git workspace.')),
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', null, 'Who approves proposals'), select('approval', [['ceo', 'You approve each one'], ['auto', 'Autopilot, no approval']], v.approval)),
      h('label', { class: 'field' }, h('span', null, 'Developers'), select('devs', [1, 2, 3, 4, 5, 6].map((n) => [n, String(n)]), devCount))),
    h('h3', null, 'Limits'),
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', null, 'Proposals per round'), num('ideas_per_round', v.ideas_per_round, 1, 8)),
      h('label', { class: 'field' }, h('span', null, 'New tasks per day'), num('daily_task_cap', v.daily_task_cap, 0, 500), h('small', null, '0 removes the cap.')),
      h('label', { class: 'field' }, h('span', null, 'Review rounds'), num('max_iterations', v.max_iterations, 1, 6), h('small', null, 'After this many rejections the task comes to you.')),
      h('label', { class: 'field' }, h('span', null, 'Turns per developer run'), num('max_turns', v.max_turns, 5, 200))),
    h('h3', null, 'Developer permissions'),
    h('label', { class: 'field' }, h('span', null, 'Mode'), select('permission_mode', [['acceptEdits', 'Edit files, run listed commands'], ['bypassPermissions', 'Skip all permission checks']], v.permission_mode),
      h('small', null, 'Skipping checks lets developers run any shell command. Use it only in a sandbox.')),
    h('label', { class: 'field' }, h('span', null, 'Allowed tools'), h('input', { name: 'allowed_tools', value: v.allowed_tools, placeholder: p?.default_tools ?? 'Default: file tools, git, npm test, npm run' }), h('small', null, 'Claude Code permission rules, comma separated. Add your test command here, for example Bash(pytest *).')),
    h('label', { class: 'field' }, h('span', null, 'Model'), h('input', { name: 'model', value: v.model, placeholder: 'Default model of your Claude Code' })),
  );
  const submit = () => {
    if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    act(async () => {
      if (p) await api('PATCH', `/api/projects/${p.id}`, body);
      else location.hash = `#/p/${(await api('POST', '/api/projects', body)).id}`;
      sheet.close();
    });
  };
  form.onsubmit = (e) => (e.preventDefault(), submit());
  const remove = () => {
    if (!confirm(`Delete “${p.name}” with its tasks and history? Files in the project folder stay.`)) return;
    sheet.close();
    act(() => api('DELETE', `/api/projects/${p.id}`));
    location.hash = '#/';
  };
  const sheet = openSheet({
    title: p ? 'Project settings' : 'New project',
    body: form,
    foot: [p ? h('button', { class: 'btn bad', style: 'margin-right:auto', onclick: remove }, 'Delete project') : null, h('button', { class: 'btn primary', onclick: submit }, p ? 'Save' : 'Found project')].filter(Boolean),
  });
}

async function taskSheet(id) {
  let data;
  try {
    data = await api('GET', `/api/tasks/${id}`);
  } catch (err) {
    return toast(err.message);
  }
  const { task, events, runs } = data;
  const label = { queued: 'Queued', in_progress: 'Building', review: 'In review', changes: 'Sent back', escalated: 'Escalated to you', done: 'Shipped', failed: 'Failed', cancelled: 'Cancelled' }[task.status];
  const cost = runs.reduce((sum, r) => sum + r.cost_usd, 0);
  const rule = (action) => () => { sheet.close(); act(() => api('POST', `/api/tasks/${id}/${action}`)); };
  const section = (title, text) => (text ? [h('h3', null, title), h('div', { class: 'plan' }, text)] : null);
  const sheet = openSheet({
    title: task.title,
    wide: true,
    body: h('div', null,
      h('dl', { class: 'kv' },
        h('dt', null, 'Status'), h('dd', null, label),
        h('dt', null, 'Review round'), h('dd', null, String(task.iteration + 1)),
        h('dt', null, 'Runs'), h('dd', null, `${runs.length}, worth ${usd(cost)} at API prices`),
        task.session_id ? [h('dt', null, 'Session'), h('dd', { class: 'mono' }, `claude --resume ${task.session_id}`)] : null),
      section('Work order', task.spec),
      section('Developer report', task.report),
      section('Review notes', task.review_notes),
      events.length ? [h('h3', null, 'Log'), h('div', { class: 'plan mono' }, events.map((e) => `${new Date(e.ts).toLocaleTimeString()}  ${e.text}`).join('\n'))] : null),
    foot: [
      task.status === 'escalated' ? h('button', { class: 'btn good', onclick: rule('accept') }, 'Accept the work') : null,
      ['escalated', 'failed'].includes(task.status) ? h('button', { class: 'btn', onclick: rule('retry') }, 'Send back') : null,
      !['done', 'cancelled'].includes(task.status) ? h('button', { class: 'btn bad', onclick: rule('cancel') }, 'Cancel task') : null,
    ].filter(Boolean),
  });
}

// ---- budget -----------------------------------------------------------------

function budgetSheet() {
  const { budget } = S.state;
  const c = budget.config;
  const num = (name, value, max, step = 1) => h('input', { name, type: 'number', min: 0, max, step, value: String(value), inputmode: 'decimal' });
  const form = h('form', null,
    h('div', { class: 'stack', style: 'margin-bottom:1.4rem' }, gauge(budget, 'five_hour'), gauge(budget, 'seven_day')),
    h('p', { class: 'small muted', style: 'margin-bottom:1.2rem' }, `Grey shows the whole window, blue the part your agents used. Claude Code reports both numbers after each run. Today: ${budget.today.runs} runs, worth ${usd(budget.today.usd)} at API prices.`),
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', null, 'Budget window'),
        h('select', { name: 'window' }, h('option', { value: 'five_hour', selected: c.window === 'five_hour' }, '5-hour limit'), h('option', { value: 'seven_day', selected: c.window === 'seven_day' }, 'Weekly limit'))),
      h('label', { class: 'field' }, h('span', null, 'Agents’ share, %'), num('sharePct', c.sharePct, 100), h('small', null, 'Agents stop after burning this slice of the window. 0 turns it off.')),
      h('label', { class: 'field' }, h('span', null, 'Stop when the window is this full, %'), num('ceilingPct', c.ceilingPct, 100), h('small', null, 'Counts your own usage too, so you keep room to work.')),
      h('label', { class: 'field' }, h('span', null, 'Daily cap, USD at API prices'), num('dailyUsd', c.dailyUsd, 10000, 0.5), h('small', null, '0 turns it off.')),
      h('label', { class: 'field' }, h('span', null, 'Runs in parallel'), num('maxParallel', c.maxParallel, 8))));
  const submit = () => {
    sheet.close();
    act(() => api('PUT', '/api/budget', Object.fromEntries(new FormData(form))));
  };
  form.onsubmit = (e) => (e.preventDefault(), submit());
  const sheet = openSheet({ title: 'Budget', body: form, foot: [h('button', { class: 'btn primary', onclick: submit }, 'Save')] });
}

// ---- archive ----------------------------------------------------------------

const SOURCE = { 'claude-code': ['dev', 'Claude Code'], 'claude-ai': ['chat', 'claude.ai'], note: ['handover', 'Note'] };

function archiveView() {
  const q = S.query.trim().toLowerCase();
  const sessions = (S.sessions ?? []).filter((s) => !q || s.title.toLowerCase().includes(q) || s.where.toLowerCase().includes(q));
  const picker = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: (e) => importFile(e.target.files[0]) });
  return h('div', { 'data-view': 'archive' },
    h('h1', { class: 'display' }, 'Archive'),
    h('p', { class: 'lede' }, 'Claude Code sessions from this machine show up on their own, the desktop app’s Code tab included. Chats from claude.ai arrive through a data export. Open a chat and hand it to a project.'),
    h('div', { class: 'actions', style: 'margin-top:1.4rem' },
      h('input', { class: 'search', type: 'search', placeholder: 'Search titles and folders', 'aria-label': 'Search', value: S.query, oninput: (e) => { S.query = e.target.value; render(); } }),
      h('button', { class: 'btn', onclick: () => picker.click() }, icon('handover'), 'Import claude.ai export'),
      h('button', { class: 'btn', onclick: noteSheet }, icon('plus'), 'Paste a note'),
      picker),
    h('div', { style: 'height:1.2rem' }),
    !S.sessions
      ? h('div', { class: 'empty' }, 'Reading sessions…')
      : sessions.length
        ? h('div', { class: 'card', style: 'padding:0;overflow:hidden' }, sessions.slice(0, 200).map((s) =>
            h('button', { class: 'session', onclick: () => chatSheet(s) },
              h('div', { class: `feed-icon ${s.source === 'claude-code' ? 'dev' : ''}` }, icon(SOURCE[s.source][0])),
              h('div', { style: 'min-width:0' }, h('div', { class: 'session-title' }, s.title), h('div', { class: 'session-where' }, s.where || SOURCE[s.source][1])),
              h('div', { class: 'feed-time' }, ago(s.updatedAt)))))
        : h('div', { class: 'empty' }, q ? 'No chat matches this search.' : 'No chats yet. Run Claude Code on this machine, or import conversations.json from claude.ai (Settings, Privacy, Export data).'),
  );
}

async function reloadSessions() {
  S.sessions = (await api('GET', '/api/history')).sessions;
  render();
}

async function importFile(file) {
  if (!file) return;
  try {
    const res = await fetch('/api/history/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`Imported ${data.imported} ${data.imported === 1 ? 'chat' : 'chats'}.`);
    await reloadSessions();
  } catch (err) {
    toast(err.message || 'Import failed.');
  }
}

function noteSheet() {
  const form = h('form', null,
    h('label', { class: 'field' }, h('span', null, 'Title'), h('input', { name: 'title', placeholder: 'Pricing discussion, March' })),
    h('label', { class: 'field' }, h('span', null, 'Text'), h('textarea', { name: 'text', required: true, style: 'min-height:14rem', placeholder: 'Paste a chat, meeting notes or a spec.' })));
  const submit = async () => {
    if (!form.reportValidity()) return;
    try {
      await api('POST', '/api/history/notes', Object.fromEntries(new FormData(form)));
      sheet.close();
      await reloadSessions();
    } catch (err) {
      toast(err.message);
    }
  };
  form.onsubmit = (e) => (e.preventDefault(), submit());
  const sheet = openSheet({ title: 'Paste a note', body: form, foot: [h('button', { class: 'btn primary', onclick: submit }, 'Save to archive')] });
}

async function chatSheet(s) {
  let chat;
  try {
    chat = await api('GET', `/api/history/chat?source=${encodeURIComponent(s.source)}&id=${encodeURIComponent(s.id)}`);
  } catch (err) {
    return toast(err.message);
  }
  const { projects } = S.state;
  const target = h('select', { 'aria-label': 'Project' }, projects.map((p) => h('option', { value: p.id }, p.name)));
  const summarize = h('input', { type: 'checkbox', checked: true });
  const send = h('button', { class: 'btn primary', disabled: !projects.length, onclick: handOver }, icon('handover'), 'Hand over');
  async function handOver() {
    send.disabled = true;
    send.lastChild.data = summarize.checked ? 'Writing the brief…' : 'Handing over…';
    try {
      await api('POST', `/api/projects/${target.value}/handovers`, { source: s.source, id: s.id, summarize: summarize.checked });
      sheet.close();
      toast('Handed over. The team reads it before the next run.');
      location.hash = `#/p/${target.value}`;
    } catch (err) {
      toast(err.message);
      send.disabled = false;
      send.lastChild.data = 'Hand over';
    }
  }
  const shown = chat.messages.slice(0, 300);
  const sheet = openSheet({
    title: chat.title,
    wide: true,
    body: h('div', null,
      chat.sessionId ? h('p', { class: 'small muted', style: 'margin-bottom:1rem' }, 'Continue this session in a terminal: ', h('span', { class: 'mono' }, `cd ${chat.where || '.'} && claude --resume ${chat.sessionId}`)) : null,
      h('div', { class: 'transcript' }, shown.map((m) =>
        h('div', { class: `msg ${m.role}` }, m.text, m.tools?.length ? h('div', { class: 'msg-tools' }, `tools: ${[...new Set(m.tools)].join(', ')}`) : null))),
      chat.messages.length > shown.length ? h('p', { class: 'small muted', style: 'margin-top:1rem' }, `${chat.messages.length - shown.length} later messages are hidden here. A handover includes them.`) : null),
    foot: [
      s.source !== 'claude-code' ? h('button', { class: 'btn bad', style: 'margin-right:auto', onclick: async () => { await api('DELETE', `/api/history/chat/${s.id}`); sheet.close(); reloadSessions(); } }, 'Delete') : null,
      projects.length ? h('label', { class: 'actions small' }, summarize, 'Claude writes a brief') : h('span', { class: 'small muted' }, 'Found a project first.'),
      projects.length ? target : null,
      send,
    ].filter(Boolean),
  });
}

// ---- boot -------------------------------------------------------------------

addEventListener('hashchange', () => {
  if (route().name === 'archive') S.sessions = null;
  refresh();
});
new EventSource('/api/stream').onmessage = () => refresh();
setInterval(render, 30000); // keeps relative times honest
refresh();
