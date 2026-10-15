import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 4317);
const app = buildApp();
app.listen({ host: '127.0.0.1', port }).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
