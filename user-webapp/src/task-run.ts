export type TaskEvent = { sequence: number; type: string; message: string; at: string; data?: Record<string, number> };
export type TaskRun = { id?: string; operation_id: string; project_id: string; platform: string; status: string; events: TaskEvent[]; metrics: { collectedCount?: number; initialCount?: number; pagesRead?: number; indexedCount?: number }; error?: string | null; created_at?: string; updated_at?: string };

/* DESIGN-DECISION: 无原始证据，自研 */
// The RPA queue is in memory. If a saved operation disappears after an engine
// restart, retain its timeline and close the project run with a clear reason.
export function interruptedTaskSnapshot(run: TaskRun) {
  const sequence = Math.max(0, ...run.events.map(event => event.sequence)) + 1;
  const error = 'RPA 引擎重启后任务已中断；请确认平台登录状态并重新启动任务';
  return { operationId: run.operation_id, platform: run.platform, status: 'failed', events: [...run.events.slice(-499), { sequence, type: 'interrupted', message: error, at: new Date().toISOString() }], metrics: run.metrics, error };
}

const metricKeys = ['pageNumber', 'pages', 'count', 'collectedCount', 'initialCount', 'pagesRead', 'pageCount', 'targetCount'] as const;
const safeErrors: Record<string, string> = {
  LOGIN_REQUIRED: '请在独立浏览器完成平台登录后重试',
  RATE_LIMITED: '已达到平台操作频率上限，请稍后重试',
  DOM_UNRECOGNIZED: '平台页面结构未识别，请检查浏览器页面后重试',
  SESSION_NOT_FOUND: '浏览器会话已失效，请重新打开浏览器',
  RESULT_PROCESSING_FAILED: '结果处理失败，请在本机查看错误后重试',
};
function safeTaskMessage(type: string, data: Record<string, number>, errorCode?: string): string {
  switch (type) {
    case 'queued': return '任务已加入队列';
    case 'running': return '任务开始执行';
    case 'browser.ready': return '平台浏览器已连接';
    case 'login.required': return '等待在独立浏览器完成平台登录';
    case 'login.checked': return '已检查平台登录页面';
    case 'search.prepare': return '准备搜索职位候选人';
    case 'search.started': return '搜索条件已应用';
    case 'search.page': return `第 ${data.pagesRead ?? 0} 页读取 ${data.pageCount ?? 0} 人`;
    case 'candidate.quick': return `已快筛 ${data.collectedCount ?? 0} 人`;
    case 'candidate.initial': return `已初筛 ${data.initialCount ?? 0} 人`;
    case 'search.completed': return `搜索完成，采集 ${data.collectedCount ?? 0} 人`;
    case 'succeeded': return '任务已完成';
    case 'cancelled': return '任务已取消';
    case 'failed': return safeErrors[errorCode ?? ''] ?? '任务失败，请在本机查看错误';
    case 'results.failed': return '结果处理失败，请在本机查看错误';
    case 'interrupted': return 'RPA 引擎重启后任务已中断';
    default: return '任务步骤已更新';
  }
}
export function publicTaskSnapshot(operation: any, platform: string) {
  /* DESIGN-DECISION: 无原始证据，自研 */
  // Only aggregate progress leaves this computer. Candidate refs, names, excerpts and resumes are omitted.
  const events: TaskEvent[] = (operation.events ?? []).slice(-500).map((item: any) => {
    const data: Record<string, number> = {};
    for (const key of metricKeys) if (Number.isInteger(item.data?.[key]) && item.data[key] >= 0) data[key] = item.data[key];
    const type = String(item.type);
    return { sequence: item.sequence, type, message: safeTaskMessage(type, data, item.data?.code ?? operation.error?.code), at: String(item.at), ...(Object.keys(data).length ? { data } : {}) };
  });
  const candidates = operation.result?.candidates ?? [];
  const latestCount = [...events].reverse().find(item => item.data?.collectedCount !== undefined)?.data?.collectedCount ?? 0;
  const latestInitial = [...events].reverse().find(item => item.data?.initialCount !== undefined)?.data?.initialCount ?? 0;
  const latestPages = [...events].reverse().find(item => item.data?.pagesRead !== undefined)?.data?.pagesRead ?? 0;
  return {
    operationId: operation.operationId,
    platform,
    status: operation.status,
    events,
    metrics: {
      collectedCount: operation.result?.collectedCount ?? Math.max(candidates.length, latestCount),
      initialCount: Math.max(candidates.filter((item: any) => Boolean(item.initialScreen?.excerpt)).length, latestInitial),
      pagesRead: operation.result?.pagesRead ?? latestPages,
    },
    error: operation.error ? safeErrors[operation.error.code] ?? '任务失败，请在本机查看错误' : null,
  };
}

export function taskCounts(resumes: Array<{ status?: string; stars?: number }>, run?: TaskRun | null) {
  const events = run?.events ?? [];
  return {
    quick: run?.metrics.collectedCount ?? 0,
    initial: run?.metrics.initialCount ?? 0,
    fourStars: resumes.filter(item => (item.stars ?? 0) >= 4).length,
    indexed: resumes.length,
    greet: events.filter(item => item.type === 'greet.completed').length,
    chatCards: events.filter(item => item.type === 'chat-card.completed').length,
    promoted: resumes.filter(item => item.status === 'PROMOTED').length,
    considering: resumes.filter(item => item.status === 'CONSIDERING').length,
    rejected: resumes.filter(item => item.status === 'REJECTED').length,
    todo: resumes.filter(item => isPendingDecision(item.status)).length,
  };
}

export function isPendingDecision(status?: string | null) {
  return !status || status === 'NEW' || status === 'indexed';
}
