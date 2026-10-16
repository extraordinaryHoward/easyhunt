import { describe, expect, it } from 'vitest';
import { summarizeCandidate } from './result';
import { publicTaskSnapshot, taskCounts } from './task-run';
describe('candidate preview',()=>{
 it('quotes observed evidence and leaves missing conditions pending',()=>{
  const value=summarizeCandidate({candidateRef:'c1',name:'张某',summary:'上海，5 年 TypeScript 经验',initialScreen:{excerpt:'负责招聘产品'}},{hardConditions:[{content:'TypeScript'},{content:'本科'}]});
  expect(value.stars).toBe(3);
  expect(value.analysis.matched[0].evidence[0]).toContain('TypeScript');
  expect(value.analysis.pending[0].content).toContain('本科');
  expect(value.analysis.mismatched).toEqual([]);
 });
});
describe('project task progress',()=>{
 it('persists aggregate progress without candidate identity or resume text',()=>{
  const snapshot=publicTaskSnapshot({operationId:'op-1',status:'running',events:[{sequence:1,type:'search.page',message:'第 1 页',at:'2026-10-16T00:00:00.000Z',data:{candidateRef:'private',collectedCount:3,pagesRead:1}}],result:{candidates:[{candidateRef:'private',name:'张某',initialScreen:{excerpt:'原文'}}]}},'boss');
  expect(snapshot.metrics.collectedCount).toBe(3);
  expect(JSON.stringify(snapshot)).not.toContain('private');
  expect(JSON.stringify(snapshot)).not.toContain('张某');
  expect(JSON.stringify(snapshot)).not.toContain('原文');
  expect(taskCounts([{status:'NEW',stars:5},{status:'PROMOTED',stars:3}],{operation_id:'op-1',project_id:'p',platform:'boss',status:'running',events:[],metrics:{collectedCount:3,initialCount:1}})).toMatchObject({quick:3,initial:1,fourStars:1,promoted:1,todo:1});
 });
});
