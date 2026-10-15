import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Resume } from './schema.js';

export type StoragePaths = { dataRoot: string; resume: string; resumeAttachment: string };
export function storagePaths(config: Partial<StoragePaths> = {}): StoragePaths {
  const dataRoot = path.resolve(config.dataRoot ?? process.env.EASYHUNT_DATA_ROOT ?? path.join(process.cwd(), 'data'));
  return { dataRoot, resume: path.resolve(config.resume ?? process.env.EASYHUNT_RESUME_DIR ?? path.join(dataRoot, 'resume')), resumeAttachment: path.resolve(config.resumeAttachment ?? process.env.EASYHUNT_ATTACHMENT_DIR ?? path.join(dataRoot, 'resumeAttachment')) };
}
export async function saveResume(paths: StoragePaths, hash: string, pdf: Buffer, resume: Resume, sourceText: string) {
  await Promise.all([mkdir(paths.dataRoot, { recursive: true }), mkdir(paths.resume, { recursive: true }), mkdir(paths.resumeAttachment, { recursive: true })]);
  const attachment = path.join(paths.resumeAttachment, `${hash}.pdf`);
  const parsed = path.join(paths.resume, `${hash}.json`);
  await writeFile(attachment, pdf, { flag: 'w' });
  await writeFile(parsed, JSON.stringify({ hash, resume, sourceText }, null, 2));
  return { attachment, parsed };
}
