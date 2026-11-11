import { openSheet } from './motion.js';
import { h, morph, flip, rollNumbers, placePill } from './dom.js';
import { icon, portrait } from './pixels.js';

// ---- helpers ----------------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, glyph = 'alert') {
  const el = h('div', { class: 'toast' }, icon(glyph), message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4100);
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
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const clock = (ts) => new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const hour = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const usd = (n) => `$${n.toFixed(2)}`;
const elapsed = (since) => {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const num = (value, fmt) => h('span', { 'data-num': String(value), 'data-fmt': fmt }, '');
const TILE_COLORS = ['#c2410c', '#1d6f8f', '#3f6b2a', '#8a3d6b', '#5b4bb0', '#9a6a00'];
const monogram = (p, size = '', status = true) =>
  h('span', { class: `mono-tile ${size}`, style: `--c:${TILE_COLORS[p.id % TILE_COLORS.length]}` }, p.name.trim()[0]?.toUpperCase() ?? '?',
    status ? h('i', { class: `status ${p.working ? 'busy' : p.status === 'active' ? 'on' : ''}` }) : null);
const avatar = (role, size = '', busy = false, name = '') =>
  role === 'sys'
    ? h('span', { class: `tile bad ${size}` }, icon('alert'))
    : h('span', { class: `avatar ${size}${busy ? ' busy' : ''}` }, portrait(role, name));
const typing = () => h('span', { class: 'typing' }, h('i'), h('i'), h('i'));
const empty = (glyph, title, text, action) => h('div', { class: 'empty' }, h('div', { class: 'tile' }, icon(glyph)), h('strong', null, title), text ? h('span', null, text) : null, action);

/** Finder on a Mac, File Explorer on Windows. */
const FILES_APP = /Mac/.test(navigator.platform) ? 'Finder' : /Win/.test(navigator.platform) ? 'File Explorer' : '';

/** Asks the system for a folder: through the desktop shell when there is one, otherwise through the local server. */
async function pickFolder() {
  if (window.corp?.pickFolder) return window.corp.pickFolder();
  return (await api('POST', '/api/pick-folder')).path;
}

function revealFolder(project) {
  if (window.corp?.revealFolder) return window.corp.revealFolder(project.workdir);
  return api('POST', `/api/projects/${project.id}/reveal`).catch((err) => toast(err.message));
}

// ---- state ------------------------------------------------------------------

const S = { state: null, detail: null, sessions: null, query: '', detailLevel: false, expanded: new Set() };

function route() {
  const m = location.hash.match(/^#\/p\/(\d+)(?:\/(\w+))?/);
  if (m) return { name: 'project', id: +m[1], tab: ['board', 'activity', 'handovers'].includes(m[2]) ? m[2] : 'overview' };
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
  const view = r.name === 'project' ? (S.detail?.project.id === r.id ? projectView(r) : h('div', { 'data-view': 'loading' })) : r.name === 'archive' ? archiveView() : boardView();
  const host = document.getElementById('view');
  const current = host.firstElementChild;
  if (current && current.dataset.view === view.dataset.view) flip(() => morph(current, view));
  else {
    host.replaceChildren(view);
    scrollTo(0, 0);
  }
  morph(document.getElementById('sidebar'), sidebar(r));
  morph(document.getElementById('topbar'), topbar(r));
  morph(document.getElementById('tabbar'), tabbar(r));
  rollNumbers();
  document.querySelectorAll('.nav, .tabs, .seg').forEach(placePill);
  tickTimers();
}

function tickTimers() {
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = elapsed(Number(el.dataset.since));
}

// ---- shell ------------------------------------------------------------------

/** Ten cells that fill as agents burn through their share. */
function cells(budget, size = '') {
  const w = budget.windows[budget.config.window];
  const share = budget.config.sharePct;
  const fraction = !w ? 0 : share ? Math.min(1, w.agentsPct / share) : w.usedPct / 100;
  const lit = fraction > 0 ? Math.max(1, Math.round(fraction * 10)) : 0;
  return h('div', { class: `cells ${size}${budget.gate.ok ? '' : ' warn'}` }, Array.from({ length: 10 }, (_, i) => h('i', { class: i < lit ? 'on' : null })));
}

function budgetShare(budget) {
  const w = budget.windows[budget.config.window];
  return w ? `${budget.config.sharePct ? w.agentsPct : w.usedPct}%` : '0%';
}

function budgetLine(budget) {
  const w = budget.windows[budget.config.window];
  if (!budget.gate.ok) return `On hold until ${hour(budget.gate.until ?? Date.now())}`;
  if (!w) return 'No reading yet';
  return budget.config.sharePct ? `Agents used ${w.agentsPct}% of ${budget.config.sharePct}%` : `Window ${w.usedPct}% full`;
}

function sidebar(r) {
  const { projects, inbox, budget, runner } = S.state;
  const link = (href, current, ...kids) => h('a', { class: 'nav-item', href, 'aria-current': current ? 'page' : null }, kids);
  return h('nav', { id: 'sidebar', 'aria-label': 'Company' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, icon('crown')),
      h('div', { class: 'brand-name' }, 'Boardroom', h('small', null, runner === 'mock' ? 'Demo mode' : 'Claude headless'))),
    h('button', { class: 'jump', onclick: palette }, icon('search'), h('span', null, 'Jump to…'), h('kbd', null, navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K')),
    h('div', { class: 'nav' },
      h('span', { class: 'pill', 'data-keep-style': true }),
      link('#/', r.name === 'board', icon('board'), h('span', { class: 'grow' }, 'Desk'), inbox.length ? h('span', { class: 'badge' }, String(inbox.length)) : null),
      link('#/archive', r.name === 'archive', icon('archive'), h('span', { class: 'grow' }, 'Archive')),
      h('div', { class: 'nav-label' }, 'Projects'),
      projects.map((p) =>
        link(`#/p/${p.id}`, r.name === 'project' && r.id === p.id, monogram(p), h('span', { class: 'grow' }, p.name),
          p.proposed + p.attention ? h('span', { class: 'badge' }, String(p.proposed + p.attention)) : null)),
      h('button', { class: 'nav-item', onclick: () => projectForm() }, icon('plus'), h('span', { class: 'grow' }, 'New project'))),
    h('div', { class: 'sidebar-foot' },
      h('button', { class: 'budget-card', onclick: budgetSheet }, h('strong', null, 'Budget', h('span', null, budgetShare(budget))), cells(budget), h('small', null, budgetLine(budget))),
      h('div', { class: 'you' }, avatar('ceo', 'sm'), h('div', null, h('strong', null, 'You'), h('small', null, 'Chief Executive')))),
  );
}

function topbar(r) {
  const { stats, budget } = S.state;
  const project = r.name === 'project' ? S.state.projects.find((p) => p.id === r.id) : null;
  const crumbs = project
    ? [h('a', { href: '#/' }, 'Projects'), icon('chevron'), h('strong', null, project.name)]
    : [h('strong', null, r.name === 'archive' ? 'Archive' : 'Desk')];
  const live = !budget.gate.ok
    ? h('span', { class: 'live-pill hold' }, icon('gauge'), 'On hold')
    : stats.working
      ? h('span', { class: 'live-pill on' }, typing(), `${stats.working} ${stats.working === 1 ? 'agent' : 'agents'} working`)
      : h('span', { class: 'live-pill' }, h('span', { class: 'dot' }), 'All quiet');
  return h('header', { id: 'topbar' }, h('div', { class: 'crumbs' }, crumbs), live);
}

function tabbar(r) {
  const { inbox } = S.state;
  return h('nav', { id: 'tabbar', 'aria-label': 'Sections' },
    h('a', { href: '#/', 'aria-current': r.name === 'board' ? 'page' : null }, icon('board'), 'Desk', inbox.length ? h('span', { class: 'badge' }, String(inbox.length)) : null),
    h('button', { onclick: projectsSheet, 'aria-current': r.name === 'project' ? 'page' : null }, icon('grid'), 'Projects'),
    h('a', { href: '#/archive', 'aria-current': r.name === 'archive' ? 'page' : null }, icon('archive'), 'Archive'),
    h('button', { onclick: budgetSheet }, icon('gauge'), 'Budget'));
}

function projectsSheet() {
  const sheet = openSheet({
    title: 'Projects',
    body: h('div', { class: 'stack' },
      S.state.projects.map((p) => h('a', { class: 'nav-item', href: `#/p/${p.id}`, onclick: () => sheet.close() }, monogram(p, 'md'), h('span', { class: 'grow' }, p.name), icon('chevron'))),
      h('button', { class: 'btn primary', onclick: () => { sheet.close(); projectForm(); } }, icon('plus'), 'New project')),
  });
}

function holdBanner() {
  const { gate } = S.state.budget;
  return gate.ok ? null : h('div', { class: 'banner' }, icon('gauge'), h('div', null, h('strong', null, 'Agents are on hold. '), gate.reason, gate.until ? ` Work resumes ${clock(gate.until)}.` : ''));
}

// ---- command palette --------------------------------------------------------

function palette() {
  if (document.querySelector('.palette')) return;
  const { projects } = S.state;
  const go = (hash) => () => (location.hash = hash);
  const commands = [
    { label: 'Desk', glyph: 'board', run: go('#/') },
    { label: 'Archive', glyph: 'archive', run: go('#/archive') },
    ...projects.map((p) => ({ label: p.name, glyph: 'chevron', hint: 'Project', run: go(`#/p/${p.id}`) })),
    { label: 'New project', glyph: 'plus', run: () => projectForm() },
    { label: 'Budget', glyph: 'gauge', run: budgetSheet },
    ...projects.map((p) => p.status === 'active'
      ? { label: `Pause ${p.name}`, glyph: 'pause', run: () => act(() => api('POST', `/api/projects/${p.id}/pause`)) }
      : { label: `Start ${p.name}`, glyph: 'play', run: () => act(() => api('POST', `/api/projects/${p.id}/start`)) }),
  ];
  let matches = commands;
  let index = 0;
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const input = h('input', { placeholder: 'Jump to a project or run a command', 'aria-label': 'Command' });
  const scrim = h('div', { class: 'palette-scrim', onpointerdown: close });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' }, input, list);
  function close() {
    scrim.remove();
    box.remove();
  }
  function paint() {
    list.replaceChildren(...(matches.length
      ? matches.map((c, i) => h('button', { class: 'palette-item', role: 'option', 'aria-selected': String(i === index), onclick: () => { close(); c.run(); }, onpointermove: () => { if (index !== i) { index = i; paint(); } } }, icon(c.glyph), c.label, c.hint ? h('small', null, c.hint) : null))
      : [h('div', { class: 'palette-none' }, 'Nothing matches.')]));
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    matches = commands.filter((c) => c.label.toLowerCase().includes(q));
    index = 0;
    paint();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % Math.max(1, matches.length);
      paint();
    } else if (e.key === 'Enter' && matches[index]) {
      close();
      matches[index].run();
    }
  };
  document.body.append(scrim, box);
  paint();
  input.focus();
}

// ---- boardroom --------------------------------------------------------------

function boardView() {
  const { projects, inbox, stats, budget, feed } = S.state;
  if (!projects.length) {
    return h('div', { 'data-view': 'welcome' },
      h('div', { class: 'card welcome' },
        h('div', { class: 'welcome-art' }, avatar('ceo', 'lg'), avatar('pm', 'lg'), avatar('dev', 'lg', false, 'Ada'), avatar('dev', 'lg', false, 'Linus')),
        h('h2', null, 'Your company has no projects yet'),
        h('p', null, 'Found one and a project manager with two developers joins it. They run on your Claude Code login.'),
        h('div', null, h('button', { class: 'btn primary', style: 'margin-top:.8rem', onclick: () => projectForm() }, icon('plus'), 'Found a project')),
        h('div', { class: 'steps' },
          h('div', { class: 'step' }, h('b', null, '01'), h('strong', null, 'The manager proposes'), 'It reads the repository and drafts work orders.'),
          h('div', { class: 'step' }, h('b', null, '02'), h('strong', null, 'You decide'), 'Approve, reject, or switch on autopilot and step out.'),
          h('div', { class: 'step' }, h('b', null, '03'), h('strong', null, 'Developers ship'), 'They build, the manager reviews, disputes come to you.'))));
  }

  return h('div', { 'data-view': 'board' },
    h('div', null,
      h('h1', { class: 'display' }, 'Desk'),
      h('p', { class: 'lede' }, inbox.length ? `${inbox.length} ${inbox.length === 1 ? 'decision waits' : 'decisions wait'} for you.` : 'No decisions wait for you.'),
      holdBanner()),
    h('div', { class: 'stats-row' },
      h('div', { class: 'stat' }, h('div', { class: 'tile' }, icon('crown')), h('b', null, num(inbox.length)), h('span', null, 'Decisions waiting')),
      h('div', { class: 'stat' }, h('div', { class: 'tile' }, icon('bolt')), h('b', null, num(stats.working), h('small', null, ` / ${stats.headcount}`)), h('span', null, 'Agents working')),
      h('div', { class: 'stat' }, h('div', { class: 'tile' }, icon('box')), h('b', null, num(stats.shippedToday)), h('span', null, 'Shipped today')),
      h('div', { class: 'stat' }, h('div', { class: 'tile' }, icon('gauge')), h('b', null, num(budget.today.usd, 'usd')), h('span', null, `${budget.today.runs} runs today, API prices`))),
    h('div', { class: 'split' },
      h('div', null,
        h('div', { class: 'section-head' }, h('h2', null, 'Waiting for you', inbox.length ? h('span', { class: 'count hot' }, String(inbox.length)) : null)),
        inbox.length
          ? h('div', { class: 'stack' }, inbox.map((item, i) => (item.kind === 'idea' ? ideaCard(item, true, i) : attentionCard(item, true, i))))
          : empty('check', 'Your desk is clear', 'Proposals and escalated tasks land here.')),
      h('div', null,
        h('div', { class: 'section-head' }, h('h2', null, 'Live')),
        feed.length
          ? h('div', { class: 'timeline' }, feed.map((e) => timelineItem(e, { compact: true, project: e.project_name, role: e.role, name: e.agent_name })))
          : empty('clock', 'Nothing yet', 'Start a project to see your agents talk.'))),
    h('div', null,
      h('div', { class: 'section-head' }, h('h2', null, 'Projects'), h('button', { class: 'btn', onclick: () => projectForm() }, icon('plus'), 'New project')),
      h('div', { class: 'grid' }, projects.map((p) => {
        const total = p.done + p.open;
        return h('a', { class: 'card project-card', href: `#/p/${p.id}`, 'data-key': `p${p.id}` },
          h('div', { class: 'project-top' },
            monogram(p, 'md', false),
            h('div', { style: 'min-width:0' }, h('h3', null, p.name), h('small', null, p.status === 'active' ? (p.working ? `${p.working} working now` : 'Running') : 'Paused', ' · ', p.approval === 'auto' ? 'Autopilot' : 'You approve')),
            h('div', { class: 'faces' }, p.agents.slice(0, 6).map((a) => avatar(a.role, 'xs', Boolean(a.job), a.name)))),
          h('div', { class: 'meter' }, h('i', { style: `width:${total ? (p.done / total) * 100 : 0}%` })),
          h('div', { class: 'minis' },
            h('span', null, h('b', null, String(p.proposed)), 'proposed'),
            h('span', null, h('b', null, String(p.open)), 'in work'),
            h('span', null, h('b', null, String(p.done)), 'shipped')));
      }))),
  );
}

function decide(idea, approve, reason) {
  const card = document.querySelector(`[data-key="idea${idea.id}"]`);
  if (card) card.dataset.decided = approve ? 'yes' : 'no';
  act(() => api('POST', `/api/ideas/${idea.id}/${approve ? 'approve' : 'reject'}`, { reason }));
}

function ideaCard(idea, showProject, i = 0) {
  return h('article', { class: 'card decision enter', 'data-key': `idea${idea.id}`, 'data-flip': `idea${idea.id}`, style: `--i:${Math.min(i, 6)}` },
    h('div', { class: 'decision-head' },
      avatar('pm', 'xs'), h('strong', null, 'Project Manager'), 'proposes',
      showProject ? h('span', { class: 'chip accent' }, idea.project_name) : null,
      h('span', { class: 'chip' }, { S: 'Small', M: 'Medium', L: 'Large' }[idea.effort] ?? idea.effort),
      idea.design ? h('span', { class: 'chip' }, 'Designed') : null,
      h('span', null, ago(idea.created_at))),
    h('h3', null, idea.title),
    idea.pitch ? h('p', { class: 'pitch' }, idea.pitch) : null,
    idea.plan ? h('details', null, h('summary', null, icon('chevron'), 'Work order'), h('div', { class: 'plan' }, idea.plan)) : null,
    idea.design ? h('details', null, h('summary', null, icon('chevron'), 'Design spec'), h('div', { class: 'plan' }, idea.design)) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn go', onclick: () => decide(idea, true) }, icon('check'), 'Approve'),
      h('button', { class: 'btn bad', onclick: () => rejectSheet(idea) }, icon('x'), 'Reject')),
    h('div', { class: 'stamp' }),
  );
}

function rejectSheet(idea) {
  const input = h('textarea', { name: 'reason', placeholder: 'Optional. The project manager reads this before the next round.' });
  const sheet = openSheet({
    title: `Reject “${idea.title}”`,
    body: h('label', { class: 'field' }, h('span', null, 'Reason'), input),
    foot: [
      h('button', { class: 'btn quiet', onclick: () => sheet.close() }, 'Keep it'),
      h('button', { class: 'btn bad', onclick: () => { sheet.close(); decide(idea, false, input.value); } }, 'Reject'),
    ],
  });
}

function attentionCard(task, showProject, i = 0) {
  const rule = (action) => () => act(() => api('POST', `/api/tasks/${task.id}/${action}`));
  const escalated = task.status === 'escalated';
  return h('article', { class: 'card decision enter', 'data-key': `task${task.id}`, 'data-flip': `att${task.id}`, style: `--i:${Math.min(i, 6)}` },
    h('div', { class: 'decision-head' },
      avatar('sys', 'xs'),
      h('strong', null, escalated ? 'Escalated to you' : 'Failed twice'),
      showProject ? h('span', { class: 'chip accent' }, task.project_name) : null,
      escalated ? h('span', { class: 'chip orange' }, `${task.iteration} review rounds`) : null),
    h('h3', null, task.title),
    task.review_notes && escalated ? h('p', { class: 'pitch' }, `Project manager: ${task.review_notes}`) : null,
    h('div', { class: 'actions' },
      escalated ? h('button', { class: 'btn go', onclick: rule('accept') }, icon('check'), 'Accept the work') : null,
      h('button', { class: 'btn', onclick: rule('retry') }, icon('back'), 'Send back'),
      h('button', { class: 'btn bad', onclick: rule('cancel') }, 'Cancel task'),
      h('button', { class: 'btn quiet', onclick: () => taskSheet(task.id) }, 'Details')),
  );
}

// ---- timeline ---------------------------------------------------------------

/** Turns a stored event into who said what to whom. */
function speaker(e, role, name) {
  if (e.type === 'error') return { role: 'sys', name: 'System', text: e.text };
  if (e.type === 'ceo' || e.type === 'reject' || (e.type === 'approve' && !e.text.startsWith('Auto'))) return { role: 'ceo', name: 'You', text: e.text.replace(/^The CEO /, '') };
  const assign = e.text.match(/^PM → (.+?): ([\s\S]*)$/);
  if (e.type === 'assign' && assign) return { role: 'pm', name: 'Project Manager', to: assign[1], text: assign[2] };
  const report = e.text.match(/^(.+?) → PM: ([\s\S]*)$/);
  if (e.type === 'report' && report) return { role: 'dev', name: report[1], to: 'Project Manager', text: report[2] };
  if (['ideate', 'idea', 'review', 'approve'].includes(e.type)) return { role: 'pm', name: 'Project Manager', text: e.text.replace(/^(PM|The project manager) /, '') };
  return { role: role ?? 'pm', name: name ?? 'Agent', text: e.text };
}

function timelineItem(e, { compact = false, project, role, name } = {}) {
  const who = speaker(e, role, name);
  const detail = e.type === 'tool' || e.type === 'say';
  const open = S.expanded.has(e.id);
  const text = who.text.charAt(0).toUpperCase() + who.text.slice(1);
  return h('div', { class: `tl-item enter${compact ? ' compact' : ''}`, 'data-key': `e${e.id}`, 'data-flip': `e${e.id}` },
    avatar(who.role, compact ? 'xs' : 'sm', false, who.name),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'tl-head' },
        h('strong', null, who.name),
        who.to ? h('span', { class: 'to' }, `to ${who.to}`) : null,
        project ? h('span', { class: 'chip' }, project) : null,
        h('time', null, ago(e.ts))),
      h('div', { class: `tl-text${detail ? ' detail' : ''}${open ? ' open' : ''}`, onclick: () => { open ? S.expanded.delete(e.id) : S.expanded.add(e.id); render(); } }, text)));
}

