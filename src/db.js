import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  workdir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paused',          -- active | paused
  approval TEXT NOT NULL DEFAULT 'ceo',           -- ceo | auto
  ideas_per_round INTEGER NOT NULL DEFAULT 3,
  max_iterations INTEGER NOT NULL DEFAULT 2,      -- review rounds before a task escalates to the CEO
  max_turns INTEGER NOT NULL DEFAULT 40,          -- agent turns per developer run
  daily_task_cap INTEGER NOT NULL DEFAULT 10,     -- 0 = no cap
  permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
  allowed_tools TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                             -- pm | designer | dev
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pitch TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT 'M',
  author TEXT NOT NULL DEFAULT 'pm',              -- pm | ceo
  design TEXT,                                    -- design spec written by the designer
  status TEXT NOT NULL DEFAULT 'proposed',        -- design | proposed | approved | rejected
  decided_by TEXT,                                -- ceo | auto
  reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',          -- queued | in_progress | blocked | review | changes | escalated | done | failed | cancelled
  assignee INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  iteration INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  report TEXT,
  review_notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  agent_id INTEGER,
  task_id INTEGER,
  kind TEXT NOT NULL,                             -- ideate | chat | design | build | review | summarize
  status TEXT NOT NULL DEFAULT 'running',         -- running | ok | error | interrupted
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  task_id INTEGER,
  agent_id INTEGER,
  type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, id);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                           -- claude-ai | note
  external_id TEXT,
  title TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  messages TEXT NOT NULL                          -- JSON [{role, text, ts}]
);
CREATE UNIQUE INDEX IF NOT EXISTS chats_external ON chats(source, external_id);

CREATE TABLE IF NOT EXISTS permission_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id INTEGER,
  agent_id INTEGER,
  rule TEXT NOT NULL,                             -- e.g. Bash(python3 *)
  example TEXT NOT NULL DEFAULT '',               -- the call that was denied
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | allowed | ignored
  ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS permission_rule ON permission_requests(project_id, rule);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                             -- ceo | pm
  text TEXT NOT NULL,
  effects TEXT,                                   -- JSON: what the manager did as a result
  answered INTEGER NOT NULL DEFAULT 0,            -- for CEO messages: has the manager replied
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  summarized INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const raw = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'corp.db'));
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA);
  // Databases created before the designer joined lack this column.
  if (!raw.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'memo')) raw.exec("ALTER TABLE projects ADD COLUMN memo TEXT NOT NULL DEFAULT ''");
  if (!raw.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'inherit_claude')) raw.exec('ALTER TABLE projects ADD COLUMN inherit_claude INTEGER NOT NULL DEFAULT 1');
  if (!raw.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'auto_push')) raw.exec('ALTER TABLE projects ADD COLUMN auto_push INTEGER NOT NULL DEFAULT 1');
  if (!raw.prepare('PRAGMA table_info(tasks)').all().some((c) => c.name === 'resume_note')) raw.exec('ALTER TABLE tasks ADD COLUMN resume_note TEXT');
  if (!raw.prepare('PRAGMA table_info(ideas)').all().some((c) => c.name === 'design')) raw.exec('ALTER TABLE ideas ADD COLUMN design TEXT');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = raw.prepare(sql)));
    return s;
  };

  const db = {
    raw,
    all: (sql, ...p) => stmt(sql).all(...p),
    get: (sql, ...p) => stmt(sql).get(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    insert(table, row) {
      const keys = Object.keys(row);
      const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
      return Number(stmt(sql).run(...keys.map((k) => row[k])).lastInsertRowid);
    },
    update(table, id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return;
      stmt(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...keys.map((k) => patch[k]),
        id,
      );
    },
    setting(key, fallback) {
      const row = stmt('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : fallback;
    },
    setSetting(key, value) {
      stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        JSON.stringify(value),
      );
    },
  };
  return db;
}
