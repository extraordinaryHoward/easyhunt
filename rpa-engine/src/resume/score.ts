import type { Job, Resume } from './schema.js';

export type AnalysisItem = { content: string; evidence: string[] };
export type Analysis = { matched: AnalysisItem[]; mismatched: AnalysisItem[]; pending: AnalysisItem[] };
export type ScoreResult = { stars: 1 | 2 | 3 | 4 | 5; score: number; analysis: Analysis };
export type ResumeScorer = (resume: Resume, job: Job, sourceText: string) => Promise<ScoreResult>;

const degrees = ['不限', '专科', '本科', '硕士', '博士'];
function excerpt(text: string, token: string): string | undefined {
  if (!token) return undefined;
  const at = text.toLowerCase().indexOf(token.toLowerCase());
  if (at < 0) return undefined;
  const start = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at);
  return text.slice(start, end < 0 ? text.length : end).trim();
}

/* DESIGN-DECISION: 无原始证据，自研 */
// Deterministic first-pass score. Evidence is always an exact PDF text excerpt;
// absence is pending rather than a fabricated negative citation.
export function ruleScore(resume: Resume, job: Job, sourceText: string): ScoreResult {
  const analysis: Analysis = { matched: [], mismatched: [], pending: [] };
  const weights = job.weights;
  const total = weights.degree + weights.experience + weights.skills;
  if (total <= 0) throw new Error('score weights must have a positive sum');
  const degree = resume.educationExperiences[0]?.degree;
  let degreeScore = 0;
  if (job.minimumDegree === '不限') { degreeScore = 1; analysis.matched.push({ content: '学历不限', evidence: degree ? [excerpt(sourceText, degree) ?? degree] : [] }); }
  else if (!degree) analysis.pending.push({ content: `学历待确认，要求${job.minimumDegree}`, evidence: [] });
  else {
    const evidence = excerpt(sourceText, degree);
    if (degrees.indexOf(degree) >= degrees.indexOf(job.minimumDegree)) { degreeScore = 1; analysis.matched.push({ content: `学历符合${job.minimumDegree}要求`, evidence: evidence ? [evidence] : [] }); }
    else analysis.mismatched.push({ content: `学历${degree}低于${job.minimumDegree}要求`, evidence: evidence ? [evidence] : [] });
  }
  let experienceScore = 0;
  const years = resume.totalExperienceYears;
  if (years === undefined) analysis.pending.push({ content: '工作年限待确认', evidence: [] });
  else {
    const evidence = excerpt(sourceText, '工作年限');
    if (years >= job.minimumExperienceYears) { experienceScore = 1; analysis.matched.push({ content: `工作年限${years}年符合要求`, evidence: evidence ? [evidence] : [] }); }
    else analysis.mismatched.push({ content: `工作年限${years}年低于${job.minimumExperienceYears}年要求`, evidence: evidence ? [evidence] : [] });
  }
  let skillHits = 0;
  for (const required of job.requiredSkills) {
    const declared = resume.skills.some(skill => skill.toLowerCase() === required.toLowerCase());
    const evidence = declared ? excerpt(sourceText, required) : undefined;
    if (declared && evidence) { skillHits++; analysis.matched.push({ content: `技能命中：${required}`, evidence: [evidence] }); }
    else analysis.pending.push({ content: `技能未确认：${required}`, evidence: [] });
  }
  const score = Math.round(100 * (degreeScore * weights.degree + experienceScore * weights.experience + skillHits / job.requiredSkills.length * weights.skills) / total);
  const stars = Math.max(1, Math.min(5, Math.ceil(score / 20))) as ScoreResult['stars'];
  return { stars, score, analysis };
}
