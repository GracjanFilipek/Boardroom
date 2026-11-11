// Bridge between the page and the desktop shell. The page gets two functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('corp', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  revealFolder: (dir) => ipcRenderer.invoke('reveal-folder', dir),
});
