import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const promptVersions = { profile: 'v1', resumeScore: 'v1', searchTerms: 'v1', resumeExtract: 'v1' } as const;
const files = { profile: 'profile.v1.txt', resumeScore: 'resume-score.v1.txt', searchTerms: 'search-terms.v1.txt', resumeExtract: 'resume-extract.v1.txt' } as const;
export type PromptName = keyof typeof files;
export async function prompt(name: PromptName): Promise<{ version: string; content: string }> {
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts');
  return { version: promptVersions[name], content: await readFile(path.join(directory, files[name]), 'utf8') };
}