// ---- project ----------------------------------------------------------------

function projectView(r) {
  const { project: p, agents, ideas, tasks, events, handovers, spend } = S.detail;
  const summary = S.state.projects.find((x) => x.id === p.id) ?? { ...p, working: 0 };
  const pm = agents.find((a) => a.role === 'pm');
  const designer = agents.find((a) => a.role === 'designer');
  const devs = agents.filter((a) => a.role === 'dev');
  const inDesign = ideas.filter((i) => i.status === 'design');
  const active = p.status === 'active';
  const proposed = ideas.filter((i) => i.status === 'proposed');
  const attention = tasks.filter((t) => ['escalated', 'failed'].includes(t.status));
  const openTasks = tasks.filter((t) => ['queued', 'changes', 'in_progress', 'review'].includes(t.status));
  const taskTitle = (id) => tasks.find((t) => t.id === id)?.title ?? 'a task';
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const messages = events.filter((e) => S.detailLevel || (e.type !== 'tool' && e.type !== 'say'));
  const item = (e, opts) => timelineItem(e, { ...opts, role: agentById.get(e.agent_id)?.role, name: agentById.get(e.agent_id)?.name });

  const node = (role, name, title, a) => {
    const job = a?.job;
    const what = job?.kind === 'ideate' ? 'Drafting proposals' : job?.kind === 'design' ? `Designing “${job.label}”` : job?.kind === 'review' ? `Reviewing “${taskTitle(job.taskId)}”` : job?.kind === 'build' ? `Building “${taskTitle(job.taskId)}”` : '';
    const idle = !a ? null : !active ? 'Off the clock' : a.role === 'pm' && proposed.length ? 'Waiting for you' : 'Idle';
    return h('div', { class: `node${job ? ' live' : ''}` },
      avatar(role, '', Boolean(job), name),
      h('strong', null, name),
      h('span', { class: 'role' }, title),
      a ? h('span', { class: 'doing' }, job ? [typing(), h('span', { 'data-since': String(job.since) }, elapsed(job.since))] : idle) : null,
      a ? h('span', { class: 'what' }, what) : null);
  };
  const setApproval = (mode) => () => act(() => api('PATCH', `/api/projects/${p.id}`, { approval: mode }));
  const tab = (id, label, count, hot) => h('a', { href: `#/p/${p.id}${id === 'overview' ? '' : `/${id}`}`, role: 'tab', 'aria-selected': String(r.tab === id) }, label, count ? h('span', { class: `count${hot ? ' hot' : ''}` }, String(count)) : null);

  const header = h('div', null,
    h('div', { class: 'actions', style: 'justify-content:space-between;align-items:flex-start;gap:1rem' },
      h('div', { style: 'display:flex;gap:1rem;align-items:center;min-width:0;flex:1 1 20rem' },
        monogram(summary, 'lg', false),
        h('div', { style: 'min-width:0' },
          h('h1', { class: 'display', style: 'font-size:clamp(1.5rem,3vw,1.9rem)' }, p.name),
          h('div', { class: 'actions small muted', style: 'margin-top:.35rem;gap:.4rem .7rem' },
            h('span', { class: `chip ${active ? 'green' : ''}` }, h('span', { class: `dot ${active ? (summary.working ? 'busy' : 'on') : ''}` }), active ? 'Running' : 'Paused'),
            h('span', null, num(spend.runs), ' runs'),
            h('span', null, num(spend.usd, 'usd'), ' at API prices')))),
      h('div', { class: 'actions' },
        active
          ? h('button', { class: 'btn', onclick: () => act(() => api('POST', `/api/projects/${p.id}/pause`)) }, icon('pause'), 'Pause')
          : h('button', { class: 'btn primary', onclick: () => act(() => api('POST', `/api/projects/${p.id}/start`)) }, icon('play'), 'Start'),
        h('button', { class: 'btn', onclick: () => directiveSheet(p) }, icon('megaphone'), 'Directive'),
        h('button', { class: 'btn icon-only', 'aria-label': 'Project settings', onclick: () => projectForm(p, devs.length) }, icon('sliders')))),
    h('p', { class: 'lede' }, p.brief ? (p.brief.length > 240 ? `${p.brief.slice(0, 240)}…` : p.brief) : 'No brief yet. Open settings and tell the project manager what this project is for.'),
    holdBanner(),
    h('div', { class: 'tabs', role: 'tablist' },
      h('span', { class: 'pill', 'data-keep-style': true }),
      tab('overview', 'Overview', proposed.length + attention.length, true),
      tab('board', 'Board', openTasks.length),
      tab('activity', 'Activity'),
      tab('handovers', 'Handovers', handovers.length)));

  let body;
  if (r.tab === 'board') {
    const lanes = [
      ['Queued', 'var(--text-3)', tasks.filter((t) => ['queued', 'changes'].includes(t.status)).reverse()],
      ['Building', 'var(--green)', tasks.filter((t) => t.status === 'in_progress')],
      ['In review', 'var(--orange)', tasks.filter((t) => t.status === 'review')],
      ['Shipped', 'var(--ink)', tasks.filter((t) => t.status === 'done').slice(0, 10)],
    ];
    body = h('div', { class: 'pipeline' }, lanes.map(([name, color, list]) =>
      h('div', { class: 'lane' },
        h('div', { class: 'lane-head' }, h('i', { style: `--c:${color}` }), name, h('span', { class: 'count' }, String(list.length))),
        list.length
          ? h('div', { class: 'lane-list' }, list.map((t) => {
              const who = agentById.get(t.assignee);
              const working = t.status === 'in_progress' || (t.status === 'review' && pm.job?.taskId === t.id);
              return h('button', { class: `ticket enter${working ? ' working' : ''}`, 'data-key': `t${t.id}`, 'data-flip': `t${t.id}`, onclick: () => taskSheet(t.id) },
                h('span', { class: 'ticket-id' }, `BR-${t.id}`),
                t.title,
                h('span', { class: 'ticket-meta' },
                  who ? [avatar('dev', 'xs', t.status === 'in_progress', who.name), who.name] : 'Unassigned',
                  h('span', { class: 'push' },
                    t.status === 'changes' ? h('span', { class: 'chip orange' }, 'Revise') : null,
                    t.iteration > 0 ? h('span', { class: 'chip' }, `Round ${t.iteration + 1}`) : null,
                    t.effort ? h('span', { class: 'chip' }, t.effort) : null)));
            }))
          : h('div', { class: 'lane-empty' }, 'Empty'))));
  } else if (r.tab === 'activity') {
    const setLevel = (v) => () => { S.detailLevel = v; render(); };
    body = h('div', null,
      h('div', { class: 'section-head', style: 'margin-top:1.2rem' },
        h('h2', null, 'Conversation'),
        h('div', { class: 'seg' },
          h('span', { class: 'pill', 'data-keep-style': true }),
          h('button', { 'aria-selected': String(!S.detailLevel), onclick: setLevel(false) }, 'Messages'),
          h('button', { 'aria-selected': String(S.detailLevel), onclick: setLevel(true) }, 'With tool calls'))),
      messages.length
        ? h('div', { class: 'card timeline', style: 'padding:.3rem 0' }, messages.slice(0, 80).map((e) => item(e)))
        : empty('chat', 'No messages yet', 'The project manager and the developers talk here.'));
  } else if (r.tab === 'handovers') {
    body = h('div', null,
      h('div', { class: 'section-head', style: 'margin-top:1.2rem' }, h('h2', null, 'Handovers'), h('a', { class: 'btn', href: '#/archive' }, icon('archive'), 'Pick a chat')),
      handovers.length
        ? h('div', { class: 'stack' }, handovers.map((ho) =>
            h('div', { class: 'card decision enter', 'data-key': `ho${ho.id}`, 'data-flip': `ho${ho.id}` },
              h('div', { class: 'decision-head' }, h('span', { class: 'tile xs' }, icon('handover')), h('strong', null, ho.summarized ? 'Brief written by Claude' : 'Raw transcript'), h('span', null, ago(ho.created_at)),
                h('button', { class: 'btn quiet icon-only', style: 'margin-left:auto', 'aria-label': 'Remove handover', onclick: () => act(() => api('DELETE', `/api/handovers/${ho.id}`)) }, icon('trash'))),
              h('h3', null, ho.title),
              h('details', null, h('summary', null, icon('chevron'), 'Read'), h('div', { class: 'plan' }, ho.body)))))
        : empty('handover', 'No handovers', 'Hand a past chat to this team. Agents read it before each run.'));
  } else {
    body = h('div', null,
      h('div', { class: 'card', style: 'margin-top:1.4rem;padding:0' },
        h('div', { class: 'org' }, h('div', { class: 'org-inner' },
          node('ceo', 'You', 'Chief Executive'),
          h('div', { class: 'org-link' },
            h('div', { class: `wire${pm.job ? ' live' : ''}` }),
            h('div', { class: 'seg', role: 'group', 'aria-label': 'Who approves proposals' },
              h('span', { class: 'pill', 'data-keep-style': true }),
              h('button', { 'aria-selected': String(p.approval === 'ceo'), onclick: setApproval('ceo') }, 'You approve'),
              h('button', { 'aria-selected': String(p.approval === 'auto'), onclick: setApproval('auto') }, 'Autopilot')),
            h('div', { class: `wire${pm.job ? ' live' : ''}` })),
          h('div', { class: 'org-pair' },
            h('div'),
            node('pm', pm.name, 'Runs the roadmap', pm),
            designer ? h('div', { class: 'org-side' }, h('div', { class: `hwire${designer.job ? ' live' : ''}` }), node('designer', designer.name, 'Designs with the manager', designer)) : h('div')),
          h('div', { class: `wire${devs.some((d) => d.job) ? ' live' : ''}` }),
          h('div', { class: 'org-children' }, devs.map((d) => h('div', { class: `org-child${d.job ? ' live' : ''}` }, node('dev', d.name, 'Developer', d))))))),
      h('div', { class: 'split' },
        h('div', null,
          h('div', { class: 'section-head' }, h('h2', null, 'Waiting for you', proposed.length + attention.length ? h('span', { class: 'count hot' }, String(proposed.length + attention.length)) : null)),
          proposed.length + attention.length
            ? h('div', { class: 'stack' }, attention.map((t, i) => attentionCard(t, false, i)), proposed.map((idea, i) => ideaCard(idea, false, i)))
            : inDesign.length
              ? empty('idea', `${inDesign.length} ${inDesign.length === 1 ? 'proposal is' : 'proposals are'} with the designer`, 'You see each one once its design spec is written.')
            : p.approval === 'auto'
              ? empty('bolt', 'Autopilot is on', 'Proposals go straight to the developers.')
              : empty('idea', active ? 'No proposals right now' : 'The team is off the clock', active ? 'The project manager brings the next round here.' : 'Start the project and the project manager drafts proposals.')),
        h('div', null,
          h('div', { class: 'section-head' }, h('h2', null, 'Latest'), h('a', { class: 'btn quiet', href: `#/p/${p.id}/activity` }, 'All activity')),
          messages.length ? h('div', { class: 'timeline' }, events.filter((e) => e.type !== 'tool' && e.type !== 'say').slice(0, 7).map((e) => item(e, { compact: true }))) : empty('clock', 'Quiet so far'))),
      h('div', { class: 'actions', style: 'margin-top:2rem' },
        h('span', { class: 'small muted mono', style: 'min-width:0;overflow-wrap:anywhere' }, p.workdir),
        h('button', { class: 'btn quiet', onclick: () => revealFolder(p) }, icon('archive'), FILES_APP ? `Show in ${FILES_APP}` : 'Open folder')));
  }
  return h('div', { 'data-view': `project-${p.id}-${r.tab}` }, header, body);
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
  const sheet = openSheet({ title: 'Directive from the CEO', body: form, foot: [h('button', { class: 'btn primary', onclick: submit }, icon('megaphone'), 'Send to the team')] });
}

