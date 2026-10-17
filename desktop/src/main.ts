import { app, BrowserView, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, safeStorage, session, shell } from 'electron';
import updater from 'electron-updater';
const { autoUpdater } = updater;
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, isAbsolute, sep, extname } from 'node:path';
console.error('Easyhunt main module loaded');
const here=dirname(fileURLToPath(import.meta.url));
const engineDir=app.isPackaged?resolve(process.resourcesPath,'rpa-engine'):resolve(here,'../../rpa-engine');
const webDir=app.isPackaged?resolve(process.resourcesPath,'user-webapp'):resolve(here,'../../user-webapp/dist');
const port=Number(process.env.EASYHUNT_PORT??4317), cdpPort=Number(process.env.EASYHUNT_CDP_PORT??9223);
const apiBase=`http://127.0.0.1:${port}`, cloudBase=process.env.EASYHUNT_CLOUD_BASE_URL??'http://127.0.0.1:4320';
const bridgeSecret=randomUUID();
const bossSearchUrl='https://www.zhipin.com/web/boss/search/';
let engine:ChildProcess|undefined, mainWindow:BrowserWindow|undefined, browserWindow:BrowserWindow|undefined, miniWindow:BrowserWindow|undefined, browserView:BrowserView|undefined, toolbarView:BrowserView|undefined, tray:Tray|undefined, accessToken='', quitting=false;
let browserTargetReady:Promise<void>|undefined;
app.commandLine.appendSwitch('remote-debugging-port',String(cdpPort));app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
type StorageSettings={dataRoot:string;resume:string;resumeAttachment:string};
function storageSettingsPath(){return join(app.getPath('userData'),'storage-settings.json');}
function defaultStorageSettings():StorageSettings{const dataRoot=join(app.getPath('userData'),'dataRoot');return{dataRoot,resume:join(dataRoot,'resume'),resumeAttachment:join(dataRoot,'resumeAttachment')};}
function readStorageSettings():StorageSettings{try{const saved=JSON.parse(readFileSync(storageSettingsPath(),'utf8'));if(['dataRoot','resume','resumeAttachment'].every(key=>typeof saved[key]==='string'&&isAbsolute(saved[key])))return saved;}catch{}return defaultStorageSettings();}
/* DESIGN-DECISION: 无原始证据，自研 */
// A path change is accepted only after the user has copied every existing file
// to the new location. Compare hashes before switching paths so no local resume
// silently disappears from the workbench after restart.
function verifyStorageMigration(source:string,destination:string){
  if(source===destination)return;
  if(lstatSync(destination).isSymbolicLink())throw new Error('新目录不能是符号链接，请选择实际目录');
  if(!existsSync(source)){accessSync(destination,constants.W_OK);return;}
  const from=realpathSync(source),to=realpathSync(destination);
  if(to.startsWith(from+sep)||from.startsWith(to+sep))throw new Error('新旧目录不能互相包含');
  accessSync(to,constants.W_OK);
  const visit=(a:string,b:string)=>{for(const entry of readdirSync(a,{withFileTypes:true})){
    if(entry.isSymbolicLink())throw new Error('存储目录包含符号链接，请先手动处理');
    const old=join(a,entry.name),next=join(b,entry.name);
    if(!existsSync(next))throw new Error(`新目录缺少 ${entry.name}；请先完整复制旧目录后再保存`);
    if(lstatSync(next).isSymbolicLink())throw new Error(`新目录中的 ${entry.name} 是符号链接，请先复制实际文件`);
    if(entry.isDirectory()){if(!statSync(next).isDirectory())throw new Error(`新目录中的 ${entry.name} 类型不一致`);visit(old,next);}
    else if(entry.isFile()){if(!statSync(next).isFile()||createHash('sha256').update(readFileSync(old)).digest('hex')!==createHash('sha256').update(readFileSync(next)).digest('hex'))throw new Error(`新目录中的 ${entry.name} 与旧文件不一致`);}
  }};
  if(existsSync(from))visit(from,to);
}
let activeStorageSettings:StorageSettings|undefined;
const approvedStoragePaths=new Set<string>();
function storageSettings():StorageSettings{activeStorageSettings??=readStorageSettings();return activeStorageSettings;}
function dataDir(){const p=storageSettings().dataRoot;mkdirSync(p,{recursive:true});return p;}
function tokenPath(){return join(dataDir(),'auth.token');}
function restoreToken(){if(existsSync(tokenPath())&&safeStorage.isEncryptionAvailable())accessToken=safeStorage.decryptString(readFileSync(tokenPath()));}
function persistToken(value:string){accessToken=value;if(safeStorage.isEncryptionAvailable())writeFileSync(tokenPath(),safeStorage.encryptString(value));}
async function startEngine(){const packaged=app.isPackaged,storage=storageSettings();engine=spawn(packaged?process.execPath:(process.env.EASYHUNT_NODE_BINARY??'node'),packaged?[resolve(engineDir,'dist/server.js')]:['--import','tsx','src/server.ts'],{cwd:engineDir,env:{...process.env,...(packaged?{ELECTRON_RUN_AS_NODE:'1'}:{}),PORT:String(port),EASYHUNT_DATA_ROOT:storage.dataRoot,EASYHUNT_RESUME_DIR:storage.resume,EASYHUNT_ATTACHMENT_DIR:storage.resumeAttachment,EASYHUNT_CDP_URL:`http://127.0.0.1:${cdpPort}`,EASYHUNT_BRIDGE_SECRET:bridgeSecret},stdio:'inherit'});for(let i=0;i<80;i++){if(engine.exitCode!==null)throw new Error(`RPA engine exited: ${engine.exitCode}`);try{if((await fetch(`${apiBase}/status`)).ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('RPA engine did not start');}
async function forward(base:string,path:string,method:string,body?:unknown,cloud=false){if(!path.startsWith('/')||path.includes('://')||path.includes('..'))throw new Error('Invalid API path');if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))throw new Error('Invalid method');const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...(cloud&&accessToken?{authorization:`Bearer ${accessToken}`}:{}),...(!cloud&&path==='/authorizations'&&method==='POST'?{'x-easyhunt-bridge-secret':bridgeSecret}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json().catch(()=>({}));if(cloud&&path==='/auth/login'&&response.ok&&data.accessToken)persistToken(data.accessToken);return{status:response.status,body:data};}
function layoutBrowser(){if(!browserWindow||!browserView)return;const[w,h]=browserWindow.getContentSize();browserView.setBounds({x:0,y:74,width:w,height:Math.max(0,h-74)});toolbarView?.setBounds({x:0,y:0,width:w,height:74});}
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
  if(!mainWindow||mainWindow.isDestroyed())return;
  if(show){
    if(!browserWindow||browserWindow.isDestroyed()||!browserView||browserView.webContents.isDestroyed())await createBrowserSurface();
    await browserTargetReady;
    const window=browserWindow, view=browserView;
    if(!window||!view)throw new Error('Browser surface could not be created');
    window.show();
    layoutBrowser();
    if(view.webContents.getURL()===`${apiBase}/bridge/view`){
      await view.webContents.loadURL(bossSearchUrl);
    }
    view.webContents.focus();
    miniWindow?.hide();
  }else{if(browserWindow&&!browserWindow.isDestroyed())browserWindow.hide();mainWindow.show();mainWindow.focus();if(miniWindow&&!miniWindow.isDestroyed())miniWindow.showInactive();}
}
async function createBrowserSurface(){
  if(browserWindow&&!browserWindow.isDestroyed())browserWindow.destroy();
  if(miniWindow&&!miniWindow.isDestroyed())miniWindow.destroy();
  browserWindow=new BrowserWindow({width:1280,height:850,show:false,title:'Easyhunt · BOSS 浏览器',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  browserWindow.on('close',event=>{if(!quitting){event.preventDefault();browserWindow?.hide();if(mainWindow?.isVisible())miniWindow?.showInactive();}});
  browserWindow.on('focus',()=>miniWindow?.hide());
  browserWindow.on('resize',layoutBrowser);
  browserView=new BrowserView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  browserWindow.addBrowserView(browserView);
  browserTargetReady=browserView.webContents.loadURL(`${apiBase}/bridge/view`).then(()=>registerBrowserViewTarget(browserView!));
  await browserTargetReady;
  toolbarView=new BrowserView({webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:resolve(here,'../src/preload.cjs')}});
  browserWindow.addBrowserView(toolbarView);
  void toolbarView.webContents.loadFile(resolve(here,'../src/browser-toolbar.html'));
  layoutBrowser();
  miniWindow=new BrowserWindow({width:320,height:190,minWidth:280,minHeight:160,show:false,alwaysOnTop:true,title:'Easyhunt · 浏览器小窗',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:resolve(here,'../src/preload.cjs')}});
  miniWindow.on('close',event=>{if(!quitting){event.preventDefault();miniWindow?.hide();}});
  void miniWindow.loadFile(resolve(here,'../src/browser-mini.html'));
}
async function createWindow(){
  mainWindow=new BrowserWindow({width:1360,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:resolve(here,'../src/preload.cjs')}});
  const devUrl=process.env.EASYHUNT_WEB_DEV_URL;
  if(devUrl)void mainWindow.loadURL(devUrl);else void mainWindow.loadFile(resolve(webDir,'index.html'));
  mainWindow.on('close',event=>{if(process.platform==='darwin'&&!quitting){event.preventDefault();mainWindow?.hide();miniWindow?.hide();}});
  await createBrowserSurface();
  mainWindow.on('focus',()=>{
    const contents=browserView?.webContents;
    if(contents&&!contents.isDestroyed()&&contents.getURL()!==`${apiBase}/bridge/view`&&!miniWindow?.isDestroyed())miniWindow?.showInactive();
  });
}
function createTray(){const icon=nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9jXYQAAAAASUVORK5CYII=');tray=new Tray(icon);tray.setToolTip('Easyhunt');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 Easyhunt',click:()=>mainWindow?.show()},{label:'退出',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',()=>mainWindow?.show());}
ipcMain.handle('cloud-request',(_e,path:string,method='GET',body?:unknown)=>forward(cloudBase,path,method,body,true));
ipcMain.handle('rpa-request',(_e,path:string,method='GET',body?:unknown)=>forward(apiBase,path,method,path==='/workflows/boss/agent'&&accessToken?{...(body as object),cloudAccessToken:accessToken}:body));
ipcMain.handle('save-local-resume',(_e,record:unknown)=>{const value=JSON.stringify(record),sourceText=typeof (record as {sourceText?:unknown})?.sourceText==='string'?(record as {sourceText:string}).sourceText.replace(/\s+/g,' ').trim():value,contentHash=createHash('sha256').update(sourceText).digest('hex'),localRef=randomUUID(),dir=storageSettings().resume;mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${localRef}.json`),value,{flag:'wx'});return{localRef,contentHash};});
ipcMain.handle('import-local-pdfs',async(_e,job:unknown)=>{
  const picked=await dialog.showOpenDialog(mainWindow!,{title:'选择本地 PDF 简历',properties:['openFile','multiSelections'],filters:[{name:'PDF 简历',extensions:['pdf']}]});
  if(picked.canceled||!picked.filePaths.length)return null;
  if(picked.filePaths.length>10)throw new Error('一次最多导入 10 份 PDF 简历');
  for(const path of picked.filePaths){if(extname(path).toLowerCase()!=='.pdf'||statSync(path).size>20_000_000)throw new Error('每份文件必须是小于 20 MB 的 PDF');}
  const response=await fetch(`${apiBase}/resumes/import-local-pdfs`,{method:'POST',headers:{'content-type':'application/json','x-easyhunt-bridge-secret':bridgeSecret},body:JSON.stringify({pdfPaths:picked.filePaths,job})});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error?.message??`本地简历导入失败 (${response.status})`);
  return data;
});
ipcMain.handle('read-local-resume',(_e,ref:string)=>{if(!/^[a-f0-9-]{36}$/.test(ref))throw new Error('Invalid local reference');const path=join(storageSettings().resume,`${ref}.json`);return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;});
ipcMain.handle('open-local-attachment',async(_e,path:string)=>{
  /* DESIGN-DECISION: 无原始证据，自研 */
  // The renderer may only open resume attachments within the configured local directory.
  const root=realpathSync(storageSettings().resumeAttachment),target=realpathSync(path);
  if(!target.startsWith(root+sep)||!['.pdf','.doc','.docx','.txt','.md','.html'].includes(extname(target).toLowerCase())||!existsSync(target))throw new Error('原始附件不在本地简历目录');
  const error=await shell.openPath(target);if(error)throw new Error(error);
  return true;
});
ipcMain.handle('local-state-read',()=>{const path=join(dataDir(),'workspace.json');return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};});
ipcMain.handle('local-state-write',(_e,value:unknown)=>{const data=JSON.stringify(value);if(!value||typeof value!=='object'||data.length>10_000_000)throw new Error('Invalid local state');const path=join(dataDir(),'workspace.json');const temporary=`${path}.tmp`;writeFileSync(temporary,data,{mode:0o600});renameSync(temporary,path);return true;});
ipcMain.handle('show-browser',(_e,show:boolean)=>showBrowser(Boolean(show)));
ipcMain.handle('browser-preview',async()=>{if(!browserView||browserView.webContents.isDestroyed())return null;try{const image=await browserView.webContents.capturePage();return image.resize({width:560}).toDataURL();}catch{return null;}});
ipcMain.handle('browser-status',async()=>{
  const contents=browserView?.webContents;
  const url=contents&&!contents.isDestroyed()?contents.getURL():'';
  const loginRequired=/\/web\/user|login|passport/i.test(url);
  let platformPage=false;
  try{const host=new URL(url).hostname;platformPage=host==='zhipin.com'||host.endsWith('.zhipin.com');}catch{}
  // A platform URL alone cannot prove that the account is signed in. Only
  // login routes are classified with certainty until a verified DOM signal exists.
  return { state:!url||url===`${apiBase}/bridge/view`?'not-opened':loginRequired?'login-required':platformPage?'login-unknown':'away-from-platform', url, windowOpen:Boolean(browserWindow&&!browserWindow.isDestroyed()&&browserWindow.isVisible()), miniVisible:Boolean(miniWindow&&!miniWindow.isDestroyed()&&miniWindow.isVisible()) };
});
ipcMain.handle('clear-browser-data',async()=>{
  const response=await fetch(`${apiBase}/bridge/reset-browser-data`,{method:'POST',headers:{'x-easyhunt-bridge-secret':bridgeSecret}});
  if(!response.ok)throw new Error('无法停止本机任务，浏览器数据未清除');
  if(browserWindow&&!browserWindow.isDestroyed())browserWindow.hide();
  if(miniWindow&&!miniWindow.isDestroyed())miniWindow.hide();
  // Clear platform origins only: the workbench uses this Electron session for
  // its own local state, which must survive a platform sign-out.
  const platformOrigins=new Set(['https://www.zhipin.com','https://passport.zhipin.com','https://app.zhipin.com']);
  try{const current=new URL(browserView?.webContents.getURL()??'');if(current.hostname==='zhipin.com'||current.hostname.endsWith('.zhipin.com'))platformOrigins.add(current.origin);}catch{}
  for(const origin of platformOrigins)
    await session.defaultSession.clearStorageData({origin});
  for(const cookie of await session.defaultSession.cookies.get({})){
    if(!cookie.domain?.replace(/^\./,'').endsWith('zhipin.com'))continue;
    const host=cookie.domain.replace(/^\./,'');
    await session.defaultSession.cookies.remove(`https://${host}${cookie.path||'/'}`,cookie.name);
  }
  await session.defaultSession.clearCache();
  if(browserView&&!browserView.webContents.isDestroyed()){
    await browserView.webContents.loadURL(`${apiBase}/bridge/view`);
    browserTargetReady=registerBrowserViewTarget(browserView);
    await browserTargetReady;
  }
  return { cleared:true };
});
ipcMain.handle('browser-controls',async(event,action:string,value?:string)=>{
  if(event.sender!==toolbarView?.webContents||!browserView)throw new Error('Browser controls are restricted to the browser toolbar');
  const contents=browserView.webContents;
  if(action==='state')return{url:contents.getURL(),canGoBack:contents.navigationHistory.canGoBack(),canGoForward:contents.navigationHistory.canGoForward()};
  const operationList=await fetch(`${apiBase}/operations`).then(response=>response.json()) as {items?:{status:string;action:string}[]};
  const active=operationList.items?.some(item=>['pending','running'].includes(item.status)&&!['session.pause','session.resume'].includes(item.action));
  if(active){
    const sessions=await fetch(`${apiBase}/sessions`).then(response=>response.json()) as {sessions?:{paused:boolean}[]};
    if(!sessions.sessions?.[0]?.paused)throw new Error('请先点击「人工接管」暂停任务，再手动导航浏览器');
  }
  if(action==='back'&&contents.navigationHistory.canGoBack())contents.navigationHistory.goBack();
  else if(action==='forward'&&contents.navigationHistory.canGoForward())contents.navigationHistory.goForward();
  else if(action==='reload')contents.reload();
  else if(action==='go'){
    const address=new URL(/^https?:\/\//i.test(value??'')?value!:`https://${value??''}`);
    if(!['https:','http:'].includes(address.protocol))throw new Error('Only HTTP(S) addresses are supported');
    await contents.loadURL(address.href);
  }else if(!['back','forward','reload'].includes(action))throw new Error('Unknown browser action');
  return{url:contents.getURL()};
});
ipcMain.handle('open-agreement',()=>{const win=new BrowserWindow({parent:mainWindow,modal:true,width:750,height:650,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});win.loadFile(resolve(webDir,'agency-agreement.html'));});
ipcMain.handle('storage-settings-read',()=>readStorageSettings());
ipcMain.handle('storage-settings-pick',async()=>{const result=await dialog.showOpenDialog(mainWindow!,{properties:['openDirectory','createDirectory']});if(result.canceled)return null;approvedStoragePaths.add(result.filePaths[0]);return result.filePaths[0];});
ipcMain.handle('storage-settings-write',(_e,value:StorageSettings)=>{const current=readStorageSettings();if(!value||!(['dataRoot','resume','resumeAttachment'] as const).every(key=>typeof value[key]==='string'&&isAbsolute(value[key])&&(approvedStoragePaths.has(value[key])||Object.values(current).includes(value[key]))))throw new Error('Invalid storage location');for(const key of ['dataRoot','resume','resumeAttachment'] as const){mkdirSync(value[key],{recursive:true});verifyStorageMigration(current[key],value[key]);}writeFileSync(storageSettingsPath(),JSON.stringify(value,null,2),{mode:0o600});return{saved:true,restartRequired:true};});
ipcMain.handle('app-restart',()=>{app.relaunch();app.quit();});
app.whenReady().then(async()=>{console.error('Easyhunt ready');restoreToken();console.error('token restored');await startEngine();console.error('engine ready');await createWindow();console.error('window ready');createTray();if(app.isPackaged&&process.env.EASYHUNT_UPDATE_URL){autoUpdater.setFeedURL({provider:'generic',url:process.env.EASYHUNT_UPDATE_URL});void autoUpdater.checkForUpdatesAndNotify().catch(e=>console.error('Updater:',e));}}).catch(e=>{console.error(e);app.quit();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});app.on('before-quit',()=>{quitting=true;engine?.kill();});
