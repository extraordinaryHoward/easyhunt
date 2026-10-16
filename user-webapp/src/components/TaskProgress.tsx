import { ChevronRight } from 'lucide-react';
import { taskCounts, type TaskRun } from '../task-run';

type ResumeIndex = { status?: string; stars?: number };

export function TaskProgress({ run, resumes, platform, paused, onDetails }: {
  run: TaskRun | null;
  resumes: ResumeIndex[];
  platform: string;
  paused: boolean;
  onDetails: () => void;
}) {
  const counts = taskCounts(resumes, run);
  const last = run?.events?.at(-1);
  const status = !run ? '待启动' : paused && run.status === 'running' ? '人工接管中' : ({ pending: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[run.status] ?? run.status;
  const target = run?.events?.find(event => event.data?.targetCount)?.data?.targetCount;
  const progress = run?.status === 'succeeded' ? 100 : target ? Math.min(99, Math.round(counts.quick / target * 100)) : 0;
  const metrics: Array<[string, number | string]> = [
    ['平台', platform], ['快筛', counts.quick], ['初筛', counts.initial],
    ['四星以上', counts.fourStars], ['已入库', counts.indexed], ['晋级', counts.promoted],
  ];
  return <div className="progress-card">
    <div className="progress-line"><strong>{platform} · {last?.message ?? '等待启动任务'}</strong><span className={`run-status ${run?.status ?? 'idle'}`}>{status}</span></div>
    {run && <><div className="progress-track"><span style={{ width: `${progress}%` }}/></div><div className="progress-note">{last?.at ? new Date(last.at).toLocaleString('zh-CN') : '—'}{target ? ` · ${counts.quick} / ${target}` : ''}</div></>}
    <div className="metric-grid">{metrics.map(([label,value])=><div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
    {run?.error && <p className="run-error">{run.error}</p>}
    <button className="task-details-link" onClick={onDetails} disabled={!run}>任务详情 <ChevronRight size={15}/></button>
  </div>;
}