function projectForm(p, devCount = 2) {
  const v = p ?? { name: '', brief: '', approval: 'ceo', ideas_per_round: 3, max_iterations: 2, max_turns: 40, daily_task_cap: 10, permission_mode: 'acceptEdits', allowed_tools: '', model: '' };
  const select = (name, options, value) => h('select', { name }, options.map(([val, label]) => h('option', { value: val, selected: String(val) === String(value) }, label)));
  const number = (name, value, min, max) => h('input', { name, type: 'number', min, max, value: String(value), inputmode: 'numeric' });
  const folderInput = h('input', { name: 'workdir', id: 'workdir', placeholder: 'No folder chosen' });
  const choose = async () => {
    try {
      const dir = await pickFolder();
      if (!dir) return;
      folderInput.value = dir;
      // A fresh project usually takes the folder's name.
      const nameInput = form.elements.name;
      if (!nameInput.value.trim()) nameInput.value = dir.split(/[\\/]/).filter(Boolean).pop() ?? '';
    } catch (err) {
      toast(err.message);
    }
  };
  const form = h('form', null,
    h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { name: 'name', required: true, value: v.name, placeholder: 'Invoice app' })),
    h('label', { class: 'field' }, h('span', null, 'Brief'), h('textarea', { name: 'brief', placeholder: 'What the product does, who uses it, what matters this month.' }, v.brief), h('small', null, 'The project manager plans from this text. Agents read it before each run.')),
    p ? null : h('div', { class: 'field' }, h('label', { for: 'workdir' }, h('span', null, 'Folder')),
      h('div', { class: 'pick' }, folderInput, h('button', { class: 'btn', type: 'button', onclick: choose }, icon('archive'), FILES_APP ? `Choose in ${FILES_APP}` : 'Choose folder')),
      h('small', null, 'An existing repository on this machine. Leave empty and Boardroom creates a fresh git workspace.')),
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', null, 'Who approves proposals'), select('approval', [['ceo', 'You approve each one'], ['auto', 'Autopilot, no approval']], v.approval)),
      h('label', { class: 'field' }, h('span', null, 'Developers'), select('devs', [1, 2, 3, 4, 5, 6].map((n) => [n, String(n)]), devCount))),
    h('h3', null, 'Limits'),
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', null, 'Proposals per round'), number('ideas_per_round', v.ideas_per_round, 1, 8)),
      h('label', { class: 'field' }, h('span', null, 'New tasks per day'), number('daily_task_cap', v.daily_task_cap, 0, 500), h('small', null, '0 removes the cap.')),
      h('label', { class: 'field' }, h('span', null, 'Review rounds'), number('max_iterations', v.max_iterations, 1, 6), h('small', null, 'After this many rejections the task comes to you.')),
      h('label', { class: 'field' }, h('span', null, 'Turns per developer run'), number('max_turns', v.max_turns, 5, 200))),
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
  const [label, tone] = { queued: ['Queued', ''], in_progress: ['Building', 'green'], review: ['In review', 'accent'], changes: ['Sent back', 'orange'], escalated: ['Escalated to you', 'orange'], done: ['Shipped', 'green'], failed: ['Failed', 'red'], cancelled: ['Cancelled', ''] }[task.status];
  const cost = runs.reduce((sum, r) => sum + r.cost_usd, 0);
  const rule = (action) => () => { sheet.close(); act(() => api('POST', `/api/tasks/${id}/${action}`)); };
  const section = (title, text) => (text ? [h('h3', null, title), h('div', { class: 'plan' }, text)] : null);
  const sheet = openSheet({
    title: `BR-${task.id}  ${task.title}`,
    wide: true,
    body: h('div', null,
      h('dl', { class: 'kv' },
        h('dt', null, 'Status'), h('dd', null, h('span', { class: `chip ${tone}` }, label)),
        h('dt', null, 'Review round'), h('dd', null, String(task.iteration + 1)),
        h('dt', null, 'Runs'), h('dd', null, `${runs.length}, worth ${usd(cost)} at API prices`),
        task.session_id ? [h('dt', null, 'Session'), h('dd', { class: 'mono' }, `claude --resume ${task.session_id}`)] : null),
      section('Work order', task.spec),
      section('Developer report', task.report),
      section('Review notes', task.review_notes),
      events.length ? [h('h3', null, 'Log'), h('div', { class: 'plan mono' }, events.map((e) => `${new Date(e.ts).toLocaleTimeString()}  ${e.text}`).join('\n'))] : null),
    foot: [
      task.status === 'escalated' ? h('button', { class: 'btn go', onclick: rule('accept') }, 'Accept the work') : null,
      ['escalated', 'failed'].includes(task.status) ? h('button', { class: 'btn', onclick: rule('retry') }, 'Send back') : null,
      !['done', 'cancelled'].includes(task.status) ? h('button', { class: 'btn bad', onclick: rule('cancel') }, 'Cancel task') : null,
    ].filter(Boolean),
  });
}

