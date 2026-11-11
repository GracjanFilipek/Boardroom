import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Chat archive. Two sources:
 *  - Claude Code sessions (CLI and the desktop app's Code tab) that live on this machine
 *    as JSONL files under ~/.claude/projects. Read live, nothing to import.
 *  - claude.ai chats (the desktop app's Chat tab). Those live on Anthropic's servers, so
 *    they arrive through the official data export (conversations.json) or as pasted notes.
 */

export function createHistory(db, { configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
  const root = path.join(configDir, 'projects');
  const headCache = new Map(); // file -> { mtimeMs, meta }

  function sessionHead(file, stat) {
    const hit = headCache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.meta;
    // The first 96 KB is enough to find the working directory and the opening message.
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, 96 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let cwd = '';
    let title = '';
    for (const line of buf.toString('utf8').split('\n')) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && row.cwd) cwd = row.cwd;
      if (row.type === 'summary' && row.summary) title = row.summary;
      if (!title && row.type === 'user' && !row.isMeta && !row.isSidechain) title = firstLine(textOf(row.message?.content));
      if (cwd && title) break;
    }
    const meta = { cwd, title: title || '(untitled session)' };
    headCache.set(file, { mtimeMs: stat.mtimeMs, meta });
    return meta;
  }

  function listCodeSessions() {
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return out;
    }
    for (const dir of dirs) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(root, dir.name)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(root, dir.name, f);
        try {
          const stat = fs.statSync(file);
          if (!stat.size) continue;
          const meta = sessionHead(file, stat);
          out.push({ source: 'claude-code', id: `${dir.name}/${f.slice(0, -6)}`, title: meta.title, where: meta.cwd, updatedAt: stat.mtimeMs });
        } catch {}
      }
    }
    return out;
  }

  function list(query = '') {
    const imported = db
      .all('SELECT id, source, title, updated_at, message_count FROM chats')
      .map((c) => ({ source: c.source, id: String(c.id), title: c.title, where: '', updatedAt: c.updated_at, messages: c.message_count }));
    const q = query.trim().toLowerCase();
    return [...listCodeSessions(), ...imported]
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.where.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 500);
  }

  function readCodeSession(id) {
    const [dir, session, ...rest] = id.split('/');
    if (rest.length || !/^[\w.-]+$/.test(dir ?? '') || !/^[\w-]+$/.test(session ?? '') || dir.startsWith('.')) throw new Error('Bad session id.');
    const file = path.join(root, dir, `${session}.jsonl`);
    const messages = [];
    let cwd = '';
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cwd && row.cwd) cwd = row.cwd;
      if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta || row.isSidechain) continue;
      const content = row.message?.content;
      const text = textOf(content);
      const tools = Array.isArray(content) ? content.filter((b) => b.type === 'tool_use').map((b) => b.name) : [];
      if (!text && !tools.length) continue; // tool results only
      const last = messages.at(-1);
      // Consecutive assistant rows are one turn split across tool calls: merge them.
      if (last && last.role === 'assistant' && row.type === 'assistant') {
        if (text) last.text = last.text ? `${last.text}\n\n${text}` : text;
        last.tools.push(...tools);
      } else {
        messages.push({ role: row.type, text, tools, ts: Date.parse(row.timestamp) || null });
      }
    }
    return {
      source: 'claude-code',
      id,
      title: firstLine(messages.find((m) => m.role === 'user')?.text) || '(untitled session)',
      where: cwd,
      sessionId: session,
      messages,
    };
  }

  function read(source, id) {
    if (source === 'claude-code') return readCodeSession(id);
    const chat = db.get('SELECT * FROM chats WHERE id = ?', Number(id));
    if (!chat) throw new Error('Chat not found.');
    return { source: chat.source, id: String(chat.id), title: chat.title, where: '', messages: JSON.parse(chat.messages) };
  }

  /** Accepts the parsed conversations.json from a claude.ai data export. */
  function importExport(data) {
    const list = Array.isArray(data) ? data : data?.conversations;
    if (!Array.isArray(list)) throw new Error('This file is not a claude.ai export. Pick conversations.json from the export archive.');
    let imported = 0;
    for (const conv of list) {
      const messages = (conv.chat_messages ?? [])
        .map((m) => ({
          role: m.sender === 'human' ? 'user' : 'assistant',
          text: (m.text || textOf(m.content) || '').trim(),
          tools: [],
          ts: Date.parse(m.created_at) || null,
        }))
        .filter((m) => m.text);
      if (!messages.length) continue;
      db.run(
        `INSERT INTO chats (source, external_id, title, updated_at, message_count, messages) VALUES ('claude-ai', ?, ?, ?, ?, ?)
         ON CONFLICT(source, external_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
           message_count = excluded.message_count, messages = excluded.messages`,
        String(conv.uuid ?? `${conv.name}-${conv.created_at}`),
        conv.name?.trim() || firstLine(messages[0].text) || '(untitled chat)',
        Date.parse(conv.updated_at ?? conv.created_at) || Date.now(),
        messages.length,
        JSON.stringify(messages),
      );
      imported++;
    }
    return imported;
  }

  function addNote(title, text) {
    if (!String(text || '').trim()) throw new Error('The note is empty.');
    const messages = [{ role: 'user', text: text.trim(), tools: [], ts: Date.now() }];
    return db.insert('chats', {
      source: 'note',
      external_id: `note-${Date.now()}`,
      title: String(title || '').trim() || firstLine(text),
      updated_at: Date.now(),
      message_count: 1,
      messages: JSON.stringify(messages),
    });
  }

  function remove(id) {
    db.run('DELETE FROM chats WHERE id = ?', Number(id));
  }

  return { list, read, importExport, addNote, remove, root };
}

export function transcriptText(chat) {
  return chat.messages
    .map((m) => `${m.role === 'user' ? 'Human' : 'Claude'}: ${m.text}${m.tools?.length ? `\n[used tools: ${[...new Set(m.tools)].join(', ')}]` : ''}`)
    .join('\n\n');
}

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function firstLine(text) {
  const line = (text || '').replace(/<[^>]+>/g, ' ').trim().split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}
