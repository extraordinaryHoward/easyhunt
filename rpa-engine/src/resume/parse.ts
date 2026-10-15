import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ResumeSchema, type Resume } from './schema.js';

export async function extractPdfText(pdf: Buffer): Promise<string> {
  const document = await getDocument({ data: new Uint8Array(pdf), useSystemFonts: true, disableFontFace: true }).promise;
  try {
    const lines: string[] = [];
    for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
      const page = await document.getPage(pageNo);
      const content = await page.getTextContent();
      let previousY: number | undefined;
      let line = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (previousY !== undefined && Math.abs(y - previousY) > 2) { lines.push(line.trim()); line = ''; }
        line += `${item.str} `;
        previousY = y;
      }
      if (line.trim()) lines.push(line.trim());
    }
    return lines.filter(Boolean).join('\n');
  } finally { await document.destroy(); }
}

export type ResumeExtractor = (sourceText: string) => Promise<unknown>;
export function proxyExtractor(url = process.env.EASYHUNT_RESUME_LLM_PROXY_URL): ResumeExtractor | undefined {
  if (!url || process.env.EASYHUNT_ALLOW_REMOTE_RESUME_PROCESSING !== 'true' || !process.env.EASYHUNT_CLOUD_ACCESS_TOKEN) return undefined;
  return async (sourceText) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.EASYHUNT_CLOUD_ACCESS_TOKEN}` }, body: JSON.stringify({ sourceText, schema: 'resume-v1', allowRemoteResumeProcessing: true }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`LLM proxy returned ${response.status}`);
    const result = await response.json() as { resume?: unknown };
    return result.resume ?? result;
  };
}

/* DESIGN-DECISION: 无原始证据，自研 */
// Regex parsing preserves source text for review when the server extractor is unavailable.
export function regexResume(sourceText: string): Resume {
  const field = (label: string) => sourceText.match(new RegExp(`(?:^|\\n)\\s*(?:${label})\\s*[:：]\\s*([^\\n]+)`, 'm'))?.[1]?.trim();
  const skills = (field('技能|技术栈') ?? '').split(/[,，、;；]/).map(x => x.trim()).filter(Boolean);
  const work = (field('工作经历|工作履历') ?? '').split(/[;；]/).map(x => x.trim()).filter(Boolean).map(x => {
    const [company = '未知公司', title = '未知岗位', dates = '', ...description] = x.split('|').map(v => v.trim());
    const [startDate, endDate] = dates.split('~').map(v => v.trim());
    return { company, title, startDate, endDate, description: description.join(' | ') || undefined };
  });
  const education = (field('教育经历|教育背景') ?? '').split(/[;；]/).map(x => x.trim()).filter(Boolean).map(x => {
    const [school = '未知学校', degree = '未知学历', major] = x.split('|').map(v => v.trim());
    return { school, degree, major };
  });
  const salaryText = field('期望薪资');
  const salaryMatch = salaryText?.match(/(\d+)(?:\s*[-~至]\s*(\d+))?\s*[kK]/);
  return ResumeSchema.parse({ name: field('姓名') ?? sourceText.split(/\s+/)[0], phone: field('电话|手机'), email: field('邮箱'), wechat: field('微信'), expectedCity: field('期望城市'), expectedTitle: field('期望岗位'), expectedSalaryText: salaryText, expectedSalary: salaryMatch ? { min: Number(salaryMatch[1]), max: Number(salaryMatch[2] ?? salaryMatch[1]), unit: 'K/月' } : undefined, skills: skills.length ? skills : ['待核实'], workExperiences: work, educationExperiences: education, totalExperienceYears: Number(field('工作年限')?.match(/\d+(?:\.\d+)?/)?.[0] ?? 0), currentCity: field('所在城市'), industry: field('行业') });
}

export async function parseResume(sourceText: string, extractor?: ResumeExtractor): Promise<{ resume: Resume; method: 'llm' | 'regex'; extractionError?: string }> {
  if (extractor) {
    try { return { resume: ResumeSchema.parse(await extractor(sourceText)), method: 'llm' }; }
    catch (error) { return { resume: regexResume(sourceText), method: 'regex', extractionError: error instanceof Error ? error.message : String(error) }; }
  }
  return { resume: regexResume(sourceText), method: 'regex' };
}
