import type { Page } from 'playwright';

export type Candidate = { candidateRef: string; name: string; summary: string; href?: string };
export type Job = { jobRef: string; title: string; href?: string };
export type SkillContext = { page: Page; sessionRef: string; signal: AbortSignal; step: () => Promise<void> };

/* DESIGN-DECISION: 无原始证据，自研 */
export interface PlatformSkill {
  platform: string;
  pages: Record<string, string>;
  search: {
    fields(ctx: SkillContext): Promise<string[]>;
    get(ctx: SkillContext, field: string): Promise<unknown>;
    set(ctx: SkillContext, field: string, value: unknown): Promise<void>;
    apply(ctx: SkillContext, patch: Record<string, unknown>): Promise<void>;
  };
  candidates: {
    list(ctx: SkillContext): Promise<Candidate[]>;
    next(ctx: SkillContext): Promise<boolean>;
  };
  resume: {
    open(ctx: SkillContext, candidateRef: string): Promise<void>;
    read(ctx: SkillContext, candidateRef: string): Promise<string>;
    close(ctx: SkillContext): Promise<void>;
  };
  jobs: {
    list(ctx: SkillContext): Promise<Job[]>;
    select(ctx: SkillContext, jobRef: string): Promise<void>;
  };
  resolveSessionRef(ref: string): string | undefined;
}
