import { describe, expect, it } from 'vitest';
import { summarizeCandidate } from './result';
import { interruptedTaskSnapshot, isPendingDecision, publicTaskSnapshot, taskCounts } from './task-run';
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
 it('keeps newly indexed local PDFs in the pending decision list and count',()=>{
  expect(isPendingDecision('indexed')).toBe(true);
  expect(isPendingDecision('NEW')).toBe(true);
  expect(isPendingDecision('PROMOTED')).toBe(false);
  expect(taskCounts([{status:'indexed',stars:4}]).todo).toBe(1);
 });
 it('persists aggregate progress without candidate identity or resume text',()=>{
  const snapshot=publicTaskSnapshot({operationId:'op-1',status:'running',events:[{sequence:1,type:'search.page',message:'第 1 页',at:'2026-10-16T00:00:00.000Z',data:{candidateRef:'private',collectedCount:3,pagesRead:1}}],result:{candidates:[{candidateRef:'private',name:'张某',initialScreen:{excerpt:'原文'}}]}},'boss');
  expect(snapshot.metrics.collectedCount).toBe(3);
  expect(JSON.stringify(snapshot)).not.toContain('private');
  expect(JSON.stringify(snapshot)).not.toContain('张某');
  expect(JSON.stringify(snapshot)).not.toContain('原文');
  expect(taskCounts([{status:'NEW',stars:5},{status:'PROMOTED',stars:3}],{operation_id:'op-1',project_id:'p',platform:'boss',status:'running',events:[],metrics:{collectedCount:3,initialCount:1}})).toMatchObject({quick:3,initial:1,fourStars:1,promoted:1,todo:1});
 });
 it('does not upload arbitrary browser error text or candidate data in the timeline',()=>{
  const snapshot=publicTaskSnapshot({operationId:'op-2',status:'failed',events:[{sequence:1,type:'failed',message:'候选人张某：13800000000',at:'2026-10-16T00:00:00.000Z',data:{candidateRef:'private',code:'DOM_UNRECOGNIZED'}}],error:{code:'DOM_UNRECOGNIZED',message:'候选人张某：13800000000'}},'boss');
  expect(JSON.stringify(snapshot)).not.toMatch(/张某|13800000000|private/);
  expect(snapshot.error).toContain('平台页面');
 });
 it('marks a lost in-memory operation as interrupted while keeping the recent event window',()=>{
  const run={operation_id:'45752b90-a35b-45cf-a8bf-70679b8db3b0',project_id:'project',platform:'boss',status:'running',events:Array.from({length:500},(_,i)=>({sequence:i+1,type:'step',message:'读取中',at:'2026-10-16T00:00:00.000Z'})),metrics:{collectedCount:9,pagesRead:2}};
  const stopped=interruptedTaskSnapshot(run);
  expect(stopped.status).toBe('failed');
  expect(stopped.events).toHaveLength(500);
  expect(stopped.events.at(-1)?.sequence).toBe(501);
  expect(stopped.metrics.collectedCount).toBe(9);
 });
});
