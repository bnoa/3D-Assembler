// Desktop shell of 3D Assembler: the same web app (dist/), in its own window, with an
// installer per system (electron-builder, see package.json "build").
const { app, BrowserWindow, Menu, dialog, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const HOST = 'app://assembler';
const MODEL = /\.(3mf|stl|obj|ply|glb|gltf|wrl)$/i;

// The web app uses absolute paths (/assets/…, /icons/…) and fetches its WASM: served from a
// standard, secure scheme rather than file://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** Model files given on the command line ("Open with", double click on a file). */
const filesIn = (argv) => argv.slice(1).filter((a) => MODEL.test(a) && fs.existsSync(a));

let win = null;
let pending = filesIn(process.argv);

function sendFiles(paths) {
  if (!paths.length) return;
  if (!win || win.webContents.isLoading()) { pending.push(...paths); return; }
  win.webContents.send('open-files', paths.map((p) => ({ name: path.basename(p), data: fs.readFileSync(p) })));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1456,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: '3D Assembler',
    backgroundColor: '#2c2e32',
    icon: path.join(DIST, 'icons', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.on('did-finish-load', () => { const p = pending; pending = []; sendFiles(p); });
  // Unsaved scene: the page asks to stay (beforeunload); confirm as the browser would.
  win.webContents.on('will-prevent-unload', (e) => {
    const fr = app.getLocale().toLowerCase().startsWith('fr');
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: fr ? ['Quitter', 'Annuler'] : ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
      title: '3D Assembler',
      message: fr ? 'La scène a des modifications non enregistrées.' : 'The scene has unsaved changes.',
      detail: fr ? 'Quitter quand même ?' : 'Quit anyway?',
    });
    if (choice === 0) e.preventDefault();
  });
  // Links to other sites open in the default browser (https only); the window never leaves the app.
  const openOutside = (url) => { if (/^https:\/\//i.test(url)) void shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(HOST + '/')) openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(HOST + '/')) return;
    e.preventDefault();
    openOutside(url);
  });
  void win.loadURL(`${HOST}/index.html`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    sendFiles(filesIn(argv));
  });
  app.on('open-file', (e, p) => { e.preventDefault(); sendFiles([p]); }); // macOS

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const url = new URL(req.url);
      let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
      // Only files inside dist/ are served (no way out with ../).
      if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
      return net.fetch(pathToFileURL(file).toString());
    });
    // Installed fonts for the Relief, camera for Add > Camera, clipboard; nothing else.
    const allowed = new Set(['local-fonts', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
    session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
    session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));
    // macOS keeps an application menu (copy / paste shortcuts); elsewhere the app has its own.
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
