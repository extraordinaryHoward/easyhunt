import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

test('packaged preload exposes the local PDF import IPC used by the workbench', async () => {
  let bridge;
  const calls = [];
  const source = readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8');
  runInNewContext(source, {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'easyhunt'); bridge = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ candidates: [] }); } },
      };
    },
  });
  assert.equal(typeof bridge.importLocalPdfs, 'function');
  const job = { title: '工程师', requiredSkills: ['TypeScript'] };
  await bridge.importLocalPdfs(job);
  assert.deepEqual(calls, [['import-local-pdfs', job]]);
});
