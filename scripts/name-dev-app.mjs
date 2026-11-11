// On macOS the Dock and menu bar take an app's name from its bundle, and `npm run app` runs
// Electron's own bundle, which is called "Electron". This renames that local copy to Booardroom.
// It touches only node_modules, does nothing on other systems, and is safe to run again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'Booardroom';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(bundle, 'Contents', 'Info.plist');

if (process.platform === 'darwin' && fs.existsSync(plist)) {
  try {
    const before = fs.readFileSync(plist, 'utf8');
    let after = before;
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      const entry = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
      after = entry.test(after)
        ? after.replace(entry, `$1${NAME}$2`)
        : after.replace(/<dict>/, `<dict>\n\t<key>${key}</key>\n\t<string>${NAME}</string>`);
    }
    if (after !== before) {
      fs.writeFileSync(plist, after);
      // A fresh modification time makes macOS read the bundle's name again.
      const now = new Date();
      fs.utimesSync(bundle, now, now);
    }
  } catch (err) {
    console.warn(`Could not rename the development app: ${err.message}`);
  }
}
