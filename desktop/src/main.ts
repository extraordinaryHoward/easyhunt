import { app, BrowserView, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, safeStorage } from 'electron';
import updater from 'electron-updater';
const { autoUpdater } = updater;
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute } from 'node:path';
console.error('Easyhunt main module loaded');
const here=dirname(fileURLToPath(import.meta.url));
const engineDir=app.isPackaged?resolve(process.resourcesPath,'rpa-engine'):resolve(here,'../../rpa-engine');
const webDir=app.isPackaged?resolve(process.resourcesPath,'user-webapp'):resolve(here,'../../user-webapp/dist');
const port=Number(process.env.EASYHUNT_PORT??4317), cdpPort=Number(process.env.EASYHUNT_CDP_PORT??9223);
const apiBase=`http://127.0.0.1:${port}`, cloudBase=process.env.EASYHUNT_CLOUD_BASE_URL??'http://127.0.0.1:4320';
const bridgeSecret=randomUUID();
const bossSearchUrl='https://www.zhipin.com/web/boss/search/';
let engine:ChildProcess|undefined, mainWindow:BrowserWindow|undefined, browserView:BrowserView|undefined, toolbarView:BrowserView|undefined, tray:Tray|undefined, accessToken='', quitting=false;
let browserTargetReady:Promise<void>|undefined;
app.commandLine.appendSwitch('remote-debugging-port',String(cdpPort));app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
type StorageSettings={dataRoot:string;resume:string;resumeAttachment:string};
function storageSettingsPath(){return join(app.getPath('userData'),'storage-settings.json');}
function defaultStorageSettings():StorageSettings{const dataRoot=join(app.getPath('userData'),'dataRoot');return{dataRoot,resume:join(dataRoot,'resume'),resumeAttachment:join(dataRoot,'resumeAttachment')};}
function readStorageSettings():StorageSettings{try{const saved=JSON.parse(readFileSync(storageSettingsPath(),'utf8'));if(['dataRoot','resume','resumeAttachment'].every(key=>typeof saved[key]==='string'&&isAbsolute(saved[key])))return saved;}catch{}return defaultStorageSettings();}
let activeStorageSettings:StorageSettings|undefined;
const approvedStoragePaths=new Set<string>();
function storageSettings():StorageSettings{activeStorageSettings??=readStorageSettings();return activeStorageSettings;}
function dataDir(){const p=storageSettings().dataRoot;mkdirSync(p,{recursive:true});return p;}
function tokenPath(){return join(dataDir(),'auth.token');}
function restoreToken(){if(existsSync(tokenPath())&&safeStorage.isEncryptionAvailable())accessToken=safeStorage.decryptString(readFileSync(tokenPath()));}
function persistToken(value:string){accessToken=value;if(safeStorage.isEncryptionAvailable())writeFileSync(tokenPath(),safeStorage.encryptString(value));}
async function startEngine(){const packaged=app.isPackaged,storage=storageSettings();engine=spawn(packaged?process.execPath:(process.env.EASYHUNT_NODE_BINARY??'node'),packaged?[resolve(engineDir,'dist/server.js')]:['--import','tsx','src/server.ts'],{cwd:engineDir,env:{...process.env,...(packaged?{ELECTRON_RUN_AS_NODE:'1'}:{}),PORT:String(port),EASYHUNT_DATA_ROOT:storage.dataRoot,EASYHUNT_RESUME_DIR:storage.resume,EASYHUNT_ATTACHMENT_DIR:storage.resumeAttachment,EASYHUNT_CDP_URL:`http://127.0.0.1:${cdpPort}`,EASYHUNT_BRIDGE_SECRET:bridgeSecret},stdio:'inherit'});for(let i=0;i<80;i++){if(engine.exitCode!==null)throw new Error(`RPA engine exited: ${engine.exitCode}`);try{if((await fetch(`${apiBase}/status`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('RPA engine did not start');}
async function forward(base:string,path:string,method:string,body?:unknown,cloud=false){if(!path.startsWith('/')||path.includes('://')||path.includes('..'))throw new Error('Invalid API path');if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))throw new Error('Invalid method');const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(cloud&&accessToken?{authorization:`Bearer ${accessToken}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(cloud&&path==='/auth/login'&&response.ok&&data.accessToken)persistToken(data.accessToken);return{status:response.status,body:data};}
function layoutBrowser(){if(!mainWindow||!browserView)return;const[w,h]=mainWindow.getContentSize();browserView.setBounds({x:0,y:74,width:w,height:Math.max(0,h-74)});toolbarView?.setBounds({x:0,y:0,width:w,height:74});}
async function registerBrowserViewTarget(view:BrowserView){
  const debuggerSession=view.webContents.debugger;
  debuggerSession.attach('1.3');
  let targetId:string;
  try{
    const result=await debuggerSession.sendCommand('Target.getTargetInfo') as {targetInfo:{targetId:string}};
    targetId=result.targetInfo.targetId;
  }finally{debuggerSession.detach();}
  for(let attempt=0;attempt<10;attempt++){
    try{
      const response=await fetch(`${apiBase}/bridge/target`,{method:'POST',headers:{'content-type':'application/json','x-easyhunt-bridge-secret':bridgeSecret},body:JSON.stringify({targetId})});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      console.info(`[bridge] BrowserView target registered: ${targetId}`);
      return;
    }catch(error){if(attempt===9)throw error;await new Promise(resolve=>setTimeout(resolve,200));}
  }
}
async function showBrowser(show:boolean){
  if(!mainWindow||!browserView)return;
  if(show){
    await browserTargetReady;
    mainWindow.addBrowserView(browserView);
    if(toolbarView)mainWindow.addBrowserView(toolbarView);
    layoutBrowser();
    if(browserView.webContents.getURL()===`${apiBase}/bridge/view`){
      await browserView.webContents.loadURL(bossSearchUrl);
    }
    browserView.webContents.focus();
  }else{if(toolbarView)mainWindow.removeBrowserView(toolbarView);mainWindow.removeBrowserView(browserView);mainWindow.webContents.focus();}
}
async function createWindow(){mainWindow=new BrowserWindow({width:1360,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:resolve(here,'../src/preload.cjs')}});const devUrl=process.env.EASYHUNT_WEB_DEV_URL;if(devUrl)void mainWindow.loadURL(devUrl);else void mainWindow.loadFile(resolve(webDir,'index.html'));browserView=new BrowserView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});mainWindow.on('resize',layoutBrowser);mainWindow.on('close',event=>{if(process.platform==='darwin'&&!quitting){event.preventDefault();mainWindow?.hide();}});browserTargetReady=browserView.webContents.loadURL(`${apiBase}/bridge/view`).then(()=>registerBrowserViewTarget(browserView!));await browserTargetReady;toolbarView=new BrowserView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:resolve(here,'../src/preload.cjs')}});void toolbarView.webContents.loadFile(resolve(here,'../src/browser-toolbar.html'));}
function createTray(){const icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9jXYQAAAAASUVORK5CYII=');tray=new Tray(icon);tray.setToolTip('Easyhunt');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 Easyhunt',click:()=>mainWindow?.show()},{label:'退出',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',()=>mainWindow?.show());}
ipcMain.handle('cloud-request',(_e,path:string,method='GET',body?:unknown)=>forward(cloudBase,path,method,body,true));
ipcMain.handle('rpa-request',(_e,path:string,method='GET',body?:unknown)=>forward(apiBase,path,method,path==='/workflows/boss/agent'&&accessToken?{...(body as object),cloudAccessToken:accessToken}:body));
ipcMain.handle('save-local-resume',(_e,record:unknown)=>{const value=JSON.stringify(record),contentHash=createHash('sha256').update(value).digest('hex'),localRef=randomUUID(),dir=storageSettings().resume;mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${localRef}.json`),value,{flag:'wx'});return{localRef,contentHash};});
ipcMain.handle('read-local-resume',(_e,ref:string)=>{if(!/^[a-f0-9-]{36}$/.test(ref))throw new Error('Invalid local reference');const path=join(storageSettings().resume,`${ref}.json`);return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;});
ipcMain.handle('local-state-read',()=>{const path=join(dataDir(),'workspace.json');return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};});
ipcMain.handle('local-state-write',(_e,value:unknown)=>{const data=JSON.stringify(value);if(!value||typeof value!=='object'||data.length>10_000_000)throw new Error('Invalid local state');const path=join(dataDir(),'workspace.json');const temporary=`${path}.tmp`;writeFileSync(temporary,data,{mode:0o600});renameSync(temporary,path);return true;});
ipcMain.handle('show-browser',(_e,show:boolean)=>showBrowser(Boolean(show)));
ipcMain.handle('open-agreement',()=>{const win=new BrowserWindow({parent:mainWindow,modal:true,width:750,height:650,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadFile(resolve(webDir,'agency-agreement.html'));});
ipcMain.handle('storage-settings-read',()=>readStorageSettings());
ipcMain.handle('storage-settings-pick',async()=>{const result=await dialog.showOpenDialog(mainWindow!,{properties:['openDirectory','createDirectory']});if(result.canceled)return null;approvedStoragePaths.add(result.filePaths[0]);return result.filePaths[0];});
ipcMain.handle('storage-settings-write',(_e,value:StorageSettings)=>{const current=readStorageSettings();if(!value||!(['dataRoot','resume','resumeAttachment'] as const).every(key=>typeof value[key]==='string'&&isAbsolute(value[key])&&(approvedStoragePaths.has(value[key])||Object.values(current).includes(value[key]))))throw new Error('Invalid storage location');for(const p of [value.dataRoot,value.resume,value.resumeAttachment])mkdirSync(p,{recursive:true});writeFileSync(storageSettingsPath(),JSON.stringify(value,null,2),{mode:0o600});return{saved:true,restartRequired:true};});
ipcMain.handle('app-restart',()=>{app.relaunch();app.quit();});
app.whenReady().then(async()=>{console.error('Easyhunt ready');restoreToken();console.error('token restored');await startEngine();console.error('engine ready');await createWindow();console.error('window ready');createTray();if(app.isPackaged&&process.env.EASYHUNT_UPDATE_URL){autoUpdater.setFeedURL({provider:'generic',url:process.env.EASYHUNT_UPDATE_URL});void autoUpdater.checkForUpdatesAndNotify().catch(e=>console.error('Updater:',e));}}).catch(e=>{console.error(e);app.quit();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});app.on('before-quit',()=>{quitting=true;engine?.kill();});
