// Bridge of the desktop app: only the model files opened with it reach the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assemblerDesktop', {
  /** Calls back with the files opened with the app ({ name, data }). */
  onOpenFiles(cb) {
    ipcRenderer.on('open-files', (_e, files) => cb(files.map((f) => ({ name: f.name, data: f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) }))));
  },
});
