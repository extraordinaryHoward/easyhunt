const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('easyhunt', {
  cloud: (path, method='GET', body) => ipcRenderer.invoke('cloud-request', path, method, body),
  rpa: (path, method='GET', body) => ipcRenderer.invoke('rpa-request', path, method, body),
  saveLocalResume: record => ipcRenderer.invoke('save-local-resume', record),
  readLocalResume: ref => ipcRenderer.invoke('read-local-resume', ref),
  importLocalPdfs: job => ipcRenderer.invoke('import-local-pdfs', job),
  browserStatus: () => ipcRenderer.invoke('browser-status'),
  clearBrowserData: () => ipcRenderer.invoke('clear-browser-data'),
  openLocalAttachment: path => ipcRenderer.invoke('open-local-attachment', path),
  localStateRead: () => ipcRenderer.invoke('local-state-read'),
  localStateWrite: value => ipcRenderer.invoke('local-state-write', value),
  showBrowser: show => ipcRenderer.invoke('show-browser', show),
  browserPreview: () => ipcRenderer.invoke('browser-preview'),
  browserControls: (action, value) => ipcRenderer.invoke('browser-controls', action, value),
  openAgreement: () => ipcRenderer.invoke('open-agreement'),
  storageSettingsRead: () => ipcRenderer.invoke('storage-settings-read'),
  storageSettingsPick: () => ipcRenderer.invoke('storage-settings-pick'),
  storageSettingsWrite: value => ipcRenderer.invoke('storage-settings-write', value),
  restartApp: () => ipcRenderer.invoke('app-restart')
});
