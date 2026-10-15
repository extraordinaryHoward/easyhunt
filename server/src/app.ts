import Fastify from 'fastify';
import type { Db } from './db.js';
import { AuthService, type CodeStore, type SmsSender } from './auth.js';
import { ApiError } from './errors.js';
import { registerP0 } from './routes-p0.js';
import { registerP1P2 } from './routes-p1p2.js';
import { registerLlmRoutes } from './llm/routes.js';
import type { LlmService } from './llm/service.js';
import { registerCollaborationRoutes } from './shares.js';

export function buildApp(options: { db: Db; codes: CodeStore; jwtSecret: string; sendSms: SmsSender; llmService?: LlmService; shareKey?: string }) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const auth = new AuthService(options.db, options.codes, options.jwtSecret, options.sendSms);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
    if (error && typeof error === 'object' && 'validation' in error) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid request' } });
    app.log.error(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
  });
  app.get('/status', async () => ({ status: 'ok', service: 'easyhunt-cloud' }));
  const guard = registerP0(app, { db: options.db, auth });
  registerP1P2(app, options.db, guard);
  registerLlmRoutes(app, options.db, options.codes, guard, options.llmService);
  registerCollaborationRoutes(app, options.db, guard, options.shareKey);
  return app;
}
