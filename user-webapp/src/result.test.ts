import { describe, expect, it } from 'vitest';
import { summarizeCandidate } from './result';
describe('candidate preview',()=>{
 it('quotes observed evidence and leaves missing conditions pending',()=>{
  const value=summarizeCandidate({candidateRef:'c1',name:'张某',summary:'上海，5 年 TypeScript 经验',initialScreen:{excerpt:'负责招聘产品'}},{hardConditions:[{content:'TypeScript'},{content:'本科'}]});
  expect(value.stars).toBe(3);
  expect(value.analysis.matched[0].evidence[0]).toContain('TypeScript');
  expect(value.analysis.pending[0].content).toContain('本科');
  expect(value.analysis.mismatched).toEqual([]);
 });
});
