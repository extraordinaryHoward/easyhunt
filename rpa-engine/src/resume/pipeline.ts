import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractPdfText, parseResume, proxyExtractor, type ResumeExtractor } from './parse.js';
import { JobSchema, type Job, type Resume } from './schema.js';
import { ruleScore, type ResumeScorer, type ScoreResult } from './score.js';
import { remoteLlmScorer } from './llm-score.js';
import { saveResume, storagePaths, type StoragePaths } from './storage.js';

export const stages = [
  { name: '接收需求', status: '初始状态' }, { name: '准备采集', status: '加载中' },
  { name: '原始数据采集', status: '重点细化' }, { name: '数据清洗过滤', status: '处理中' },
  { name: '结构化解析', status: '处理中' }, { name: '智能标签提取', status: '处理中' },
  { name: '算法权重匹配', status: '计算中' }, { name: '候选人排序筛选', status: '优化中' },
  { name: '结果整合生成', status: '生成中' }, { name: '匹配完成', status: '完成' },
] as const;
export type StageEvent = { name: typeof stages[number]['name']; status: typeof stages[number]['status']; at: string; outcome?: 'completed' | 'failed'; error?: string };
export type ResumeInput = { pdfPath: string; inactive?: boolean; expired?: boolean };
export type CandidateResult = { hash: string; pdfPath: string; resume: Resume; sourceText: string; extractionMethod: 'llm' | 'regex'; extractionError?: string; tags: string[]; score: ScoreResult; localFiles: { attachment: string; parsed: string } };
export type PipelineResult = { runId: string; stages: StageEvent[]; candidates: CandidateResult[]; filtered: Array<{ pdfPath: string; reason: 'duplicate' | 'inactive' | 'expired' }>; failed: Array<{ pdfPath: string; error: string }> };

/* DESIGN-DECISION: 无原始证据，自研 */
// Stage checkpoints run sequentially. A candidate failure is isolated so the
// remaining local PDFs can still finish; every transition is recorded in order.
export async function runResumePipeline(inputs: ResumeInput[], jobInput: Job, options: { paths?: Partial<StoragePaths>; extractor?: ResumeExtractor; scorer?: ResumeScorer; localOnly?: boolean; onStage?: (event: StageEvent) => void } = {}): Promise<PipelineResult> {
  const job = JobSchema.parse(jobInput);
  const paths = storagePaths(options.paths);
  const cloudToken = process.env.EASYHUNT_CLOUD_ACCESS_TOKEN;
  const scorer = options.scorer ?? (!options.localOnly && process.env.EASYHUNT_ALLOW_REMOTE_RESUME_PROCESSING === 'true' && cloudToken ? remoteLlmScorer({ baseUrl: process.env.EASYHUNT_CLOUD_BASE_URL ?? 'http://127.0.0.1:4320', accessToken: cloudToken, allowRemoteResumeProcessing: true }) : async (resume: Resume, job: Job, sourceText: string) => ruleScore(resume, job, sourceText));
  const result: PipelineResult = { runId: randomUUID(), stages: [], candidates: [], filtered: [], failed: [] };
  const seen = new Set<string>();
  const raw: Array<{ input: ResumeInput; pdf: Buffer; hash: string; sourceText: string }> = [];
  const cleaned: typeof raw = [];
  const parsed: Array<{ input: ResumeInput; pdf: Buffer; hash: string; sourceText: string; resume: Resume; method: 'llm' | 'regex'; extractionError?: string; tags: string[]; score?: ScoreResult }> = [];
  const enter = (index: number) => { const event: StageEvent = { ...stages[index], at: new Date().toISOString() }; result.stages.push(event); options.onStage?.(event); return event; };
  const step = async (index: number, run: () => Promise<void> | void) => { const event = enter(index); try { await run(); event.outcome = 'completed'; } catch (error) { event.outcome = 'failed'; event.error = error instanceof Error ? error.message : String(error); throw error; } };
  await step(0, () => { if (!inputs.length) throw new Error('at least one PDF resume is required'); });
  await step(1, () => { if (!job.requiredSkills.length) throw new Error('job skills are required'); });
  await step(2, async () => { for (const input of inputs) { try { const pdf = await readFile(input.pdfPath); if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('not a PDF'); const sourceText = await extractPdfText(pdf); if (!sourceText.trim()) throw new Error('PDF contains no extractable text'); const hash = createHash('sha256').update(sourceText.replace(/\s+/g, ' ').trim()).digest('hex'); raw.push({ input, pdf, hash, sourceText }); } catch (error) { result.failed.push({ pdfPath: input.pdfPath, error: error instanceof Error ? error.message : String(error) }); } } });
  await step(3, () => { for (const item of raw) { const reason = seen.has(item.hash) ? 'duplicate' : item.input.inactive ? 'inactive' : item.input.expired ? 'expired' : undefined; seen.add(item.hash); if (reason) result.filtered.push({ pdfPath: item.input.pdfPath, reason }); else cleaned.push(item); } });
  await step(4, async () => { for (const item of cleaned) { try { const { resume, method, extractionError } = await parseResume(item.sourceText, options.localOnly ? undefined : options.extractor ?? proxyExtractor()); parsed.push({ ...item, resume, method, extractionError, tags: [] }); } catch (error) { result.failed.push({ pdfPath: item.input.pdfPath, error: error instanceof Error ? error.message : String(error) }); } } });
  await step(5, () => { for (const item of parsed) item.tags = [...new Set([item.resume.expectedTitle, ...item.resume.skills].filter((v): v is string => Boolean(v)))]; });
  await step(6, async () => { for (const item of parsed) item.score = await scorer(item.resume, job, item.sourceText); });
  await step(7, () => { parsed.sort((a, b) => b.score!.score - a.score!.score || a.hash.localeCompare(b.hash)); });
  await step(8, async () => { for (const item of parsed) { const localFiles = await saveResume(paths, item.hash, item.pdf, item.resume, item.sourceText); result.candidates.push({ hash: item.hash, pdfPath: item.input.pdfPath, resume: item.resume, sourceText: item.sourceText, extractionMethod: item.method, extractionError: item.extractionError, tags: item.tags, score: item.score!, localFiles }); } });
  await step(9, () => {});
  return result;
}
