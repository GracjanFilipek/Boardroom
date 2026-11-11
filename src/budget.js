/**
 * Budget gate. Every headless run reports how full your subscription windows are
 * (5-hour and weekly). The gate compares those readings with the limits the CEO set
 * and tells the orchestrator whether agents may start another run.
 */

export const DEFAULT_BUDGET = {
  window: 'five_hour', // five_hour | seven_day
  sharePct: 10,        // agents may burn this many percentage points of the window, 0 = off
  ceilingPct: 80,      // agents stop once the window is this full, whoever filled it, 0 = off
  dailyUsd: 0,         // cap on API-equivalent cost per day, 0 = off
  maxParallel: 2,      // concurrent runs across the company
};

export const WINDOW_LABEL = { five_hour: '5-hour', seven_day: 'weekly' };

export function createBudget(db, now = () => Date.now()) {
  const config = () => ({ ...DEFAULT_BUDGET, ...db.setting('budget', {}) });

  function setConfig(patch) {
    const next = { ...config() };
    if (patch.window in WINDOW_LABEL) next.window = patch.window;
    for (const key of ['sharePct', 'ceilingPct']) {
      if (patch[key] !== undefined) next[key] = clamp(Number(patch[key]) || 0, 0, 100);
    }
    if (patch.dailyUsd !== undefined) next.dailyUsd = Math.max(0, Number(patch.dailyUsd) || 0);
    if (patch.maxParallel !== undefined) next.maxParallel = clamp(Math.round(Number(patch.maxParallel) || 1), 1, 8);
    db.setSetting('budget', next);
    return next;
  }

  /** Store a rate-limit reading from the CLI. */
  function record(info) {
    const windows = info?.unifiedWindows;
    if (!windows) return;
    const limits = db.setting('limits', {});
    const baseline = db.setting('baseline', {});
    for (const name of Object.keys(WINDOW_LABEL)) {
      const w = windows[name];
      if (!w || typeof w.utilization !== 'number') continue;
      limits[name] = { utilization: w.utilization, resetsAt: w.resetsAt, status: w.status ?? 'allowed' };
      // A new resetsAt means a fresh window: remember where the agents started in it.
      if (baseline[name]?.resetsAt !== w.resetsAt) baseline[name] = { resetsAt: w.resetsAt, utilization: w.utilization };
    }
    db.setSetting('limits', limits);
    db.setSetting('baseline', baseline);
  }

  function spentToday() {
    const midnight = new Date(now());
    midnight.setHours(0, 0, 0, 0);
    return db.get('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS runs FROM runs WHERE started_at >= ?', midnight.getTime());
  }

  /** Live windows only: a window whose reset time passed counts as unknown. */
  function windows() {
    const limits = db.setting('limits', {});
    const baseline = db.setting('baseline', {});
    const out = {};
    for (const name of Object.keys(WINDOW_LABEL)) {
      const w = limits[name];
      if (!w || w.resetsAt * 1000 <= now()) continue;
      const start = baseline[name]?.resetsAt === w.resetsAt ? baseline[name].utilization : w.utilization;
      out[name] = {
        usedPct: round(w.utilization * 100),
        agentsPct: round(Math.max(0, w.utilization - start) * 100),
        resetsAt: w.resetsAt * 1000,
        status: w.status,
      };
    }
    return out;
  }

  /** @returns {{ok: boolean, reason?: string, until?: number}} */
  function gate() {
    const cfg = config();
    const live = windows();
    for (const [name, w] of Object.entries(live)) {
      if (w.status === 'rejected') return { ok: false, reason: `Your ${WINDOW_LABEL[name]} limit is exhausted.`, until: w.resetsAt };
    }
    const w = live[cfg.window];
    if (w) {
      const label = WINDOW_LABEL[cfg.window];
      if (cfg.sharePct > 0 && w.agentsPct >= cfg.sharePct) {
        return { ok: false, reason: `Agents used their ${cfg.sharePct}% share of the ${label} window.`, until: w.resetsAt };
      }
      if (cfg.ceilingPct > 0 && w.usedPct >= cfg.ceilingPct) {
        return { ok: false, reason: `The ${label} window is ${w.usedPct}% full. Agents stop at ${cfg.ceilingPct}%.`, until: w.resetsAt };
      }
    }
    if (cfg.dailyUsd > 0 && spentToday().usd >= cfg.dailyUsd) {
      const tomorrow = new Date(now());
      tomorrow.setHours(24, 0, 0, 0);
      return { ok: false, reason: `Agents reached today's $${cfg.dailyUsd} cost cap.`, until: tomorrow.getTime() };
    }
    return { ok: true };
  }

  return { config, setConfig, record, windows, gate, spentToday };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n) => Math.round(n * 10) / 10;
