import path from 'node:path';
import { runResumePipeline } from './pipeline.js';

const pdfs = process.argv.slice(2);
if (!pdfs.length) {
  console.error('Usage: npm run resume:demo -- <resume.pdf> [more.pdf ...]');
  process.exitCode = 2;
} else {
  const result = await runResumePipeline(pdfs.map(pdfPath => ({ pdfPath: path.resolve(pdfPath) })), {
    title: '高级后端开发工程师', requiredSkills: ['Java', 'Spring Boot', 'Redis'], minimumDegree: '本科', minimumExperienceYears: 5,
    weights: { degree: 0.25, experience: 0.3, skills: 0.45 },
  }, { onStage: event => console.log(`[${event.status}] ${event.name}`) });
  console.log(JSON.stringify({ runId: result.runId, candidates: result.candidates.map(c => ({ name: c.resume.name, stars: c.score.stars, score: c.score.score, analysis: c.score.analysis, extractionMethod: c.extractionMethod, localFiles: c.localFiles })), filtered: result.filtered, failed: result.failed }, null, 2));
}
