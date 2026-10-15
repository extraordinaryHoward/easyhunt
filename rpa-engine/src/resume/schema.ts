import { z } from 'zod';

export const WorkExperienceSchema = z.object({ company: z.string().min(1), title: z.string().min(1), startDate: z.string().optional(), endDate: z.string().optional(), description: z.string().optional() });
export const EducationExperienceSchema = z.object({ school: z.string().min(1), degree: z.string().min(1), major: z.string().optional(), startDate: z.string().optional(), endDate: z.string().optional() });

// The source report names fields but leaves nested experience fields unspecified.
/* DESIGN-DECISION: 无原始证据，自研 */
export const ResumeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().optional(), email: z.email().optional(), wechat: z.string().optional(),
  expectedCity: z.string().optional(), expectedTitle: z.string().optional(),
  expectedSalary: z.object({ min: z.number().nonnegative(), max: z.number().nonnegative(), unit: z.literal('K/月'), months: z.number().int().positive().optional() }).optional(),
  expectedSalaryText: z.string().optional(), skills: z.array(z.string().min(1)).min(1),
  workExperiences: z.array(WorkExperienceSchema), educationExperiences: z.array(EducationExperienceSchema),
  totalExperienceYears: z.number().nonnegative().optional(), currentCity: z.string().optional(), industry: z.string().optional(),
});
export type Resume = z.infer<typeof ResumeSchema>;

export const JobSchema = z.object({ title: z.string().min(1), requiredSkills: z.array(z.string().min(1)).min(1), minimumDegree: z.enum(['不限', '专科', '本科', '硕士', '博士']).default('不限'), minimumExperienceYears: z.number().nonnegative().default(0), weights: z.object({ degree: z.number().nonnegative(), experience: z.number().nonnegative(), skills: z.number().nonnegative() }).default({ degree: 0.25, experience: 0.3, skills: 0.45 }) });
export type Job = z.infer<typeof JobSchema>;