// ---- budget -----------------------------------------------------------------

function gauge(budget, name) {
  const w = budget.windows[name];
  const cfg = budget.config;
  return h('div', { class: 'gauge' },
    h('div', { class: 'gauge-head' }, h('span', null, name === 'five_hour' ? '5-hour limit' : 'Weekly limit'), h('span', null, w ? `${w.usedPct}% used · resets ${clock(w.resetsAt)}` : 'no reading yet')),
    h('div', { class: 'gauge-track' },
      h('div', { class: 'gauge-fill', style: `width:${w?.usedPct ?? 0}%` }),
      h('div', { class: 'gauge-fill agents', style: `width:${w?.agentsPct ?? 0}%` }),
      cfg.window === name && cfg.ceilingPct ? h('div', { class: 'gauge-mark', style: `left:${cfg.ceilingPct}%` }) : null));
}

function budgetSheet() {
  const { budget } = S.state;
  const c = budget.config;
  const number = (name, value, max, step = 1) => h('input', { name, type: 'number', min: 0, max, step, value: String(value), inputmode: 'decimal' });
  const form = h('form', null,
    h('div', { class: 'budget-hero' },
      h('b', null, budgetShare(budget), c.sharePct ? h('span', null, ` of ${c.sharePct}% share`) : h('span', null, ' of the window')),
      cells(budget, 'lg'),
      h('span', { class: 'small muted' }, `${budgetLine(budget)}. Today: ${budget.today.runs} runs, ${usd(budget.today.usd)} at API prices.`)),
    h('div', { class: 'stack', style: 'margin-bottom:.8rem' }, gauge(budget, 'five_hour'), gauge(budget, 'seven_day')),
    h('p', { class: 'small muted', style: 'margin-bottom:1.4rem' }, 'Grey shows the whole window, black the part your agents used, the red mark the ceiling. Claude Code reports these numbers after each run.'),
    h('div', { class: 'row2' },
      h('label', { class: 'field' }, h('span', null, 'Budget window'),
        h('select', { name: 'window' }, h('option', { value: 'five_hour', selected: c.window === 'five_hour' }, '5-hour limit'), h('option', { value: 'seven_day', selected: c.window === 'seven_day' }, 'Weekly limit'))),
      h('label', { class: 'field' }, h('span', null, 'Agents’ share, %'), number('sharePct', c.sharePct, 100), h('small', null, 'Agents stop after burning this slice of the window. 0 turns it off.')),
      h('label', { class: 'field' }, h('span', null, 'Ceiling, %'), number('ceilingPct', c.ceilingPct, 100), h('small', null, 'Agents stop once the window is this full, your own usage included.')),
      h('label', { class: 'field' }, h('span', null, 'Daily cap, USD at API prices'), number('dailyUsd', c.dailyUsd, 10000, 0.5), h('small', null, '0 turns it off.')),
      h('label', { class: 'field' }, h('span', null, 'Runs in parallel'), number('maxParallel', c.maxParallel, 8))));
  const submit = () => {
    sheet.close();
    act(() => api('PUT', '/api/budget', Object.fromEntries(new FormData(form))));
  };
  form.onsubmit = (e) => (e.preventDefault(), submit());
  const sheet = openSheet({ title: 'Budget', body: form, foot: [h('button', { class: 'btn primary', onclick: submit }, 'Save')] });
}

