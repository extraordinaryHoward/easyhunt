import type { LocalResume } from './client';
type Candidate = { candidateRef: string; name: string; summary: string; initialScreen?: { excerpt?: string } };
type Portrait = { hardConditions?: Array<{ content: string }> };

/* DESIGN-DECISION: 无原始证据，自研 */
// A browser card is not a full PDF resume. Score only observed, quoted text;
// absent conditions remain pending for a human instead of becoming false negatives.
export function summarizeCandidate(candidate: Candidate, portrait: Portrait): LocalResume {
  const sourceText = [candidate.summary, candidate.initialScreen?.excerpt].filter(Boolean).join('\n');
  const conditions = portrait.hardConditions ?? [];
  const matched: LocalResume['analysis']['matched'] = [];
  const pending: LocalResume['analysis']['pending'] = [];
  for (const condition of conditions) {
    const token = condition.content.trim();
    if (token && sourceText.toLowerCase().includes(token.toLowerCase())) {
      const line = sourceText.split('\n').find(item => item.toLowerCase().includes(token.toLowerCase())) ?? sourceText;
      matched.push({ content: token, evidence: [line] });
    } else pending.push({ content: `${token || '条件'}待确认`, evidence: [] });
  }
  if (!conditions.length) pending.push({ content: '等待完整简历与岗位条件复核', evidence: [] });
  const ratio = conditions.length ? matched.length / conditions.length : 0;
  const stars = Math.max(1, Math.min(5, Math.round(1 + ratio * 4)));
  return { name: candidate.name, candidateRef: candidate.candidateRef, sourceText, stars, analysis: { matched, mismatched: [], pending }, createdAt: new Date().toISOString() };
}
