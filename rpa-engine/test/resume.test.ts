import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { extractPdfText, parseResume } from '../src/resume/parse.js';
import { runResumePipeline, stages } from '../src/resume/pipeline.js';
import { ResumeSchema } from '../src/resume/schema.js';
import { buildApp } from '../src/app.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const files = ['chen-wei.pdf', 'lin-xiao.pdf', 'wang-ning.pdf'].map(name => path.join(fixtureDir, name));
const job = { title: '高级后端开发工程师', requiredSkills: ['Java', 'Spring Boot', 'Redis'], minimumDegree: '本科' as const, minimumExperienceYears: 5, weights: { degree: 0.25, experience: 0.3, skills: 0.45 } };

test('three real PDFs complete ten stages; duplicate is removed; evidence quotes source', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'easyhunt-resume-'));
  try {
    const result = await runResumePipeline([...files, files[0]].map(pdfPath => ({ pdfPath })), job, { paths: { dataRoot } });
    assert.deepEqual(result.stages.map(stage => ({ name: stage.name, status: stage.status })), stages.map(stage => ({ ...stage })));
    assert.ok(result.stages.every(stage => stage.outcome === 'completed'));
    assert.equal(result.candidates.length, 3);
    assert.deepEqual(result.filtered.map(x => x.reason), ['duplicate']);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.candidates.map(x => x.resume.name), ['陈伟', '林晓', '王宁']);
    for (const candidate of result.candidates) {
      ResumeSchema.parse(candidate.resume);
      assert.ok(candidate.score.stars >= 1 && candidate.score.stars <= 5);
      for (const group of ['matched', 'mismatched', 'pending'] as const) for (const item of candidate.score.analysis[group]) {
        assert.ok(item.content);
        assert.ok(Array.isArray(item.evidence));
        for (const evidence of item.evidence) assert.ok(candidate.sourceText.includes(evidence));
      }
      assert.ok((await stat(candidate.localFiles.attachment)).size > 500);
      assert.equal(JSON.parse(await readFile(candidate.localFiles.parsed, 'utf8')).hash, candidate.hash);
      assert.ok(candidate.localFiles.parsed.startsWith(path.join(dataRoot, 'resume')));
      assert.ok(candidate.localFiles.attachment.startsWith(path.join(dataRoot, 'resumeAttachment')));
    }
    assert.ok(result.candidates[2].score.analysis.mismatched.length >= 2);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test('inactive and expired marks filter before parsing and persist nothing', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'easyhunt-resume-'));
  try {
    const result = await runResumePipeline([{ pdfPath: files[0], inactive: true }, { pdfPath: files[1], expired: true }], job, { paths: { dataRoot } });
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(result.filtered.map(x => x.reason), ['inactive', 'expired']);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});

test('valid LLM proxy output uses Zod; invalid output falls back to regex', async () => {
  const text = await extractPdfText(await readFile(files[0]));
  const fallback = await parseResume(text, async () => ({ name: '', skills: [] }));
  assert.equal(fallback.method, 'regex');
  assert.equal(fallback.resume.name, '陈伟');
  assert.ok(fallback.extractionError);
  const llm = await parseResume(text, async () => ({ ...fallback.resume, expectedCity: '上海' }));
  assert.equal(llm.method, 'llm');
});

test('desktop-only PDF import returns local attachment and structured analysis', async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'easyhunt-import-'));
  const previousRoot = process.env.EASYHUNT_DATA_ROOT;
  const previousSecret = process.env.EASYHUNT_BRIDGE_SECRET;
  process.env.EASYHUNT_DATA_ROOT = dataRoot;
  process.env.EASYHUNT_BRIDGE_SECRET = 'test-local-desktop-secret';
  const app = buildApp();
  try {
    const payload = { pdfPaths: [files[0]], job };
    const denied = await app.inject({ method: 'POST', url: '/resumes/import-local-pdfs', payload });
    assert.equal(denied.statusCode, 403);
    const imported = await app.inject({ method: 'POST', url: '/resumes/import-local-pdfs', payload, headers: { 'x-easyhunt-bridge-secret': 'test-local-desktop-secret' } });
    assert.equal(imported.statusCode, 200, imported.body);
    const candidate = imported.json().candidates[0];
    assert.equal(candidate.resume.name, '陈伟');
    assert.ok(candidate.localFiles.attachment.startsWith(path.join(dataRoot, 'resumeAttachment')));
    assert.ok((await stat(candidate.localFiles.attachment)).size > 500);
  } finally {
    await app.close();
    if (previousRoot === undefined) delete process.env.EASYHUNT_DATA_ROOT; else process.env.EASYHUNT_DATA_ROOT = previousRoot;
    if (previousSecret === undefined) delete process.env.EASYHUNT_BRIDGE_SECRET; else process.env.EASYHUNT_BRIDGE_SECRET = previousSecret;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
