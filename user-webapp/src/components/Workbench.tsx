import { useEffect, useState } from 'react';
import { BriefcaseBusiness, ChevronDown, CircleHelp, ClipboardList, Database, FolderOpen, Globe2, ListPlus, Monitor, Puzzle, Radar, Settings2, Sparkles, UserRound, X } from 'lucide-react';
import { restartApp, storageSettingsPick, storageSettingsRead, storageSettingsWrite, type StorageSettings } from '../client';

export type Project = { id: string; title: string; description?: string; created_at?: string; recruitment_config?: Record<string, any>; recruitmentConfig?: Record<string, any> };
export type Resume = { id: string; project_id: string; local_ref: string; display_name: string; stars: number; status: string; platform?: string; expected_title?: string; created_at?: string };
export const projectConfig = (project: Project | null) => project?.recruitment_config ?? project?.recruitmentConfig ?? {};
export const platformName = (value?: string) => ({ boss: 'BOSS 直聘', liepin: '猎聘', liepin_enterprise: '猎聘企业端', zhaopin: '智联招聘' } as Record<string, string>)[value ?? ''] ?? value ?? '未设置';
export const decisionLabel = (status?: string) => ({ NEW: '待处理', PROMOTED: '晋级', CONSIDERING: '考虑', REJECTED: '淘汰' } as Record<string, string>)[status ?? ''] ?? '待处理';

export function Sidebar({ page, projects, current, onPage, onProject }: { page: string; projects: Project[]; current: Project | null; onPage: (value: string) => void; onProject: (value: Project) => void }) {
  const [accountOpen, setAccountOpen] = useState(false);
  return <aside className="sidebar">
    <div className="brand"><div className="brand-mark"><Radar size={21} strokeWidth={2.25}/></div><div><strong>Easyhunt</strong><small>RECRUITING SYSTEM</small></div></div>
    <div className="side-group side-primary"><button className={page === 'wizard' ? 'active' : ''} onClick={() => onPage('wizard')}><ListPlus size={18}/>新职位</button><button className={page === 'projects' ? 'active' : ''} onClick={() => onPage('projects')}><BriefcaseBusiness size={18}/>全部职位</button><div className="side-label">近期职位 <ChevronDown size={14}/></div><div className="recent-list">{projects.slice(0, 5).map(project => <button key={project.id} className={current?.id === project.id && page === 'workspace' ? 'active recent' : 'recent'} onClick={() => onProject(project)} title={project.title}><span className="recent-dot"/><span className="truncate">{project.title}</span></button>)}{projects.length === 0 && <span className="side-hint">创建职位后会显示在这里</span>}</div></div>
    <div className="side-spacer"/>
    <div className="side-group side-bottom"><button className={page === 'skill' ? 'active' : ''} onClick={() => onPage('skill')}><Puzzle size={18}/>寻访 Skill</button><button onClick={() => onPage('browser')}><Monitor size={18}/>打开浏览器</button><button className={page === 'platforms' ? 'active' : ''} onClick={() => onPage('platforms')}><Globe2 size={18}/>平台管理</button></div>
    <div className="account-wrap"><button className="account-trigger" onClick={() => setAccountOpen(!accountOpen)} aria-expanded={accountOpen}><span className="account-avatar"><UserRound size={19}/></span><span><strong>本地工作台</strong><small>无需登录</small></span><ChevronDown size={16}/></button>{accountOpen && <div className="account-menu"><div className="account-menu-title">Easyhunt · 本地模式</div><button onClick={() => { onPage('settings'); setAccountOpen(false); }}><Settings2 size={16}/>系统设置</button><button onClick={() => { onPage('account'); setAccountOpen(false); }}><CircleHelp size={16}/>账户与服务</button></div>}</div>
  </aside>;
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) { return <div className="empty-state"><div className="empty-icon"><ClipboardList size={25}/></div><strong>{title}</strong><p>{detail}</p>{action}</div>; }

export function SectionTitle({ eyebrow, title, trailing }: { eyebrow?: string; title: string; trailing?: React.ReactNode }) { return <div className="section-title"><div>{eyebrow && <small>{eyebrow}</small>}<h2>{title}</h2></div>{trailing}</div>; }

export function StorageSettingsView({ onClose, notify }: { onClose: () => void; notify: (message: string) => void }) {
  const [value, setValue] = useState<StorageSettings | null>(null), [changed, setChanged] = useState(false), [saving, setSaving] = useState(false);
  useEffect(() => { storageSettingsRead().then(setValue).catch(error => notify(String(error))); }, []);
  const fields: Array<{ key: keyof StorageSettings; title: string; detail: string }> = [
    { key: 'dataRoot', title: '本机数据存储位置', detail: '项目索引与本地工作状态' },
    { key: 'resume', title: '简历存储位置', detail: '简历解析结果与原文' },
    { key: 'resumeAttachment', title: '附件简历存储位置', detail: '下载的 PDF 附件' }
  ];
  async function pick(key: keyof StorageSettings) { const path = await storageSettingsPick(); if (path && value) { setValue({ ...value, [key]: path }); setChanged(true); } }
  async function save() { if (!value) return; setSaving(true); try { await storageSettingsWrite(value); setChanged(false); notify('目录已保存。重启后新位置生效，原目录数据不会自动迁移。'); } catch (error) { notify(error instanceof Error ? error.message : String(error)); } finally { setSaving(false); } }
  return <div className="settings-page"><div className="settings-head"><div><small className="eyebrow">PREFERENCES / 01</small><h1>系统设置</h1></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18}/></button></div><div className="settings-layout"><nav className="settings-nav"><button className="active"><Database size={16}/>存储位置</button><button onClick={() => notify('当前版本的通用设置由桌面客户端管理。')}><Settings2 size={16}/>通用</button></nav><div className="settings-content"><h2>存储位置</h2><p className="muted">简历原文默认保存在这台电脑。更改目录后请重启应用；原有文件需要自行迁移。</p>{fields.map(field => <div className="storage-field" key={field.key}><label>{field.title}</label><small>{field.detail}</small><div className="storage-input"><input readOnly value={value?.[field.key] ?? '读取中…'} aria-label={field.title}/><button onClick={() => pick(field.key)} disabled={!value}><FolderOpen size={16}/>选择文件夹</button></div></div>)}<div className="settings-actions"><button className="button-primary" onClick={save} disabled={!changed || saving}>保存设置</button><button onClick={() => restartApp()}>重启应用</button></div></div></div></div>;
}

export function ModeIcon({ target }: { target: boolean }) { return target ? <Sparkles size={23}/> : <UserRound size={23}/>; }
