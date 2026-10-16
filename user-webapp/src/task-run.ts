export type TaskEvent = { sequence: number; type: string; message: string; at: string; data?: Record<string, number> };
export type TaskRun = { id?: string; operation_id: string; project_id: string; platform: string; status: string; events: TaskEvent[]; metrics: { collectedCount?: number; initialCount?: number; pagesRead?: number; indexedCount?: number }; error?: string | null; created_at?: string; updated_at?: string };

const metricKeys = ['pageNumber', 'pages', 'count', 'collectedCount', 'initialCount', 'pagesRead', 'pageCount', 'targetCount'] as const;
export function publicTaskSnapshot(operation: any, platform: string) {
  /* DESIGN-DECISION: 无原始证据，自研 */
  // Only aggregate progress leaves this computer. Candidate refs, names, excerpts and resumes are omitted.
  const events: TaskEvent[] = (operation.events ?? []).slice(-500).map((item: any) => {
    const data: Record<string, number> = {};
    for (const key of metricKeys) if (Number.isInteger(item.data?.[key]) && item.data[key] >= 0) data[key] = item.data[key];
    return { sequence: item.sequence, type: String(item.type), message: String(item.message), at: String(item.at), ...(Object.keys(data).length ? { data } : {}) };
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
    error: operation.error?.message ?? null,
  };
}

export function taskCounts(resumes: Array<{ status?: string; stars?: number }>, run?: TaskRun | null) {
  return {
    quick: run?.metrics.collectedCount ?? 0,
    initial: run?.metrics.initialCount ?? 0,
    fourStars: resumes.filter(item => (item.stars ?? 0) >= 4).length,
    indexed: resumes.length,
    promoted: resumes.filter(item => item.status === 'PROMOTED').length,
    considering: resumes.filter(item => item.status === 'CONSIDERING').length,
    rejected: resumes.filter(item => item.status === 'REJECTED').length,
    todo: resumes.filter(item => !item.status || item.status === 'NEW' || item.status === 'indexed').length,
  };
}
