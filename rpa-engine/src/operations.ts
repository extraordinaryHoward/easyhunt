import { randomUUID } from 'node:crypto';
import { ApiError } from './spec.js';

export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type OperationEvent = { sequence: number; type: string; message: string; at: string; data?: Record<string, unknown> };
export type Operation = { operationId: string; action: string; status: OperationStatus; createdAt: string; updatedAt: string; events: OperationEvent[]; result?: unknown; error?: { code: string; message: string } };

/* DESIGN-DECISION: 无原始证据，自研 */
// Each operation awaits a checkpoint before each browser step. Pause blocks future steps;
// resume re-reads the page and retries the unfinished step. Cancel aborts checkpoint waits.
export class OperationQueue {
  private operations = new Map<string, Operation>();
  private controllers = new Map<string, AbortController>();
  constructor(private log: (event: { operationId: string; action: string; status: OperationStatus; at: string }) => void = (event) => console.log(JSON.stringify({ event: 'operation', ...event }))) {}

  private emit(operation: Operation) { this.log({ operationId: operation.operationId, action: operation.action, status: operation.status, at: operation.updatedAt }); }

  create(action: string, run: (signal: AbortSignal, report: (type: string, message: string, data?: Record<string, unknown>) => void) => Promise<unknown> | unknown): Operation {
    const now = new Date().toISOString();
    const operation: Operation = { operationId: randomUUID(), action, status: 'pending', createdAt: now, updatedAt: now, events: [] };
    const report = (type: string, message: string, data?: Record<string, unknown>) => {
      const at = new Date().toISOString();
      operation.events.push({ sequence: operation.events.length + 1, type, message, at, ...(data ? { data } : {}) });
      operation.updatedAt = at;
      console.log(JSON.stringify({ event: 'operation-step', operationId: operation.operationId, action, type, message, at, ...(data ? { data } : {}) }));
    };
    const controller = new AbortController();
    this.operations.set(operation.operationId, operation);
    this.controllers.set(operation.operationId, controller);
    report('queued', '任务已加入队列');
    this.emit(operation);
    setTimeout(async () => {
      if (operation.status === 'cancelled') return;
      operation.status = 'running';
      operation.updatedAt = new Date().toISOString();
      report('running', '任务开始执行');
      this.emit(operation);
      try {
        const result = await run(controller.signal, report);
        if (!this.isCancelled(operation.operationId)) { operation.result = result; operation.status = 'succeeded'; report('succeeded', '任务已完成'); }
      } catch (error) {
        if (!this.isCancelled(operation.operationId)) {
          operation.error = { code: error instanceof ApiError ? error.code : 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) };
          operation.status = 'failed';
          report('failed', operation.error.message, { code: operation.error.code });
        }
      } finally {
        operation.updatedAt = new Date().toISOString();
        this.emit(operation);
        this.controllers.delete(operation.operationId);
      }
    }, 30);
    return operation;
  }

  get(id: string): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new ApiError(404, 'OPERATION_NOT_FOUND', `operation ${id} not found`);
    return operation;
  }

  list(limit = 100): Operation[] { return [...this.operations.values()].slice(-limit).reverse(); }

  cancel(id: string): Operation {
    const operation = this.get(id);
    if (operation.status === 'succeeded' || operation.status === 'failed') throw new ApiError(409, 'OPERATION_FINISHED', `operation ${id} has finished`);
    if (operation.status !== 'cancelled') { operation.status = 'cancelled'; operation.updatedAt = new Date().toISOString(); this.controllers.get(id)?.abort(); operation.events.push({ sequence: operation.events.length + 1, type: 'cancelled', message: '任务已取消', at: operation.updatedAt }); this.emit(operation); }
    return operation;
  }

  cancelActive() { for (const operation of this.operations.values()) if (operation.status === 'pending' || operation.status === 'running') this.cancel(operation.operationId); }

  private isCancelled(id: string) { return this.operations.get(id)?.status === 'cancelled'; }
}
