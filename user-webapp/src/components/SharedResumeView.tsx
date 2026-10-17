import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { cloud } from '../client';

export type SharedResumeSummary = { id: string; resume_id: string; display_name: string; expires_at: string; permission: 'READ' | 'EDIT' };
type SharedResume = { permission: 'READ' | 'EDIT' | 'OWNER'; content: { sourceText: string }; expiresAt: string };

/* DESIGN-DECISION: 无原始证据，自研 */
// The recipient edits only the explicitly shared text, never the owner's local PDF.
export function SharedResumeView({ share, onClose, notify }: { share: SharedResumeSummary; onClose: () => void; notify: (message: string) => void }) {
  const [detail, setDetail] = useState<SharedResume | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void cloud(`/resume/${share.resume_id}/shares/${share.id}`).then((value: SharedResume) => {
      if (!active) return;
      setDetail(value);
      setDraft(value.content.sourceText);
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [share.id, share.resume_id]);
  async function save() {
    if (!detail || detail.permission !== 'EDIT' || !draft.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await cloud(`/resume/${share.resume_id}/shares/${share.id}`, 'PUT', { content: { sourceText: draft.trim(), document: null } });
      setDetail({ ...detail, content: { sourceText: draft.trim() } });
      notify('分享内容已保存');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="shared-resume-title">
      <div className="modal-head"><div><small className="eyebrow">SHARED RESUME</small><h2 id="shared-resume-title">{share.display_name}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭分享"><X size={18}/></button></div>
      {error && <p className="error" role="alert">{error}</p>}
      {!detail && !error && <p className="muted">正在读取分享内容…</p>}
      {detail && <><p className="muted">{detail.permission === 'EDIT' ? '可编辑分享文字' : '只读'} · 有效期至 {new Date(detail.expiresAt).toLocaleString('zh-CN')}。内容由简历所有者选择并上传，原始 PDF 保存在其本机。</p>
        <label htmlFor="shared-resume-text">分享的简历文字</label>
        <textarea id="shared-resume-text" className="shared-resume-text" value={draft} onChange={event => setDraft(event.target.value)} readOnly={detail.permission !== 'EDIT'} maxLength={10000} rows={14}/>
        <div className="modal-actions"><button onClick={onClose}>关闭</button>{detail.permission === 'EDIT' && <button className="button-dark" disabled={busy || !draft.trim() || draft.trim() === detail.content.sourceText} onClick={() => void save()}>{busy ? '保存中…' : '保存修改'}</button>}</div>
      </>}
    </div>
  </div>;
}
