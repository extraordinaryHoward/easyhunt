import { localCloud } from './local-cloud';
export type Reply<T = any> = { status: number; body: T };
export type LocalResume = { name: string; sourceText: string; stars: number; analysis: { matched: Array<{ content: string; evidence: string[] }>; mismatched: Array<{ content: string; evidence: string[] }>; pending: Array<{ content: string; evidence: string[] }> }; candidateRef: string; createdAt: string; attachmentPath?: string; structured?: Record<string, unknown>; profileVersionId?: string };
export type StorageSettings = { dataRoot: string; resume: string; resumeAttachment: string };
export class ApiRequestError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'ApiRequestError'; }
}
declare global { interface Window { easyhunt?: { cloud(path: string, method?: string, body?: unknown): Promise<Reply>; rpa(path: string, method?: string, body?: unknown): Promise<Reply>; saveLocalResume(record: LocalResume): Promise<{ localRef: string; contentHash: string }>; readLocalResume(localRef: string): Promise<LocalResume | null>; importLocalPdfs(job: unknown): Promise<any>; browserStatus(): Promise<{ state:string; url:string; windowOpen:boolean; miniVisible:boolean }>; clearBrowserData(): Promise<{ cleared:boolean }>; openLocalAttachment(path: string): Promise<boolean>; localStateRead(): Promise<unknown>; localStateWrite(value: unknown): Promise<boolean>; showBrowser(show: boolean): Promise<void>; openAgreement(): Promise<void>; storageSettingsRead(): Promise<StorageSettings>; storageSettingsPick(): Promise<string|null>; storageSettingsWrite(value: StorageSettings): Promise<{saved:boolean;restartRequired:boolean}>; restartApp(): Promise<void> } } }
let browserToken = '';
const cloudBase = import.meta.env.VITE_CLOUD_BASE_URL ?? 'http://127.0.0.1:4320';
const rpaBase = import.meta.env.VITE_RPA_BASE_URL ?? 'http://127.0.0.1:4317';
export const isLocalMode = import.meta.env.VITE_CLOUD_MODE !== 'remote';
async function direct(base: string, path: string, method: string, body?: unknown, cloud = false): Promise<Reply> {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(cloud && browserToken ? { authorization: `Bearer ${browserToken}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (cloud && path === '/auth/login' && response.ok) browserToken = data.accessToken;
  return { status: response.status, body: data };
}
export async function cloud(path: string, method = 'GET', body?: unknown) { if (isLocalMode) return localCloud(path, method, body); const reply = window.easyhunt ? await window.easyhunt.cloud(path, method, body) : await direct(cloudBase, path, method, body, true); if (reply.status >= 400) throw new Error(reply.body?.error?.message ?? `Cloud HTTP ${reply.status}`); return reply.body; }
export async function rpa(path: string, method = 'GET', body?: unknown) { const reply = window.easyhunt ? await window.easyhunt.rpa(path, method, body) : await direct(rpaBase, path, method, body); if (reply.status >= 400) throw new ApiRequestError(reply.body?.error?.message ?? `RPA HTTP ${reply.status}`, reply.status, reply.body?.error?.code); return reply.body; }
export async function saveLocalResume(record: LocalResume) {
  if (window.easyhunt) return window.easyhunt.saveLocalResume(record);
  const bytes = new TextEncoder().encode(record.sourceText.replace(/\s+/g,' ').trim());
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(x => x.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(`easyhunt-resume-${hash}`, JSON.stringify(record));
  return { localRef: hash, contentHash: hash };
}
export async function readLocalResume(localRef: string) { return window.easyhunt ? window.easyhunt.readLocalResume(localRef) : JSON.parse(localStorage.getItem(`easyhunt-resume-${localRef}`) ?? 'null') as LocalResume | null; }
export async function importLocalPdfs(job: unknown) { if (!window.easyhunt) throw new Error('请在桌面客户端导入本地 PDF'); return window.easyhunt.importLocalPdfs(job); }
export async function openLocalAttachment(path: string) { if (!window.easyhunt) throw new Error('请在桌面客户端打开原始附件'); return window.easyhunt.openLocalAttachment(path); }
export async function showBrowser(show: boolean) { await window.easyhunt?.showBrowser(show); }
export async function browserStatus() { return window.easyhunt?.browserStatus() ?? { state:'desktop-only', url:'', windowOpen:false, miniVisible:false }; }
export async function clearBrowserData() { if(!window.easyhunt)throw new Error('请在桌面客户端清除浏览器数据');return window.easyhunt.clearBrowserData(); }
export async function openAgreement() { await window.easyhunt?.openAgreement(); }
export async function storageSettingsRead(): Promise<StorageSettings> { return window.easyhunt?.storageSettingsRead() ?? {dataRoot:'浏览器预览：仅桌面客户端可配置',resume:'',resumeAttachment:''}; }
export async function storageSettingsPick(): Promise<string|null> { return window.easyhunt?.storageSettingsPick() ?? null; }
export async function storageSettingsWrite(value: StorageSettings) { if (!window.easyhunt) throw new Error('请在桌面客户端配置存储位置'); return window.easyhunt.storageSettingsWrite(value); }
export async function restartApp() { await window.easyhunt?.restartApp(); }
