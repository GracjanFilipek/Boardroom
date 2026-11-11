import { execFile, spawn } from 'node:child_process';

/**
 * Native folder dialog and file-manager reveal for the machine the server runs on.
 * The browser cannot hand a page a real folder path, so the local server asks the OS instead.
 */

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10 * 60_000, windowsHide: true }, (err, stdout) => {
      resolve({ missing: err?.code === 'ENOENT', ok: !err, out: String(stdout || '').trim() });
    });
  });

/** Opens the system folder chooser. Resolves with the chosen path, or null when the person cancels. */
export async function pickFolder(prompt = 'Choose the project folder') {
  if (process.platform === 'darwin') {
    const res = await run('osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]);
    return res.ok && res.out ? res.out.replace(/\/$/, '') : null;
  }
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description = '${prompt.replace(/'/g, "''")}'`,
      '$d.ShowNewFolderButton = $true',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $d.SelectedPath }",
    ].join('; ');
    const res = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
    if (res.missing) throw new Error('PowerShell is not available, so the folder dialog cannot open. Type the path instead.');
    return res.out || null;
  }
  for (const [cmd, args] of [
    ['zenity', ['--file-selection', '--directory', `--title=${prompt}`]],
    ['kdialog', ['--getexistingdirectory', process.env.HOME || '/', '--title', prompt]],
  ]) {
    const res = await run(cmd, args);
    if (!res.missing) return res.out || null;
  }
  throw new Error('No folder dialog found (install zenity or kdialog). Type the path instead.');
}

/** Shows a folder in Finder, File Explorer or the desktop's file manager. */
export function revealFolder(dir) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
