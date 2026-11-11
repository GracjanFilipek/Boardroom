// Desktop shell. Starts the Booardroom server inside the app on a private local port
// and shows it in a window. Data lives in the per-user application folder.

import { app, BrowserWindow, Menu, shell, dialog, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = process.env.CORP_RUNNER === 'mock';
const iconFile = path.join(root, 'electron', 'icon.png');

app.setName('Booardroom');
app.setAboutPanelOptions({ applicationName: 'Booardroom', applicationVersion: app.getVersion(), iconPath: iconFile });
let win = null;
let origin = null;
let stopServer = () => {};

/**
 * An app started from the Dock or Start menu gets a bare PATH, so `claude` is often missing
 * from it. Add the usual install folders and point CLAUDE_BIN at the first binary found.
 */
function locateClaude() {
  const home = os.homedir();
  const exe = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [
    path.join(home, '.claude', 'local'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
  ].filter(Boolean);
  process.env.PATH = [process.env.PATH, ...dirs].filter(Boolean).join(path.delimiter);
  if (process.env.CLAUDE_BIN) return;
  for (const dir of process.env.PATH.split(path.delimiter)) {
    for (const name of exe) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return void (process.env.CLAUDE_BIN = file);
    }
  }
}

/** Runs the server in this process. Needs node:sqlite, which recent Electron versions ship. */
async function startInProcess(dataDir) {
  await import('node:sqlite');
  const { createApp } = await import('../src/server.js');
  const { runClaude, createMockRunner } = await import('../src/claude.js');
  const corp = createApp({ dataDir, mock, runner: mock ? createMockRunner({ delay: 2500 }) : runClaude });
  await new Promise((resolve, reject) => corp.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  corp.orch.tick();
  stopServer = () => corp.close();
  return `http://127.0.0.1:${corp.server.address().port}`;
}

/** Fallback for an Electron without node:sqlite: run the server with the Node on PATH. */
function startWithSystemNode(dataDir) {
  return new Promise((resolve, reject) => {
    const port = 43170 + Math.floor(Math.random() * 800);
    const child = spawn('node', ['--disable-warning=ExperimentalWarning', path.join(root, 'src', 'server.js')], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CORP_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => {
      log += chunk;
      if (log.includes('Booardroom is open')) resolve(`http://127.0.0.1:${port}`);
    });
    child.stderr.on('data', (chunk) => (log += chunk));
    child.on('error', () => reject(new Error('Booardroom needs Node 22.13 or newer on your PATH.')));
    child.on('exit', (code) => reject(new Error(`The server stopped (code ${code}).\n${log.slice(-600)}`)));
    stopServer = () => child.kill();
  });
}

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: 'Booardroom',
    icon: iconFile,
    backgroundColor: '#f5f4ef',
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 16, y: 18 } : undefined,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(root, 'electron', 'preload.cjs') },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (win = null));

  // The window only ever shows the local app. Everything else opens in the browser.
  const external = (url) => !url.startsWith(origin);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (external(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!external(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  win.loadURL(`${origin}/${mac ? '?shell=mac' : '?shell=desktop'}`);
}

// The page asks for a folder; the dialog opens as a sheet on the window, the way Finder and Explorer users expect.
ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, { title: 'Choose the project folder', buttonLabel: 'Choose', properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});
ipcMain.handle('reveal-folder', (_event, dir) => {
  if (typeof dir === 'string' && fs.existsSync(dir)) shell.openPath(dir);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    locateClaude();
    // Started with `npm run app`, the Dock would show Electron's own icon.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconFile);
    const dataDir = process.env.CORP_DATA_DIR ? path.resolve(process.env.CORP_DATA_DIR) : path.join(app.getPath('userData'), mock ? 'demo' : 'company');
    // The app had other names before. Carry a company founded under one of them over, once.
    if (!process.env.CORP_DATA_DIR && !fs.existsSync(dataDir)) {
      for (const former of ['Boardroom', 'boardroom', 'Agent Corp', 'agent-corp']) {
        const old = path.join(app.getPath('appData'), former, path.basename(dataDir));
        if (!fs.existsSync(old)) continue;
        fs.mkdirSync(path.dirname(dataDir), { recursive: true });
        fs.cpSync(old, dataDir, { recursive: true });
        break;
      }
    }
    try {
      origin = await startInProcess(dataDir).catch((err) => {
        if (err?.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw err;
        return startWithSystemNode(dataDir);
      });
    } catch (err) {
      dialog.showErrorBox('Booardroom could not start', String(err?.message ?? err));
      return app.quit();
    }
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => !win && createWindow());
  });

  // Agents keep working while the window is closed on macOS, as with any Dock app. Elsewhere, closing quits.
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
  app.on('before-quit', () => stopServer());
}
