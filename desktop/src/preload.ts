import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('easyhunt',{
cloud:(path:string,method='GET',body?:unknown)=>ipcRenderer.invoke('cloud-request',path,method,body),
rpa:(path:string,method='GET',body?:unknown)=>ipcRenderer.invoke('rpa-request',path,method,body),
saveLocalResume:(record:unknown)=>ipcRenderer.invoke('save-local-resume',record),
readLocalResume:(ref:string)=>ipcRenderer.invoke('read-local-resume',ref),
showBrowser:(show:boolean)=>ipcRenderer.invoke('show-browser',show),
browserPreview:()=>ipcRenderer.invoke('browser-preview'),
browserControls:(action:string,value?:string)=>ipcRenderer.invoke('browser-controls',action,value),
openAgreement:()=>ipcRenderer.invoke('open-agreement'),
storageSettingsRead:()=>ipcRenderer.invoke('storage-settings-read'),
storageSettingsPick:()=>ipcRenderer.invoke('storage-settings-pick'),
storageSettingsWrite:(value:unknown)=>ipcRenderer.invoke('storage-settings-write',value),
restartApp:()=>ipcRenderer.invoke('app-restart')});
