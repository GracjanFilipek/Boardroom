import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * GitHub for the company. Booardroom holds the account, creates repositories and pushes approved
 * work itself, so agents never need to authenticate or to be trusted with a push.
 *
 * The account comes from the GitHub CLI when it is logged in (`gh auth token`), otherwise from a
 * personal access token the CEO pasted. A pasted token is kept in the local database.
 */
export function createGitHub(db, { fetchImpl = fetch, apiBase = 'https://api.github.com', useCli = true } = {}) {
  const run = (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
      });
    });

  let cliToken = { at: 0, value: null };
  async function token() {
    const saved = db.setting('github.token', null);
    if (saved) return { token: saved, source: 'token' };
    if (!useCli) return { token: null, source: null };
    if (Date.now() - cliToken.at > 60_000) {
      const res = await run('gh', ['auth', 'token', '--hostname', 'github.com']);
      cliToken = { at: Date.now(), value: res.ok && res.out ? res.out : null };
    }
    return { token: cliToken.value, source: cliToken.value ? 'cli' : null };
  }

  async function api(method, route, body, withToken) {
    const tok = withToken ?? (await token()).token;
    if (!tok) throw new Error('GitHub is not connected.');
    const res = await fetchImpl(apiBase + route, {
      method,
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'booardroom', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data.errors?.[0]?.message || data.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(`GitHub said: ${detail}`), { status: res.status });
    }
    return data;
  }

  /** Who the company acts as on GitHub, or null when nothing is connected. */
  async function account() {
    const { token: tok, source } = await token();
    if (!tok) return null;
    const cached = db.setting('github.user', null);
    if (cached && cached.for === tok.slice(-8)) return { ...cached.user, source };
    try {
      const me = await api('GET', '/user', null, tok);
      const user = { login: me.login, id: me.id, name: me.name || me.login, email: `${me.id}+${me.login}@users.noreply.github.com` };
      db.setSetting('github.user', { for: tok.slice(-8), user });
      return { ...user, source };
    } catch (err) {
      return { error: err.message, source };
    }
  }

  /** Saves a pasted token after checking that GitHub accepts it. */
  async function connect(pasted) {
    const tok = String(pasted || '').trim();
    if (!tok) throw new Error('Paste a token first.');
    const me = await api('GET', '/user', null, tok);
    db.setSetting('github.token', tok);
    db.setSetting('github.user', { for: tok.slice(-8), user: { login: me.login, id: me.id, name: me.name || me.login, email: `${me.id}+${me.login}@users.noreply.github.com` } });
    return account();
  }

  function disconnect() {
    db.run("DELETE FROM settings WHERE key IN ('github.token', 'github.user')");
    cliToken = { at: 0, value: null };
  }

  /**
   * Environment that lets git and gh in a child process act as the account, without the token
   * touching any file: a credential helper defined through git's environment config.
   */
  async function env() {
    const { token: tok } = await token();
    if (!tok) return {};
    const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
    return {
      BOOARDROOM_GH_TOKEN: tok,
      GH_TOKEN: tok,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: String(n + 2),
      // An empty helper first drops helpers from the machine's config, so ours is the one asked.
      [`GIT_CONFIG_KEY_${n}`]: 'credential.https://github.com.helper',
      [`GIT_CONFIG_VALUE_${n}`]: '',
      [`GIT_CONFIG_KEY_${n + 1}`]: 'credential.https://github.com.helper',
      [`GIT_CONFIG_VALUE_${n + 1}`]: '!f() { echo username=x-access-token; echo "password=$BOOARDROOM_GH_TOKEN"; }; f',
    };
  }

  const git = async (workdir, args, auth = false) => run('git', args, { cwd: workdir, env: { ...process.env, ...(auth ? await env() : {}) } });

  /** Where a project folder stands: is it a repository, where does origin point, is there anything to push. */
  async function status(workdir) {
    if (!fs.existsSync(path.join(workdir, '.git'))) return { isGit: false, remote: null, web: null };
    const remote = (await git(workdir, ['remote', 'get-url', 'origin'])).out || null;
    const web = remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? null;
    return { isGit: true, remote, web: web ? `https://github.com/${web}` : null, slug: web };
  }

  /** Commits made in this folder carry the account's name, unless the folder or machine already names someone. */
  async function setIdentity(workdir) {
    const me = await account();
    if (!me?.login) return;
    if (!(await git(workdir, ['config', 'user.email'])).out) {
      await git(workdir, ['config', 'user.name', me.name]);
      await git(workdir, ['config', 'user.email', me.email]);
    }
  }

  async function push(workdir) {
    const st = await status(workdir);
    if (!st.remote) return { ok: false, skipped: true, error: 'This project has no GitHub repository yet.' };
    if (!(await git(workdir, ['rev-parse', '--verify', 'HEAD'])).ok) return { ok: false, skipped: true, error: 'Nothing is committed yet.' };
    const res = await git(workdir, ['push', '-u', 'origin', 'HEAD'], true);
    return res.ok ? { ok: true, web: st.web } : { ok: false, error: res.err.split('\n').filter(Boolean).slice(-3).join(' ') || 'git push failed.' };
  }

  /** Creates a repository under the account, points the project folder at it and pushes what is there. */
  async function createRepo(workdir, { name, isPrivate = true, description = '' }) {
    const clean = String(name || '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean) throw new Error('Give the repository a name.');
    if (!fs.existsSync(path.join(workdir, '.git')) && !(await git(workdir, ['init', '-q'])).ok) throw new Error('git init failed. Is git installed?');
    if ((await status(workdir)).remote) throw new Error('This folder already points at a repository.');
    const repo = await api('POST', '/user/repos', { name: clean, private: Boolean(isPrivate), description: String(description).slice(0, 300) });
    await git(workdir, ['remote', 'add', 'origin', repo.clone_url]);
    await setIdentity(workdir);
    const pushed = await push(workdir);
    return { url: repo.html_url, pushed: pushed.ok, note: pushed.ok || pushed.skipped ? null : pushed.error };
  }

  /** Points the project folder at a repository that already exists. */
  async function link(workdir, url) {
    const slug = String(url || '').trim().match(/(?:github\.com[:/])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1];
    if (!slug) throw new Error('Give the repository as owner/name or its GitHub address.');
    await api('GET', `/repos/${slug}`);
    if (!fs.existsSync(path.join(workdir, '.git'))) await git(workdir, ['init', '-q']);
    const has = (await status(workdir)).remote;
    await git(workdir, has ? ['remote', 'set-url', 'origin', `https://github.com/${slug}.git`] : ['remote', 'add', 'origin', `https://github.com/${slug}.git`]);
    await setIdentity(workdir);
    return { url: `https://github.com/${slug}` };
  }

  return { account, connect, disconnect, env, status, setIdentity, push, createRepo, link };
}
