import { ApiError } from '../spec.js';
import type { PlatformSkill } from './types.js';
import { BossSkill } from './boss/index.js';

export class SkillRegistry {
  private skills = new Map<string, PlatformSkill>();
  constructor(skills: PlatformSkill[] = [new BossSkill()]) { for (const skill of skills) this.skills.set(skill.platform, skill); }
  get(platform: string): PlatformSkill {
    const skill = this.skills.get(platform);
    if (!skill) throw new ApiError(501, 'SKILL_NOT_IMPLEMENTED', `${platform} skill is not implemented`);
    return skill;
  }
}