// ---- archive ----------------------------------------------------------------

const SOURCE = { 'claude-code': ['terminal', 'Claude Code'], 'claude-ai': ['chat', 'claude.ai'], note: ['handover', 'Note'] };

function archiveView() {
  const q = S.query.trim().toLowerCase();
  const sessions = (S.sessions ?? []).filter((s) => !q || s.title.toLowerCase().includes(q) || s.where.toLowerCase().includes(q));
  return h('div', { 'data-view': 'archive' },
    h('div', null,
      h('h1', { class: 'display' }, 'Archive'),
      h('p', { class: 'lede' }, 'Claude Code sessions from this machine show up on their own, the desktop app’s Code tab included. Chats from claude.ai arrive through a data export. Open a chat and hand it to a project.')),
    h('div', { class: 'actions', style: 'margin-top:1.5rem' },
      h('div', { class: 'search-wrap' }, icon('search'), h('input', { class: 'search', type: 'search', placeholder: 'Search titles and folders', 'aria-label': 'Search', value: S.query, oninput: (e) => { S.query = e.target.value; render(); } })),
      h('button', { class: 'btn', onclick: importSheet }, icon('handover'), 'Import from claude.ai'),
      h('button', { class: 'btn', onclick: noteSheet }, icon('plus'), 'Paste a note')),
    h('div', { style: 'margin-top:1.2rem' },
      !S.sessions
        ? empty('clock', 'Reading sessions…')
        : sessions.length
          ? h('div', { class: 'card', style: 'padding:0;overflow:hidden' }, sessions.slice(0, 200).map((s) => {
              const [glyph, label] = SOURCE[s.source];
              return h('button', { class: 'session', 'data-key': `${s.source}:${s.id}`, 'data-flip': `s:${s.source}:${s.id}`, onclick: () => chatSheet(s) },
                h('span', { class: 'tile sm' }, icon(glyph)),
                h('div', { style: 'min-width:0' }, h('div', { class: 'session-title' }, s.title), h('div', { class: 'session-where' }, s.where ? `${label} · ${s.where}` : label)),
                h('time', null, ago(s.updatedAt)));
            }))
          : q
            ? empty('search', 'No chat matches', 'Try a shorter search.')
            : empty('archive', 'No chats yet', 'Run Claude Code on this machine, or import your chats from claude.ai.')),
  );
}

