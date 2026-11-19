// Update of the desktop app from the latest GitHub release. Everything is decided here, in the main
// process: the page can only ask "update now", not choose what is downloaded or run.
// The installer is checked against the SHA-256 fingerprint GitHub publishes for it before it is used.
const { app, ipcMain, net, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = 'bnoa/3D-Assembler';
const PAGE = `https://github.com/${REPO}/releases/latest`;
/** Where release files may come from (the download link redirects to GitHub's file storage). */
const TRUSTED = /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//i;

/** The release file this installation can update itself with. */
function wantedAsset() {
  if (process.platform === 'win32') return /Setup-x64\.exe$/i;
  if (process.platform === 'darwin') return /macOS\.dmg$/i;
  if (process.platform === 'linux' && process.env.APPIMAGE) return /Linux-x64\.AppImage$/i;
  return null; // .deb or unpacked app: the release page instead
}

/** true when version a is strictly greater than b (0.10.0 > 0.9.2). */
function isNewer(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d > 0; }
  return false;
}

async function latestAsset() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const rel = await res.json();
  // Only a newer version is installed (never the same one again, never an older one).
  if (!isNewer(rel.tag_name, app.getVersion())) throw new Error('not-newer');
  const want = wantedAsset();
  const asset = want && Array.isArray(rel.assets) ? rel.assets.find((a) => typeof a.name === 'string' && want.test(a.name)) : null;
  return asset ?? null;
}

async function download(asset) {
  const url = String(asset.browser_download_url ?? '');
  if (!TRUSTED.test(url)) throw new Error('untrusted-url');
  const sum = /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest ?? ''));
  if (!sum) throw new Error('no-checksum');
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(data).digest('hex') !== sum[1].toLowerCase()) throw new Error('checksum-mismatch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3d-assembler-update-'));
  const file = path.join(dir, path.basename(asset.name).replace(/[^\w.-]/g, '_'));
  fs.writeFileSync(file, data, { mode: 0o755 });
  return file;
}

/** Installs the latest release. Returns what happened: 'installing', 'opened' or 'page'. */
async function installUpdate() {
  const asset = await latestAsset();
  if (!asset) { await shell.openExternal(PAGE); return 'page'; }
  const file = await download(asset);
  if (process.platform === 'win32') {
    // Silent install over the current one, then the installer starts the new version.
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 300);
    return 'installing';
  }
  if (process.platform === 'darwin') {
    // An unsigned app cannot replace itself: the disk image opens, the user drags the app over.
    await shell.openPath(file);
    return 'opened';
  }
  // Linux AppImage: the new file takes the place of the running one, then the app restarts.
  const current = process.env.APPIMAGE;
  const next = `${current}.new`;
  fs.copyFileSync(file, next);
  fs.chmodSync(next, 0o755);
  fs.renameSync(next, current);
  app.relaunch({ execPath: current });
  app.quit();
  return 'installing';
}

/** Answers the page's "update now", only from the app's own window, one update at a time. */
function registerUpdate(isOwnPage) {
  let running = null;
  ipcMain.handle('install-update', async (e) => {
    if (!isOwnPage(e.sender)) throw new Error('refused');
    running ??= installUpdate().finally(() => { running = null; });
    return running;
  });
}

module.exports = { registerUpdate, latestAsset, download };
