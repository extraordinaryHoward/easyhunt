import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, X } from 'lucide-react';
import type { LocalResume } from '../client';
import type { Resume } from './Workbench';

type Decision = { id: string; decision_status: string; decision_reason?: string | null; created_at: string };
const labels: Record<string,string> = { PROMOTED:'晋级', CONSIDERING:'考虑', REJECTED:'淘汰' };
const fieldLabels: Record<string,string> = { name:'姓名', expectedCity:'期望城市', expectedTitle:'期望职位', expectedSalaryText:'期望薪资', currentCity:'所在城市', totalExperienceYears:'工作年限', industry:'行业', skills:'技能', phone:'电话', email:'邮箱', wechat:'微信' };
function valueText(value: unknown): string {
  if (Array.isArray(value)) return value.map(valueText).join(' · ');
  if (value && typeof value === 'object') return Object.values(value).filter(Boolean).map(valueText).join(' · ');
  return String(value ?? '');
}

export function ResumeReader({ record, row, history, position, total, onClose, onMove, onDecision, onAttachment }: {
  record: LocalResume;
  row: Resume | null;
  history: Decision[];
  position: number;
  total: number;
  onClose: () => void;
  onMove: (direction: -1 | 1) => void;
  onDecision: (status: string, reason: string) => void;
  onAttachment: (path: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const sourceRef = useRef<HTMLElement>(null);
  const markedRef = useRef<HTMLElement>(null);
  useEffect(() => { setEvidence(''); setReason(''); }, [record.candidateRef]);
  useEffect(() => { if (!evidence) return; (markedRef.current ?? sourceRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [evidence]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft' && position > 0) onMove(-1);
      if (event.key === 'ArrowRight' && position < total - 1) onMove(1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, onMove, position, total]);
  const jump = (value: string) => { setEvidence(value); if (evidence === value) (markedRef.current ?? sourceRef.current)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  const lines = record.sourceText.split(/\n+/).map(line=>line.trim()).filter(Boolean);
  return <div className="overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="modal detail-modal resume-reader">
      <div className="modal-head"><div><small className="eyebrow">CANDIDATE / {position+1} OF {total}</small><h2>{record.name}</h2><p><span className="stars">{'★'.repeat(record.stars)}{'☆'.repeat(5-record.stars)}</span> · {row?.platform?.toUpperCase() ?? '本地简历'} · {labels[row?.status ?? ''] ?? '待处理'}</p></div><div className="reader-nav"><button disabled={position<=0} onClick={()=>onMove(-1)} title="上一份 · ←"><ArrowLeft size={17}/></button><button disabled={position>=total-1} onClick={()=>onMove(1)} title="下一份 · →"><ArrowRight size={17}/></button><button onClick={onClose} aria-label="关闭"><X size={18}/></button></div></div>
      <div className="reader-grid"><div className="reader-body">
        <section className="reader-section"><h3>简历内容</h3>{record.structured && Object.keys(record.structured).length > 0 ? <>{Object.entries(record.structured).filter(([key,value])=>!['workExperiences','educationExperiences'].includes(key)&&value!==undefined&&value!==null).map(([key,value])=><div className="reader-field" key={key}><small>{fieldLabels[key]??key}</small><span>{valueText(value)}</span></div>)}{(['workExperiences','educationExperiences'] as const).map(key=>Array.isArray(record.structured?.[key])&&record.structured[key].length>0?<div className="reader-history" key={key}><h4>{key==='workExperiences'?'工作经历':'教育经历'}</h4>{(record.structured[key] as unknown[]).map((item,index)=><p className="reader-line" key={index}>{valueText(item)}</p>)}</div>:null)}</> : <><p className="muted">当前只有平台已展示的候选人信息；未采集到完整附件时不补造经历。</p>{lines.map((line,index)=><p className="reader-line" key={index}>{line}</p>)}</>}</section>
        <section className="reader-section" ref={sourceRef}><div className="reader-section-head"><h3>本地原文</h3>{record.attachmentPath && <button onClick={()=>onAttachment(record.attachmentPath!)}><ExternalLink size={15}/>打开原文件</button>}</div>{evidence && !record.sourceText.includes(evidence) && <p className="muted">该证据片段未出现在当前本地原文中</p>}{record.sourceText ? <pre className="reader-source">{evidence && record.sourceText.includes(evidence) ? <>{record.sourceText.slice(0,record.sourceText.indexOf(evidence))}<mark ref={markedRef}>{evidence}</mark>{record.sourceText.slice(record.sourceText.indexOf(evidence)+evidence.length)}</> : record.sourceText}</pre> : <p className="muted">暂无可读取的原文</p>}</section>
      </div><aside className="reader-side">
        <section className="reader-section"><h3>匹配分析 <span>{record.stars} / 5 星</span></h3><p className="muted">评分画像：{record.profileVersionId ? record.profileVersionId.slice(0,8) : '历史版本未记录'}。画像变更后需主动重新分析。</p>{(['matched','mismatched','pending'] as const).map(key=><div className="reader-analysis" key={key}><h4>{({matched:'匹配项',mismatched:'不匹配项',pending:'待确认项'})[key]} · {record.analysis[key].length}</h4>{record.analysis[key].map((item,index)=><div className="analysis-item" key={index}><strong>{item.content}</strong>{item.evidence?.length ? item.evidence.map((quote,i)=><button className="evidence-link" key={i} onClick={()=>jump(quote)} title="定位到本地原文">{quote}</button>) : <small>暂无原文证据</small>}</div>)}</div>)}</section>
        <section className="reader-section"><h3>决策</h3><label>决策原因（可选）<textarea rows={3} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} placeholder="记录判断依据"/></label><div className="reader-decisions">{Object.entries(labels).map(([status,label])=><button key={status} onClick={()=>{onDecision(status,reason);setReason('');}}>{label}</button>)}</div><h4>决策历史</h4>{history.length ? history.map(item=><div className="decision-history" key={item.id}><strong>{labels[item.decision_status] ?? item.decision_status}</strong><small>{new Date(item.created_at).toLocaleString('zh-CN')}</small>{item.decision_reason && <p>{item.decision_reason}</p>}</div>) : <p className="muted">暂无决策记录</p>}</section>
      </aside></div>
    </div>
  </div>;
}