async function reloadSessions() {
  S.sessions = (await api('GET', '/api/history')).sessions;
  render();
}

/** claude.ai chats live on Anthropic's servers, so there is no file to find until you request one. This walks through it. */
function importSheet() {
  const picker = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', hidden: true, onchange: (e) => { sheet.close(); importFile(e.target.files[0]); } });
  const step = (n, title, text) => h('div', { class: 'howto' }, h('b', null, n), h('div', null, h('strong', null, title), h('p', null, text)));
  const sheet = openSheet({
    title: 'Import chats from claude.ai',
    body: h('div', null,
      h('p', { class: 'muted', style: 'margin-bottom:1rem' }, 'Chats from claude.ai and the desktop app’s Chat tab are stored on Anthropic’s servers. No copy exists on this computer until you ask for an export.'),
      step('1', 'Request the export', ['Open ', h('a', { href: 'https://claude.ai/settings/data-privacy-controls', target: '_blank', rel: 'noopener' }, 'claude.ai, Settings, Privacy'), ' and press Export data.']),
      step('2', 'Wait for the email', 'Anthropic emails you a download link, usually within minutes. The link expires after 24 hours.'),
      step('3', 'Download the zip', 'It lands in your Downloads folder with a name that starts with “data-”.'),
      step('4', 'Pick it here', 'Choose the zip as it is. Boardroom reads conversations.json out of it. Nothing leaves this computer.'),
      picker),
    foot: [h('button', { class: 'btn primary', onclick: () => picker.click() }, icon('handover'), 'Choose the export file')],
  });
}

