const base = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data;
}

try {
  const opened = await request('/browser/open', 'POST', { platform: 'boss', page: 'search' });
  const sessionRef = opened.browser.sessionRef as string;
  console.log(`BOSS session: ${sessionRef} ${opened.browser.url}`);
  const created = await request('/operations', 'POST', { action: 'candidates.list', sessionRef, contextRef: 'current-page' });
  for (let attempt = 0; attempt < 120; attempt++) {
    const operation = await request(`/operations/${created.operationId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) {
      console.log(JSON.stringify(operation, null, 2));
      process.exitCode = operation.status === 'succeeded' ? 0 : 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