async function importFile(file) {
  if (!file) return;
  try {
    const res = await fetch('/api/history/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`Imported ${data.imported} ${data.imported === 1 ? 'chat' : 'chats'}.`, 'check');
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
  const sendLabel = h('span', null, 'Hand over');
  const send = h('button', { class: 'btn primary', disabled: !projects.length, onclick: handOver }, icon('handover'), sendLabel);
  async function handOver() {
    send.disabled = true;
    sendLabel.replaceChildren(summarize.checked ? 'Writing the brief ' : 'Handing over ', typing());
    try {
      await api('POST', `/api/projects/${target.value}/handovers`, { source: s.source, id: s.id, summarize: summarize.checked });
      sheet.close();
      toast('Handed over. The team reads it before the next run.', 'check');
      location.hash = `#/p/${target.value}/handovers`;
    } catch (err) {
      toast(err.message);
      send.disabled = false;
      sendLabel.textContent = 'Hand over';
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

// The desktop shell passes ?shell=mac or ?shell=desktop so the page can make room for window controls.
const shellKind = new URLSearchParams(location.search).get('shell');
if (shellKind) document.documentElement.dataset.shell = shellKind;

addEventListener('hashchange', () => {
  if (route().name === 'archive') S.sessions = null;
  render(); // paint the navigation at once, data follows
  refresh();
});
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    palette();
  }
});
addEventListener('resize', () => document.querySelectorAll('.nav, .tabs, .seg').forEach(placePill));
new EventSource('/api/stream').onmessage = () => refresh();
setInterval(tickTimers, 1000);
setInterval(render, 30000); // keeps relative times honest
refresh();
